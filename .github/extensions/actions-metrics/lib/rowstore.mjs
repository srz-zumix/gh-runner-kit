// The registry of collected job-row snapshots.
//
// Rows are held here rather than on the panel because they are a property of
// the query, not of the window someone happens to be looking at: two panels
// pointed at the same organization over the same days ask the CLI the same
// question, and collecting it twice would spend the API budget twice and hold
// two copies of a large array in this process.
//
// A snapshot is kept serialized. The panel fetches it over HTTP and re-fetches
// it whenever the iframe reloads, so the bytes are produced once and handed out
// unchanged afterwards.

import { collectJobRows } from "./jobrows.mjs";
import { describeScope, filtersOf, limitsOf, rowQueryId, targetOf } from "./query.mjs";

/**
 * How many distinct queries keep their rows.
 *
 * Small on purpose: each entry is the full serialized row set, and the reason
 * to keep more than one is only so that stepping a window back and forward
 * does not re-collect. Beyond that the memory is worth more than the wait.
 */
const MAX_ENTRIES = 3;

let nextId = 1;

export class RowStore {
    constructor({ cwd, log } = {}) {
        this.cwd = cwd;
        this.log = log ?? (() => {});
        this.entries = new Map();
        this.listeners = new Map();
    }

    entry(signature) {
        let entry = this.entries.get(signature);
        if (!entry) {
            entry = {
                signature,
                id: `rows-${nextId++}`,
                revision: 0,
                status: "idle",
                progress: "",
                error: null,
                payload: null,
                count: 0,
                truncated: false,
                malformed: 0,
                budget: 0,
                collectedAt: null,
                durationMs: 0,
                scope: null,
                generation: 0,
                inflight: null,
                abort: null,
                lastAccess: Date.now(),
            };
            this.entries.set(signature, entry);
        }
        entry.lastAccess = Date.now();
        return entry;
    }

    /** Drop the least recently read snapshot once the registry is over budget. */
    evict() {
        while (this.entries.size > MAX_ENTRIES) {
            let oldest = null;
            for (const entry of this.entries.values()) {
                // A collection in flight has a panel waiting on it, and a
                // snapshot someone is subscribed to is on screen.
                if (entry.inflight || this.listeners.get(entry.signature)?.size) {
                    continue;
                }
                if (!oldest || entry.lastAccess < oldest.lastAccess) {
                    oldest = entry;
                }
            }
            if (!oldest) {
                return;
            }
            this.entries.delete(oldest.signature);
            this.listeners.delete(oldest.signature);
        }
    }

    subscribe(signature, listener) {
        const set = this.listeners.get(signature) ?? new Set();
        set.add(listener);
        this.listeners.set(signature, set);
        return () => {
            set.delete(listener);
            if (set.size === 0) {
                this.listeners.delete(signature);
                // The snapshot may have been held over the bound only because
                // this panel was reading it. Nothing else would come back to
                // release it if no further collection is ever requested.
                this.evict();
            }
        };
    }

    emit(signature) {
        const payload = this.describe(signature);
        for (const listener of this.listeners.get(signature) ?? []) {
            try {
                listener(payload);
            } catch {
                // A broken subscriber must never break a collection.
            }
        }
    }

    /**
     * The part of a snapshot that is safe to put in the panel state.
     *
     * Everything here is a scalar: the panel state is re-serialized and pushed
     * over SSE on every progress line, so the rows themselves are fetched
     * separately and never travel this way.
     */
    describe(signature) {
        const entry = this.entries.get(signature);
        if (!entry) {
            return null;
        }
        return {
            id: entry.id,
            revision: entry.revision,
            status: entry.status,
            progress: entry.progress,
            error: entry.error,
            count: entry.count,
            truncated: entry.truncated,
            malformed: entry.malformed,
            budget: entry.budget,
            collectedAt: entry.collectedAt,
            durationMs: entry.durationMs,
            scope: entry.scope,
        };
    }

    /**
     * The serialized rows, but only for the revision the caller asked for.
     *
     * A panel that asks for a superseded revision is told so rather than handed
     * the current one: it requested the rows for a window it has since left,
     * and answering with different rows under the old identity would draw the
     * new data on the old axis.
     */
    payload(id, revision) {
        for (const entry of this.entries.values()) {
            if (entry.id !== id) {
                continue;
            }
            entry.lastAccess = Date.now();
            if (entry.revision !== Number(revision)) {
                return { superseded: true, revision: entry.revision };
            }
            if (!entry.payload) {
                return { pending: true, revision: entry.revision };
            }
            return { bytes: entry.payload, revision: entry.revision };
        }
        return { missing: true };
    }

    /**
     * Ensure a snapshot exists for one query, collecting it if it does not.
     *
     * The query is captured before the first await and read from that capture
     * afterwards: by the time the CLI returns, the panel that asked may be
     * pointed somewhere else entirely.
     */
    request({ query, force = false } = {}) {
        const signature = rowQueryId(query);
        const entry = this.entry(signature);
        this.evict();

        if (entry.inflight && !force) {
            return this.describe(signature);
        }
        if (!force && entry.status === "ready" && entry.payload) {
            return this.describe(signature);
        }

        entry.status = "loading";
        entry.progress = "Starting";
        entry.error = null;
        // Claimed before the first await, so a collection that is superseded
        // cannot commit its rows nor report itself finished on behalf of the
        // one that replaced it.
        const generation = (entry.generation += 1);
        entry.abort?.abort();
        const abort = new AbortController();
        entry.abort = abort;
        this.emit(signature);

        // Captured before the first await: by the time the CLI returns, the
        // panel that asked may be pointed somewhere else entirely.
        const captured = {
            target: targetOf(query),
            filters: filtersOf(query),
            limits: limitsOf(query),
            scope: describeScope(query),
        };

        entry.inflight = (async () => {
            try {
                const result = await collectJobRows({
                    target: captured.target,
                    filters: captured.filters,
                    limits: captured.limits,
                    cwd: this.cwd,
                    signal: abort.signal,
                    onProgress: (message) => {
                        if (generation !== entry.generation) {
                            return;
                        }
                        entry.progress = message;
                        this.emit(signature);
                    },
                });
                if (generation !== entry.generation) {
                    return;
                }
                // Serialized once here: the panel re-fetches these bytes on
                // every iframe reload, and re-stringifying twenty thousand
                // rows each time is the difference between instant and a
                // visible pause.
                entry.payload = Buffer.from(
                    JSON.stringify({
                        id: entry.id,
                        revision: entry.revision + 1,
                        collectedAt: result.collectedAt,
                        truncated: result.truncated,
                        malformed: result.malformed,
                        budget: result.budget,
                        scope: captured.scope,
                        rows: result.rows,
                    }),
                    "utf8",
                );
                entry.revision += 1;
                entry.count = result.rows.length;
                entry.truncated = result.truncated;
                entry.malformed = result.malformed;
                entry.budget = result.budget;
                entry.collectedAt = result.collectedAt;
                entry.durationMs = result.durationMs;
                entry.scope = captured.scope;
                entry.status = "ready";
                entry.progress = "";
            } catch (error) {
                if (generation !== entry.generation || abort.signal.aborted) {
                    return;
                }
                entry.status = "error";
                entry.progress = "";
                entry.error = error?.message ?? String(error);
                this.log(`actions-metrics: job rows failed for ${captured.scope.target} over ${captured.scope.days}d: ${entry.error}`);
            } finally {
                if (generation === entry.generation) {
                    entry.inflight = null;
                    entry.abort = null;
                    this.emit(signature);
                    // An entry that was protected purely because it was still
                    // collecting is now releasable, and eviction otherwise only
                    // runs when the next collection starts.
                    this.evict();
                }
            }
        })();

        return this.describe(signature);
    }

    signature(query) {
        return rowQueryId(query);
    }
}
