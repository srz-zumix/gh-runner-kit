// Step timeline collection. Streams `metrics steps` and `metrics jobs` NDJSON
// through gh runner-kit, then aggregates in shared/steps.mjs so the browser and
// canvas actions read the same statistics.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { assertRateBudget, ghRaw, isRateLimitError, noteRateLimit } from "./gh.mjs";
import { runLines } from "./jobs.mjs";
import { jobRowsCommand, probeRunnerKit, snapshotCommand, stepRowsCommand } from "./runnerkit.mjs";
import { aggregateSteps, normalizeRunnerFilter } from "../shared/steps.mjs";
import { collectEarlierAttempts } from "./stepattempts.mjs";

const DEFAULT_STEP_RUN_BUDGET = 500;
const MAX_STEP_RUN_BUDGET = 5000;

function describe(error) {
    return error?.message ?? String(error);
}

export function normalizeWorkflowForCli(workflow) {
    const value = String(workflow ?? "").trim();
    if (!value) {
        return "";
    }
    if (/^\d+$/.test(value)) {
        return value;
    }
    return basename(value);
}

function clampRunBudget(value) {
    if (value === null || String(value).trim() === "") {
        return DEFAULT_STEP_RUN_BUDGET;
    }
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return DEFAULT_STEP_RUN_BUDGET;
    }
    if (number === 0 && (typeof value === "number" || typeof value === "string")) return 0;
    return Math.min(MAX_STEP_RUN_BUDGET, Math.max(1, Math.floor(number)));
}

function readJsonLine(line, rows, counters) {
    try {
        rows.push(JSON.parse(line));
    } catch {
        counters.malformed += 1;
    }
    return true;
}

// The CLI reports on stderr how many repositories reached --max-runs, because the
// NDJSON rows have no place for it; an older CLI prints nothing and yields false.
export function reportsRunCapReached(stderr) {
    const match = /(?:^|\s)truncated_repos=(\d+)(?:\s|$)/m.exec(String(stderr ?? ""));
    return Boolean(match && Number(match[1]) > 0);
}

const METRICS_WARNING_PREFIX = "metrics: ";

// Unquotes a slog text value. Go quotes it with strconv.Quote, whose escapes are mostly
// JSON compatible; anything JSON cannot read is kept with only the quotes removed.
function unquoteLogValue(value) {
    if (!value.startsWith("\"")) {
        return value;
    }
    try {
        return JSON.parse(value);
    } catch {
        return value.slice(1, -1);
    }
}

// The CLI logs the collection warnings on stderr as slog text lines, such as
// `level=WARN msg="metrics: Jobs for run #1: ..."`. The run cap notice is skipped
// because it is reported through reportsRunCapReached instead.
export function parseCollectionWarning(line) {
    const text = String(line ?? "");
    if (!/(?:^|\s)level=WARN(?:\s|$)/.test(text)) {
        return null;
    }
    const match = /(?:^|\s)msg=("(?:[^"\\]|\\.)*"|\S+)/.exec(text);
    if (!match) {
        return null;
    }
    const message = unquoteLogValue(match[1]);
    if (!message.startsWith(METRICS_WARNING_PREFIX) || /(?:^|\s)truncated_repos=\d+(?:\s|$)/.test(text)) {
        return null;
    }
    return message.slice(METRICS_WARNING_PREFIX.length);
}

// A report reading a local snapshot through --input makes no API request, so it passes
// gated=false and still renders after metrics collect spent the remaining budget.
async function streamCommand({ args, env, cwd, target, signal, onProgress, label, gated = true, acceptRow }) {
    const rows = [];
    const counters = { malformed: 0 };
    const warnings = [];
    onProgress?.(label);
    const onStderrLine = (line) => {
        const warning = parseCollectionWarning(line);
        if (warning && !warnings.includes(warning)) {
            warnings.push(warning);
        }
    };
    const result = await runLines(args, env, cwd, line => {
        if (acceptRow) {
            const row = JSON.parse(line);
            if (acceptRow(row)) rows.push(row);
            return true;
        }
        return readJsonLine(line, rows, counters);
    }, signal, { host: gated ? target?.host ?? null : undefined, onStderrLine });
    return { rows, malformed: counters.malformed, warnings, truncated: Boolean(result.truncated) || reportsRunCapReached(result.stderr) };
}

// Reads the step and job listings from one `metrics collect` snapshot, so both describe
// exactly the same runs even when a run starts or finishes between the two reports.
async function streamFromSnapshot({ common, budget, workflowFile, cwd, target, signal, onProgress, includeAllAttempts }) {
    const dir = await mkdtemp(join(tmpdir(), "actions-metrics-steps-"));
    try {
        const input = join(dir, "snapshot.json.gz");
        onProgress?.(`Collecting ${budget === 0 ? "all" : `up to ${budget}`} runs of ${workflowFile} with metrics collect`);
        const collect = snapshotCommand({ ...common, output: input });
        await ghRaw(collect.args, { cwd, env: collect.env, host: target?.host ?? null, signal });
        const steps = await streamCommand({ ...stepRowsCommand({ ...common, input }), cwd, target, signal, onProgress, label: `Reading the steps of ${workflowFile}`, gated: false });
        const jobs = await streamCommand({ ...jobRowsCommand({ ...common, input }), cwd, target, signal, onProgress, label: `Reading job denominators for ${workflowFile}`, gated: false });
        if (includeAllAttempts) {
            const runs = await streamCommand({ args: ["runner-kit", "metrics", "runs", "--input", input, "--format", "ndjson"], cwd, target, signal, onProgress, label: "Reading sampled run attempts", gated: false });
            if (runs.malformed) throw new Error("The sampled run listing contains malformed rows; cannot collect every attempt reliably");
            const history = await collectEarlierAttempts({
                runs: runs.rows,
                jobs: jobs.rows,
                steps: steps.rows,
                cwd, target, signal, onProgress,
                concurrency: common.limits?.jobConcurrency ?? 6,
                rowFilters: { kind: common.kind, runner: common.pattern, excludeRunners: common.exclusions, labels: common.filters?.labels ?? [] },
            });
            jobs.rows = history.jobs;
            steps.rows = history.steps;
            jobs.warnings.push(...runs.warnings, ...history.warnings);
            jobs.historicalAttemptsRequested = history.historicalAttemptsRequested;
            jobs.historicalAttemptsWithJobs = history.historicalAttemptsWithJobs;
        }
        return { steps, jobs };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

export async function collectStepMetrics({
    target,
    filters,
    limits,
    cwd,
    workflow,
    repository = "",
    job = "",
    jobStatus = "",
    includeAllAttempts = false,
    mergeMatrix = true,
    showInfra = true,
    runBudget = DEFAULT_STEP_RUN_BUDGET,
    kind = "all",
    runner = "",
    excludeRunners = [],
    step = "",
    limit = 0,
    runnerFilter = {},
    reuseRows = false,
    cache = null,
    dataset = null,
    signal,
    onProgress,
} = {}) {
    const probe = await probeRunnerKit(cwd);
    if (!probe.available) {
        return { available: false, reason: `${probe.reason}. Install it with \`gh extension install srz-zumix/gh-runner-kit\`.` };
    }
    if (!probe.subcommands.has("steps")) {
        return { available: false, reason: "gh runner-kit metrics steps is not available in the installed version. Update gh runner-kit to use the Step timeline tab." };
    }
    if (!probe.subcommands.has("jobs")) {
        return { available: false, reason: "gh runner-kit metrics jobs is not available in the installed version. Update gh runner-kit to use the Step timeline tab." };
    }
    if (includeAllAttempts && (!probe.subcommands.has("collect") || !probe.subcommands.has("runs") || !probe.jobSubcommands?.has("timeline"))) {
        return { available: false, reason: "Including all attempts requires gh runner-kit metrics collect, metrics runs and job timeline. Update gh runner-kit to use this option." };
    }

    const workflowFile = normalizeWorkflowForCli(workflow || filters?.workflow);
    if (!workflowFile) {
        return { available: false, reason: "Choose a workflow file before collecting step statistics. The CLI expects a file name such as ci.yml, not the workflow display name." };
    }

    const budget = clampRunBudget(runBudget);
    if (dataset) {
        signal?.throwIfAborted();
        const selection = dataset.select({ workflow: workflowFile, runBudget: budget, latestOnly: !includeAllAttempts, kind, runner, excludeRunners, labels: filters?.labels ?? [] });
        const key = JSON.stringify([dataset.meta.id, workflowFile, budget, includeAllAttempts, kind, runner, excludeRunners, filters?.labels]);
        let steps = reuseRows && cache?.key === key ? cache.steps : null;
        const jobKeys = new Set(selection.jobs.map(row => JSON.stringify([row.Repo, String(row.JobID)])));
        if (!steps) {
            steps = await streamCommand({
                ...stepRowsCommand({ target, input: dataset.input, kind: "all" }),
                cwd, target, signal, onProgress, gated: false,
                label: "Reading steps from the shared dataset",
                acceptRow: row => jobKeys.has(JSON.stringify([row.Repo, String(row.JobID)])),
            });
        }
        const jobs = { rows: selection.jobs, malformed: 0, warnings: dataset.meta.warnings };
        const aggregate = aggregateSteps({
            jobs: jobs.rows, steps: steps.rows, repository, mergeMatrix, showInfra,
            selectedJob: job, jobStatus, includeAllAttempts, stepPattern: step, limit,
            runner: normalizeRunnerFilter(runnerFilter),
        });
        const truncated = dataset.meta.truncated || selection.sampled || steps.truncated;
        const sampledRuns = dataset.runs.filter(run => selection.selected.has(JSON.stringify([run.repository, String(run.id)])));
        const latestAttempts = new Map(sampledRuns.map(run => [JSON.stringify([run.repository, String(run.id)]), run.run_attempt ?? 1]));
        const historical = new Set(selection.jobs.filter(row => row.RunAttempt < latestAttempts.get(JSON.stringify([row.Repo, String(row.RunID)])))
            .map(row => JSON.stringify([row.Repo, String(row.RunID), row.RunAttempt])));
        const reused = Boolean(reuseRows && cache?.key === key);
        return {
            available: true, rows: { key, jobs, steps },
            reusedRows: reused,
            workflow: workflowFile, job: job || "", mergeMatrix: Boolean(mergeMatrix),
            showInfra: Boolean(showInfra), runBudget: budget, truncated,
            malformedRows: steps.malformed, warnings: dataset.meta.warnings,
            ...aggregate,
            meta: {
                ...aggregate.meta, datasetId: dataset.meta.id, allAttemptsCollected: true,
                runBudget: budget, truncated, workflow: workflowFile, job: job || "",
                malformedRows: steps.malformed, warnings: dataset.meta.warnings, reusedRows: reused,
                historicalAttemptsRequested: includeAllAttempts ? sampledRuns.reduce((sum, run) => sum + Math.max(0, (run.run_attempt ?? 1) - 1), 0) : 0,
                historicalAttemptsWithJobs: includeAllAttempts ? historical.size : 0,
            },
        };
    }
    // Everything that changes which rows the CLI returns is part of the key; repository,
    // job, status, step, matrix, infra and runner filters only change the aggregation.
    const rowsKey = JSON.stringify({ target, filters, limits, workflowFile, budget, kind, runner, excludeRunners, includeAllAttempts });
    const cached = reuseRows && cache?.key === rowsKey ? cache : null;
    if (!cached) {
        await assertRateBudget(target?.host ?? null, { cwd });
    }
    try {
        const common = {
            target,
            filters,
            limits,
            workflow: workflowFile,
            runBudget: budget,
            kind,
            pattern: runner,
            exclusions: excludeRunners,
            probe,
        };
        let steps = cached?.steps;
        let jobs = cached?.jobs;
        // The step filter is applied in aggregateSteps rather than by the CLI, because
        // the jobs that never ran the filtered step still count toward its presence.
        if (!cached && probe.subcommands.has("collect")) {
            ({ steps, jobs } = await streamFromSnapshot({ common, budget, workflowFile, cwd, target, signal, onProgress, includeAllAttempts }));
        } else if (!cached) {
            // A CLI without metrics collect lists the runs once per report, so a run that
            // arrives between the two can still make the listings differ slightly.
            const stepCommand = stepRowsCommand(common);
            steps = await streamCommand({ ...stepCommand, cwd, target, signal, onProgress, label: `Reading ${budget === 0 ? "all" : `up to ${budget}`} runs of ${workflowFile} with metrics steps` });
            const jobCommand = jobRowsCommand({ ...common, filters: { ...filters, workflow: workflowFile }, limits: { ...limits, maxRuns: budget } });
            jobs = await streamCommand({ ...jobCommand, cwd, target, signal, onProgress, label: `Reading job denominators for ${workflowFile}` });
        }
        const runnerSelection = normalizeRunnerFilter(runnerFilter);
        const aggregate = aggregateSteps({
            jobs: jobs.rows,
            steps: steps.rows,
            repository,
            mergeMatrix,
            showInfra,
            selectedJob: job,
            jobStatus,
            includeAllAttempts,
            stepPattern: step,
            limit,
            runner: runnerSelection,
        });
        const warnings = [...new Set([...(steps.warnings ?? []), ...(jobs.warnings ?? [])])];
        // The CLI reports the repositories that reached the run budget on stderr. The
        // busiest repository of the unfiltered rows is the fallback for a CLI that does
        // not, compared per repository because the budget applies to each of them.
        const truncated = steps.truncated || jobs.truncated || (budget > 0 && aggregate.meta.maxRunsPerRepo >= budget);
        return {
            available: true,
            rows: { key: rowsKey, steps, jobs },
            reusedRows: Boolean(cached),
            runnerFilter: runnerSelection,
            workflow: workflowFile,
            job: job || "",
            mergeMatrix: Boolean(mergeMatrix),
            showInfra: Boolean(showInfra),
            runBudget: budget,
            truncated,
            malformedRows: steps.malformed + jobs.malformed,
            warnings,
            ...aggregate,
            meta: {
                ...aggregate.meta,
                runBudget: budget,
                truncated,
                workflow: workflowFile,
                job: job || "",
                malformedRows: steps.malformed + jobs.malformed,
                warnings,
                reusedRows: Boolean(cached),
                historicalAttemptsRequested: jobs.historicalAttemptsRequested ?? 0,
                historicalAttemptsWithJobs: jobs.historicalAttemptsWithJobs ?? 0,
            },
        };
    } catch (error) {
        if (isRateLimitError(error)) {
            throw await noteRateLimit(target?.host ?? null, error, { cwd });
        }
        return { available: false, reason: `gh runner-kit step metrics failed: ${describe(error)}` };
    }
}

export { DEFAULT_STEP_RUN_BUDGET, MAX_STEP_RUN_BUDGET };
