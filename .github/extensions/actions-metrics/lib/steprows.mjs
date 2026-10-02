// Step timeline collection. Streams `metrics steps` and `metrics jobs` NDJSON
// through gh runner-kit, then aggregates in shared/steps.mjs so the browser and
// canvas actions read the same statistics.

import { basename } from "node:path";
import { assertRateBudget, isRateLimitError, noteRateLimit } from "./gh.mjs";
import { runLines } from "./jobs.mjs";
import { jobRowsCommand, probeRunnerKit, stepRowsCommand } from "./runnerkit.mjs";
import { aggregateSteps, normalizeRunnerFilter } from "../shared/steps.mjs";

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
    const number = Number(value);
    if (!Number.isFinite(number)) {
        return DEFAULT_STEP_RUN_BUDGET;
    }
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

async function streamCommand({ args, env, cwd, target, signal, onProgress, label }) {
    const rows = [];
    const counters = { malformed: 0 };
    onProgress?.(label);
    const result = await runLines(args, env, cwd, (line) => readJsonLine(line, rows, counters), signal, { host: target?.host ?? null });
    return { rows, malformed: counters.malformed, truncated: Boolean(result.truncated) };
}

export async function collectStepMetrics({
    target,
    filters,
    limits,
    cwd,
    workflow,
    job = "",
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

    const workflowFile = normalizeWorkflowForCli(workflow || filters?.workflow);
    if (!workflowFile) {
        return { available: false, reason: "Choose a workflow file before collecting step statistics. The CLI expects a file name such as ci.yml, not the workflow display name." };
    }

    const budget = clampRunBudget(runBudget);
    // Everything that changes which rows the CLI returns is part of the key; the job,
    // matrix, infra and runner filter options only change the aggregation.
    const rowsKey = JSON.stringify({ target, filters, limits, workflowFile, budget, kind, runner, excludeRunners, step });
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
        if (!cached) {
            const stepCommand = stepRowsCommand({ ...common, steps: step ? [step] : [] });
            steps = await streamCommand({ ...stepCommand, cwd, target, signal, onProgress, label: `Reading up to ${budget} runs of ${workflowFile} with metrics steps` });
            const jobCommand = jobRowsCommand({ ...common, filters: { ...filters, workflow: workflowFile }, limits: { ...limits, maxRuns: budget } });
            jobs = await streamCommand({ ...jobCommand, cwd, target, signal, onProgress, label: `Reading job denominators for ${workflowFile}` });
        }
        const runnerSelection = normalizeRunnerFilter(runnerFilter);
        const aggregate = aggregateSteps({
            jobs: jobs.rows,
            steps: steps.rows,
            mergeMatrix,
            showInfra,
            selectedJob: job,
            limit,
            runner: runnerSelection,
        });
        const truncated = steps.truncated || jobs.truncated || aggregate.meta.analysedRuns >= budget;
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
            ...aggregate,
            meta: {
                ...aggregate.meta,
                runBudget: budget,
                truncated,
                workflow: workflowFile,
                job: job || "",
                malformedRows: steps.malformed + jobs.malformed,
                reusedRows: Boolean(cached),
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
