// Row normalization for `gh runner-kit metrics jobs --format ndjson`.
//
// Imported by the extension process (Node) and by the canvas renderer's worker
// (browser), so it must stay free of any Node-only import.

/** Go marshals a `time.Duration` as an integer number of nanoseconds. */
const NS_PER_MS = 1e6;

// Go marshals a zero `time.Time` as "0001-01-01T00:00:00Z". Anything that far
// in the past is a missing timestamp rather than a real one.
const MIN_REAL_TIME_MS = Date.UTC(1971, 0, 1);

// Joins the parts of a composite key. A unit separator cannot occur in a repo,
// a workflow path or a runner name, so a key cannot be forged by one.
export const FIELD_SEPARATOR = "\u241f";

/** Parse a GitHub or Go timestamp into epoch milliseconds, or null when absent. */
export function parseTime(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }
    const ms = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(ms) || ms < MIN_REAL_TIME_MS) {
        return null;
    }
    return ms;
}

function nsToMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, value / NS_PER_MS);
}

function text(value) {
    return typeof value === "string" ? value : "";
}

/**
 * GitHub identifiers are opaque, not quantities: a job id is already past 2^53
 * on some hosts, where `Number` would round two distinct jobs onto one value
 * and collapse them during de-duplication. They are carried as strings.
 */
function id(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    return Number.isFinite(value) ? String(value) : "";
}

/**
 * Lifecycle bucket for a job. GitHub reports `queued`, `waiting`, `requested`,
 * `pending`, `in_progress` and `completed`; anything else falls back to "other".
 */
export function jobState(status) {
    switch (text(status).toLowerCase()) {
        case "completed":
            return "completed";
        case "in_progress":
            return "running";
        case "queued":
        case "waiting":
        case "requested":
        case "pending":
            return "queued";
        default:
            return "other";
    }
}

// Conclusions that carry a real pass or fail verdict. Cancelled, skipped and
// neutral jobs are deliberately excluded so they neither inflate nor deflate
// the success rate: a cancelled job says nothing about whether the code works.
export const SUCCESS_CONCLUSIONS = new Set(["success"]);
export const FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

export function isDecided(conclusion) {
    return SUCCESS_CONCLUSIONS.has(conclusion) || FAILURE_CONCLUSIONS.has(conclusion);
}

/** The label a job with no runner name is grouped under. Matches the projection. */
export const UNIDENTIFIED = "(unidentified)";

/** Normalize one raw NDJSON row into the shape the explorer works with. */
export function normalizeRow(raw, index) {
    const queuedAt = parseTime(raw.QueuedAt);
    const startedAt = parseTime(raw.StartedAt);
    const completedAt = parseTime(raw.CompletedAt);

    // The CLI reports both the timestamps and the durations it derived from
    // them. The derived value is preferred because it is what the aggregate
    // reports used, and the subtraction is only a fallback.
    let waitMs = null;
    if (startedAt !== null) {
        waitMs = nsToMs(raw.Wait);
        if (waitMs === null && queuedAt !== null) {
            waitMs = Math.max(0, startedAt - queuedAt);
        }
    }

    let durationMs = null;
    if (completedAt !== null) {
        durationMs = nsToMs(raw.Duration);
        if (durationMs === null && startedAt !== null) {
            durationMs = Math.max(0, completedAt - startedAt);
        }
    }

    const repo = text(raw.Repo);
    const workflow = text(raw.Workflow);
    const workflowPath = text(raw.WorkflowPath);
    const jobName = text(raw.JobName);
    const branch = text(raw.Branch);
    const conclusionRaw = text(raw.Conclusion).toLowerCase();
    const conclusion = conclusionRaw === "" ? null : conclusionRaw;
    const runnerName = text(raw.RunnerName).trim();
    const kind = text(raw.Kind).toLowerCase() || "unknown";
    const labels = Array.isArray(raw.Labels) ? raw.Labels.filter((label) => typeof label === "string" && label !== "") : [];

    return {
        i: index,
        jobId: id(raw.JobID),
        runId: id(raw.RunID),
        runAttempt: Number(raw.RunAttempt) || 1,
        repo,
        workflow,
        workflowPath,
        // Workflow names are not unique across repositories, and a renamed
        // workflow keeps its path, so the group is repo plus path.
        workflowKey: `${repo}${FIELD_SEPARATOR}${workflowPath || workflow}`,
        jobName,
        event: text(raw.Event),
        branch,
        labels,
        labelSet: labels.length > 0 ? labels.join(", ") : "(none)",
        kind,
        runnerId: id(raw.RunnerID),
        runnerName,
        runnerGroup: text(raw.RunnerGroup),
        // Grouped on the name alone, which is what the server-side projection
        // does, so the two tabs rank the same machines. The kind is carried
        // alongside for display rather than folded into the key: one name
        // reported under two kinds is a reporting artefact, not two machines.
        runnerKey: runnerName === "" ? UNIDENTIFIED : runnerName,
        status: text(raw.Status).toLowerCase(),
        state: jobState(raw.Status),
        conclusion,
        decided: isDecided(conclusion),
        succeeded: SUCCESS_CONCLUSIONS.has(conclusion),
        failed: FAILURE_CONCLUSIONS.has(conclusion),
        queuedAt,
        startedAt,
        completedAt,
        waitMs,
        durationMs,
        search: `${repo} ${workflow} ${jobName} ${runnerName} ${labels.join(" ")} ${branch}`.toLowerCase(),
    };
}

/**
 * Normalize and de-duplicate rows. A job id identifies one attempt of one job,
 * so a row repeated across overlapping collection pages collapses to one entry.
 *
 * Rows are ordered by when the job was queued, falling back to when it started,
 * so that a job whose queue time GitHub did not report still lands somewhere
 * sensible rather than at the beginning of the window.
 */
export function normalizeRows(rawRows) {
    const byJobId = new Map();
    const withoutId = [];
    for (const raw of rawRows) {
        const jobId = id(raw?.JobID);
        if (jobId === "" || jobId === "0") {
            withoutId.push(raw);
            continue;
        }
        byJobId.set(jobId, raw);
    }
    const merged = [...byJobId.values(), ...withoutId];
    const order = (raw) => parseTime(raw.QueuedAt) ?? parseTime(raw.StartedAt) ?? 0;
    merged.sort((left, right) => order(left) - order(right));
    return merged.map((raw, index) => normalizeRow(raw, index));
}

/**
 * How each row was treated, so that a chart can say what it is not showing.
 * The projection on the Runner activity tab keeps the same counters, and the
 * two are asserted equal in the tests.
 */
export function countRowHealth(rows, { windowFrom, windowTo } = {}) {
    const health = {
        total: rows.length,
        neverStarted: 0,
        unfinished: 0,
        zeroDuration: 0,
        negativeDuration: 0,
        outside: 0,
        unidentified: 0,
    };
    for (const row of rows) {
        if (row.runnerName === "") {
            health.unidentified += 1;
        }
        if (row.startedAt === null) {
            health.neverStarted += 1;
            continue;
        }
        if (row.completedAt === null) {
            health.unfinished += 1;
            continue;
        }
        if (row.completedAt === row.startedAt) {
            health.zeroDuration += 1;
            continue;
        }
        if (row.completedAt < row.startedAt) {
            health.negativeDuration += 1;
            continue;
        }
        if (
            Number.isFinite(windowFrom) &&
            Number.isFinite(windowTo) &&
            (row.completedAt <= windowFrom || row.startedAt >= windowTo)
        ) {
            health.outside += 1;
        }
    }
    return health;
}
