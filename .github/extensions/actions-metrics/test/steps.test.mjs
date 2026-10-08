import test from "node:test";
import assert from "node:assert/strict";

import { aggregateSteps, displayStepName, downsampleNewest, effectiveStepSettings, filterTimelineJobs, formatDuration, formatLabelSet, labelSetKey, matchJobStatus, matchRunner, matchWildcard, matrixMergeMap, normalizeJobStatus, normalizeRunnerFilter, percentile, splitLabelSet, stepKey, timelineMatchesWorkflow } from "../shared/steps.mjs";

test("timelineMatchesWorkflow compares workflow file names", () => {
    const timeline = { Workflow: "Labeler", WorkflowPath: ".github/workflows/labeler.yml" };
    assert.equal(timelineMatchesWorkflow(timeline, "labeler.yml"), true);
    assert.equal(timelineMatchesWorkflow(timeline, ".github/workflows/labeler.yml"), true);
    assert.equal(timelineMatchesWorkflow(timeline, "build.yml"), false);
    assert.equal(timelineMatchesWorkflow(null, "build.yml"), true);
    assert.equal(timelineMatchesWorkflow(timeline, ""), true);
});

test("displayStepName abbreviates pinned action shas", () => {
    const sha = "1b79cc935fc4ae393f5ecc2b8f0a7cd10cae75eb";
    assert.equal(displayStepName(`Run srz-zumix/labeler-action@${sha}`), "Run srz-zumix/labeler-action@1b79cc9");
    assert.equal(displayStepName(`Post Run actions/checkout@${sha} #2`), "Post Run actions/checkout@1b79cc9 #2");
    assert.equal(displayStepName("Run actions/checkout@v4"), "Run actions/checkout@v4");
    assert.equal(displayStepName("Set up job"), "Set up job");
    assert.equal(displayStepName(null), "");
});

const sec = (n) => `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`;
const ns = (s) => s * 1_000_000_000;

function job(id, name, started, completed, conclusion = "success") {
    return {
        Repo: "owner/repo",
        RunID: String(100 + id),
        RunAttempt: 1,
        JobID: String(id),
        Workflow: "Build",
        WorkflowPath: ".github/workflows/build.yml",
        JobName: name,
        Conclusion: conclusion,
        QueuedAt: sec(Math.max(0, started - 2)),
        StartedAt: sec(started),
        CompletedAt: sec(completed),
        Wait: ns(2),
        Duration: ns(completed - started),
    };
}

function step(jobId, jobName, runId, number, name, start, end, conclusion = "success") {
    return {
        Repo: "owner/repo",
        RunID: String(runId),
        RunAttempt: 1,
        RunStartedAt: sec(0),
        JobID: String(jobId),
        Workflow: "Build",
        WorkflowPath: ".github/workflows/build.yml",
        JobName: jobName,
        JobConclusion: conclusion === "failure" ? "failure" : "success",
        JobQueuedAt: sec(0),
        JobStartedAt: sec(1),
        JobCompletedAt: sec(jobId === 3 ? 26 : 51),
        StepNumber: number,
        StepName: name,
        StepKey: stepKey(name, number === 5 ? 2 : 1),
        StepConclusion: conclusion,
        StartedAt: start === null ? null : sec(start),
        CompletedAt: end === null ? null : sec(end),
        Duration: start === null || end === null ? 0 : ns(end - start),
        Offset: start === null ? 0 : ns(start - 1),
    };
}

test("nearest-rank percentile matches Go vectors", () => {
    assert.equal(percentile([], 50), 0);
    assert.equal(percentile([30, 20, 40], 50), 30);
    assert.equal(percentile([30, 20, 40], 90), 40);
    assert.equal(percentile([1, 2, 3, 4], 75), 3);
    assert.equal(percentile([1, 2, 3, 4], 0), 1);
    assert.equal(percentile([1, 2, 3, 4], 100), 4);
});

test("conditional matrix merge requires siblings", () => {
    const groups = [
        { repo: "r", workflow: "w", jobName: "test (ubuntu, 1.22)" },
        { repo: "r", workflow: "w", jobName: "test (macos, 1.22)" },
        { repo: "r", workflow: "w", jobName: "solo (only)" },
        { repo: "r", workflow: "w", jobName: "plain" },
    ];
    const merged = matrixMergeMap(groups);
    assert.equal(merged.get("r␟w␟test (ubuntu, 1.22)"), "test");
    assert.equal(merged.get("r␟w␟test (macos, 1.22)"), "test");
    assert.equal(merged.has("r␟w␟solo (only)"), false);
});

test("aggregateSteps handles duplicate names and Go step counts", () => {
    const jobs = [job(1, "build", 1, 51), job(2, "build", 1, 41), job(3, "build", 1, 31)];
    const steps = [
        step(1, "build", 101, 1, "Set up job", 1, 2),
        step(1, "build", 101, 2, "Compile", 6, 36),
        step(1, "build", 101, 3, "Upload", 37, 40),
        step(1, "build", 101, 5, "Upload", 41, 43),
        step(2, "build", 102, 1, "Set up job", 1, 2),
        step(2, "build", 102, 2, "Compile", 6, 46, "failure"),
        step(2, "build", 102, 3, "Upload", null, null, "skipped"),
        step(3, "build", 103, 1, "Set up job", 1, 2),
        step(3, "build", 103, 2, "Compile", 6, 26),
    ];
    const result = aggregateSteps({ jobs, steps, showInfra: true });
    const compile = result.stepStats.find((row) => row.stepKey === "Compile");
    assert.equal(compile.jobs, 3);
    assert.equal(compile.executed, 3);
    assert.equal(compile.failed, 1);
    assert.equal(compile.samples, 3);
    assert.equal(compile.duration.p50, 30_000);
    assert.equal(compile.duration.p90, 40_000);
    assert.equal(compile.duration.max, 40_000);
    assert.equal(compile.offsetMs, 5_000);
    assert.equal(result.typicalTimeline.find((row) => row.job === "build").steps.find((row) => row.name === "Compile").failureRate, 1 / 3);
    assert.equal(Math.round(compile.share * 10) / 10, 0.8);
    const upload2 = result.stepStats.find((row) => row.stepKey === "Upload #2");
    assert.equal(upload2.executed, 1);
});

test("typical timeline uses median observed offsets", () => {
    const result = aggregateSteps({ jobs: [job(1, "build", 1, 21), job(2, "build", 1, 31)], steps: [step(1, "build", 101, 2, "Compile", 4, 10), step(2, "build", 102, 2, "Compile", 8, 20)] });
    const build = result.typicalTimeline.find((row) => row.job === "build");
    assert.equal(build.steps[0].offsetMs, 3_000);
    assert.equal(build.steps[0].durationMs, 6_000);
    assert.equal(build.steps[0].failureRate, 0);
});

test("trend and downsampling keep newest points", () => {
    const points = Array.from({ length: 2100 }, (_, index) => ({ t: index, durationMs: index }));
    const sampled = downsampleNewest(points, 2000);
    assert.equal(sampled.length, 2000);
    assert.equal(sampled[0].t, 100);
    assert.equal(sampled.at(-1).t, 2099);
});

test("duration display keeps sub-second values honest", () => {
    assert.equal(formatDuration(500), "<1s");
    assert.equal(formatDuration(1500), "2s");
});

import { jobRowsCommand, runTimelineCommand, snapshotCommand, stepRowsCommand } from "../lib/runnerkit.mjs";

test("stepRowsCommand uses workflow file and run budget", () => {
    const target = { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null };
    const { args } = stepRowsCommand({
        target,
        filters: { days: 7, workflow: "ignored.yml", runnerType: "auto", event: "push", branch: "main", includeRepos: [], excludeRepos: [], labels: ["ubuntu-latest"] },
        limits: { maxRuns: 0 },
        workflow: "ci.yml",
        runBudget: 20,
        kind: "all",
        jobs: ["build*"],
        steps: ["Compile"],
    });
    assert.deepEqual(args.slice(0, 6), ["runner-kit", "metrics", "steps", "--repo", "owner/repo", "--days"]);
    assert.equal(args[args.indexOf("--workflow") + 1], "ci.yml");
    assert.equal(args[args.indexOf("--max-runs") + 1], "20");
    assert(args.includes("--job"));
    assert(args.includes("--step"));
});

test("runTimelineCommand builds job timeline command", () => {
    const target = { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null };
    const { args } = runTimelineCommand({ target, run: "123", attempt: 2, format: "json" });
    assert.deepEqual(args, ["runner-kit", "job", "timeline", "123", "--format", "json", "--repo", "owner/repo", "--attempt", "2"]);
});

test("presence ignores jobs that ran no step", () => {
    const result = aggregateSteps({
        jobs: [job(1, "deploy", 1, 21), job(2, "deploy", 1, 1, "skipped")],
        steps: [step(1, "deploy", 101, 2, "Run", 4, 10)],
    });
    const run = result.stepStats.find((row) => row.stepKey === "Run");
    assert.equal(run.jobs, 1);
    assert.equal(run.presence, 1);
    const deploy = result.jobStats.find((row) => row.job === "deploy");
    assert.equal(deploy.runs, 2);
});

test("run list merges carried-over jobs and reports the attempt count", () => {
    const first = { ...job(1, "test", 1, 11), RunID: "500", RunAttempt: 1 };
    const rerun = { ...job(2, "test", 20, 30), RunID: "500", RunAttempt: 2 };
    const result = aggregateSteps({ jobs: [first, rerun], steps: [] });
    const runs = result.runs.filter((row) => row.runId === "500");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].runAttempt, 2);
    assert.equal(runs[0].jobs, 2);
});

test("run list shows one row per run unless a job is selected", () => {
    const build = { ...job(1, "build", 1, 11), RunID: "600" };
    const lint = { ...job(2, "lint", 1, 5), RunID: "600" };
    assert.equal(aggregateSteps({ jobs: [build, lint], steps: [] }).runs.filter((row) => row.runId === "600").length, 1);
    const filtered = aggregateSteps({ jobs: [build, lint], steps: [], selectedJob: "lint" }).runs;
    assert.deepEqual(filtered.map((row) => [row.runId, row.job]), [["600", "lint"]]);
});

test("run list conclusion does not depend on job order", () => {
    const conclusionOf = (jobs) => aggregateSteps({ jobs, steps: [] }).runs.find((row) => row.runId === "700").conclusion;
    const ok = { ...job(1, "build", 1, 11), RunID: "700" };
    const cancelled = { ...job(2, "lint", 1, 5, "cancelled"), RunID: "700" };
    const failed = { ...job(3, "test", 1, 5, "failure"), RunID: "700" };
    const running = { ...job(4, "deploy", 1, 5, ""), RunID: "700" };
    assert.equal(conclusionOf([ok, cancelled]), "cancelled");
    assert.equal(conclusionOf([cancelled, ok]), "cancelled");
    assert.equal(conclusionOf([cancelled, failed, ok]), "failure");
    assert.equal(conclusionOf([ok, failed, cancelled]), "failure");
    assert.equal(conclusionOf([ok, running]), null);
    assert.equal(conclusionOf([running, ok]), null);
});

test("runTimelineCommand lets a run URL name its own repository", () => {
    const target = { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null };
    const { args } = runTimelineCommand({ target, run: "https://github.com/other/repo/actions/runs/123", format: "json" });
    assert(!args.includes("--repo"));
    const explicit = runTimelineCommand({ target: { kind: "org", owner: "owner", host: null }, repo: "owner/app", run: "123" });
    assert.equal(explicit.args[explicit.args.indexOf("--repo") + 1], "owner/app");
});

test("jobRowsCommand never passes --job, which metrics jobs does not accept", () => {
    const target = { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null };
    const { args } = jobRowsCommand({ target, filters: { days: 7, runnerType: "auto", includeRepos: [], excludeRepos: [], labels: [] }, limits: {}, kind: "all", jobs: ["build"] });
    assert(!args.includes("--job"));
});

test("label sets round-trip and compare regardless of order and case", () => {
    const labels = ["self-hosted", "a,b", 'say "hi"'];
    assert.equal(formatLabelSet(labels), 'self-hosted,"a,b","say ""hi"""');
    assert.deepEqual(splitLabelSet(formatLabelSet(labels)), labels);
    assert.equal(labelSetKey(["Linux", "self-hosted"]), labelSetKey(["self-hosted", "linux", "linux"]));
    assert.notEqual(labelSetKey(["linux"]), labelSetKey(["linux", "x64"]));
});

test("matchRunner follows the CLI kind semantics and name wildcards", () => {
    const hosted = { kind: "hosted", labels: ["ubuntu-latest"], runnerGroup: "GitHub Actions", runnerName: "GitHub Actions" };
    const mac = { kind: "self-hosted", labels: ["self-hosted", "macOS"], runnerGroup: "Default", runnerName: "mac-01.local" };
    const unknown = { kind: "unknown", labels: [], runnerGroup: "", runnerName: "" };
    assert.equal(matchRunner(hosted, { kind: "self-hosted" }), false);
    assert.equal(matchRunner(unknown, { kind: "self-hosted" }), true);
    assert.equal(matchRunner(unknown, { kind: "github-hosted" }), false);
    assert.equal(matchRunner(mac, { labels: "macos,self-hosted" }), true);
    assert.equal(matchRunner(mac, { labels: "self-hosted" }), false);
    assert.equal(matchRunner(mac, { group: "Default", name: "mac-*.local" }), true);
    assert.equal(matchRunner(mac, { name: "mac-0?" }), false);
    assert.deepEqual(normalizeRunnerFilter({ kind: "bogus", name: " x " }), { kind: "all", labels: "", group: "", name: "x" });
});

function onRunner(row, labels, kind, runnerName) {
    return { ...row, Labels: labels, Kind: kind, RunnerName: runnerName, RunnerGroup: kind === "hosted" ? "GitHub Actions" : "Default" };
}

test("runner filter narrows statistics while pools and facets keep every runner", () => {
    const jobs = [
        onRunner(job(1, "build", 1, 51), ["ubuntu-latest"], "hosted", "GitHub Actions"),
        onRunner(job(2, "build", 1, 51), ["self-hosted", "linux"], "self-hosted", "box-1"),
        onRunner({ ...job(3, "build", 1, 26), StartedAt: null, CompletedAt: null, Wait: 0, Duration: 0, Conclusion: "" }, ["self-hosted", "linux"], "self-hosted", ""),
    ];
    const steps = [
        onRunner(step(1, "build", 101, 1, "Compile", 1, 41), ["ubuntu-latest"], "hosted", "GitHub Actions"),
        onRunner(step(2, "build", 102, 1, "Compile", 1, 11), ["linux", "self-hosted"], "self-hosted", "box-1"),
    ];
    const all = aggregateSteps({ jobs, steps });
    assert.deepEqual(all.stepStats[0].byRunner.map((pool) => [pool.labels, pool.samples, pool.p50]), [["linux,self-hosted", 1, 10_000], ["ubuntu-latest", 1, 40_000]]);
    const linux = all.runners.find((pool) => pool.key === labelSetKey(["linux", "self-hosted"]));
    assert.equal(linux.jobs, 2);
    // The job that never started is counted but kept out of the wait and run percentiles.
    assert.equal(linux.wait.samples, 1);
    assert.equal(linux.duration.samples, 1);
    assert.equal(linux.duration.p50, 50_000);
    assert.deepEqual(linux.runners.map((item) => item.value), ["box-1"]);

    const filtered = aggregateSteps({ jobs, steps, runner: { kind: "self-hosted" } });
    assert.equal(filtered.stepStats[0].samples, 1);
    assert.equal(filtered.stepStats[0].duration.p50, 10_000);
    assert.equal(filtered.meta.totalJobs, 2);
    assert.equal(filtered.meta.unfilteredJobs, 3);
    assert.equal(filtered.runners.length, 2);
    assert.deepEqual(filtered.runnerFacets.kinds.map((item) => item.value).sort(), ["hosted", "self-hosted"]);
    assert.deepEqual(filtered.runs.find((row) => row.runId === "102").runners, ["box-1"]);
});

test("job status matches lifecycle status or conclusion and defaults to every job", () => {
    const completed = { status: "completed", conclusion: "failure" };
    assert.equal(normalizeJobStatus(" FAILURE "), "failure");
    assert.equal(normalizeJobStatus(null), "");
    assert.equal(matchJobStatus(completed, ""), true);
    assert.equal(matchJobStatus(completed, "completed"), true);
    assert.equal(matchJobStatus(completed, " FAILURE "), true);
    assert.equal(matchJobStatus(completed, "success"), false);
    assert.equal(matchJobStatus({ status: "in_progress", conclusion: null }, "in_progress"), true);
    assert.equal(matchJobStatus({ status: "in_progress", conclusion: null }, "success"), false);
});

test("repository filtering narrows every statistical surface and preserves repository choices", () => {
    const jobs = [
        onRunner(job(1, "build", 1, 51), ["ubuntu-latest"], "hosted", "GitHub Actions"),
        onRunner({ ...job(2, "build", 1, 41, "failure"), Repo: "owner/other" }, ["self-hosted", "linux"], "self-hosted", "box-1"),
        onRunner({ ...job(3, "build", 1, 31, "failure"), Repo: "owner/other" }, ["ubuntu-latest"], "hosted", "GitHub Actions"),
    ];
    const steps = jobs.map((row, index) => ({ ...onRunner(step(index + 1, "build", row.RunID, 1, "Compile", 1, 11, row.Conclusion), row.Labels, row.Kind, row.RunnerName), Repo: row.Repo }));
    const all = aggregateSteps({ jobs, steps });
    assert.deepEqual(aggregateSteps({ jobs, steps, repository: "" }), all);
    const filtered = aggregateSteps({ jobs, steps, repository: " owner/other ", selectedJob: "build", jobStatus: "failure", runner: { kind: "self-hosted" } });
    assert.equal(filtered.repository, "owner/other");
    assert.equal(filtered.meta.repository, "owner/other");
    assert.equal(filtered.meta.totalJobs, 1);
    assert.equal(filtered.meta.unfilteredJobs, 3);
    assert.equal(filtered.meta.totalStepRows, 1);
    assert.equal(filtered.meta.analysedRuns, 1);
    assert.equal(filtered.meta.maxRunsPerRepo, 2);
    for (const key of ["stepStats", "jobStats", "typicalTimeline", "runs"]) {
        assert.ok(filtered[key].length > 0);
        assert.ok(filtered[key].every((row) => row.repo === "owner/other"));
    }
    assert.deepEqual(filtered.stepStats[0].trend.points.map((point) => point.runId), ["102"]);
    assert.equal(filtered.typicalTimeline[0].steps[0].failureRate, 1);
    assert.equal(filtered.runners.reduce((sum, pool) => sum + pool.jobs, 0), 2);
    assert.deepEqual(filtered.repositoryFacets, [{ value: "owner/other", count: 2 }, { value: "owner/repo", count: 1 }]);
    assert.deepEqual(filtered.repositoryFacets, all.repositoryFacets);
    assert.deepEqual(filtered.jobStatusFacets, [{ value: "failure", count: 2 }]);

    const empty = aggregateSteps({ jobs, steps, repository: "owner/missing" });
    for (const key of ["stepStats", "jobStats", "typicalTimeline", "runs", "runners"]) assert.deepEqual(empty[key], []);
    assert.equal(empty.meta.totalJobs, 0);
    assert.equal(empty.meta.unfilteredJobs, 3);
    assert.deepEqual(empty.repositoryFacets, all.repositoryFacets);
    assert.deepEqual(empty.jobStatusFacets, []);
    assert.deepEqual(empty.runnerFacets.names, []);
    const orphan = aggregateSteps({ jobs: [], steps: [step(1, "build", 101, 1, "Compile", 1, 11)], repository: "owner/repo" });
    assert.deepEqual(orphan.repositoryFacets, [{ value: "owner/repo", count: 0 }]);
    assert.equal(orphan.stepStats.length, 1);
});

test("repository filtering keeps run attempts, matrix variants and sample caps consistent", () => {
    const jobs = [
        job(1, "test (linux)", 1, 21),
        job(2, "test (macos)", 1, 31),
        { ...job(3, "test (linux)", 1, 41), RunID: "101", RunAttempt: 2 },
        { ...job(4, "test (linux)", 1, 51), Repo: "owner/other" },
        { ...job(5, "test (linux)", 1, 51), Repo: "owner/other" },
        { ...job(6, "test (linux)", 1, 51), Repo: "owner/other" },
    ];
    const steps = jobs.map((row, index) => ({ ...step(index + 1, row.JobName, row.RunID, 1, "Test", 1, 11), Repo: row.Repo, RunAttempt: row.RunAttempt }));
    const result = aggregateSteps({ jobs, steps, repository: "owner/repo", selectedJob: "test", includeAllAttempts: true });
    assert.equal(result.meta.maxRunsPerRepo, 3);
    assert.equal(result.meta.analysedRuns, 2);
    assert.equal(result.meta.analysedAttempts, 3);
    assert.equal(result.stepStats[0].job, "test");
    assert.deepEqual(result.stepStats[0].variants, ["test (linux)", "test (macos)"]);
    assert.equal(result.runs.length, 3);
    assert.ok(result.runs.every((row) => row.repo === "owner/repo"));
});

test("job status filters whole jobs, all their steps and every statistical surface", () => {
    const jobs = [
        { ...job(1, "build", 1, 51), Status: "completed" },
        { ...job(2, "build", 1, 41, "failure"), Status: "completed" },
        { ...job(3, "build", 1, 31, "failure"), Status: "completed" },
    ];
    const steps = [
        step(1, "build", 101, 1, "Compile", 1, 40),
        // The successful step's JobConclusion is intentionally stale; the job
        // listing owns its outcome, not the individual step or its repeated fields.
        step(2, "build", 102, 1, "Compile", 1, 11),
        step(2, "build", 102, 2, "Test", 11, 21, "failure"),
        step(2, "build", 102, 3, "Deploy", null, null, "skipped"),
        step(3, "build", 103, 2, "Test", 2, 22, "failure"),
    ];
    const result = aggregateSteps({ jobs, steps, jobStatus: " FAILURE " });
    assert.equal(result.jobStatus, "failure");
    assert.equal(result.meta.jobStatus, "failure");
    assert.equal(result.meta.totalJobs, 2);
    assert.equal(result.meta.unfilteredJobs, 3);
    assert.equal(result.meta.totalStepRows, 4);
    assert.equal(result.meta.analysedRuns, 2);
    assert.equal(result.meta.maxRunsPerRepo, 3);
    assert.equal(result.jobStats[0].runs, 2);
    assert.equal(result.runners[0].jobs, 2);
    const compile = result.stepStats.find((row) => row.stepKey === "Compile");
    assert.equal(compile.samples, 1);
    assert.equal(compile.duration.p50, 10_000);
    assert.equal(compile.presence, 0.5);
    assert.equal(compile.byRunner[0].samples, 1);
    assert.deepEqual(compile.trend.points.map((point) => point.runId), ["102"]);
    assert.equal(result.stepStats.find((row) => row.stepKey === "Deploy").skipped, 1);
    assert.equal(result.typicalTimeline[0].steps.find((row) => row.name === "Compile").durationMs, 10_000);
    assert.deepEqual(result.runs.map((row) => row.runId), ["103", "102"]);
    assert.deepEqual(result.jobStatusFacets, [
        { value: "completed", count: 3 },
        { value: "failure", count: 2 },
        { value: "success", count: 1 },
    ]);
    assert.equal(aggregateSteps({ jobs, steps, jobStatus: "completed" }).meta.totalStepRows, 5);
    assert.deepEqual(aggregateSteps({ jobs, steps, jobStatus: "" }), aggregateSteps({ jobs, steps }));
});

test("job status joins steps by repository, workflow, run and attempt, not just job name or ID", () => {
    const failed = { ...job(1, "build", 1, 51, "failure"), Status: "completed" };
    const original = step(1, "build", 101, 1, "Compile", 1, 11);
    const variants = [
        { Repo: "owner/other" },
        { WorkflowPath: ".github/workflows/release.yml" },
        { RunID: "900" },
        { RunAttempt: 2 },
    ];
    const jobs = [failed, ...variants.map((patch) => ({ ...failed, ...patch, Conclusion: "success" }))];
    const steps = [original, ...variants.map((patch) => ({ ...original, ...patch }))];
    const result = aggregateSteps({ jobs, steps, jobStatus: "failure" });
    assert.equal(result.meta.totalJobs, 1);
    assert.equal(result.meta.totalStepRows, 1);
    assert.equal(result.stepStats[0].samples, 1);
});

test("job status composes with runner and job filters without changing matrix names", () => {
    const jobs = [
        onRunner(job(1, "test (linux)", 1, 51, "failure"), ["self-hosted", "linux"], "self-hosted", "box-1"),
        onRunner(job(2, "test (macos)", 1, 41), ["macos-latest"], "hosted", "GitHub Actions"),
        onRunner(job(3, "test (linux)", 1, 31, "failure"), ["ubuntu-latest"], "hosted", "GitHub Actions"),
    ];
    const steps = jobs.map((row, index) => onRunner(step(index + 1, row.JobName, row.RunID, 1, "Test", 1, 11), row.Labels, row.Kind, row.RunnerName));
    const result = aggregateSteps({ jobs, steps, selectedJob: "test", jobStatus: "failure", runner: { kind: "self-hosted" } });
    assert.equal(result.stepStats[0].job, "test");
    assert.equal(result.stepStats[0].samples, 1);
    assert.equal(result.meta.totalJobs, 1);
    assert.equal(result.runners.reduce((sum, pool) => sum + pool.jobs, 0), 2);
    assert.equal(result.runnerFacets.kinds.length, 2);
    assert.deepEqual(result.jobStatusFacets.map((item) => item.value).sort(), ["failure", "success"]);
    assert.deepEqual(result.runs.map((row) => row.runId), ["101"]);
});

test("queued jobs count without timed samples and an unmatched status stays empty", () => {
    const jobs = [{ ...job(1, "build", 1, 51, ""), Status: "queued", StartedAt: null, CompletedAt: null }];
    const queued = aggregateSteps({ jobs, steps: [], jobStatus: "queued" });
    assert.equal(queued.meta.totalJobs, 1);
    assert.equal(queued.jobStats[0].runs, 1);
    assert.equal(queued.runners[0].duration.samples, 0);
    const empty = aggregateSteps({ jobs, steps: [step(2, "build", 102, 1, "Compile", 1, 11)], jobStatus: "failure" });
    assert.equal(empty.meta.totalJobs, 0);
    assert.equal(empty.meta.totalStepRows, 0);
    for (const key of ["stepStats", "jobStats", "typicalTimeline", "runs", "runners"]) assert.deepEqual(empty[key], []);
    assert.deepEqual(empty.jobStatusFacets, [{ value: "queued", count: 1 }]);
});

test("single-run Gantt uses the job status filter without dropping steps or mutating the timeline", () => {
    const timeline = { Jobs: [
        { Name: "build", Status: "completed", Conclusion: "success", Steps: [{ Conclusion: "success" }] },
        { Name: "test", Status: "completed", Conclusion: "failure", Steps: [{ Conclusion: "success" }, { Conclusion: "failure" }, { Conclusion: "skipped" }] },
        { Name: "deploy", Status: "in_progress", Conclusion: "", Steps: [] },
    ] };
    assert.deepEqual(filterTimelineJobs(timeline, "failure").map((row) => row.Name), ["test"]);
    assert.equal(filterTimelineJobs(timeline, "failure")[0].Steps.length, 3);
    assert.equal(filterTimelineJobs(timeline, "completed").length, 2);
    assert.deepEqual(filterTimelineJobs(timeline, "in_progress").map((row) => row.Name), ["deploy"]);
    assert.deepEqual(filterTimelineJobs(timeline, "cancelled"), []);
    assert.deepEqual(filterTimelineJobs(timeline), timeline.Jobs);
    assert.equal(timeline.Jobs.length, 3);
    assert.deepEqual(filterTimelineJobs(null, "failure"), []);
    timeline.Repo = "owner/repo";
    assert.equal(filterTimelineJobs(timeline, "failure", "owner/repo").length, 1);
    assert.deepEqual(filterTimelineJobs(timeline, "", "owner/other"), []);
    assert.deepEqual(filterTimelineJobs(timeline, "", ""), timeline.Jobs);
    assert.equal(timeline.Jobs.length, 3);
});

test("a step literally named like an occurrence key stays apart", () => {
    const literal = { ...step(1, "build", 101, 4, "Upload #2", 43, 45), StepKey: "Upload #2", StepOccurrence: 1 };
    const second = { ...step(1, "build", 101, 5, "Upload", 41, 43), StepOccurrence: 2 };
    // Without StepOccurrence the occurrence is recovered from the display key.
    const { StepOccurrence: _, ...legacySecond } = second;
    for (const rows of [[step(1, "build", 101, 3, "Upload", 37, 40), second, literal], [step(1, "build", 101, 3, "Upload", 37, 40), legacySecond, literal]]) {
        const result = aggregateSteps({ jobs: [job(1, "build", 1, 51)], steps: rows });
        assert.equal(result.stepStats.length, 3);
        assert.equal(new Set(result.stepStats.map((row) => row.id)).size, 3);
        assert.ok(result.stepStats.every((row) => row.samples === 1));
        assert.equal(result.typicalTimeline[0].steps.length, 3);
    }
});

test("workflow files sharing a display name stay apart", () => {
    const other = (row) => ({ ...row, WorkflowPath: ".github/workflows/release.yml" });
    const result = aggregateSteps({
        jobs: [job(1, "build", 1, 51), other(job(2, "build", 1, 41))],
        steps: [step(1, "build", 101, 2, "Compile", 6, 36), other(step(2, "build", 102, 2, "Compile", 6, 46))],
    });
    assert.equal(result.stepStats.length, 2);
    assert.equal(result.jobStats.length, 2);
    assert.deepEqual(result.jobStats.map((row) => row.workflowPath).sort(), [".github/workflows/build.yml", ".github/workflows/release.yml"]);
});

test("jobs without timestamps contribute no zero duration or wait", () => {
    const queued = { ...job(2, "build", 1, 41), StartedAt: null, CompletedAt: null, Duration: 0, Wait: 0, Conclusion: "" };
    const result = aggregateSteps({ jobs: [job(1, "build", 1, 51), queued], steps: [step(1, "build", 101, 2, "Compile", 6, 36)] });
    const build = result.jobStats.find((row) => row.job === "build");
    assert.equal(build.runs, 2);
    assert.equal(build.duration.p50, 50_000);
    assert.equal(build.wait.p50, 2_000);
});

test("job failure rate only counts decided jobs", () => {
    const jobs = [job(1, "build", 1, 51, "failure"), job(2, "build", 1, 41, "cancelled"), job(3, "build", 1, 31, "skipped")];
    const result = aggregateSteps({ jobs, steps: [] });
    assert.equal(result.jobStats[0].failureRate, 1);
    assert.equal(result.runners[0].failureRate, 1);
});

test("typical job offsets are sampled once per job", () => {
    const late = (row) => ({ ...row, JobStartedAt: sec(21) });
    const steps = [
        step(1, "build", 101, 1, "A", 1, 2), step(1, "build", 101, 2, "B", 2, 3), step(1, "build", 101, 3, "C", 3, 4),
        late(step(2, "build", 102, 1, "A", 21, 22)),
        late(step(3, "build", 103, 1, "A", 21, 22)),
    ];
    const result = aggregateSteps({ jobs: [], steps });
    assert.equal(result.typicalTimeline[0].startOffsetMs, 21_000);
});

test("aggregateSteps handles more timestamps than a call accepts as arguments", () => {
    const steps = Array.from({ length: 70_000 }, (_, index) => step(index, "build", 1000 + index, 2, "Compile", 6, 36));
    const result = aggregateSteps({ jobs: [], steps });
    assert.ok(result.meta.newest);
    assert.equal(result.meta.maxRunsPerRepo, 70_000);
});

test("maxRunsPerRepo counts runs per repository before the runner filter", () => {
    const elsewhere = (row) => ({ ...row, Repo: "owner/other" });
    const jobs = [job(1, "build", 1, 51), job(2, "build", 1, 41), elsewhere(job(3, "build", 1, 31))];
    const result = aggregateSteps({ jobs, steps: [], runner: { name: "nobody" } });
    assert.equal(result.meta.analysedRuns, 0);
    assert.equal(result.meta.maxRunsPerRepo, 2);
});

test("runTimelineHost follows the host a run URL or repository names", async () => {
    const { runTimelineHost } = await import("../lib/timeline.mjs");
    const target = { kind: "repo", host: "ghe.example.com", owner: "o", name: "r" };
    assert.equal(runTimelineHost({ target, run: "https://github.com/o/r/actions/runs/1" }), "github.com");
    assert.equal(runTimelineHost({ target, repo: "other.example.com/o/r", run: "1" }), "other.example.com");
    assert.equal(runTimelineHost({ target, repo: "o/r", run: "1" }), "ghe.example.com");
    assert.equal(runTimelineHost({ target: null, run: "1" }), null);
    assert.equal(runTimelineHost({ target, run: "https://ghe.internal:8443/o/r/actions/runs/1" }), "ghe.internal:8443");
});

test("stepIdOf tells a literal occurrence name from a repeated step", async () => {
    const { stepIdOf } = await import("../shared/steps.mjs");
    assert.notEqual(stepIdOf("Upload #2", "Upload #2"), stepIdOf("Upload", "Upload #2"));
    assert.equal(stepIdOf("Upload", "Upload #2"), stepIdOf("Upload", "Upload #2", 2));
    assert.equal(stepIdOf("Upload #2", "Upload #2", 1), stepIdOf("Upload #2", "Upload #2"));
});

test("reportsRunCapReached reads the truncated repository count from CLI stderr", async () => {
    const { reportsRunCapReached } = await import("../lib/steprows.mjs");
    assert.equal(reportsRunCapReached('time=x level=WARN msg="metrics: --max-runs was reached, so older runs were not collected" truncated_repos=2\n'), true);
    assert.equal(reportsRunCapReached("level=WARN truncated_repos=0"), false);
    assert.equal(reportsRunCapReached("level=INFO msg=progress"), false);
    assert.equal(reportsRunCapReached(undefined), false);
});

test("a step filter keeps every job that ran a step in the presence denominator", () => {
    const jobs = [job(1, "build", 1, 51), job(2, "build", 1, 41)];
    const steps = [
        step(1, "build", 101, 1, "Set up job", 1, 2),
        step(1, "build", 101, 2, "Deploy", 6, 36),
        step(2, "build", 102, 1, "Set up job", 1, 2),
    ];
    const result = aggregateSteps({ jobs, steps, stepPattern: "Dep*" });
    assert.deepEqual(result.stepStats.map((row) => row.stepKey), ["Deploy"]);
    assert.equal(result.stepStats[0].jobs, 2);
    assert.equal(result.stepStats[0].presence, 0.5);
});

test("a timed out step counts as failed", () => {
    const jobs = [job(1, "build", 1, 51), job(2, "build", 1, 41)];
    const steps = [
        step(1, "build", 101, 2, "Compile", 6, 36),
        step(2, "build", 102, 2, "Compile", 6, 40, "timed_out"),
    ];
    const result = aggregateSteps({ jobs, steps });
    const compile = result.stepStats.find((row) => row.stepKey === "Compile");
    assert.equal(compile.failed, 1);
    assert.equal(compile.failureRate, 0.5);
    assert.equal(result.typicalTimeline[0].steps.find((row) => row.name === "Compile").failed, true);
    assert.equal(result.typicalTimeline[0].steps.find((row) => row.name === "Compile").failureRate, 0.5);
});

test("timeline failure rates share step-statistic denominators, filters and job identities", () => {
    const jobs = [
        { ...job(1, "build", 1, 51), Kind: "hosted" },
        { ...job(2, "build", 1, 41, "failure"), Kind: "self-hosted" },
        { ...job(3, "build", 1, 31), Kind: "hosted" },
        { ...job(4, "build", 1, 31), Kind: "self-hosted", Conclusion: null, Status: "in_progress" },
        { ...job(5, "test", 1, 21), Kind: "hosted" },
    ];
    const steps = [
        { ...step(1, "build", 101, 2, "Compile", 6, 36), Kind: "hosted" },
        { ...step(2, "build", 102, 2, "Compile", 6, 40, "failure"), Kind: "self-hosted" },
        { ...step(3, "build", 103, 2, "Compile", null, null, "skipped"), Kind: "hosted" },
        { ...step(4, "build", 104, 2, "Compile", 6, null), Kind: "self-hosted", StepConclusion: null, StepStatus: "in_progress" },
        { ...step(5, "test", 105, 2, "Compile", 6, 16), Kind: "hosted" },
    ];
    for (const [filters, expected] of [
        [{}, 1 / 3],
        [{ jobStatus: "failure" }, 1],
        [{ jobStatus: "success" }, 0],
        [{ runner: { kind: "self-hosted" } }, 0.5],
        [{ runner: { kind: "github-hosted" } }, 0],
    ]) {
        const result = aggregateSteps({ jobs, steps, ...filters });
        const timeline = result.typicalTimeline.find((row) => row.job === "build").steps[0];
        const statistic = result.stepStats.find((row) => row.job === "build");
        assert.equal(timeline.failureRate, expected);
        assert.equal(timeline.failureRate, statistic.failureRate);
    }
    const limited = aggregateSteps({ jobs, steps, limit: 1 });
    assert.equal(limited.stepStats.length, 1);
    assert.equal(limited.typicalTimeline.find((row) => row.job === "test").steps[0].failureRate, 0);
});

test("matchWildcard mirrors the CLI pattern semantics", () => {
    assert.equal(matchWildcard("Deploy", "Deploy"), true);
    assert.equal(matchWildcard("Deploy", "Deploy now"), false);
    assert.equal(matchWildcard("Run actions/*@v4", "Run actions/checkout@v4"), true);
    assert.equal(matchWildcard("*cache*", "Restore cache"), true);
    assert.equal(matchWildcard("a*b*c", "acb"), false);
});

test("parseCollectionWarning keeps the CLI collection warnings only", async () => {
    const { parseCollectionWarning } = await import("../lib/steprows.mjs");
    assert.equal(parseCollectionWarning('time=x level=WARN msg="metrics: Jobs for run #3: \\"not found\\""'), 'Jobs for run #3: "not found"');
    assert.equal(parseCollectionWarning("time=x level=WARN msg=metrics:"), null);
    assert.equal(parseCollectionWarning('time=x level=WARN msg="metrics: --max-runs was reached, so older runs were not collected" truncated_repos=2'), null);
    assert.equal(parseCollectionWarning('time=x level=INFO msg="metrics: wrote the snapshot"'), null);
    assert.equal(parseCollectionWarning('time=x level=WARN msg="something else"'), null);
});

test("snapshotCommand collects once and the reports read it through --input", () => {
    const target = { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null };
    const filters = { days: 7, workflow: "", runnerType: "auto", includeRepos: [], excludeRepos: [], labels: ["linux"] };
    const collect = snapshotCommand({ target, filters, limits: {}, workflow: "ci.yml", runBudget: 20, output: "/tmp/s.json.gz" });
    assert.deepEqual(collect.args.slice(0, 5), ["runner-kit", "metrics", "collect", "--repo", "owner/repo"]);
    assert(!collect.args.includes("--format"));
    assert.equal(collect.args[collect.args.indexOf("--workflow") + 1], "ci.yml");
    assert.equal(collect.args[collect.args.indexOf("--max-runs") + 1], "20");
    assert.equal(collect.args[collect.args.indexOf("--output") + 1], "/tmp/s.json.gz");
    const steps = stepRowsCommand({ target, filters, limits: {}, workflow: "ci.yml", runBudget: 20, kind: "all", input: "/tmp/s.json.gz" });
    assert.deepEqual(steps.args.slice(0, 7), ["runner-kit", "metrics", "steps", "--input", "/tmp/s.json.gz", "--format", "ndjson"]);
    for (const flag of ["--repo", "--days", "--workflow", "--max-runs"]) assert(!steps.args.includes(flag), flag);
    assert.equal(steps.args[steps.args.indexOf("--label") + 1], "linux");
    const jobs = jobRowsCommand({ target, filters, limits: {}, kind: "all", input: "/tmp/s.json.gz" });
    assert.deepEqual(jobs.args.slice(0, 7), ["runner-kit", "metrics", "jobs", "--input", "/tmp/s.json.gz", "--format", "ndjson"]);
    assert(!jobs.args.includes("--days"));
});

test("effectiveStepSettings keeps the in-flight selection of the same target only", () => {
    const received = { workflow: "ci.yml", includeAllAttempts: false, jobStatus: "" };
    const pending = { seq: 2, identity: "owner/repo", settings: { workflow: "ci.yml", includeAllAttempts: true, jobStatus: "" } };
    assert.equal(effectiveStepSettings(received, pending, "owner/repo").includeAllAttempts, true);
    assert.equal(effectiveStepSettings(received, pending, "owner/other").includeAllAttempts, false);
    assert.deepEqual(effectiveStepSettings(received, null, "owner/repo"), received);
    assert.equal(effectiveStepSettings(undefined, pending, "owner/repo").includeAllAttempts, true);
    assert.deepEqual(effectiveStepSettings(undefined, null, "owner/repo"), {});
});
