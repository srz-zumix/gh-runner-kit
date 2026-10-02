import test from "node:test";
import assert from "node:assert/strict";

import { aggregateSteps, displayStepName, downsampleNewest, formatDuration, formatLabelSet, labelSetKey, matchRunner, matrixMergeMap, normalizeRunnerFilter, percentile, splitLabelSet, stepKey, timelineMatchesWorkflow } from "../shared/steps.mjs";

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
    assert.equal(Math.round(compile.share * 10) / 10, 0.8);
    const upload2 = result.stepStats.find((row) => row.stepKey === "Upload #2");
    assert.equal(upload2.executed, 1);
});

test("typical timeline uses median observed offsets", () => {
    const result = aggregateSteps({ jobs: [job(1, "build", 1, 21), job(2, "build", 1, 31)], steps: [step(1, "build", 101, 2, "Compile", 4, 10), step(2, "build", 102, 2, "Compile", 8, 20)] });
    const build = result.typicalTimeline.find((row) => row.job === "build");
    assert.equal(build.steps[0].offsetMs, 3_000);
    assert.equal(build.steps[0].durationMs, 6_000);
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

import { jobRowsCommand, runTimelineCommand, stepRowsCommand } from "../lib/runnerkit.mjs";

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
