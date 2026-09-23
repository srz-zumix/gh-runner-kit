// Everything the job explorer draws, computed from normalized rows.
//
// Imported by the extension process (Node, for the agent-facing digest) and by
// the canvas renderer's worker (browser), so it must stay free of any Node-only
// import.
//
// The explorer's defining property is that this runs in the browser: the rows
// are fetched once and every filter is answered here, so a filter costs a
// re-aggregation rather than a CLI round trip.

import {
    bucketAxis,
    chooseBucketMs,
    clipInterval,
    mergeIntervals,
    mergedTotal,
    occupancyByBucket,
    peakPerBucket,
} from "./intervals.mjs";
import { UNIDENTIFIED } from "./rows.mjs";

/**
 * The filters answered in the browser. These narrow the rows already in hand
 * and can never broaden past what was collected, which is why the collection
 * scope is reported separately in the panel.
 */
/**
 * A fresh, unshared filter set.
 *
 * A factory rather than a spread of the frozen default, because spreading it
 * copies the empty arrays by reference: two "cleared" filter sets would share
 * one array, and the first in-place change to either would appear in both.
 */
export function emptyExploreFilters() {
    return {
        text: "",
        repo: [],
        workflow: [],
        label: [],
        runner: [],
        branch: [],
        event: [],
        kind: [],
        conclusion: [],
        state: [],
        from: null,
        to: null,
    };
}

export const EMPTY_FILTERS = Object.freeze({
    text: "",
    repo: [],
    workflow: [],
    label: [],
    runner: [],
    branch: [],
    event: [],
    kind: [],
    conclusion: [],
    state: [],
    from: null,
    to: null,
});

const LIST_KEYS = ["repo", "workflow", "label", "runner", "branch", "event", "kind", "conclusion", "state"];

function time(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const ms = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

export function normalizeExploreFilters(input) {
    const filters = { ...EMPTY_FILTERS };
    if (!input || typeof input !== "object") {
        return filters;
    }
    filters.text = typeof input.text === "string" ? input.text.trim() : "";
    for (const key of LIST_KEYS) {
        const value = input[key];
        filters[key] = Array.isArray(value) ? value.filter((entry) => typeof entry === "string" && entry !== "") : [];
    }
    filters.from = time(input.from);
    filters.to = time(input.to);
    if (filters.from !== null && filters.to !== null && filters.to < filters.from) {
        [filters.from, filters.to] = [filters.to, filters.from];
    }
    return filters;
}

export function hasActiveExploreFilters(filters) {
    if (!filters) {
        return false;
    }
    if (filters.text) {
        return true;
    }
    if (filters.from !== null || filters.to !== null) {
        return true;
    }
    return LIST_KEYS.some((key) => (filters[key] ?? []).length > 0);
}

function matchesList(list, value) {
    return list.length === 0 || list.includes(value);
}

/**
 * Whether a row survives the filters.
 *
 * The time range is matched on the job's interval rather than on when it was
 * queued: selecting an hour on the timeline is a question about what was
 * running then, and a long job that started before the selection was still
 * occupying its runner during it. A job that never started is placed by its
 * queue time so that the queue backlog does not vanish from a selection.
 *
 * `collectedAt` closes a job that was still running when the rows were taken,
 * matching what the charts draw. Without it a job that started before the
 * selection and had not finished by collection time would be measured as
 * ending the moment it started, and would drop out of every selection after
 * its first instant — while still being drawn as busy by the heatmap.
 */
export function applyExploreFilters(rows, input, options = {}) {
    const filters = normalizeExploreFilters(input);
    if (!hasActiveExploreFilters(filters)) {
        return rows;
    }
    const openEnd = Number.isFinite(options.collectedAt) ? options.collectedAt : null;
    const needle = filters.text.toLowerCase();
    const { from, to } = filters;
    const out = [];
    for (const row of rows) {
        if (needle && !row.search.includes(needle)) {
            continue;
        }
        if (!matchesList(filters.repo, row.repo)) {
            continue;
        }
        if (!matchesList(filters.workflow, row.workflowKey)) {
            continue;
        }
        if (!matchesList(filters.runner, row.runnerKey)) {
            continue;
        }
        if (!matchesList(filters.branch, row.branch)) {
            continue;
        }
        if (!matchesList(filters.event, row.event)) {
            continue;
        }
        if (!matchesList(filters.kind, row.kind)) {
            continue;
        }
        if (!matchesList(filters.conclusion, row.conclusion ?? "(none)")) {
            continue;
        }
        if (!matchesList(filters.state, row.state)) {
            continue;
        }
        if (filters.label.length > 0 && !filters.label.some((label) => row.labels.includes(label))) {
            continue;
        }
        if (from !== null || to !== null) {
            const start = row.startedAt ?? row.queuedAt;
            if (start === null) {
                continue;
            }
            // A job that started and has not finished is treated as occupying
            // its runner up to the moment the rows were taken, which is what
            // the concurrency and heatmap charts draw. A job that never
            // started is a point event at its queue time, so that a backlog
            // is still selectable.
            const end = row.completedAt ?? (row.startedAt === null ? start : (openEnd ?? start));
            // Half-open on both sides, matching the buckets the selection was
            // made on, so a job cannot be selected and then drawn outside it.
            if (to !== null && start >= to) {
                continue;
            }
            // `[start, end)` overlaps the selection when it ends after it
            // begins. A point event has no extent to overlap with, so it is
            // placed by its instant instead.
            if (from !== null && (end > start ? end <= from : start < from)) {
                continue;
            }
        }
        out.push(row);
    }
    return out;
}

/** Nearest-rank percentile over a sorted sample. Null for an empty sample. */
function percentile(sorted, p) {
    if (sorted.length === 0) {
        return null;
    }
    const rank = Math.ceil((p / 100) * sorted.length);
    return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Distribution of the rows that actually carry the measure. A row with no value
 * is counted in `missing` rather than treated as a zero, which would drag every
 * percentile down: a job that never started has no duration, not a duration of
 * nothing.
 */
function describe(values, missing) {
    const sorted = values.slice().sort((left, right) => left - right);
    const total = sorted.reduce((sum, value) => sum + value, 0);
    return {
        count: sorted.length,
        missing,
        total,
        mean: sorted.length > 0 ? total / sorted.length : null,
        min: sorted.length > 0 ? sorted[0] : null,
        p50: percentile(sorted, 50),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted.length > 0 ? sorted.at(-1) : null,
    };
}

const WAIT_BUCKETS = [
    { label: "< 5s", lo: 0, hi: 5000 },
    { label: "5–15s", lo: 5000, hi: 15000 },
    { label: "15–30s", lo: 15000, hi: 30000 },
    { label: "30–60s", lo: 30000, hi: 60000 },
    { label: "1–2m", lo: 60000, hi: 120000 },
    { label: "2–5m", lo: 120000, hi: 300000 },
    { label: "5–15m", lo: 300000, hi: 900000 },
    { label: "15–60m", lo: 900000, hi: 3600000 },
    { label: "> 1h", lo: 3600000, hi: Infinity },
];

const DURATION_BUCKETS = [
    { label: "< 30s", lo: 0, hi: 30000 },
    { label: "30–60s", lo: 30000, hi: 60000 },
    { label: "1–2m", lo: 60000, hi: 120000 },
    { label: "2–5m", lo: 120000, hi: 300000 },
    { label: "5–10m", lo: 300000, hi: 600000 },
    { label: "10–20m", lo: 600000, hi: 1200000 },
    { label: "20–40m", lo: 1200000, hi: 2400000 },
    { label: "40–90m", lo: 2400000, hi: 5400000 },
    { label: "> 1.5h", lo: 5400000, hi: Infinity },
];

function histogram(values, buckets) {
    const counts = buckets.map((bucket) => ({ ...bucket, count: 0 }));
    for (const value of values) {
        for (const bucket of counts) {
            if (value >= bucket.lo && value < bucket.hi) {
                bucket.count += 1;
                break;
            }
        }
    }
    return counts;
}

function groupBy(rows, keyOf) {
    const groups = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (key === null || key === undefined || key === "") {
            continue;
        }
        const bucket = groups.get(key);
        if (bucket) {
            bucket.push(row);
        } else {
            groups.set(key, [row]);
        }
    }
    return groups;
}

function groupStats(key, rows, decorate) {
    const durations = [];
    const waits = [];
    let decided = 0;
    let failures = 0;
    let computeMs = 0;
    for (const row of rows) {
        if (row.durationMs !== null) {
            durations.push(row.durationMs);
            computeMs += row.durationMs;
        }
        if (row.waitMs !== null) {
            waits.push(row.waitMs);
        }
        if (row.decided) {
            decided += 1;
            if (row.failed) {
                failures += 1;
            }
        }
    }
    durations.sort((left, right) => left - right);
    waits.sort((left, right) => left - right);
    return {
        key,
        count: rows.length,
        decided,
        failures,
        failureRate: decided > 0 ? failures / decided : null,
        computeMs,
        p50DurationMs: percentile(durations, 50),
        p95DurationMs: percentile(durations, 95),
        p50WaitMs: percentile(waits, 50),
        p95WaitMs: percentile(waits, 95),
        ...(decorate ? decorate(rows[0], rows) : {}),
    };
}

function topGroups(rows, keyOf, decorate, limit, rank) {
    const entries = [...groupBy(rows, keyOf).entries()].map(([key, group]) => groupStats(key, group, decorate));
    const by = rank ?? ((entry) => entry.count);
    entries.sort((left, right) => by(right) - by(left) || right.count - left.count);
    return entries.slice(0, limit);
}

function countValues(rows, valuesOf) {
    const counts = new Map();
    for (const row of rows) {
        for (const value of valuesOf(row)) {
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || String(left.key).localeCompare(String(right.key)));
}

/**
 * The interval a job occupied its runner for, clipped to the window.
 *
 * A job that has not finished is closed at `openEndMs` - the instant the rows
 * were collected - because it was genuinely still running then. This differs
 * from the Runner activity tab, which drops unfinished jobs rather than
 * reconcile them with a concurrency report collected at another instant; the
 * explorer has no such report to reconcile with, and the panel labels the
 * difference.
 */
function occupancyOf(row, windowFrom, windowTo, openEndMs) {
    if (row.startedAt === null) {
        return null;
    }
    const end = row.completedAt ?? openEndMs;
    if (!Number.isFinite(end) || end <= row.startedAt) {
        return null;
    }
    return clipInterval(row.startedAt, end, windowFrom, windowTo);
}

/**
 * Per-runner busy time across the axis.
 *
 * Intervals are union-merged per runner before they are spread, so a runner
 * that ran two jobs at once is busy for the union of them and not for their
 * sum. Without that a cell reads as more than a whole bucket of busy time and
 * the heatmap draws a runner darker than "never idle".
 *
 * Jobs whose runner GitHub did not name are counted apart rather than merged
 * into one row: they did not all run on one machine, so their union would be
 * meaningless.
 */
export function buildHeatmap(rows, { windowFrom, windowTo, bucketMs, openEndMs, topRunners = 40 } = {}) {
    const buckets = bucketAxis({ fromMs: windowFrom, toMs: windowTo, bucketMs });
    const empty = {
        buckets,
        spans: [],
        runners: [],
        runnerCount: 0,
        unnamed: null,
        remainder: { cells: [], total: 0, runners: 0 },
    };
    if (buckets.length === 0) {
        return empty;
    }

    const byRunner = new Map();
    let unnamedJobs = 0;
    let unnamedJobMs = 0;
    for (const row of rows) {
        const interval = occupancyOf(row, windowFrom, windowTo, openEndMs);
        if (interval === null) {
            continue;
        }
        if (row.runnerName === "") {
            unnamedJobs += 1;
            unnamedJobMs += interval[1] - interval[0];
            continue;
        }
        let entry = byRunner.get(row.runnerKey);
        if (!entry) {
            entry = { runner: row.runnerKey, kind: row.kind, group: row.runnerGroup, jobs: 0, jobMs: 0, intervals: [] };
            byRunner.set(row.runnerKey, entry);
        }
        entry.jobs += 1;
        entry.jobMs += interval[1] - interval[0];
        entry.intervals.push(interval);
    }

    for (const entry of byRunner.values()) {
        entry.merged = mergeIntervals(entry.intervals);
        entry.busyMs = mergedTotal(entry.merged);
    }

    const ranked = [...byRunner.values()].sort(
        (left, right) => right.busyMs - left.busyMs || right.jobs - left.jobs || left.runner.localeCompare(right.runner),
    );
    const top = ranked.slice(0, Math.max(0, topRunners));

    const claimed = new Float64Array(buckets.length);
    const drawn = top.map((entry) => {
        const cells = occupancyByBucket(buckets, entry.merged);
        for (let index = 0; index < cells.length; index += 1) {
            claimed[index] += cells[index];
        }
        return {
            runner: entry.runner,
            kind: entry.kind,
            group: entry.group,
            jobs: entry.jobs,
            jobMs: entry.jobMs,
            busyMs: entry.busyMs,
            cells: Array.from(cells),
        };
    });

    // The remainder is the occupancy of the runners outside the drawn rows, so
    // it is summed from their own merged intervals rather than taken as a
    // difference from a fleet total: fleet job time and per-runner busy time
    // are different measures and subtracting one from the other is nonsense.
    const remainder = new Float64Array(buckets.length);
    let remainderTotal = 0;
    for (const entry of ranked.slice(top.length)) {
        occupancyByBucket(buckets, entry.merged, remainder);
        remainderTotal += entry.busyMs;
    }

    return {
        buckets,
        // How much of each bucket the collection actually covers. The axis is
        // epoch-aligned, so the first and last columns usually hang outside the
        // window; dividing their busy time by a full bucket would report a
        // runner that was busy for every observed minute as mostly idle.
        spans: buckets.map((bucket) => Math.max(0, Math.min(bucket.end, windowTo) - Math.max(bucket.start, windowFrom))),
        runners: drawn,
        runnerCount: ranked.length,
        unnamed: unnamedJobs > 0 ? { jobs: unnamedJobs, jobMs: unnamedJobMs } : null,
        remainder: {
            cells: Array.from(remainder),
            total: remainderTotal,
            runners: Math.max(0, ranked.length - drawn.length),
        },
        claimed: Array.from(claimed),
    };
}

/**
 * Every number the explorer renders.
 *
 * @param rows normalized rows, already filtered by the caller
 * @param options.windowFrom / options.windowTo the collection window, in ms.
 *        Authoritative: activity is clipped to it rather than widening it, so
 *        the charts never describe time the collection did not cover.
 * @param options.collectedAt when the rows were collected, used to close out
 *        the jobs that were still running
 * @param options.topLimit how many entries each top-N list keeps
 * @param options.topRunners how many runner rows the heatmap draws
 */
export function buildExploreAggregate(rows, options = {}) {
    const collectedAt = Number.isFinite(options.collectedAt) ? options.collectedAt : Date.now();
    const windowFrom = Number.isFinite(options.windowFrom) ? options.windowFrom : null;
    const windowTo = Number.isFinite(options.windowTo) ? options.windowTo : collectedAt;
    const topLimit = options.topLimit ?? 12;

    let dataFrom = Infinity;
    let dataTo = -Infinity;
    for (const row of rows) {
        const at = row.queuedAt ?? row.startedAt;
        if (at !== null) {
            if (at < dataFrom) {
                dataFrom = at;
            }
            if (at > dataTo) {
                dataTo = at;
            }
        }
        if (row.completedAt !== null && row.completedAt > dataTo) {
            dataTo = row.completedAt;
        }
    }
    const from = windowFrom ?? (Number.isFinite(dataFrom) ? dataFrom : collectedAt - 86400000);
    const to = Math.max(windowTo, from + 60000);
    const spanMs = to - from;
    const bucketMs = chooseBucketMs(spanMs, options.targetBuckets ?? 80);
    const buckets = bucketAxis({ fromMs: from, toMs: to, bucketMs });

    const totals = {
        jobs: rows.length,
        completed: 0,
        running: 0,
        queued: 0,
        other: 0,
        decided: 0,
        success: 0,
        failure: 0,
        neverStarted: 0,
        unfinished: 0,
    };
    const waits = [];
    const durations = [];
    let waitMissing = 0;
    let durationMissing = 0;
    let computeMs = 0;

    const repos = new Set();
    const workflows = new Set();
    const runners = new Set();
    const labels = new Set();
    const branches = new Set();

    const starts = [];
    const ends = [];

    // The stacked timeline is indexed by the bucket a job was queued into,
    // which is the question "how much work was asked for then".
    const series = buckets.map((bucket) => ({ t: bucket.start, total: 0, success: 0, failure: 0, other: 0 }));
    const axisStart = buckets[0]?.start ?? from;

    for (const row of rows) {
        switch (row.state) {
            case "completed":
                totals.completed += 1;
                break;
            case "running":
                totals.running += 1;
                break;
            case "queued":
                totals.queued += 1;
                break;
            default:
                totals.other += 1;
                break;
        }
        if (row.decided) {
            totals.decided += 1;
            if (row.succeeded) {
                totals.success += 1;
            } else {
                totals.failure += 1;
            }
        }
        if (row.startedAt === null) {
            totals.neverStarted += 1;
        } else if (row.completedAt === null) {
            totals.unfinished += 1;
        }

        if (row.waitMs === null) {
            waitMissing += 1;
        } else {
            waits.push(row.waitMs);
        }
        if (row.durationMs === null) {
            durationMissing += 1;
        } else {
            durations.push(row.durationMs);
            computeMs += row.durationMs;
        }

        if (row.repo) {
            repos.add(row.repo);
        }
        if (row.workflowKey) {
            workflows.add(row.workflowKey);
        }
        if (row.runnerName) {
            runners.add(row.runnerKey);
        }
        for (const label of row.labels) {
            labels.add(label);
        }
        if (row.branch) {
            branches.add(row.branch);
        }

        const at = row.queuedAt ?? row.startedAt;
        if (at !== null) {
            const index = Math.floor((at - axisStart) / bucketMs);
            const bucket = series[index];
            if (bucket) {
                bucket.total += 1;
                if (row.succeeded) {
                    bucket.success += 1;
                } else if (row.failed) {
                    bucket.failure += 1;
                } else {
                    bucket.other += 1;
                }
            }
        }

        const interval = occupancyOf(row, from, to, collectedAt);
        if (interval !== null) {
            starts.push(interval[0]);
            ends.push(interval[1]);
        }
    }

    const peaks = peakPerBucket(buckets, starts, ends);
    const sortedPeaks = peaks.slice().sort((left, right) => left - right);
    // Looped rather than spread: an axis of tens of thousands of buckets
    // overflows the argument list.
    let peakMax = 0;
    let peakSum = 0;
    for (const peak of peaks) {
        peakSum += peak;
        if (peak > peakMax) {
            peakMax = peak;
        }
    }

    return {
        generatedAt: collectedAt,
        window: { from, to, spanMs, bucketMs },
        totals,
        successRate: totals.decided > 0 ? totals.success / totals.decided : null,
        wait: describe(waits, waitMissing),
        duration: describe(durations, durationMissing),
        computeMs,
        distinct: {
            repos: repos.size,
            workflows: workflows.size,
            runners: runners.size,
            labels: labels.size,
            branches: branches.size,
        },
        timeline: { bucketMs, from: buckets[0]?.start ?? from, buckets: series },
        concurrency: {
            bucketMs,
            points: buckets.map((bucket, index) => ({ t: bucket.start, v: peaks[index] })),
            max: peakMax,
            p95: percentile(sortedPeaks, 95) ?? 0,
            mean: peaks.length > 0 ? peakSum / peaks.length : 0,
        },
        waitHistogram: histogram(waits, WAIT_BUCKETS),
        durationHistogram: histogram(durations, DURATION_BUCKETS),
        byConclusion: countValues(rows, (row) => [row.conclusion ?? "(none)"]),
        byKind: countValues(rows, (row) => [row.kind]),
        byEvent: countValues(rows, (row) => [row.event]).filter((entry) => entry.key !== ""),
        topWorkflows: topGroups(
            rows,
            (row) => row.workflowKey,
            (row) => ({ label: row.workflow || row.workflowPath, repo: row.repo, path: row.workflowPath }),
            topLimit,
        ),
        // Multi-valued: a job asking for three labels is counted under each, so
        // these counts deliberately exceed the job total.
        topLabels: (() => {
            const groups = new Map();
            for (const row of rows) {
                for (const label of row.labels) {
                    const bucket = groups.get(label);
                    if (bucket) {
                        bucket.push(row);
                    } else {
                        groups.set(label, [row]);
                    }
                }
            }
            return [...groups.entries()]
                .map(([label, group]) => groupStats(label, group, () => ({ label })))
                .sort((left, right) => right.count - left.count)
                .slice(0, topLimit);
        })(),
        topRunners: topGroups(
            rows,
            (row) => row.runnerKey,
            (row) => ({ label: row.runnerKey, group: row.runnerGroup, kind: row.kind }),
            topLimit,
            (entry) => entry.computeMs,
        ),
        topRepos: topGroups(rows, (row) => row.repo, (row) => ({ label: row.repo }), topLimit, (entry) => entry.computeMs),
        heatmap: buildHeatmap(rows, {
            windowFrom: from,
            windowTo: to,
            bucketMs,
            openEndMs: collectedAt,
            topRunners: options.topRunners ?? 40,
        }),
    };
}

/**
 * How each facet dimension reads a row: the values it contributes to that
 * dimension, and how those values are labelled for a reader.
 *
 * `values` is a list because a job carries several labels, so one row is
 * counted once under each of them.
 */
const FACET_DIMENSIONS = {
    repo: { values: (row) => [row.repo] },
    workflow: { values: (row) => [row.workflowKey], label: (row) => row.workflow || row.workflowPath },
    runner: { values: (row) => [row.runnerKey], label: (row) => (row.runnerName === "" ? UNIDENTIFIED : row.runnerName) },
    label: { values: (row) => row.labels },
    branch: { values: (row) => [row.branch] },
    event: { values: (row) => [row.event] },
    kind: { values: (row) => [row.kind] },
    conclusion: { values: (row) => [row.conclusion ?? "(none)"] },
    state: { values: (row) => [row.state] },
};

const FACET_KEYS = Object.keys(FACET_DIMENSIONS);

function sortFacet(counts) {
    return [...counts.values()].sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function tallyRow(counts, row, dimension) {
    for (const value of dimension.values(row)) {
        if (value === null || value === undefined || value === "") {
            continue;
        }
        const entry = counts.get(value);
        if (entry) {
            entry.count += 1;
        } else {
            counts.set(value, { value, label: dimension.label ? dimension.label(row, value) : value, count: 1 });
        }
    }
}

/**
 * The options each facet select offers, with the row count behind each.
 *
 * Counts every dimension against the rows that pass *every other* dimension,
 * so a facet keeps offering the alternatives the reader has not picked. The
 * naive version — counting the fully filtered rows — empties every picker as
 * soon as it is used: selecting one runner would drop every other runner from
 * the list, making a two-runner comparison impossible to express.
 *
 * `filters` may be omitted, in which case every option is counted over all the
 * rows given.
 */
export function buildExploreFacets(rows, input, options = {}) {
    const filters = input ? normalizeExploreFilters(input) : null;
    const counts = new Map(FACET_KEYS.map((key) => [key, new Map()]));

    if (!filters || !hasActiveExploreFilters(filters)) {
        for (const row of rows) {
            for (const key of FACET_KEYS) {
                tallyRow(counts.get(key), row, FACET_DIMENSIONS[key]);
            }
        }
        return Object.fromEntries(FACET_KEYS.map((key) => [key, sortFacet(counts.get(key))]));
    }

    // The dimensions that are actually narrowing anything. A dimension with no
    // selection excludes no row, so it can never be the reason a row is out and
    // does not need to be tested.
    const active = FACET_KEYS.filter((key) => (filters[key] ?? []).length > 0);
    // Everything that is not a facet — the free-text search and the time range —
    // applies to every count, because those have no picker to keep populated.
    const base = applyExploreFilters(
        rows,
        { ...emptyExploreFilters(), text: filters.text, from: filters.from, to: filters.to },
        options,
    );

    for (const row of base) {
        // A row that fails two or more dimensions is not one selection away
        // from being included, so it is counted nowhere. A row that fails
        // exactly one is counted in that dimension alone: it is what the
        // reader would gain by also picking its value there.
        let missed = null;
        let misses = 0;
        for (const key of active) {
            if (!rowMatchesFacet(row, key, filters[key])) {
                misses += 1;
                if (misses > 1) {
                    break;
                }
                missed = key;
            }
        }
        if (misses > 1) {
            continue;
        }
        if (misses === 1) {
            tallyRow(counts.get(missed), row, FACET_DIMENSIONS[missed]);
            continue;
        }
        for (const key of FACET_KEYS) {
            tallyRow(counts.get(key), row, FACET_DIMENSIONS[key]);
        }
    }

    return Object.fromEntries(FACET_KEYS.map((key) => [key, sortFacet(counts.get(key))]));
}

function rowMatchesFacet(row, key, selected) {
    if (key === "label") {
        return selected.some((label) => row.labels.includes(label));
    }
    const values = FACET_DIMENSIONS[key].values(row);
    return selected.includes(values[0]);
}

/** Sort comparators the job table offers, by column key. */
export const TABLE_SORTS = {
    queued: (row) => row.queuedAt ?? 0,
    repo: (row) => row.repo.toLowerCase(),
    workflow: (row) => row.workflow.toLowerCase(),
    job: (row) => row.jobName.toLowerCase(),
    conclusion: (row) => row.conclusion ?? "",
    wait: (row) => row.waitMs ?? -1,
    duration: (row) => row.durationMs ?? -1,
    runner: (row) => row.runnerKey.toLowerCase(),
};

export function sortRows(rows, key, direction) {
    const read = TABLE_SORTS[key] ?? TABLE_SORTS.queued;
    const sign = direction === "asc" ? 1 : -1;
    return rows.slice().sort((left, right) => {
        const a = read(left);
        const b = read(right);
        if (a === b) {
            return left.i - right.i;
        }
        return a < b ? -sign : sign;
    });
}

/**
 * A compact digest for the agent. The per-bucket series and the heatmap are
 * dropped: they are thousands of numbers that say nothing when read aloud.
 */
export function summarizeExplore(aggregate, context = {}) {
    const short = (entries, extra) =>
        (entries ?? []).slice(0, 5).map((entry) => ({
            name: entry.label ?? entry.key,
            jobs: entry.count,
            failureRate: entry.failureRate,
            ...(extra ? extra(entry) : {}),
        }));
    return {
        ...context,
        window: aggregate.window,
        totals: aggregate.totals,
        successRate: aggregate.successRate,
        wait: { p50: aggregate.wait.p50, p95: aggregate.wait.p95, missing: aggregate.wait.missing },
        duration: { p50: aggregate.duration.p50, p95: aggregate.duration.p95, missing: aggregate.duration.missing },
        computeMs: aggregate.computeMs,
        concurrency: { max: aggregate.concurrency.max, p95: aggregate.concurrency.p95 },
        distinct: aggregate.distinct,
        topWorkflows: short(aggregate.topWorkflows, (entry) => ({ p95DurationMs: entry.p95DurationMs })),
        topLabels: short(aggregate.topLabels, (entry) => ({ p95WaitMs: entry.p95WaitMs })),
        topRunners: short(aggregate.topRunners, (entry) => ({ computeMs: entry.computeMs })),
        busiestRunners: (aggregate.heatmap?.runners ?? []).slice(0, 5).map((runner) => ({
            name: runner.runner,
            busyMs: runner.busyMs,
            jobs: runner.jobs,
        })),
    };
}
