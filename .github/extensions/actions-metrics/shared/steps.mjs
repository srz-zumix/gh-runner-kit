import { FIELD_SEPARATOR, FAILURE_CONCLUSIONS, isDecided, parseTime } from "./rows.mjs";

const NS_PER_MS = 1e6;
const INFRA_STEP_NAMES = new Set(["Set up job", "Complete job"]);

function text(value) {
    return typeof value === "string" ? value : "";
}

function id(value) {
    if (typeof value === "string") {
        return value.trim();
    }
    return Number.isFinite(value) ? String(value) : "";
}

function nsToMs(value) {
    return Number.isFinite(value) ? Math.max(0, value / NS_PER_MS) : null;
}

function finite(value, fallback = 0) {
    return Number.isFinite(value) ? value : fallback;
}

function keyOf(...parts) {
    return parts.map((part) => String(part ?? "")).join(FIELD_SEPARATOR);
}

export function stepKey(name, occurrence = 1) {
    return occurrence <= 1 ? String(name ?? "") : `${String(name ?? "")} #${occurrence}`;
}

// stepOccurrence recovers which occurrence of its name a step is. The CLI reports it
// as StepOccurrence; older CLIs only report the display key, which is unambiguous
// once read together with the step name.
function stepOccurrence(occurrence, name, key) {
    const reported = Number(occurrence);
    if (Number.isInteger(reported) && reported >= 1) {
        return reported;
    }
    const prefix = `${name} #`;
    if (key !== name && key.startsWith(prefix)) {
        const parsed = Number(key.slice(prefix.length));
        if (Number.isInteger(parsed) && parsed >= 2) {
            return parsed;
        }
    }
    return 1;
}

// stepIdOf identifies a step inside its job from its name, its display key and the
// occurrence the CLI reported, if any. A step literally named "Upload #2" shares its
// display key with the second "Upload", but not its id.
export function stepIdOf(name, key, occurrence) {
    const stepName = String(name ?? "");
    const displayKey = String(key ?? "") || stepName;
    return keyOf(stepName, stepOccurrence(occurrence, stepName, displayKey));
}

// workflowIdentity tells two workflow files that share a display name apart.
function workflowIdentity(row) {
    return row.workflowPath || row.workflow;
}

function maxOf(values) {
    let result = -Infinity;
    for (const value of values) {
        if (value > result) result = value;
    }
    return result;
}

function minOf(values) {
    let result = Infinity;
    for (const value of values) {
        if (value < result) result = value;
    }
    return result;
}

export function isInfrastructureStep(name) {
    const value = String(name ?? "");
    return INFRA_STEP_NAMES.has(value) || value.startsWith("Post ");
}

export function percentile(values, p) {
    if (!Array.isArray(values) || values.length === 0) {
        return 0;
    }
    const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
    if (sorted.length === 0) {
        return 0;
    }
    let rank = Math.ceil((p / 100) * sorted.length);
    rank = Math.min(sorted.length, Math.max(1, rank));
    return sorted[rank - 1];
}

export function mean(values) {
    const clean = values.filter((value) => Number.isFinite(value));
    return clean.length === 0 ? 0 : clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

export function coefficientOfVariation(values) {
    const avg = mean(values);
    if (!(avg > 0)) {
        return 0;
    }
    const clean = values.filter((value) => Number.isFinite(value));
    const variance = mean(clean.map((value) => (value - avg) ** 2));
    return Math.sqrt(variance) / avg;
}

function matrixBaseName(name) {
    const value = String(name ?? "");
    if (!value.endsWith(")")) {
        return null;
    }
    let depth = 0;
    for (let index = value.length - 1; index >= 0; index -= 1) {
        const char = value[index];
        if (char === ")") {
            depth += 1;
        } else if (char === "(") {
            depth -= 1;
            if (depth === 0) {
                if (index === 0 || value[index - 1] !== " ") {
                    return null;
                }
                const base = value.slice(0, index - 1);
                return base === "" ? null : base;
            }
        }
    }
    return null;
}

export function matrixMergeMap(jobGroups) {
    const members = new Map();
    for (const group of jobGroups) {
        const base = matrixBaseName(group.jobName);
        if (!base) {
            continue;
        }
        const workflow = group.workflowPath || group.workflow;
        const key = keyOf(group.repo, workflow, base);
        if (!members.has(key)) {
            members.set(key, { base, names: new Set(), repo: group.repo, workflow });
        }
        members.get(key).names.add(group.jobName);
    }
    const merged = new Map();
    for (const item of members.values()) {
        if (item.names.size < 2) {
            continue;
        }
        for (const name of item.names) {
            merged.set(keyOf(item.repo, item.workflow, name), item.base);
        }
    }
    return merged;
}

export function normalizeJobRow(raw = {}, index = 0) {
    const queuedAt = parseTime(raw.QueuedAt);
    const startedAt = parseTime(raw.StartedAt);
    const completedAt = parseTime(raw.CompletedAt);
    // The CLI reports a missing span as 0, so a duration or wait is only trusted when
    // both of its timestamps are known; otherwise a queued job would read as instant.
    const durationMs = startedAt !== null && completedAt !== null ? nsToMs(raw.Duration) ?? Math.max(0, completedAt - startedAt) : null;
    const waitMs = queuedAt !== null && startedAt !== null ? nsToMs(raw.Wait) ?? Math.max(0, startedAt - queuedAt) : null;
    const repo = text(raw.Repo);
    const workflow = text(raw.Workflow);
    const workflowPath = text(raw.WorkflowPath);
    const jobName = text(raw.JobName);
    const runId = id(raw.RunID);
    return {
        i: index,
        repo,
        runId,
        runAttempt: Number(raw.RunAttempt) || 1,
        jobId: id(raw.JobID),
        workflow,
        workflowPath,
        workflowKey: `${repo}${FIELD_SEPARATOR}${workflowPath || workflow}`,
        jobName,
        event: text(raw.Event),
        branch: text(raw.Branch),
        labels: Array.isArray(raw.Labels) ? raw.Labels.filter((label) => typeof label === "string") : [],
        kind: text(raw.Kind),
        runnerName: text(raw.RunnerName),
        runnerGroup: text(raw.RunnerGroup),
        status: text(raw.Status).toLowerCase(),
        conclusion: text(raw.Conclusion).toLowerCase() || null,
        failed: FAILURE_CONCLUSIONS.has(text(raw.Conclusion).toLowerCase()),
        queuedAt,
        startedAt,
        completedAt,
        waitMs,
        durationMs,
        runUrl: repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null,
    };
}

export function normalizeStepRow(raw = {}, index = 0) {
    const startedAt = parseTime(raw.StartedAt);
    const completedAt = parseTime(raw.CompletedAt);
    const jobStartedAt = parseTime(raw.JobStartedAt);
    const jobCompletedAt = parseTime(raw.JobCompletedAt);
    const jobQueuedAt = parseTime(raw.JobQueuedAt);
    const runStartedAt = parseTime(raw.RunStartedAt);
    const durationMs = nsToMs(raw.Duration) ?? (startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : 0);
    const offsetMs = nsToMs(raw.Offset) ?? (jobStartedAt !== null && startedAt !== null ? Math.max(0, startedAt - jobStartedAt) : 0);
    const repo = text(raw.Repo);
    const workflow = text(raw.Workflow);
    const workflowPath = text(raw.WorkflowPath);
    const jobName = text(raw.JobName);
    const stepName = text(raw.StepName);
    const displayKey = text(raw.StepKey) || stepKey(stepName, 1);
    const occurrence = stepOccurrence(raw.StepOccurrence, stepName, displayKey);
    const runId = id(raw.RunID);
    return {
        i: index,
        repo,
        runId,
        runAttempt: Number(raw.RunAttempt) || 1,
        runStartedAt,
        jobId: id(raw.JobID),
        workflow,
        workflowPath,
        workflowKey: `${repo}${FIELD_SEPARATOR}${workflowPath || workflow}`,
        jobName,
        event: text(raw.Event),
        branch: text(raw.Branch),
        labels: Array.isArray(raw.Labels) ? raw.Labels.filter((label) => typeof label === "string") : [],
        kind: text(raw.Kind),
        runnerName: text(raw.RunnerName),
        runnerGroup: text(raw.RunnerGroup),
        jobConclusion: text(raw.JobConclusion).toLowerCase() || null,
        jobQueuedAt,
        jobStartedAt,
        jobCompletedAt,
        jobDurationMs: jobStartedAt !== null && jobCompletedAt !== null ? Math.max(0, jobCompletedAt - jobStartedAt) : null,
        stepNumber: Number(raw.StepNumber) || 0,
        stepName,
        stepKey: displayKey,
        stepOccurrence: occurrence,
        stepId: keyOf(stepName, occurrence),
        stepStatus: text(raw.StepStatus).toLowerCase(),
        stepConclusion: text(raw.StepConclusion).toLowerCase() || null,
        startedAt,
        completedAt,
        durationMs,
        offsetMs,
        runUrl: repo && runId ? `https://github.com/${repo}/actions/runs/${runId}` : null,
    };
}

function groupJobName(row, mergeMap, mergeMatrix) {
    if (!mergeMatrix) {
        return row.jobName;
    }
    return mergeMap.get(keyOf(row.repo, workflowIdentity(row), row.jobName)) ?? row.jobName;
}

function summarizeSamples(values) {
    const clean = values.filter((value) => Number.isFinite(value));
    return {
        p25: percentile(clean, 25),
        p50: percentile(clean, 50),
        p75: percentile(clean, 75),
        p90: percentile(clean, 90),
        p95: percentile(clean, 95),
        max: clean.length ? maxOf(clean) : 0,
        mean: mean(clean),
        cv: coefficientOfVariation(clean),
    };
}

function dailyKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

export function downsampleNewest(points, limit = 2000) {
    const ordered = [...(points ?? [])].sort((left, right) => finite(right.t) - finite(left.t));
    return ordered.slice(0, Math.max(0, limit)).sort((left, right) => finite(left.t) - finite(right.t));
}

function buildTrend(samples) {
    const byTime = samples.filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.durationMs)).sort((a, b) => a.t - b.t);
    const middle = Math.floor(byTime.length / 2);
    const first = byTime.slice(0, middle).map((sample) => sample.durationMs);
    const second = byTime.slice(middle).map((sample) => sample.durationMs);
    const firstP50 = percentile(first, 50);
    const secondP50 = percentile(second, 50);
    const daily = new Map();
    for (const sample of byTime) {
        const day = dailyKey(sample.t);
        if (!daily.has(day)) {
            daily.set(day, []);
        }
        daily.get(day).push(sample.durationMs);
    }
    return {
        firstP50Ms: firstP50,
        secondP50Ms: secondP50,
        deltaP50Ms: second.length && first.length ? secondP50 - firstP50 : 0,
        daily: [...daily.entries()].map(([date, values]) => ({ date, p50Ms: percentile(values, 50), p90Ms: percentile(values, 90), samples: values.length })),
        points: downsampleNewest(byTime.map((sample) => ({ t: sample.t, durationMs: sample.durationMs, runId: sample.runId, jobId: sample.jobId }))),
    };
}

const RUNNER_KINDS = new Set(["all", "self-hosted", "github-hosted"]);

function quoteLabel(label) {
    return label === "" || /[,"\r\n]/.test(label) ? `"${label.replaceAll('"', '""')}"` : label;
}

// formatLabelSet mirrors the CLI's compact runs-on rendering, quoting labels that
// contain a separator so two distinct sets never render the same.
export function formatLabelSet(labels) {
    return (labels ?? []).map((label) => quoteLabel(String(label))).join(",");
}

// labelSetKey identifies a runs-on set regardless of label order and case, so
// ["Linux", "self-hosted"] and ["self-hosted", "linux"] land in the same pool.
export function labelSetKey(labels) {
    return formatLabelSet([...new Set((labels ?? []).map((label) => String(label).toLowerCase()))].sort());
}

// matchWildcard follows the CLI's MatchWildcard: * stands for any sequence of
// characters, including a slash, and the rest of the pattern matches literally.
export function matchWildcard(pattern, name) {
    const escaped = String(pattern).split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${escaped.join(".*")}$`, "s").test(String(name ?? ""));
}

// normalizeRunnerFilter fills the defaults of a runner filter so it can be stored,
// compared and echoed back unchanged.
export function normalizeRunnerFilter(filter = {}) {
    const kind = String(filter?.kind ?? "all").trim().toLowerCase();
    return {
        kind: RUNNER_KINDS.has(kind) ? kind : "all",
        labels: String(filter?.labels ?? "").trim(),
        group: String(filter?.group ?? "").trim(),
        name: String(filter?.name ?? "").trim(),
    };
}

export function isRunnerFilterActive(filter) {
    const value = normalizeRunnerFilter(filter);
    return value.kind !== "all" || Boolean(value.labels || value.group || value.name);
}

// effectiveStepSettings lays the settings of a step request still in flight over the
// ones the panel last received, so a render before the response keeps showing what
// the user picked. A request made for another dashboard target is ignored.
export function effectiveStepSettings(settings, pending, identity) {
    const base = settings ?? {};
    if (!pending || pending.identity !== identity) return base;
    return { ...base, ...pending.settings };
}

// matchRunner applies a runner filter to a job or step row. The kind semantics follow
// the CLI's --kind: self-hosted keeps every job that did not run on a hosted runner.
export function matchRunner(row, filter) {
    const value = normalizeRunnerFilter(filter);
    if (value.kind === "self-hosted" && row.kind === "hosted") return false;
    if (value.kind === "github-hosted" && row.kind !== "hosted") return false;
    if (value.labels && labelSetKey(row.labels) !== labelSetKey(splitLabelSet(value.labels))) return false;
    if (value.group && row.runnerGroup !== value.group) return false;
    if (value.name && !matchWildcard(value.name, row.runnerName)) return false;
    return true;
}

// splitLabelSet parses a label set rendered by formatLabelSet back into labels.
export function splitLabelSet(text) {
    const labels = [];
    let current = "";
    let quoted = false;
    const value = String(text ?? "");
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (quoted) {
            if (char === '"' && value[index + 1] === '"') {
                current += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                current += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ",") {
            labels.push(current.trim());
            current = "";
        } else {
            current += char;
        }
    }
    if (current.trim() !== "" || labels.length > 0) labels.push(current.trim());
    return labels;
}

function countInto(map, key) {
    if (key === "" || key === null || key === undefined) return;
    map.set(key, (map.get(key) ?? 0) + 1);
}

function countedList(map) {
    return [...map.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
}

export function normalizeJobStatus(value) {
    return String(value ?? "").trim().toLowerCase();
}

export function matchJobStatus(row, value) {
    const status = normalizeJobStatus(value);
    return !status || normalizeJobStatus(row.status) === status || normalizeJobStatus(row.conclusion) === status;
}

export function filterTimelineJobs(timeline, jobStatus = "") {
    return (timeline?.Jobs ?? []).filter((job) => matchJobStatus({ status: job.Status, conclusion: job.Conclusion }, jobStatus));
}

function jobStatusFacets(rows) {
    const counts = new Map();
    for (const row of rows) {
        for (const value of new Set([row.status, row.conclusion])) countInto(counts, value);
    }
    return countedList(counts);
}

function jobRowKey(row) {
    return keyOf(row.repo, workflowIdentity(row), row.runId, row.runAttempt, row.jobId || row.jobName);
}

// runnerPools groups jobs by their runs-on set. Wait and duration percentiles only use
// jobs that recorded the timestamps they need, so queued or skipped jobs do not pull
// the medians toward zero.
function runnerPools(rows) {
    const pools = new Map();
    for (const row of rows) {
        const key = labelSetKey(row.labels);
        if (!pools.has(key)) {
            pools.set(key, { key, labels: formatLabelSet(row.labels), kinds: new Map(), groups: new Map(), names: new Map(), jobs: 0, decided: 0, failed: 0, waits: [], durations: [] });
        }
        const pool = pools.get(key);
        pool.jobs += 1;
        if (isDecided(row.conclusion)) pool.decided += 1;
        if (row.failed) pool.failed += 1;
        countInto(pool.kinds, row.kind);
        countInto(pool.groups, row.runnerGroup);
        countInto(pool.names, row.runnerName);
        if (row.startedAt !== null && Number.isFinite(row.waitMs)) pool.waits.push(row.waitMs);
        if (row.startedAt !== null && row.completedAt !== null && Number.isFinite(row.durationMs)) pool.durations.push(row.durationMs);
    }
    return [...pools.values()].map((pool) => ({
        key: pool.key,
        labels: pool.labels,
        kinds: countedList(pool.kinds),
        groups: countedList(pool.groups),
        runners: countedList(pool.names),
        jobs: pool.jobs,
        wait: { p50: percentile(pool.waits, 50), p90: percentile(pool.waits, 90), samples: pool.waits.length },
        duration: { p50: percentile(pool.durations, 50), p90: percentile(pool.durations, 90), samples: pool.durations.length },
        failureRate: pool.decided > 0 ? pool.failed / pool.decided : 0,
    })).sort((a, b) => b.jobs - a.jobs || a.labels.localeCompare(b.labels));
}

function runnerFacets(rows) {
    const kinds = new Map();
    const labelSets = new Map();
    const groups = new Map();
    const names = new Map();
    for (const row of rows) {
        countInto(kinds, row.kind);
        const key = labelSetKey(row.labels);
        if (!labelSets.has(key)) labelSets.set(key, { value: formatLabelSet(row.labels), count: 0 });
        labelSets.get(key).count += 1;
        countInto(groups, row.runnerGroup);
        countInto(names, row.runnerName);
    }
    return {
        kinds: countedList(kinds),
        labelSets: [...labelSets.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
        groups: countedList(groups),
        names: countedList(names),
    };
}

// The run list reports one conclusion per run whatever order its jobs arrive in: any
// failure wins, then cancellation, and an unfinished job (null) outranks a success so
// a run that is still going never reads as successful. Unknown values rank last.
const RUN_CONCLUSION_RANK = ["failure", "timed_out", "startup_failure", "cancelled", "action_required", "stale", null, "success", "neutral", "skipped"];

function conclusionRank(conclusion) {
    const rank = RUN_CONCLUSION_RANK.indexOf(conclusion ?? null);
    return rank === -1 ? RUN_CONCLUSION_RANK.length : rank;
}

function outranksConclusion(candidate, current) {
    const left = conclusionRank(candidate);
    const right = conclusionRank(current);
    if (left !== right) return left < right;
    return left === RUN_CONCLUSION_RANK.length && String(candidate) < String(current);
}

export function aggregateSteps({ jobs = [], steps = [], mergeMatrix = true, showInfra = true, selectedJob = "", stepPattern = "", limit = 0, runner = {}, jobStatus = "", includeAllAttempts = false } = {}) {
    const runnerFilter = normalizeRunnerFilter(runner);
    const statusFilter = normalizeJobStatus(jobStatus);
    const allJobRows = jobs.map(normalizeJobRow).filter((row) => row.jobName);
    const allStepRows = steps.map(normalizeStepRow).filter((row) => row.stepKey && row.jobName);
    // The matrix merge map and the runner facets come from every row, so narrowing
    // filters neither renames jobs nor hides the choices needed to widen them again.
    const mergeMap = matrixMergeMap(allJobRows.map((row) => ({ repo: row.repo, workflow: row.workflow, workflowPath: row.workflowPath, jobName: row.jobName })));
    const facets = runnerFacets(allJobRows);
    const statusRows = allJobRows.filter((row) => matchJobStatus(row, statusFilter));
    const matchingJobs = new Set(statusRows.map(jobRowKey));
    const poolRows = statusRows.filter((row) => !selectedJob || groupJobName(row, mergeMap, mergeMatrix) === selectedJob);
    const jobRows = statusRows.filter((row) => matchRunner(row, runnerFilter));
    // Step outcomes need not match their job's outcome: a failed job can contain
    // successful or skipped steps. Match the job listing, not JobConclusion.
    const stepRows = allStepRows.filter((row) => matchRunner(row, runnerFilter) && (!statusFilter || matchingJobs.has(jobRowKey(row))));
    const runIds = new Set([...jobRows, ...stepRows].map((row) => row.runId).filter(Boolean));
    // The run budget caps every repository on its own and applies before the runner
    // filter, so whether it was reached is read from the unfiltered rows per repository.
    const collectedRuns = new Map();
    for (const row of [...allJobRows, ...allStepRows]) {
        if (!row.runId) continue;
        if (!collectedRuns.has(row.repo)) collectedRuns.set(row.repo, new Set());
        collectedRuns.get(row.repo).add(row.runId);
    }
    let maxRunsPerRepo = 0;
    for (const runs of collectedRuns.values()) maxRunsPerRepo = Math.max(maxRunsPerRepo, runs.size);
    const allTimes = [...jobRows.flatMap((row) => [row.queuedAt, row.startedAt, row.completedAt]), ...stepRows.flatMap((row) => [row.runStartedAt, row.startedAt, row.completedAt])]
        .filter((value) => Number.isFinite(value));
    // PRESENCE only counts the jobs that ran at least one step, matching the CLI;
    // skipped and unfinished jobs stay in jobStats through jobRuns.
    const executedJobIds = new Set(stepRows.map((row) => row.jobId).filter(Boolean));
    const jobCounts = new Map();
    const jobRuns = new Map();
    const variants = new Map();
    const jobDurations = new Map();
    const jobWaits = new Map();
    const jobFailures = new Map();
    const runList = new Map();
    const workflowNames = new Map();
    for (const row of jobRows) {
        const jobName = groupJobName(row, mergeMap, mergeMatrix);
        const key = keyOf(row.repo, workflowIdentity(row), jobName);
        if (!workflowNames.has(key)) workflowNames.set(key, { repo: row.repo, workflow: row.workflow, workflowPath: row.workflowPath, job: jobName });
        jobRuns.set(key, (jobRuns.get(key) ?? 0) + 1);
        if (executedJobIds.has(row.jobId)) {
            jobCounts.set(key, (jobCounts.get(key) ?? 0) + 1);
            if (!variants.has(key)) {
                variants.set(key, new Set());
            }
            variants.get(key).add(row.jobName);
        }
        if (!jobDurations.has(key)) jobDurations.set(key, []);
        if (!jobWaits.has(key)) jobWaits.set(key, []);
        if (!jobFailures.has(key)) jobFailures.set(key, { failed: 0, total: 0 });
        if (Number.isFinite(row.durationMs)) jobDurations.get(key).push(row.durationMs);
        if (Number.isFinite(row.waitMs)) jobWaits.get(key).push(row.waitMs);
        // Like the dashboard's other failure rates, only finished jobs with a success or
        // failure conclusion count, so cancelled, skipped and running jobs do not dilute it.
        const failures = jobFailures.get(key);
        if (isDecided(row.conclusion)) failures.total += 1;
        if (row.failed) failures.failed += 1;
        // Latest mode collapses carried-over jobs into one run row. All-attempt mode
        // keeps each attempt's jobs and outcome together so an earlier timeout stays
        // selectable even when a later attempt succeeded.
        const runKey = keyOf(row.repo, workflowIdentity(row), selectedJob ? jobName : "", row.runId, includeAllAttempts ? row.runAttempt : "");
        const current = runList.get(runKey) ?? { repo: row.repo, workflow: row.workflow, job: jobName, runId: row.runId, runAttempt: row.runAttempt, branch: row.branch, conclusion: row.conclusion, durationMs: 0, url: row.runUrl, jobs: 0, runners: [], labelSets: [] };
        if (row.runnerName && !current.runners.includes(row.runnerName)) current.runners.push(row.runnerName);
        const labels = formatLabelSet(row.labels);
        if (row.labels.length && !current.labelSets.some((value) => labelSetKey(splitLabelSet(value)) === labelSetKey(row.labels))) current.labelSets.push(labels);
        current.runAttempt = Math.max(current.runAttempt, row.runAttempt);
        current.durationMs += row.durationMs ?? 0;
        current.jobs += 1;
        if (outranksConclusion(row.conclusion, current.conclusion)) current.conclusion = row.conclusion;
        runList.set(runKey, current);
    }

    const accs = new Map();
    const jobTimeline = new Map();
    for (const row of stepRows) {
        if (!showInfra && isInfrastructureStep(row.stepName)) {
            continue;
        }
        const jobName = groupJobName(row, mergeMap, mergeMatrix);
        if (selectedJob && selectedJob !== jobName) {
            continue;
        }
        const jobKey = keyOf(row.repo, workflowIdentity(row), jobName);
        if (!jobTimeline.has(jobKey)) {
            jobTimeline.set(jobKey, { repo: row.repo, workflow: row.workflow, workflowPath: row.workflowPath, job: jobName, jobIds: new Set(), queuedOffsets: [], startOffsets: [], endOffsets: [], steps: new Map() });
        }
        const timeline = jobTimeline.get(jobKey);
        // Every step row repeats its job's timestamps, so they are sampled once per job
        // rather than weighting each job by how many steps it ran.
        const jobIdentity = row.jobId || keyOf(row.runId, row.runAttempt, row.jobName);
        if (Number.isFinite(row.runStartedAt) && !timeline.jobIds.has(jobIdentity)) {
            timeline.jobIds.add(jobIdentity);
            if (Number.isFinite(row.jobQueuedAt)) timeline.queuedOffsets.push(Math.max(0, row.jobQueuedAt - row.runStartedAt));
            if (Number.isFinite(row.jobStartedAt)) timeline.startOffsets.push(Math.max(0, row.jobStartedAt - row.runStartedAt));
            if (Number.isFinite(row.jobCompletedAt)) timeline.endOffsets.push(Math.max(0, row.jobCompletedAt - row.runStartedAt));
        }
        // The step filter only narrows the step statistics, after every row has fed the
        // presence denominators and the job timing above.
        if (stepPattern && !matchWildcard(stepPattern, row.stepName)) {
            continue;
        }

        const key = keyOf(jobKey, row.stepId);
        if (!accs.has(key)) {
            accs.set(key, {
                id: key,
                repo: row.repo,
                workflow: row.workflow,
                workflowPath: row.workflowPath,
                job: jobName,
                variants: [...(variants.get(jobKey) ?? new Set([row.jobName]))].sort(),
                stepKey: row.stepKey,
                stepName: row.stepName,
                stepOccurrence: row.stepOccurrence,
                stepId: row.stepId,
                jobs: jobCounts.get(jobKey) ?? 0,
                executed: 0,
                skipped: 0,
                failed: 0,
                samples: [],
                offsets: [],
                shares: [],
                byRunner: new Map(),
            });
        }
        const acc = accs.get(key);
        if (row.stepConclusion === "skipped") {
            acc.skipped += 1;
            continue;
        }
        if (row.startedAt !== null) {
            acc.executed += 1;
            if (FAILURE_CONCLUSIONS.has(row.stepConclusion)) {
                acc.failed += 1;
            }
        }
        if (row.startedAt !== null && row.completedAt !== null) {
            acc.samples.push({ t: row.startedAt, durationMs: row.durationMs, runId: row.runId, jobId: row.jobId });
            const poolKey = labelSetKey(row.labels);
            if (!acc.byRunner.has(poolKey)) acc.byRunner.set(poolKey, { labels: formatLabelSet(row.labels), durations: [] });
            acc.byRunner.get(poolKey).durations.push(row.durationMs);
            acc.offsets.push(row.offsetMs);
            if (row.jobDurationMs > 0) {
                acc.shares.push(Math.min(1, row.durationMs / row.jobDurationMs));
            }
            if (!timeline.steps.has(row.stepId)) {
                timeline.steps.set(row.stepId, { key: row.stepKey, id: row.stepId, name: row.stepName, offsets: [], durations: [], conclusions: [] });
            }
            const step = timeline.steps.get(row.stepId);
            step.offsets.push(row.offsetMs);
            step.durations.push(row.durationMs);
            step.conclusions.push(row.stepConclusion || "");
        }
    }

    let stepStats = [...accs.values()].map((acc) => {
        const durations = acc.samples.map((sample) => sample.durationMs);
        const summary = summarizeSamples(durations);
        const jobs = Math.max(acc.jobs, acc.executed + acc.skipped);
        const trend = buildTrend(acc.samples);
        return {
            id: acc.id,
            repo: acc.repo,
            workflow: acc.workflow,
            workflowPath: acc.workflowPath,
            job: acc.job,
            variants: acc.variants,
            variantCount: acc.variants.length,
            stepKey: acc.stepKey,
            stepName: acc.stepName,
            stepOccurrence: acc.stepOccurrence,
            stepId: acc.stepId,
            infrastructure: isInfrastructureStep(acc.stepName),
            jobs,
            executed: acc.executed,
            skipped: acc.skipped,
            failed: acc.failed,
            samples: durations.length,
            presence: jobs > 0 ? acc.executed / jobs : 0,
            skipRate: jobs > 0 ? acc.skipped / jobs : 0,
            failureRate: acc.executed > 0 ? acc.failed / acc.executed : 0,
            duration: summary,
            share: percentile(acc.shares, 50),
            offsetMs: percentile(acc.offsets, 50),
            byRunner: [...acc.byRunner.values()].map((pool) => ({ labels: pool.labels, samples: pool.durations.length, p50: percentile(pool.durations, 50), p90: percentile(pool.durations, 90) }))
                .sort((a, b) => b.samples - a.samples || a.labels.localeCompare(b.labels)),
            trend,
        };
    });

    stepStats.sort((a, b) => a.repo.localeCompare(b.repo) || a.workflow.localeCompare(b.workflow) || a.workflowPath.localeCompare(b.workflowPath) || a.job.localeCompare(b.job) || a.offsetMs - b.offsetMs || a.stepKey.localeCompare(b.stepKey) || a.stepId.localeCompare(b.stepId));
    const totalSteps = stepStats.length;
    if (limit > 0) {
        stepStats = stepStats.slice(0, limit);
    }

    const jobStats = [...jobRuns.entries()].map(([key, count]) => {
        const { repo, workflow, workflowPath, job } = workflowNames.get(key);
        const failures = jobFailures.get(key) ?? { failed: 0, total: 0 };
        return {
            repo,
            workflow,
            workflowPath,
            job,
            variants: [...(variants.get(key) ?? new Set([job]))].sort(),
            runs: count,
            wait: { p50: percentile(jobWaits.get(key) ?? [], 50), p90: percentile(jobWaits.get(key) ?? [], 90) },
            duration: { p50: percentile(jobDurations.get(key) ?? [], 50), p90: percentile(jobDurations.get(key) ?? [], 90) },
            failureRate: failures.total > 0 ? failures.failed / failures.total : 0,
        };
    }).sort((a, b) => a.repo.localeCompare(b.repo) || a.workflow.localeCompare(b.workflow) || a.job.localeCompare(b.job));

    const typicalTimeline = [...jobTimeline.entries()].map(([jobKey, job]) => ({
        repo: job.repo,
        workflow: job.workflow,
        workflowPath: job.workflowPath,
        job: job.job,
        queuedOffsetMs: percentile(job.queuedOffsets, 50),
        startOffsetMs: percentile(job.startOffsets, 50),
        endOffsetMs: percentile(job.endOffsets, 50),
        steps: [...job.steps.values()].map((step) => {
            const duration = summarizeSamples(step.durations);
            const acc = accs.get(keyOf(jobKey, step.id));
            return {
                key: step.key,
                id: step.id,
                name: step.name,
                offsetMs: percentile(step.offsets, 50),
                offsetP25Ms: percentile(step.offsets, 25),
                offsetP90Ms: percentile(step.offsets, 90),
                durationMs: duration.p50,
                durationP90Ms: duration.p90,
                failed: step.conclusions.some((value) => FAILURE_CONCLUSIONS.has(value)),
                failureRate: acc.executed > 0 ? acc.failed / acc.executed : 0,
                infrastructure: isInfrastructureStep(step.name),
            };
        }).sort((a, b) => a.offsetMs - b.offsetMs || a.key.localeCompare(b.key) || a.id.localeCompare(b.id)),
    })).sort((a, b) => a.startOffsetMs - b.startOffsetMs || a.job.localeCompare(b.job));

    // A loop rather than a spread: a large collection holds more timestamps than a
    // function call accepts as arguments.
    const newest = allTimes.length ? maxOf(allTimes) : null;
    const oldest = allTimes.length ? minOf(allTimes) : null;
    return {
        stepStats,
        jobStats,
        typicalTimeline,
        runners: runnerPools(poolRows),
        runnerFacets: facets,
        jobStatus: statusFilter,
        includeAllAttempts,
        jobStatusFacets: jobStatusFacets(allJobRows),
        runs: [...runList.values()].filter((row) => !selectedJob || row.job === selectedJob).sort((a, b) => String(b.runId).length - String(a.runId).length || String(b.runId).localeCompare(String(a.runId)) || b.runAttempt - a.runAttempt).slice(0, 100),
        meta: {
            analysedRuns: runIds.size,
            analysedAttempts: new Set([...jobRows, ...stepRows].filter((row) => row.runId).map((row) => keyOf(row.repo, row.runId, row.runAttempt))).size,
            maxRunsPerRepo,
            oldest: oldest === null ? null : new Date(oldest).toISOString(),
            newest: newest === null ? null : new Date(newest).toISOString(),
            totalJobs: jobRows.length,
            unfilteredJobs: allJobRows.length,
            runnerFilter,
            jobStatus: statusFilter,
            totalStepRows: stepRows.length,
            totalSteps,
            latestAttemptBasis: !includeAllAttempts,
        },
    };
}

// displayStepName shortens pinned action refs (`owner/action@<40-hex sha>`) to a
// 7-character abbreviated sha so long `Run …` / `Post Run …` names stay readable.
export function displayStepName(name) {
    return String(name ?? "").replace(/@([0-9a-f]{40})\b/gi, (_, sha) => `@${sha.slice(0, 7)}`);
}

// timelineMatchesWorkflow reports whether a single-run timeline belongs to the
// workflow file whose step statistics are loaded. Missing data counts as a match.
export function timelineMatchesWorkflow(timeline, workflow) {
    if (!timeline || !workflow) return true;
    const file = (value) => String(value ?? "").split("/").filter(Boolean).at(-1) ?? "";
    return file(timeline.WorkflowPath) === file(workflow);
}

export function formatDuration(ms) {
    if (!Number.isFinite(ms)) {
        return "–";
    }
    if (ms > 0 && ms < 1000) {
        return "<1s";
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
}
