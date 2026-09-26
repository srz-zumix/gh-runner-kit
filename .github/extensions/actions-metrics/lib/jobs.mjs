// Per-runner timeline, derived from `gh runner-kit metrics jobs`.
//
// The aggregate reports cannot answer "how busy was *this* runner over time":
// `metrics concurrency` is bucket-level and `metrics runner` is window-level.
// `metrics jobs` emits one row per job, which is enough to rebuild the same
// timeline for an arbitrary subset of the fleet - at the price of a row per
// job, hundreds of thousands of them for a busy organization.
//
// So this runs on demand rather than on every refresh, narrows the rows in the
// CLI with `--runner` and `--exclude-runner`, streams the answer as NDJSON
// instead of buffering it, and returns only the aggregate. The raw rows never
// leave this module.

import { spawn } from "node:child_process";
import { assertRateBudget, isRateLimitError, noteRateLimit } from "./gh.mjs";
import { jobRowsCommand, probeRunnerKit, runnerPattern, runnerPatternMatcher } from "./runnerkit.mjs";
// One definition of the interval arithmetic, shared with the browser-side
// explorer so the two tabs cannot report different concurrency for one window.
import { peakPerBucket } from "../shared/intervals.mjs";
import { parseTime } from "../shared/rows.mjs";

/**
 * Stop reading rather than aggregate an unbounded stream into memory. The
 * setting below may lower this but never raise it: every matched row is
 * retained as a start, an end and an owner, so the ceiling is a memory budget
 * and not a preference.
 *
 * The bounds are declared in shared/fields.mjs so the toolbar offers exactly
 * what the normalizer accepts.
 */
import {
    DEFAULT_JOB_KIND,
    DEFAULT_TOP_RUNNERS,
    JOB_KIND_KEYS,
    MAX_ROWS,
    MAX_TOP_RUNNERS,
    MIN_ROWS,
    MIN_TOP_RUNNERS,
} from "../shared/fields.mjs";

export { DEFAULT_JOB_KIND, DEFAULT_TOP_RUNNERS, JOB_KIND_KEYS, MAX_ROWS, MAX_TOP_RUNNERS, MIN_ROWS, MIN_TOP_RUNNERS };

/** Label for the jobs whose runner the API did not name. */
export const UNIDENTIFIED = "(unidentified)";

/** How many exclusion patterns one projection accepts, and how long each may be. */
const MAX_EXCLUSIONS = 32;
const MAX_PATTERN_LENGTH = 200;

/**
 * Compile the exclusion field into the patterns the CLI is given and the
 * matcher the fallback path uses.
 *
 * Both come from `runnerPattern`, the same normalization the Runner field
 * sends to `--runner`, so a bare word means "contains that word" in both
 * fields and a name carrying `[`, `]`, `?` or a backslash is matched
 * literally rather than as glob syntax. Matching is anchored and
 * case-sensitive because `--exclude-runner` is.
 *
 * A pattern able to match the empty string - in practice a bare `*` - also
 * drops the jobs whose runner the API did not name. That is what the CLI
 * does, and the dashboard must not quietly mean something else by `*`.
 */
export function compileExclusions(exclude) {
    const terms = String(exclude ?? "")
        .split(",")
        .map((term) => term.trim())
        .filter((term) => term !== "");
    if (terms.length > MAX_EXCLUSIONS) {
        throw new Error(`An exclusion takes at most ${MAX_EXCLUSIONS} patterns`);
    }
    const patterns = [];
    const expressions = [];
    for (const term of terms) {
        if (term.length > MAX_PATTERN_LENGTH) {
            throw new Error(`An exclusion pattern is at most ${MAX_PATTERN_LENGTH} characters`);
        }
        const pattern = runnerPattern(term);
        patterns.push(pattern);
        expressions.push(runnerPatternMatcher(pattern));
    }
    return {
        patterns,
        active: expressions.length > 0,
        test(name) {
            for (const expression of expressions) {
                if (expression.test(name)) {
                    return true;
                }
            }
            return false;
        },
    };
}

/**
 * A job timestamp, or null when the row does not carry one.
 *
 * Shared with the explorer rather than parsed here, because Go marshals a zero
 * `time.Time` as "0001-01-01T00:00:00Z" and `Date.parse` accepts it as a real
 * date in the year 1. Read that way a job that had not finished yet looks like
 * a job that finished two thousand years before it started, and is reported as
 * corrupt source data instead of as an ordinary running job.
 */
const toTime = parseTime;

/** Bucket edges arrive as RFC 3339 strings from the reports, epoch ms in tests. */
function bucketTime(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : Number.NaN;
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : Number.NaN;
}

/**
 * Index of the first bucket that can overlap `time`, that is the first one
 * whose end is strictly after it. Buckets are half-open `[start, end)`, so a
 * job ending exactly on a boundary belongs to the earlier bucket only.
 */
function firstBucket(buckets, time) {
    let low = 0;
    let high = buckets.length;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (buckets[mid].end <= time) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    return low;
}

/** Spread one interval over the buckets it covers, in place. */
function distribute(cells, buckets, from, to) {
    for (let index = firstBucket(buckets, from); index < buckets.length; index += 1) {
        const bucket = buckets[index];
        if (bucket.start >= to) {
            break;
        }
        const overlap = Math.min(to, bucket.end) - Math.max(from, bucket.start);
        if (overlap > 0) {
            cells[index] += overlap;
        }
    }
}


/**
 * Stream the NDJSON lines of one `gh` invocation into `onLine`.
 *
 * When `host` is given - null names the default host - the call is not started
 * while that host cools down from a rate limit or has no budget left, and a
 * rate limit refusal starts that cooldown, like the calls that go through
 * `gh.mjs`. One stream can cost thousands of requests, so the budget is checked
 * up front rather than discovered after the first refusal.
 */
export async function runLines(args, env, cwd, onLine, signal, { host } = {}) {
    const gated = host !== undefined;
    if (gated) {
        await assertRateBudget(host, { cwd });
    }
    try {
        return await streamLines(args, env, cwd, onLine, signal);
    } catch (error) {
        if (gated && isRateLimitError(error)) {
            throw await noteRateLimit(host, error, { cwd });
        }
        throw error;
    }
}

function streamLines(args, env, cwd, onLine, signal) {
    return new Promise((resolve, reject) => {
        // The signal can already be aborted here: an await between the caller
        // and this point (the rate budget check) lets the collection be
        // superseded before the listener below is registered, and an
        // already-fired abort never re-fires. Bail out before spawning so a
        // dead stream does not spend API budget.
        if (signal?.aborted) {
            reject(new Error("The runner timeline was superseded."));
            return;
        }
        const child = spawn("gh", args, {
            cwd,
            env: env ? { ...process.env, ...env } : process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let pending = "";
        let stopped = false;
        let aborted = false;

        const stop = () => {
            if (!stopped) {
                stopped = true;
                child.kill("SIGTERM");
            }
        };
        const onAbort = () => {
            aborted = true;
            stop();
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            // Keep only the tail: the CLI logs a progress line per repository.
            stderr = (stderr + chunk).slice(-8192);
        });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            if (stopped) {
                return;
            }
            pending += chunk;
            let cut = pending.indexOf("\n");
            while (cut >= 0) {
                const line = pending.slice(0, cut);
                pending = pending.slice(cut + 1);
                if (line.trim() && onLine(line) === false) {
                    stop();
                    return;
                }
                cut = pending.indexOf("\n");
            }
        });

        child.on("error", (error) => {
            signal?.removeEventListener?.("abort", onAbort);
            reject(error.code === "ENOENT" ? new Error("GitHub CLI (gh) was not found on PATH") : error);
        });
        child.on("close", (code) => {
            signal?.removeEventListener?.("abort", onAbort);
            if (aborted) {
                reject(new Error("The runner timeline was superseded."));
                return;
            }
            if (stopped) {
                // The row cap closed the stream, so a non-zero exit is expected.
                resolve({ truncated: true });
                return;
            }
            // A trailing row without its newline is still a row.
            if (pending.trim()) {
                onLine(pending);
            }
            if (code === 0) {
                resolve({ truncated: false });
                return;
            }
            const message = stderr.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Error:"));
            const error = new Error(message ? message.replace(/^Error:\s*/, "") : `gh runner-kit metrics jobs exited with ${code}`);
            // Kept so a rate limit is recognized even when the log tail, not
            // the "Error:" line, is what names it.
            error.stderr = stderr;
            reject(error);
        });
    });
}

/**
 * Which workflow the projection runs against. The field is a local override of
 * the dashboard filter, so an empty field inherits whatever the filter bar
 * carries and a literal `*` drops it for this projection only.
 */
export function resolveWorkflow(filters, override) {
    const inherited = filters?.workflow ?? "";
    const text = String(override ?? "").trim();
    if (text === "") {
        return { value: inherited, source: "inherit" };
    }
    if (text === "*") {
        return { value: "", source: "override" };
    }
    return { value: text, source: "override" };
}

/**
 * Rebuild the concurrency timeline from the job rows matching `query`.
 *
 * `buckets` are the intervals `gh runner-kit metrics concurrency` already
 * returned: reusing them rather than recomputing boundaries keeps the filtered
 * chart on the same axis as the unfiltered one.
 */
export async function collectRunnerTimeline({
    target,
    filters,
    limits,
    cwd,
    buckets,
    query,
    workflow,
    exclude = "",
    excludeInCli = false,
    kind = DEFAULT_JOB_KIND,
    topRunners = DEFAULT_TOP_RUNNERS,
    maxRows = MAX_ROWS,
    onProgress,
    signal,
} = {}) {
    // Clamped here as well as in the settings, because the ceiling is a memory
    // budget of this function and an agent action reaches it directly.
    const rowCap = Number.isFinite(maxRows) ? Math.min(Math.max(Math.floor(maxRows), MIN_ROWS), MAX_ROWS) : MAX_ROWS;
    const pattern = runnerPattern(query);
    const exclusions = compileExclusions(exclude);
    // Where the exclusion is applied, which decides both what the row counters
    // mean and what the panel is told about them. On the CLI path the rows are
    // dropped before the stream is written, so they are neither counted here
    // nor charged against the row cap; on the fallback path they arrive and are
    // dropped below, having already consumed their slot.
    const excludeMode = exclusions.active ? (excludeInCli ? "cli" : "local") : null;
    // The reports timestamp buckets as RFC 3339 strings; the projection works
    // in epoch milliseconds but hands the original labels back so the filtered
    // chart is drawn on exactly the same axis as the unfiltered one.
    const axis = (buckets ?? [])
        .map((bucket) => ({
            start: bucketTime(bucket.start),
            end: bucketTime(bucket.end),
            startLabel: bucket.start,
            endLabel: bucket.end,
        }))
        .filter((bucket) => Number.isFinite(bucket.start) && Number.isFinite(bucket.end) && bucket.end > bucket.start)
        .sort((left, right) => left.start - right.start);
    if (axis.length === 0) {
        throw new Error("the concurrency timeline has no bucket to project the jobs onto");
    }
    const windowStart = axis[0].start;
    const windowEnd = axis.at(-1).end;

    const workflowScope = resolveWorkflow(filters, workflow);
    const { args, env } = jobRowsCommand({
        target,
        filters: { ...filters, workflow: workflowScope.value },
        limits,
        pattern,
        exclusions: excludeMode === "cli" ? exclusions.patterns : [],
        kind,
        probe: await probeRunnerKit(cwd),
    });
    const started = Date.now();
    const busy = new Float64Array(axis.length);
    const counts = new Int32Array(axis.length);
    const runners = new Map();
    // Flat arrays rather than an array of pairs: one job row is one entry in
    // each, which keeps 400k intervals to three dense number arrays.
    const jobStarts = [];
    const jobEnds = [];
    const jobOwners = [];
    let rows = 0;
    let matched = 0;
    let excluded = 0;
    let unfinished = 0;
    let zeroDuration = 0;
    let negativeDuration = 0;
    let outside = 0;
    let malformed = 0;

    onProgress?.(pattern ? `Reading the jobs of ${pattern}` : "Reading every job in the window");

    const { truncated } = await runLines(args, env, cwd, (line) => {
        rows += 1;
        if (rows > rowCap) {
            return false;
        }
        let row;
        try {
            row = JSON.parse(line);
        } catch {
            malformed += 1;
            return true;
        }
        const name = String(row.RunnerName ?? "").trim();
        if (excludeMode === "local" && exclusions.test(name)) {
            // Dropped before every other counter, so an excluded runner reaches
            // neither the busy series, the peak sweep, the ranking nor the
            // remainder. It still consumed a row of the stream cap above: this
            // installed CLI has no `--exclude-runner`, so the rows were read to
            // get here.
            excluded += 1;
            return true;
        }
        const from = toTime(row.StartedAt);
        const to = toTime(row.CompletedAt);
        if (from === null || to === null) {
            // A job that never started, or had not finished when the window was
            // collected, occupies a runner for an interval the row cannot
            // describe. Charging it against `Date.now()` would not reconcile
            // with the concurrency report, which was collected at a different
            // instant, so it is reported separately instead.
            unfinished += 1;
            return true;
        }
        if (to === from) {
            // GitHub records these timestamps to the second, so a job shorter
            // than that reports the same instant twice. There is no interval to
            // spread and the time it stands for is below the chart resolution.
            zeroDuration += 1;
            return true;
        }
        if (to < from) {
            // Invalid source data: the API reported the job as finishing before
            // it started. The CLI reports these as zero-duration too, so they
            // are excluded rather than guessed at.
            negativeDuration += 1;
            return true;
        }
        const clippedStart = Math.max(from, windowStart);
        const clippedEnd = Math.min(to, windowEnd);
        if (clippedEnd <= clippedStart) {
            outside += 1;
            return true;
        }
        matched += 1;

        const key = name || UNIDENTIFIED;
        let runner = runners.get(key);
        if (!runner) {
            runner = { id: runners.size, runner: key, jobMs: 0, busyMs: 0, jobs: 0, unidentified: name === "" };
            runners.set(key, runner);
        }
        runner.jobs += 1;
        jobStarts.push(clippedStart);
        jobEnds.push(clippedEnd);
        jobOwners.push(runner.id);

        for (let index = firstBucket(axis, clippedStart); index < axis.length; index += 1) {
            const bucket = axis[index];
            if (bucket.start >= clippedEnd) {
                break;
            }
            const overlap = Math.min(clippedEnd, bucket.end) - Math.max(clippedStart, bucket.start);
            if (overlap > 0) {
                busy[index] += overlap;
                counts[index] += 1;
                runner.jobMs += overlap;
            }
        }
        if (matched % 20000 === 0) {
            onProgress?.(`Projected ${matched} jobs onto the timeline`);
        }
        return true;
    }, signal, { host: target?.host ?? null });

    const peaks = peakPerBucket(axis, jobStarts, jobEnds);
    // Union-merged occupancy for every runner, not just the ranked ones: the
    // table searches all of them, so all of them need a comparable busy time.
    // One shared pass over an index sorted by (owner, start) avoids both a
    // per-runner interval array and a per-runner bucket array, which is what
    // made this top-40 only.
    mergeRunnerBusy({ axis, runners, jobStarts, jobEnds, jobOwners, onProgress });
    const ranked = [...runners.values()].sort(
        (left, right) =>
            right.jobMs - left.jobMs || right.jobs - left.jobs || left.runner.localeCompare(right.runner),
    );
    const top = ranked.slice(0, Math.max(0, topRunners));
    const rowsByRunner = buildRunnerRows({ axis, top, jobStarts, jobEnds, jobOwners, onProgress });

    const remainder = new Float64Array(axis.length);
    for (let index = 0; index < axis.length; index += 1) {
        // Floating point can leave a few microseconds behind; the remainder is
        // a display value, so it is clamped rather than reported as negative.
        remainder[index] = Math.max(0, busy[index] - rowsByRunner.claimed[index]);
    }

    return {
        query: String(query ?? "").trim(),
        pattern,
        workflow: workflowScope,
        buckets: axis.map((bucket, index) => ({
            start: bucket.startLabel,
            end: bucket.endLabel,
            busyTimeMs: busy[index],
            jobs: counts[index],
            peak: peaks[index],
            // The inventory is not knowable per runner subset, so the chart
            // draws no capacity line and reports no utilization here.
            runners: 0,
            utilization: 0,
        })),
        runners: rowsByRunner.rows,
        runnerCount: ranked.length,
        remainder: {
            // Everything the returned rows do not account for, so the heatmap
            // can say how much activity it is not showing. It is not drawn as a
            // row: an intensity spread over an unknown number of runners would
            // mean nothing.
            busyTimeMs: Array.from(remainder),
            total: remainder.reduce((sum, value) => sum + value, 0),
            runners: Math.max(0, ranked.length - rowsByRunner.rows.length),
        },
        rows: Math.min(rows, rowCap),
        // The settings this projection actually ran with, so the panel can say
        // which jobs it looked at rather than leave the reader to infer it.
        kind,
        rowCap,
        topRunners,
        matched,
        // Unknown rather than zero when the CLI did the dropping: the excluded
        // rows were never written to the stream, so there is nothing to count.
        excluded: excludeMode === "cli" ? null : excluded,
        exclusions: exclusions.patterns,
        excludeMode,
        unfinished,
        zeroDuration,
        negativeDuration,
        outside,
        malformed,
        truncated,
        // Every job interval, summed: a runner that ran two jobs at once is
        // counted twice here, which is what the fleet-wide report counts and
        // what `Share` divides by. `runnerBusyTimeMs` is the union-merged
        // total, which answers "how long was a runner occupied" instead.
        busyTimeMs: busy.reduce((sum, value) => sum + value, 0),
        runnerBusyTimeMs: ranked.reduce((sum, runner) => sum + runner.busyMs, 0),
        // Every runner the window held, ranked. Kept out of the browser state
        // by the caller - at 18k names it is megabytes - and served a page at
        // a time instead, so the table can search all of them.
        all: ranked,
        computedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
    };
}

/** Overlap of one interval with the axis, without materialising the buckets. */
function distributedTotal(buckets, from, to) {
    let total = 0;
    for (let index = firstBucket(buckets, from); index < buckets.length; index += 1) {
        const bucket = buckets[index];
        if (bucket.start >= to) {
            break;
        }
        const overlap = Math.min(to, bucket.end) - Math.max(from, bucket.start);
        if (overlap > 0) {
            total += overlap;
        }
    }
    return total;
}

/**
 * Union-merged busy time of every runner, written onto the aggregates in place.
 *
 * Two jobs running at once on one runner occupy it once, so the intervals are
 * merged before they are measured. Doing it for all of them - a busy day names
 * tens of thousands - rules out the per-runner interval array and the
 * per-runner bucket array `buildRunnerRows` uses: instead one index is sorted
 * by (owner, start) and walked once, so the cost is one sort and one pass no
 * matter how the jobs are spread over the names.
 *
 * The overlap is measured against the axis rather than as a plain interval
 * length, so a bucket the axis does not cover is not counted, which is what
 * keeps this equal to the sum of the cells `buildRunnerRows` draws.
 */
function mergeRunnerBusy({ axis, runners, jobStarts, jobEnds, jobOwners, onProgress }) {
    if (jobOwners.length === 0) {
        return;
    }
    onProgress?.(`Merging the jobs of ${runners.size} runners`);
    const byId = new Array(runners.size);
    for (const runner of runners.values()) {
        byId[runner.id] = runner;
    }
    // Every job the API did not name shares one row, but they did not
    // necessarily share a machine, so merging their overlaps would claim
    // knowledge there is none of. They are summed instead, which is the same
    // answer as their job time and is the honest upper bound.
    const unmergeable = runners.get(UNIDENTIFIED)?.id ?? -1;

    const order = new Int32Array(jobOwners.length);
    for (let index = 0; index < order.length; index += 1) {
        order[index] = index;
    }
    order.sort((left, right) => jobOwners[left] - jobOwners[right] || jobStarts[left] - jobStarts[right]);

    let owner = -1;
    let openStart = 0;
    let openEnd = 0;
    let open = false;
    const close = () => {
        if (open) {
            byId[owner].busyMs += distributedTotal(axis, openStart, openEnd);
            open = false;
        }
    };
    for (let cursor = 0; cursor < order.length; cursor += 1) {
        const index = order[cursor];
        if (jobOwners[index] !== owner) {
            close();
            owner = jobOwners[index];
        }
        if (owner === unmergeable) {
            byId[owner].busyMs += distributedTotal(axis, jobStarts[index], jobEnds[index]);
            continue;
        }
        if (!open) {
            openStart = jobStarts[index];
            openEnd = jobEnds[index];
            open = true;
        } else if (jobStarts[index] <= openEnd) {
            openEnd = Math.max(openEnd, jobEnds[index]);
        } else {
            byId[owner].busyMs += distributedTotal(axis, openStart, openEnd);
            openStart = jobStarts[index];
            openEnd = jobEnds[index];
        }
    }
    close();
}

/**
 * Exact per-bucket busy time of the busiest runners.
 *
 * Deliberately a second pass over the intervals already in memory rather than a
 * matrix filled while streaming: which runners belong in the heatmap is only
 * known once every row has been read, and a cell kept for each of the 42k
 * ephemeral runners a busy day produces would cost far more than the 40 rows
 * that are actually drawn.
 *
 * The cells merge the jobs that overlap on the same runner, so a cell can be
 * read as "how much of this bucket the runner was working" and never exceeds
 * the bucket. Their total is `busyMs`, which `mergeRunnerBusy` already computed
 * for every runner, so it is read from the aggregate rather than recomputed
 * here: two answers to one question would be two answers to disagree over.
 * `jobMs` keeps the plain sum, which is what the fleet-wide report counts.
 */
function buildRunnerRows({ axis, top, jobStarts, jobEnds, jobOwners, onProgress }) {
    const claimed = new Float64Array(axis.length);
    if (top.length === 0) {
        return { rows: [], claimed };
    }
    onProgress?.(`Building the timeline of the ${top.length} busiest runners`);

    const slots = new Map(top.map((runner, slot) => [runner.id, slot]));
    const owned = top.map(() => []);
    for (let index = 0; index < jobOwners.length; index += 1) {
        const slot = slots.get(jobOwners[index]);
        if (slot !== undefined) {
            owned[slot].push(index);
        }
    }

    const rows = top.map((runner, slot) => {
        const union = new Float64Array(axis.length);
        const indices = owned[slot].sort((left, right) => jobStarts[left] - jobStarts[right]);
        // The unnamed row is many machines, so its jobs are not merged - see
        // mergeRunnerBusy - and its cells are summed to match its busyMs. A
        // cell can then exceed its bucket, which is true: the row is a total,
        // not one machine's occupancy.
        const merge = !runner.unidentified;
        let openStart = null;
        let openEnd = null;
        for (const index of indices) {
            distribute(claimed, axis, jobStarts[index], jobEnds[index]);
            if (!merge) {
                distribute(union, axis, jobStarts[index], jobEnds[index]);
                continue;
            }
            if (openStart === null) {
                openStart = jobStarts[index];
                openEnd = jobEnds[index];
            } else if (jobStarts[index] <= openEnd) {
                openEnd = Math.max(openEnd, jobEnds[index]);
            } else {
                distribute(union, axis, openStart, openEnd);
                openStart = jobStarts[index];
                openEnd = jobEnds[index];
            }
        }
        if (openStart !== null) {
            distribute(union, axis, openStart, openEnd);
        }

        const cells = [];
        let firstActive = -1;
        for (let index = 0; index < union.length; index += 1) {
            if (union[index] > 0) {
                cells.push([index, Math.round(union[index])]);
                if (firstActive < 0) {
                    firstActive = index;
                }
            }
        }
        return {
            runner: runner.runner,
            jobs: runner.jobs,
            jobMs: runner.jobMs,
            busyMs: runner.busyMs,
            unidentified: runner.unidentified,
            firstActive,
            cells,
        };
    });
    return { rows, claimed };
}

