// One canvas panel. Holds the query the panel currently asks - target and
// settings alike, in the one canonical object - and re-broadcasts store updates
// for that target to the panel's SSE clients.
//
// The runner projection lives here rather than in the store: the collected
// metrics are shared by every panel pointed at the same target, but the runner
// and workflow a panel is tracing are that panel's own view of them.

import {
    applyQueryPatch,
    assertQuery,
    canonicalizeQuery,
    collectionId,
    filtersOf,
    formatQuery,
    limitsOf,
    normalizeQuery,
    // Aliased: `this.projectionId` below is the nonce of one drawn projection,
    // which the panel echoes back, not the identity of the settings it was
    // drawn with.
    projectionId as projectionKey,
    scopeOf,
    targetOf,
} from "./query.mjs";
import { exportFleet, hasExcludeRunner, hasJobRows } from "./runnerkit.mjs";
import { collectRunnerTimeline, compileExclusions } from "./jobs.mjs";

/** Hard ceiling on one page of runners, so a crafted query cannot ask for all of them at once. */
const MAX_PAGE = 200;

export class DashboardInstance {
    constructor({ instanceId, store, query }) {
        this.instanceId = instanceId;
        this.store = store;
        // The panel's own copy of the query. The store holds the one in force
        // for the target, which a second panel can change; this is what this
        // panel last asked for and what it falls back to before the store has
        // an entry.
        this.query = normalizeQuery(query);
        this.listeners = new Set();
        this.unsubscribe = null;
        this.timeline = null;
        this.timelineStatus = "idle";
        this.timelineError = null;
        this.timelineRequest = null;
        this.timelineProgress = "";
        this.timelineBase = null;
        this.timelineGeneration = 0;
        this.timelineAbort = null;
        // Which projection settings the drawn projection was computed with, so
        // a change made here or in another panel on the same target can be
        // told apart from a re-broadcast of the same state.
        this.timelineSignature = null;
        // Every runner the last projection observed, ranked. Held here rather
        // than sent to the panel: at 18k names it is megabytes, and the state
        // is re-broadcast on every store update and every progress line.
        this.timelineAll = [];
        this.projectionId = null;
        // The row snapshot this panel's explorer is reading. Only the identity
        // is held: the rows themselves are fetched over their own endpoint so
        // they never enter the state that is pushed on every progress line.
        this.rowSignature = null;
        this.rowUnsubscribe = null;
        this.attach();
    }

    get key() {
        return formatQuery(this.query);
    }

    attach() {
        this.unsubscribe?.();
        // A new target is a new question, so the rows collected for the old
        // one are released rather than left subscribed: they describe a
        // repository this panel no longer shows.
        this.rowUnsubscribe?.();
        this.rowUnsubscribe = null;
        this.rowSignature = null;
        this.store.entry(this.query);
        this.unsubscribe = this.store.subscribe(this.key, () => {
            this.broadcast();
            this.reproject();
        });
    }

    /**
     * The query in force for this panel's target. Read from the store rather
     * than from `this.query`, because one target has one query: a second panel
     * pointed at the same organization changes it for both, and this one is
     * only told over the store.
     */
    get effectiveQuery() {
        return this.store.snapshot(this.key)?.query ?? this.query;
    }

    /** The flat settings the collection layer reads, for the query in force. */
    get effectiveFilters() {
        return filtersOf(this.effectiveQuery);
    }

    /**
     * Re-run the drawn projection when the settings it was computed with have
     * changed. Called after `broadcast`, so a change that also invalidated the
     * collection has already dropped the projection through `state` and there
     * is nothing left to re-run - a new window is not the same question.
     */
    reproject() {
        if (!this.timelineRequest) {
            return;
        }
        const signature = projectionKey(this.effectiveQuery);
        if (signature === this.timelineSignature) {
            return;
        }
        // Claimed before the call so the broadcast it triggers does not ask for
        // the same re-run again. `project` supersedes a projection that is
        // still streaming through its own generation counter, so a change made
        // mid-run is safe.
        this.timelineSignature = signature;
        void this.project(this.timelineRequest).catch(() => {});
    }

    dispose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.rowUnsubscribe?.();
        this.rowUnsubscribe = null;
        this.dropTimeline();
        this.listeners.clear();
    }

    /**
     * Identity of the collection a projection was computed against. A
     * projection is expressed in the buckets one collection returned, so it is
     * dropped rather than redrawn against a window it does not describe. Only
     * the collection signature counts: a projection setting changes how the
     * same collection is read, and re-runs the projection instead of ending it.
     */
    baseKey(stored) {
        return `${this.key}|${stored?.updatedAt ?? ""}|${collectionId(stored?.query ?? this.query)}`;
    }

    dropTimeline() {
        this.timeline = null;
        this.timelineStatus = "idle";
        this.timelineError = null;
        this.timelineRequest = null;
        this.timelineProgress = "";
        this.timelineBase = null;
        this.timelineSignature = null;
        this.timelineGeneration += 1;
        this.timelineAbort?.abort();
        this.timelineAbort = null;
        // The retained runners describe the projection that is going away, so
        // they go with it: a page served from them afterwards would answer a
        // question about a window the panel no longer shows.
        this.timelineAll = [];
        this.projectionId = null;
    }

    /**
     * A request that never got as far as reading a job row. The previous
     * projection is dropped with it: the error describes the query the reader
     * just asked for, so leaving the last one drawn underneath would read as
     * its result. Like an accepted request it also supersedes a projection
     * that is still running, which is the run's own behaviour.
     */
    rejectTimeline(message) {
        this.dropTimeline();
        this.timelineStatus = "error";
        this.timelineError = message;
        this.broadcast();
    }

    state() {
        const stored = this.store.snapshot(this.key);
        if (this.timelineBase !== null && this.timelineBase !== this.baseKey(stored)) {
            this.dropTimeline();
        }
        return {
            instanceId: this.instanceId,
            key: this.key,
            target: targetOf(this.effectiveQuery),
            scope: scopeOf(this.effectiveQuery),
            query: this.effectiveQuery,
            filters: filtersOf(this.effectiveQuery),
            status: stored?.status ?? "idle",
            progress: this.timelineProgress || (stored?.progress ?? ""),
            error: stored?.error ?? null,
            metrics: stored?.metrics ?? null,
            updatedAt: stored?.updatedAt ?? null,
            timeline: this.timeline,
            timelineStatus: this.timelineStatus,
            timelineError: this.timelineError,
            timelineRequest: this.timelineRequest,
            rows: this.rowState(),
        };
    }

    /**
     * The explorer's snapshot status, or null when nothing has asked for rows.
     *
     * Recomputed from the current filters rather than cached, so a settings
     * change made in another panel on the same target immediately reads as a
     * different query here instead of leaving this panel describing rows that
     * no longer answer its window.
     */
    rowState() {
        if (!this.rowSignature) {
            return null;
        }
        const wanted = this.store.rows.signature(this.effectiveQuery);
        const described = this.store.rows.describe(this.rowSignature);
        return {
            ...(described ?? { status: "idle" }),
            // The panel compares these: when they differ the rows on screen
            // answer a question that is no longer the one being asked, and the
            // explorer re-requests instead of redrawing.
            signature: this.rowSignature,
            wanted,
            stale: wanted !== this.rowSignature,
        };
    }

    /**
     * Start or reuse the row collection for this panel's current filters.
     *
     * Subscribing here rather than in the store keeps the SSE fan-out in one
     * place: a row-collection progress line reaches the panel as an ordinary
     * state broadcast, the same way a metrics progress line does.
     */
    rowPayload(id, revision) {
        return this.store.rows.payload(id, revision);
    }

    requestRows({ force = false } = {}) {
        const query = this.effectiveQuery;
        const signature = this.store.rows.signature(query);
        if (signature !== this.rowSignature) {
            this.rowUnsubscribe?.();
            this.rowSignature = signature;
            this.rowUnsubscribe = this.store.rows.subscribe(signature, () => this.broadcast());
        }
        const descriptor = this.store.rows.request({ query, force });
        this.broadcast();
        return descriptor;
    }

    onState(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    broadcast() {
        const payload = this.state();
        for (const listener of this.listeners) {
            try {
                listener(payload);
            } catch {
                // Never let a dead client break the refresh pipeline.
            }
        }
    }

    /**
     * Publish the current window through `gh runner-kit metrics export`. Run on
     * demand rather than on every refresh: the dashboard already renders these
     * numbers, so this exists to feed a monitoring system.
     */
    export(format) {
        const query = this.effectiveQuery;
        return exportFleet({
            target: targetOf(query),
            filters: filtersOf(query),
            limits: limitsOf(query),
            cwd: this.store.cwd,
            format,
        });
    }

    /**
     * Read one projection request, or refuse it.
     *
     * Split out of `project` because the HTTP route starts the projection and
     * answers before it finishes: a rejected promise would have nowhere to go,
     * so the route validates first and replies 400 while the agent action keeps
     * getting a thrown error.
     */
    planProjection({ query = "", workflow = "", exclude = "", all = false, clear = false } = {}) {
        const text = String(query ?? "").trim();
        const excluded = String(exclude ?? "").trim();
        const intents = (clear ? 1 : 0) + (all ? 1 : 0) + (text === "" ? 0 : 1);
        if (intents > 1) {
            throw new Error("A runner pattern, every runner and clearing are three different requests");
        }
        if (excluded !== "" && intents === 0) {
            throw new Error("An exclusion narrows a trace, so it needs a runner pattern or every runner alongside it");
        }
        // Refused here rather than after the stream has been read, so a typo
        // costs nothing.
        compileExclusions(excluded);
        return {
            query: text,
            exclude: excluded,
            workflow: String(workflow ?? "").trim(),
            all: Boolean(all),
            clear: Boolean(clear) || intents === 0,
        };
    }

    /**
     * Project the jobs of the runners matching one pattern onto the buckets the
     * last collection returned, through `gh runner-kit metrics jobs`.
     *
     * Exactly one intent per call: trace a pattern, trace every runner in the
     * window, or drop the projection. `all` is spelled out rather than inferred
     * from an empty pattern because it is the expensive one - it reads every
     * job row the window holds - and an omitted argument must not be what asks
     * for it.
     *
     * `exclude` is not an intent: it narrows whichever of the two traces runs,
     * so an exclusion on its own is refused rather than quietly dropping the
     * projection the caller was trying to narrow.
     */
    async project(request = {}) {
        const plan = this.planProjection(request);
        const { query: text, exclude: excluded, workflow, all } = plan;
        if (plan.clear) {
            this.dropTimeline();
            this.broadcast();
            return this.state();
        }

        const stored = this.store.snapshot(this.key);
        const buckets = stored?.metrics?.fleet?.concurrency ?? [];
        if (stored?.status !== "ready" || buckets.length === 0) {
            this.rejectTimeline("The concurrency timeline has to be collected before a runner can be projected onto it.");
            return this.state();
        }

        // Claimed before the first await, not after it. The capability probe
        // below is an await, so two requests arriving together could otherwise
        // resume in the opposite order and let the older one claim the newer
        // generation - which would leave the panel showing the trace that was
        // superseded.
        const generation = (this.timelineGeneration += 1);
        // A projection reads every job in the window, so a superseded one is
        // killed rather than left running for a result nobody will read.
        this.timelineAbort?.abort();
        const controller = new AbortController();
        this.timelineAbort = controller;
        // The previous cells described a different query, so they are dropped
        // instead of left on screen under the new one's progress line.
        this.timeline = null;
        this.timelineAll = [];
        this.projectionId = null;
        this.timelineStatus = "loading";
        this.timelineError = null;
        this.timelineRequest = {
            query: text,
            all: Boolean(all),
            workflow: String(workflow ?? "").trim(),
            exclude: excluded,
        };
        this.timelineBase = this.baseKey(stored);
        // Recorded with the request so a later settings change can tell that
        // the drawn projection no longer answers it.
        this.timelineSignature = projectionKey(stored.query ?? this.query);
        this.timelineProgress = all ? "Reading every job in the window" : `Projecting ${text} onto the timeline`;
        this.broadcast();

        try {
            if (!(await hasJobRows(this.store.cwd))) {
                // Only reported if this request is still the current one: a
                // superseded request must not overwrite the newer one's state.
                if (generation === this.timelineGeneration) {
                    this.rejectTimeline("gh runner-kit metrics jobs is not available in the installed version.");
                }
                return this.state();
            }
            const active = filtersOf(stored.query ?? this.query);
            const timeline = await collectRunnerTimeline({
                target: targetOf(stored.query ?? this.query),
                filters: active,
                limits: limitsOf(stored.query ?? this.query),
                kind: active.jobKind,
                topRunners: active.topRunners,
                maxRows: active.maxRows,
                cwd: this.store.cwd,
                buckets,
                query: text,
                workflow,
                exclude: excluded,
                // Probed rather than assumed: an older `gh runner-kit` would
                // fail on an unknown flag, so the rows are filtered here when
                // the installed one cannot do it itself.
                excludeInCli: excluded === "" ? false : await hasExcludeRunner(this.store.cwd),
                signal: controller.signal,
                onProgress: (message) => {
                    if (generation === this.timelineGeneration) {
                        this.timelineProgress = message;
                        this.broadcast();
                    }
                },
            });
            // A newer query, or a refresh, superseded this one while it ran.
            if (generation !== this.timelineGeneration) {
                return this.state();
            }
            // The full ranking stays here; the panel gets a summary and asks
            // for a page of it when the table is filtered.
            const { all: ranked, ...summary } = timeline;
            this.timelineAll = ranked;
            this.projectionId = `${generation}-${Date.now().toString(36)}`;
            this.timeline = { ...summary, projectionId: this.projectionId, observedRunners: ranked.length };
            this.timelineStatus = "ready";
        } catch (error) {
            if (generation !== this.timelineGeneration) {
                return this.state();
            }
            this.timeline = null;
            this.timelineAll = [];
            this.projectionId = null;
            this.timelineStatus = "error";
            this.timelineError = error?.message ?? String(error);
            this.store.log(`actions-metrics: runner timeline failed for ${this.key}: ${this.timelineError}`);
        } finally {
            if (generation === this.timelineGeneration) {
                this.timelineAbort = null;
                this.timelineProgress = "";
                this.broadcast();
            }
        }
        return this.state();
    }

    /**
     * One page of the runners the last projection observed.
     *
     * The table has to search every runner - a busy organization names tens of
     * thousands and only the 40 busiest carry a timeline - so the search runs
     * here, over the retained ranking, rather than over the rows the panel was
     * given. Filtering, then sorting, then cutting the page is the order that
     * makes "40 of 327 matching, out of 18386 observed" true; sorting a page
     * that was already cut would sort the wrong 40.
     *
     * `projection` is the identity of the projection the caller was looking at.
     * A page is refused rather than answered from a newer one, because a table
     * filled from a projection the reader never asked about is worse than an
     * empty one.
     */
    runnerPage({ projection = "", query = "", sort = "jobMs", direction = "desc", limit = 40, offset = 0 } = {}) {
        if (!this.projectionId) {
            throw Object.assign(new Error("No runner projection is loaded"), { status: 409 });
        }
        // Required, not merely checked when present: a page is only meaningful
        // as the answer to "the projection I am looking at", and a caller that
        // does not say which one cannot be given rows it can trust.
        if (projection !== this.projectionId) {
            throw Object.assign(new Error("That runner projection has been replaced"), { status: 409 });
        }
        const columns = { runner: "runner", jobs: "jobs", jobMs: "jobMs", busyMs: "busyMs" };
        const column = columns[sort];
        if (!column) {
            throw Object.assign(new Error(`Runners cannot be sorted by ${sort}`), { status: 400 });
        }
        const size = Math.min(MAX_PAGE, Math.max(1, Number(limit) || MAX_PAGE));
        const from = Math.max(0, Number(offset) || 0);
        // Case-insensitive substring, not the glob the trace fields use: this
        // one only changes what is visible, so being forgiving costs nothing.
        const needle = String(query ?? "").trim().toLowerCase();
        const matches = needle === "" ? this.timelineAll : this.timelineAll.filter((row) => row.runner.toLowerCase().includes(needle));

        const sign = direction === "asc" ? 1 : -1;
        const sorted = [...matches].sort((left, right) => {
            if (column === "runner") {
                return sign * left.runner.localeCompare(right.runner);
            }
            return sign * (left[column] - right[column]) || left.runner.localeCompare(right.runner);
        });

        return {
            projectionId: this.projectionId,
            observed: this.timelineAll.length,
            matched: sorted.length,
            offset: from,
            limit: size,
            sort,
            direction: sign === 1 ? "asc" : "desc",
            query: String(query ?? "").trim(),
            rows: sorted.slice(from, from + size).map((row) => ({
                runner: row.runner,
                jobs: row.jobs,
                jobMs: row.jobMs,
                busyMs: row.busyMs,
                unidentified: row.unidentified,
            })),
        };
    }

    /**
     * Apply a partial change to the query and start a refresh. Which of `repo`
     * and `owner` the patch names is what selects the scope, because `A/B` is a
     * repository on the default host and an organization on host `A` alike. The
     * returned promise resolves when collection finishes; progress arrives over
     * SSE. `bypassCache` additionally discards the job cache `gh runner-kit`
     * keeps.
     *
     * `force` defaults to off so that a settings change costs what it is worth:
     * the store collects again when the filters ask for different data, and
     * only an explicit Refresh insists on it regardless.
     */
    apply({ patch, force = false, bypassCache = false } = {}) {
        // A patch, not a replacement: an omitted field keeps the value in
        // force for the target rather than falling back to its default, so an
        // agent that changes only the window does not silently reset the rest.
        // Canonicalized after validating, so that two spellings of one
        // target are one query and do not read as a changed collection.
        const next = patch
            ? canonicalizeQuery(assertQuery(applyQueryPatch(this.effectiveQuery, patch)))
            : normalizeQuery(this.effectiveQuery);
        const targetChanged = formatQuery(next) !== this.key;
        this.query = next;
        if (targetChanged) {
            this.attach();
        }
        const done = this.store.refresh(this.query, { force, bypassCache });
        this.broadcast();
        return done;
    }
}
