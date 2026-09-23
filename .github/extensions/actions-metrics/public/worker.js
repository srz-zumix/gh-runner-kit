// The job explorer's aggregation thread.
//
// Everything expensive happens here: decoding the row payload, normalizing it,
// and re-aggregating it on every filter change. At the full row budget a pass
// costs tens of milliseconds, which is imperceptible when it happens off the
// main thread and a visible stutter when it does not.
//
// The rows are held here and nowhere else. The main thread transfers the
// payload in and then keeps only the aggregates it draws, so one snapshot is
// never resident twice.

import { normalizeRows, countRowHealth } from "/shared/rows.mjs";
import { applyExploreFilters, buildExploreAggregate, buildExploreFacets, sortRows, summarizeExplore } from "/shared/explore.mjs";

let rows = [];
let snapshot = null;
/**
 * The rows the last filter run produced, kept so that paging the table does not
 * re-filter: scrolling a table is a much more frequent action than changing a
 * filter, and re-running the predicate for every page would make the cheaper
 * action pay for the more expensive one.
 */
let filtered = [];
let filterKey = "";
let sorted = [];
let sortKey = "";

function post(message, transfer) {
    self.postMessage(message, transfer ?? []);
}

/**
 * Decode a transferred payload.
 *
 * The bytes arrive as an ArrayBuffer rather than as an object so that the main
 * thread can hand ownership over instead of having the structured clone
 * algorithm copy several megabytes of parsed rows across the boundary.
 */
function load(buffer) {
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    const payload = JSON.parse(text);
    rows = normalizeRows(payload.rows ?? []);
    snapshot = {
        id: payload.id,
        revision: payload.revision,
        collectedAt: payload.collectedAt,
        truncated: Boolean(payload.truncated),
        malformed: payload.malformed ?? 0,
        budget: payload.budget ?? 0,
        scope: payload.scope ?? null,
        raw: payload.rows?.length ?? 0,
    };
    filtered = [];
    filterKey = "";
    sorted = [];
    sortKey = "";
    return snapshot;
}

function select(filters) {
    const key = JSON.stringify(filters ?? {});
    if (key !== filterKey) {
        filtered = applyExploreFilters(rows, filters ?? {}, { collectedAt: snapshot?.collectedAt });
        filterKey = key;
        sorted = [];
        sortKey = "";
    }
    return filtered;
}

self.onmessage = (event) => {
    const { id, type, payload } = event.data ?? {};
    try {
        if (type === "load") {
            const meta = load(payload.buffer);
            post({
                id,
                type: "loaded",
                payload: {
                    snapshot: meta,
                    rowCount: rows.length,
                    health: countRowHealth(rows, { windowFrom: payload.windowFrom, windowTo: payload.windowTo }),
                    facets: buildExploreFacets(rows),
                },
            });
            return;
        }

        if (type === "aggregate") {
            if (!snapshot) {
                post({ id, type: "empty" });
                return;
            }
            const subset = select(payload.filters);
            const options = {
                windowFrom: payload.windowFrom,
                windowTo: payload.windowTo,
                collectedAt: snapshot.collectedAt,
                bucketMs: payload.bucketMs,
                topRunners: payload.topRunners,
            };
            const aggregate = buildExploreAggregate(subset, options);
            post({
                id,
                type: "aggregate",
                payload: {
                    aggregate,
                    // Counted over all the rows against the current filters,
                    // not over the filtered subset: a facet has to keep
                    // offering the values the reader has not chosen, or
                    // picking one runner would remove every other runner from
                    // the list and a comparison could never be expressed.
                    facets: buildExploreFacets(rows, payload.filters, { collectedAt: snapshot.collectedAt }),
                    matched: subset.length,
                    total: rows.length,
                    summary: summarizeExplore(aggregate),
                },
            });
            return;
        }

        if (type === "page") {
            if (!snapshot) {
                post({ id, type: "page", payload: { rows: [], matched: 0 } });
                return;
            }
            const subset = select(payload.filters);
            const key = `${payload.sort}|${payload.direction}`;
            if (key !== sortKey) {
                sorted = sortRows(subset, payload.sort, payload.direction);
                sortKey = key;
            }
            const offset = Math.max(0, Number(payload.offset) || 0);
            const limit = Math.max(1, Math.min(500, Number(payload.limit) || 50));
            post({
                id,
                type: "page",
                payload: {
                    rows: sorted.slice(offset, offset + limit),
                    matched: sorted.length,
                    offset,
                    limit,
                },
            });
            return;
        }

        if (type === "release") {
            rows = [];
            snapshot = null;
            filtered = [];
            sorted = [];
            filterKey = "";
            sortKey = "";
            post({ id, type: "released" });
            return;
        }

        post({ id, type: "error", payload: { message: `Unknown request: ${type}` } });
    } catch (error) {
        post({ id, type: "error", payload: { message: error?.message ?? String(error) } });
    }
};
