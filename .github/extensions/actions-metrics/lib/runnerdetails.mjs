import { runLines } from "./process.mjs";
import { stepRowsCommand } from "./runnerkit.mjs";
import { normalizeJobRow, normalizeStepRow } from "../shared/steps.mjs";
import { FAILURE_CONCLUSIONS, isDecided } from "../shared/rows.mjs";

const STEP_FAILURES = new Set(["failure", "timed_out", "startup_failure"]);
const RECENT_JOB_LIMIT = 100;
const FAILED_STEP_LIMIT = 50;
const NO_CONCLUSION = "__no_conclusion__";

function normalizeRecentJobFilters(filters = {}) {
    if (!filters || typeof filters !== "object" || Array.isArray(filters)) {
        throw new TypeError("Recent job filters must be an object");
    }
    const result = {};
    for (const key of ["result", "failedStep", "repository", "workflow", "job"]) {
        const value = filters[key] ?? "";
        if (typeof value !== "string") throw new TypeError(`Recent job filter ${key} must be a string`);
        result[key] = value.trim().toLowerCase();
    }
    return result;
}

function jobKey(row) {
    if (row.jobId && row.jobId !== "0") {
        return JSON.stringify([row.repo, "id", row.jobId, row.runAttempt]);
    }
    return JSON.stringify([row.repo, row.workflowPath || row.workflow, row.runId, row.runAttempt, row.jobName]);
}

function stepJobKey(row) {
    if (row.jobId && row.jobId !== "0") {
        return JSON.stringify([row.repo, "id", row.jobId, row.runAttempt]);
    }
    return JSON.stringify([row.repo, row.workflowPath || row.workflow, row.runId, row.runAttempt, row.jobName]);
}

function utcDay(timestamp) {
    return new Date(timestamp).toISOString().slice(0, 10);
}

function summarizeRunnerDetails({ jobs = [], steps = [], runner, includeAllAttempts = false, recentJobFilters = {}, dataset = {}, host = "github.com", malformedStepRows = 0 } = {}) {
    const name = String(runner ?? "").trim();
    if (!name) throw new TypeError("Runner name is required");
    const filters = normalizeRecentJobFilters(recentJobFilters);

    const allJobs = jobs.map(normalizeJobRow).filter(row => row.runnerName === name);
    const selectedJobs = allJobs.filter(row => includeAllAttempts || row.latest);
    const selectedByKey = new Map(selectedJobs.map(row => [jobKey(row), row]));
    const stepRows = steps.map(normalizeStepRow)
        .filter(row => row.stepName && row.runnerName === name && selectedByKey.has(stepJobKey(row)));

    const uniqueSteps = new Map();
    for (const row of stepRows) {
        const key = JSON.stringify([stepJobKey(row), row.stepId]);
        if (!uniqueSteps.has(key)) uniqueSteps.set(key, row);
    }

    const failedByJob = new Map();
    const failedSteps = new Map();
    for (const row of uniqueSteps.values()) {
        const key = stepJobKey(row);
        const failed = STEP_FAILURES.has(row.stepConclusion);
        if (failed) {
            if (!failedByJob.has(key)) failedByJob.set(key, []);
            failedByJob.get(key).push({ stepNumber: row.stepNumber, name: row.stepName });
        }

        if (!failedSteps.has(row.stepName)) {
            failedSteps.set(row.stepName, { name: row.stepName, failed: 0, executed: 0, workflows: new Set(), latestFailureAt: null });
        }
        const summary = failedSteps.get(row.stepName);
        if (row.startedAt !== null) summary.executed++;
        if (failed) {
            summary.failed++;
            summary.workflows.add(JSON.stringify([row.repo, row.workflowPath || row.workflow]));
            const at = row.completedAt ?? row.startedAt;
            if (at !== null && (summary.latestFailureAt === null || at > summary.latestFailureAt)) summary.latestFailureAt = at;
        }
    }

    const daily = new Map();
    let unbucketedJobs = 0;
    let decidedJobs = 0;
    let failedJobs = 0;
    for (const row of selectedJobs) {
        if (!isDecided(row.conclusion)) continue;
        decidedJobs++;
        if (FAILURE_CONCLUSIONS.has(row.conclusion)) failedJobs++;
        if (row.completedAt === null) {
            unbucketedJobs++;
            continue;
        }
        const day = utcDay(row.completedAt);
        if (!daily.has(day)) daily.set(day, { day, decided: 0, failed: 0 });
        const bucket = daily.get(day);
        bucket.decided++;
        if (FAILURE_CONCLUSIONS.has(row.conclusion)) bucket.failed++;
    }

    const executionDays = new Map();
    let unstartedJobs = 0;
    for (const row of selectedJobs) {
        if (row.startedAt === null) {
            unstartedJobs++;
            continue;
        }
        const day = utcDay(row.startedAt);
        if (!executionDays.has(day)) executionDays.set(day, { day, jobs: 0, succeeded: 0, failed: 0, other: 0 });
        const bucket = executionDays.get(day);
        bucket.jobs++;
        if (row.conclusion === "success") bucket.succeeded++;
        else if (FAILURE_CONCLUSIONS.has(row.conclusion)) bucket.failed++;
        else bucket.other++;
    }

    const contains = (value, term) => !term || String(value ?? "").toLowerCase().includes(term);
    const matchingJobs = selectedJobs.filter(row =>
        (!filters.result || (filters.result === NO_CONCLUSION ? !row.conclusion : row.conclusion === filters.result))
        && contains(row.repo, filters.repository)
        && (contains(row.workflow, filters.workflow) || contains(row.workflowPath, filters.workflow))
        && contains(row.jobName, filters.job)
        && (!filters.failedStep || (failedByJob.get(jobKey(row)) ?? [])
            .some(step => contains(step.name, filters.failedStep))),
    );
    const resultOptions = [...new Set(selectedJobs.map(row => row.conclusion || NO_CONCLUSION))].sort();
    const recentJobs = [...matchingJobs]
        .sort((a, b) => (b.completedAt ?? b.startedAt ?? b.queuedAt ?? 0) - (a.completedAt ?? a.startedAt ?? a.queuedAt ?? 0))
        .slice(0, RECENT_JOB_LIMIT)
        .map(row => ({
            repo: row.repo,
            workflow: row.workflow,
            workflowPath: row.workflowPath,
            job: row.jobName,
            jobId: row.jobId || null,
            runId: row.runId || null,
            runAttempt: row.runAttempt,
            runnerId: row.runnerId || null,
            status: row.status,
            conclusion: row.conclusion,
            queuedAt: row.queuedAt === null ? null : new Date(row.queuedAt).toISOString(),
            startedAt: row.startedAt === null ? null : new Date(row.startedAt).toISOString(),
            completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
            runUrl: row.repo && row.runId
                ? `https://${host}/${row.repo.split("/").map(encodeURIComponent).join("/")}/actions/runs/${encodeURIComponent(row.runId)}/attempts/${row.runAttempt}`
                : null,
            failedStepNames: (failedByJob.get(jobKey(row)) ?? [])
                .sort((a, b) => a.stepNumber - b.stepNumber || a.name.localeCompare(b.name))
                .map(step => step.name),
        }));

    const allRankedSteps = [...failedSteps.values()]
        .filter(row => row.failed > 0)
        .map(row => ({
            name: row.name,
            failed: row.failed,
            executed: row.executed,
            failureRate: row.executed > 0 ? row.failed / row.executed : null,
            workflows: row.workflows.size,
            latestFailureAt: row.latestFailureAt === null ? null : new Date(row.latestFailureAt).toISOString(),
        }))
        .sort((a, b) => b.failed - a.failed || (b.failureRate ?? -1) - (a.failureRate ?? -1) || a.name.localeCompare(b.name));
    const rankedSteps = allRankedSteps.slice(0, FAILED_STEP_LIMIT);

    const trend = [...daily.values()]
        .sort((a, b) => a.day.localeCompare(b.day))
        .map(row => ({ ...row, failureRate: row.decided > 0 ? row.failed / row.decided : null }));

    return {
        runner: name,
        attemptScope: includeAllAttempts ? "all" : "latest",
        summary: {
            jobs: selectedJobs.length,
            decidedJobs,
            failedJobs,
            failureRate: decidedJobs > 0 ? failedJobs / decidedJobs : null,
        },
        trend: { timeZone: "UTC", timestamp: "job completion date", days: trend, unbucketedJobs },
        executions: {
            timeZone: "UTC",
            timestamp: "job start date",
            days: [...executionDays.values()].sort((a, b) => a.day.localeCompare(b.day)),
            unstartedJobs,
        },
        failedSteps: rankedSteps,
        recentJobs,
        meta: {
            datasetId: dataset.id ?? null,
            truncated: dataset.truncated === true,
            warnings: Array.isArray(dataset.warnings) ? dataset.warnings : [],
            totalJobs: selectedJobs.length,
            matchingJobs: matchingJobs.length,
            returnedJobs: recentJobs.length,
            resultOptions,
            returnedFailedSteps: rankedSteps.length,
            totalFailedStepNames: allRankedSteps.length,
            malformedStepRows,
        },
    };
}

export async function collectRunnerDetails({ dataset, target, cwd, runner, includeAllAttempts = false, recentJobFilters = {}, signal } = {}) {
    const name = String(runner ?? "").trim();
    if (!name) throw new TypeError("Runner name is required");

    const jobs = (dataset.jobs ?? []).filter(row => {
        const normalized = normalizeJobRow(row);
        return normalized.runnerName === name && (includeAllAttempts || normalized.latest);
    });

    const selectedKeys = new Set(jobs.map(row => jobKey(normalizeJobRow(row))));
    const hasPatternSyntax = ["*", "?", "[", "]", "\\"].some(character => name.includes(character));
    const stepsCommand = stepRowsCommand({
        target,
        input: dataset.input,
        kind: "all",
        pattern: hasPatternSyntax ? "" : name,
        labels: [],
    });
    const steps = [];
    let malformedSteps = 0;
    await runLines(stepsCommand.args, stepsCommand.env, cwd, line => {
        try {
            const row = JSON.parse(line);
            const normalized = normalizeStepRow(row);
            if (normalized.runnerName === name && selectedKeys.has(stepJobKey(normalized))) steps.push(row);
        } catch {
            malformedSteps++;
        }
        return true;
    }, signal);

    return summarizeRunnerDetails({
        jobs,
        steps,
        runner: name,
        includeAllAttempts,
        recentJobFilters,
        dataset: {
            id: dataset.meta?.id,
            truncated: dataset.meta?.truncated,
            warnings: dataset.meta?.warnings,
        },
        host: target?.host || "github.com",
        malformedStepRows: malformedSteps,
    });
}

/**
 * Every named runner in the retained job rows with its job counts, most jobs first.
 * Jobs without a runner name are omitted because they cannot be opened as details.
 */
function listRunnerNames(jobs = [], { includeAllAttempts = false } = {}) {
    const runners = new Map();
    for (const raw of jobs) {
        const row = normalizeJobRow(raw);
        if (!row.runnerName || (!includeAllAttempts && !row.latest)) continue;
        if (!runners.has(row.runnerName)) {
            runners.set(row.runnerName, { runner: row.runnerName, jobs: 0, decidedJobs: 0, failedJobs: 0, latestAt: null });
        }
        const summary = runners.get(row.runnerName);
        summary.jobs++;
        if (isDecided(row.conclusion)) {
            summary.decidedJobs++;
            if (FAILURE_CONCLUSIONS.has(row.conclusion)) summary.failedJobs++;
        }
        const at = row.completedAt ?? row.startedAt ?? row.queuedAt;
        if (at !== null && (summary.latestAt === null || at > summary.latestAt)) summary.latestAt = at;
    }
    return [...runners.values()]
        .map(row => ({
            ...row,
            failureRate: row.decidedJobs > 0 ? row.failedJobs / row.decidedJobs : null,
            latestAt: row.latestAt === null ? null : new Date(row.latestAt).toISOString(),
        }))
        .sort((a, b) => b.jobs - a.jobs || a.runner.localeCompare(b.runner));
}

export { listRunnerNames, normalizeRecentJobFilters, summarizeRunnerDetails };
