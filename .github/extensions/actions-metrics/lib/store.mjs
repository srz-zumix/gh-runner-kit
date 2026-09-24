// Dashboard state keyed by target, not by canvas instance: two panels pointed
// at the same repository or organization must show the same data, and the data
// has to survive iframe reloads and re-opens with a fresh instanceId.
//
// One target therefore has one active query. The identities below are
// generations within that entry rather than cache keys: they say whether the
// data in hand still answers the question being asked, not which of several
// datasets to hand back. Raw job rows are the exception - `RowStore` really is
// keyed by its query - because the explorer asks a different question of the
// CLI than the fleet metrics do.

import { collectSnapshot } from "./collect.mjs";
import { RowStore } from "./rowstore.mjs";
import { buildMetrics } from "./metrics.mjs";
import { rememberFilters } from "./prefs.mjs";
import {
    collectionId,
    filtersOf,
    formatQuery,
    limitsOf,
    normalizeQuery,
    persistedFields,
    scopeOf,
    targetKey,
    targetOf,
} from "./query.mjs";

export class DashboardStore {
    constructor({ cwd, log } = {}) {
        this.cwd = cwd;
        this.log = log ?? (() => {});
        this.entries = new Map();
        this.listeners = new Map();
        // Job rows are keyed by their own query rather than by target: the
        // explorer asks a different question of the CLI than the fleet
        // metrics do, and the two are collected and superseded separately.
        this.rows = new RowStore({ cwd, log: this.log });
    }

    entry(query) {
        const canonical = normalizeQuery(query);
        // Keyed by the scope-aware identity, not the display selector: two
        // distinct targets can share one selector, and they must not share one
        // entry. The selector is kept alongside for logs and persistence.
        const key = targetKey(canonical);
        let entry = this.entries.get(key);
        if (!entry) {
            entry = {
                key,
                selector: formatQuery(canonical),
                // The query is the entry's own state; the parsed target and the
                // flat filters below are derived from it on the way out.
                query: canonical,
                status: "idle",
                progress: "",
                error: null,
                metrics: null,
                updatedAt: null,
                inflight: null,
            };
            this.entries.set(key, entry);
        }
        return entry;
    }

    snapshot(key) {
        const entry = this.entries.get(key);
        if (!entry) {
            return null;
        }
        return {
            key: entry.key,
            selector: entry.selector,
            query: entry.query,
            target: targetOf(entry.query),
            filters: filtersOf(entry.query),
            status: entry.status,
            progress: entry.progress,
            error: entry.error,
            metrics: entry.metrics,
            updatedAt: entry.updatedAt,
        };
    }

    subscribe(key, listener) {
        const set = this.listeners.get(key) ?? new Set();
        set.add(listener);
        this.listeners.set(key, set);
        return () => {
            set.delete(listener);
            if (set.size === 0) {
                this.listeners.delete(key);
            }
        };
    }

    emit(key) {
        const payload = this.snapshot(key);
        for (const listener of this.listeners.get(key) ?? []) {
            try {
                listener(payload);
            } catch {
                // A broken SSE client must never break a refresh.
            }
        }
    }

    /**
     * Refresh a target's metrics. Concurrent calls share one in-flight
     * collection unless `force` is set with different filters.
     *
     * Only a change to the collection signature collects again: the projection
     * settings and the request concurrency describe how the data already in
     * hand is read, and re-collecting a busy organization to answer them would
     * cost half an hour for rows that would come back identical.
     */
    async refresh(query, { force = false, bypassCache = false } = {}) {
        const entry = this.entry(query);
        const next = normalizeQuery(query ?? entry.query);
        const filtersChanged = collectionId(next) !== collectionId(entry.query);
        const settingsChanged = JSON.stringify(next) !== JSON.stringify(entry.query);
        entry.query = next;

        if (settingsChanged) {
            // A settings-only change never reaches the collection below, so it
            // is persisted here instead; otherwise it would not survive a
            // reload.
            void rememberFilters(entry.key, entry.selector, scopeOf(entry.query), persistedFields(entry.query)).catch(() => {});
        }

        if (entry.inflight && !filtersChanged && !force) {
            if (settingsChanged) {
                this.emit(entry.key);
            }
            return entry.inflight;
        }
        if (!force && !filtersChanged && entry.status === "ready" && entry.metrics) {
            if (settingsChanged) {
                this.emit(entry.key);
            }
            return this.snapshot(entry.key);
        }

        entry.status = "loading";
        entry.progress = "Starting";
        entry.error = null;
        this.emit(entry.key);

        // Claimed before the first await so a collection that was superseded -
        // by a changed window, or by a second Refresh - cannot commit its rows
        // under the newer one's filters, nor report itself finished on its
        // behalf.
        const generation = (entry.generation = (entry.generation ?? 0) + 1);
        const limits = limitsOf(entry.query);

        entry.inflight = (async () => {
            try {
                const snapshot = await collectSnapshot({
                    target: targetOf(entry.query),
                    filters: filtersOf(entry.query),
                    limits,
                    cwd: this.cwd,
                    force: bypassCache,
                    onProgress: (message) => {
                        if (generation !== entry.generation) {
                            return;
                        }
                        entry.progress = message;
                        this.emit(entry.key);
                    },
                });
                if (generation !== entry.generation) {
                    return this.snapshot(entry.key);
                }
                entry.metrics = buildMetrics(snapshot);
                entry.status = "ready";
                entry.progress = "";
                entry.updatedAt = snapshot.collectedAt;
                await rememberFilters(entry.key, entry.selector, scopeOf(entry.query), persistedFields(entry.query)).catch(() => {});
            } catch (error) {
                if (generation !== entry.generation) {
                    return this.snapshot(entry.key);
                }
                entry.status = "error";
                entry.progress = "";
                entry.error = error?.message ?? String(error);
                this.log(`actions-metrics: refresh failed for ${entry.selector}: ${entry.error}`);
            } finally {
                if (generation === entry.generation) {
                    entry.inflight = null;
                    this.emit(entry.key);
                }
            }
            return this.snapshot(entry.key);
        })();

        return entry.inflight;
    }
}
