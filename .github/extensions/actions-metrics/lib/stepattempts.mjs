import { GhError, isRateLimitError, mapLimit } from "./gh.mjs";
import { collectRunTimeline } from "./timeline.mjs";
import { matchRunner, matchWildcard, normalizeJobRow } from "../shared/steps.mjs";

// Adapt the CLI's attempt timeline to the same row schema as metrics jobs/steps.
// The CLI owns timestamps, durations, runner classification and step occurrences.
export function timelineRows(timeline, repo) {
    const jobs = [];
    const steps = [];
    for (const job of timeline.Jobs ?? []) {
        const row = {
            Repo: repo,
            RunID: String(timeline.RunID),
            RunAttempt: timeline.RunAttempt,
            JobID: String(job.JobID),
            Workflow: timeline.Workflow,
            WorkflowPath: timeline.WorkflowPath,
            JobName: job.Name,
            Event: timeline.Event,
            Branch: timeline.Branch,
            Labels: job.Labels,
            Kind: job.Kind,
            RunnerName: job.RunnerName,
            RunnerGroup: job.RunnerGroup,
            Status: job.Status,
            Conclusion: job.Conclusion,
            QueuedAt: job.QueuedAt,
            StartedAt: job.StartedAt,
            CompletedAt: job.CompletedAt,
            Wait: job.Wait,
            Duration: job.Duration,
        };
        jobs.push(row);
        for (const step of job.Steps ?? []) {
            steps.push({
                Repo: row.Repo,
                RunID: row.RunID,
                RunAttempt: row.RunAttempt,
                RunStartedAt: timeline.StartedAt,
                JobID: row.JobID,
                Workflow: row.Workflow,
                WorkflowPath: row.WorkflowPath,
                JobName: row.JobName,
                Event: row.Event,
                Branch: row.Branch,
                Labels: row.Labels,
                Kind: row.Kind,
                RunnerName: row.RunnerName,
                RunnerGroup: row.RunnerGroup,
                JobConclusion: row.Conclusion,
                JobQueuedAt: row.QueuedAt,
                JobStartedAt: row.StartedAt,
                JobCompletedAt: row.CompletedAt,
                StepNumber: step.Number,
                StepName: step.Name,
                StepKey: step.Key,
                StepOccurrence: step.Occurrence,
                StepStatus: step.Status,
                StepConclusion: step.Conclusion,
                StartedAt: step.StartedAt,
                CompletedAt: step.CompletedAt,
                Duration: step.Duration,
                Offset: step.JobOffset,
            });
        }
    }
    return { jobs, steps };
}

function jobKey(row) {
    return JSON.stringify([row.Repo, String(row.RunID), String(row.JobID)]);
}

export function mergeAttemptRows(latest, historical) {
    const jobs = new Map(latest.jobs.map((row) => [jobKey(row), row]));
    const steps = new Map(latest.steps.map((row) => [JSON.stringify([jobKey(row), row.StepNumber]), row]));
    for (const rows of historical) {
        for (const row of rows.jobs) jobs.set(jobKey(row), row);
        for (const row of rows.steps) steps.set(JSON.stringify([jobKey(row), row.StepNumber]), row);
    }
    return { jobs: [...jobs.values()], steps: [...steps.values()] };
}

export function filterAttemptRows(rows, { kind = "all", runner = "", excludeRunners = [], labels = [] } = {}) {
    const jobs = rows.jobs.filter((row) => {
        const job = normalizeJobRow(row);
        if (!matchRunner(job, { kind, name: runner })) return false;
        if (excludeRunners.some((pattern) => matchWildcard(pattern, job.runnerName))) return false;
        const available = new Set(job.labels.map((label) => label.toLowerCase()));
        return labels.every((label) => available.has(String(label).toLowerCase()));
    });
    const keys = new Set(jobs.map(jobKey));
    return { jobs, steps: rows.steps.filter((row) => keys.has(jobKey(row))) };
}

export async function collectEarlierAttempts({
    runs,
    jobs,
    steps,
    cwd,
    target,
    signal,
    concurrency = 6,
    onProgress,
    rowFilters,
    fetchTimeline = collectRunTimeline,
}) {
    const retried = runs.filter((run) => Number(run.RunAttempt) > 1);
    const results = await mapLimit(retried, concurrency, async (run) => {
        const rows = [];
        const warnings = [];
        let requested = 0;
        let populated = 0;
        for (let attempt = 1; attempt < Number(run.RunAttempt); attempt += 1) {
            signal?.throwIfAborted();
            requested += 1;
            const label = `${run.Repository} run ${run.RunID} attempt ${attempt}`;
            onProgress?.(`Reading ${label}`);
            let result;
            try {
                result = await fetchTimeline({ cwd, target, repo: run.Repository, run: String(run.RunID), attempt, signal });
            } catch (error) {
                if (signal?.aborted || isRateLimitError(error)) throw error;
                if (!(error instanceof GhError) || (![403, 404].includes(error.status) && !(error.status >= 500))) throw error;
                warnings.push(`Could not read ${label}: ${error.message}`);
                continue;
            }
            if (result.available === false) throw new Error(result.reason);
            const timeline = result.timeline;
            if (!timeline || String(timeline.RunID) !== String(run.RunID) || Number(timeline.RunAttempt) !== attempt) {
                throw new Error(`The CLI returned a different run or attempt for ${label}`);
            }
            if (!timeline.Jobs?.length) {
                warnings.push(`No jobs were returned for ${label}; historical jobs may no longer be available from GitHub.`);
                continue;
            }
            populated += 1;
            rows.push(filterAttemptRows(timelineRows(timeline, run.Repository), rowFilters));
        }
        return { rows, warnings, requested, populated };
    });
    return {
        ...mergeAttemptRows({ jobs, steps }, results.flatMap((result) => result.rows)),
        warnings: results.flatMap((result) => result.warnings),
        historicalAttemptsRequested: results.reduce((sum, result) => sum + result.requested, 0),
        historicalAttemptsWithJobs: results.reduce((sum, result) => sum + result.populated, 0),
    };
}
