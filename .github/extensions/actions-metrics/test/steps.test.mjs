import test from "node:test";
import assert from "node:assert/strict";

import { aggregateSteps, displayStepName, downsampleNewest, effectiveStepSettings, filterTimelineJobs, formatDuration, formatLabelSet, isRecoveredJobStatus, isRunnerFilterActive, labelSetKey, matchJobStatus, matchRunner, matchWildcard, matrixMergeMap, normalizeFailedStep, normalizeJobStatus, normalizeRunnerFilter, normalizeStepFilters, percentile, runnerFilterSelections, splitLabelSet, stepKey, timelineMatchesWorkflow, toggleRunnerFilterValue } from "../shared/steps.mjs";

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

test("individual runner selection matches literal names without changing wildcard filters", () => {
    const literal = { runnerName: "box*" };
    const other = { runnerName: "box-02" };
    assert.equal(matchRunner(literal, { name: "box*", nameExact: true }), true);
    assert.equal(matchRunner(other, { name: "box*", nameExact: true }), false);
    assert.equal(matchRunner(other, { name: "box*" }), true);
    assert.deepEqual(normalizeRunnerFilter({ name: " box* ", nameExact: true }), {
        kind: "all", labels: "", group: "", name: "box*", nameExact: true,
    });
    assert.deepEqual(normalizeRunnerFilter({ name: "", nameExact: true }), normalizeRunnerFilter());
});

test("runner selections migrate scalar preferences without changing exact or wildcard semantics", () => {
    const legacy = { kind: "self-hosted", labels: "linux,self-hosted", group: "Default", name: "box*", nameExact: true };
    assert.deepEqual(runnerFilterSelections(legacy), {
        kinds: ["self-hosted", "unknown"], labelSets: ["linux,self-hosted"], groups: ["Default"], names: ["box*"],
    });
    const names = toggleRunnerFilterValue(legacy, "names", "box-b");
    assert.deepEqual(names.names, ["box*", "box-b"]);
    assert.equal(names.name, "");
    assert.equal(Object.hasOwn(names, "nameExact"), false);
    assert.deepEqual(toggleRunnerFilterValue(names, "names", "box*").names, ["box-b"]);
    const labels = toggleRunnerFilterValue(legacy, "labelSets", "macos");
    assert.deepEqual(labels.labelSets, ["linux,self-hosted", "macos"]);
    assert.equal(labels.labels, "");
    assert.deepEqual(toggleRunnerFilterValue(labels, "labelSets", "SELF-HOSTED,LINUX").labelSets, ["macos"]);
    assert.deepEqual(toggleRunnerFilterValue(legacy, "kinds", "hosted").kinds, ["self-hosted", "unknown", "hosted"]);
    assert.deepEqual(toggleRunnerFilterValue(legacy, "groups", "Other").groups, ["Default", "Other"]);
    assert.equal(legacy.name, "box*");
    assert.equal(legacy.nameExact, true);
    assert.equal(isRunnerFilterActive({ names: ["box-a"] }), true);
    assert.equal(isRunnerFilterActive({ names: [] }), false);
    assert.deepEqual(normalizeRunnerFilter({ names: ["box-a", "box-a", "", null], kinds: ["hosted", "invalid"] }), {
        ...normalizeRunnerFilter(), names: ["box-a"], kinds: ["hosted"],
    });
    const pattern = { name: "box*", names: ["other"] };
    assert.equal(matchRunner({ runnerName: "box-b" }, pattern), true);
    assert.equal(matchRunner({ runnerName: "other" }, pattern), true);
    assert.equal(matchRunner({ runnerName: "missing" }, pattern), false);
    assert.deepEqual(runnerFilterSelections({ name: "box-a" }).names, ["box-a"]);
    assert.deepEqual(toggleRunnerFilterValue({ name: "box-a" }, "names", "box-b").names, ["box-a", "box-b"]);
});

test("runner facets OR their values and AND dimensions across every aggregate", () => {
    const jobs = [
        onRunner(job(1, "build", 2, 12), ["self-hosted", "linux"], "self-hosted", "box*"),
        { ...onRunner(job(2, "build", 2, 22), ["macos"], "self-hosted", "box-b"), RunnerGroup: "Other" },
        onRunner(job(3, "build", 2, 32), ["self-hosted", "linux"], "self-hosted", "box-02"),
        onRunner(job(4, "build", 2, 42), ["ubuntu-latest"], "hosted", "GitHub Actions"),
    ];
    const steps = jobs.map(row => ({
        ...onRunner(step(Number(row.JobID), "build", row.RunID, 1, "Compile", 2, 7), row.Labels, row.Kind, row.RunnerName),
        RunnerGroup: row.RunnerGroup,
    }));
    const filter = {
        kinds: ["self-hosted", "unknown"], labelSets: ["LINUX,SELF-HOSTED", "macos"],
        groups: ["Default", "Other"], names: ["box*", "box-b"],
    };
    const result = aggregateSteps({ jobs, steps, runner: filter });
    assert.equal(result.meta.totalJobs, 2);
    assert.equal(result.meta.totalStepRows, 2);
    assert.equal(result.meta.analysedRuns, 2);
    assert.equal(result.stepStats[0].samples, 2);
    assert.equal(result.jobStats[0].runs, 2);
    assert.equal(result.typicalTimeline.length, 1);
    assert.deepEqual(result.runs.map(row => row.runId), ["102", "101"]);
    assert.deepEqual(result.runners.flatMap(pool => pool.individuals.map(row => row.name)).sort(), ["box*", "box-b"]);
    assert.equal(result.runners.reduce((sum, pool) => sum + pool.duration.total, 0), 30000);
    assert.equal(result.runnerFacets.names.length, 4);
    assert.deepEqual(result.runnerFacets, aggregateSteps({ jobs, steps }).runnerFacets);
    const narrower = aggregateSteps({ jobs, steps, runner: { ...filter, groups: ["Default"] } });
    assert.deepEqual(narrower.runs.map(row => row.runId), ["101"]);
    const empty = aggregateSteps({ jobs, steps, runner: { ...filter, names: ["missing"] } });
    assert.deepEqual(empty.runners, []);
    assert.deepEqual(empty.runs, []);
    assert.deepEqual(empty.runnerFacets, result.runnerFacets);
    assert.equal(matchRunner({ kind: "unknown" }, { kinds: ["self-hosted"] }), false);
    assert.equal(matchRunner({ kind: "unknown" }, { kinds: ["unknown"] }), true);
});

function onRunner(row, labels, kind, runnerName) {
    return { ...row, Labels: labels, Kind: kind, RunnerName: runnerName, RunnerGroup: kind === "hosted" ? "GitHub Actions" : "Default" };
}

test("runner pools retain totals and expose only non-hosted individual statistics", () => {
    const labels = ["self-hosted", "linux"];
    const jobs = [
        onRunner(job(1, "build", 2, 12), labels, "self-hosted", "box-a"),
        onRunner({ ...job(2, "build", 2, 32, "failure"), RunID: "101", RunAttempt: 2 }, ["LINUX", "self-hosted"], "self-hosted", "box-a"),
        onRunner(job(3, "build", 2, 22), labels, "self-hosted", "box-b"),
        onRunner(job(4, "build", 2, 7), labels, "unknown", "unknown-runner"),
        onRunner(job(5, "build", 2, 42), labels, "hosted", "box-a"),
        onRunner({ ...job(6, "build", 2, 3), StartedAt: null, CompletedAt: null, Conclusion: "", Wait: 0, Duration: 0 }, labels, "unknown", ""),
        onRunner(job(7, "build", 2, 12), ["ubuntu-latest"], "hosted", "GitHub Actions"),
    ];
    const steps = jobs.filter(row => row.StartedAt).map(row => ({
        ...onRunner(step(Number(row.JobID), "build", row.RunID, 1, "Compile", 2, 7, row.Conclusion), row.Labels, row.Kind, row.RunnerName),
        RunAttempt: row.RunAttempt,
    }));
    const result = aggregateSteps({ jobs, steps, includeAllAttempts: true });
    const pool = result.runners.find(row => row.key === labelSetKey(labels));
    assert.equal(pool.jobs, 6);
    assert.equal(pool.duration.total, 105000);
    assert.equal(pool.duration.samples, 5);
    assert.equal(pool.failureRate, 0.2);
    assert.equal(pool.individuals.length, 4);
    const byName = new Map(pool.individuals.map(row => [row.name, row]));
    const first = byName.get("box-a");
    assert.equal(first.jobs, 2);
    assert.deepEqual(first.wait, { p50: 2000, p90: 2000, samples: 2 });
    assert.deepEqual(first.duration, { p50: 10000, p90: 30000, samples: 2, total: 40000 });
    assert.equal(first.failureRate, 0.5);
    assert.deepEqual(first.kinds, [{ value: "self-hosted", count: 2 }]);
    assert.equal(byName.get("box-b").duration.total, 20000);
    assert.equal(byName.get("unknown-runner").duration.total, 5000);
    assert.equal(byName.get("").jobs, 1);
    assert.equal(byName.get("").wait.samples, 0);
    assert.equal(byName.get("").duration.samples, 0);
    assert.equal(byName.get("").duration.total, 0);
    assert.equal(pool.individuals.reduce((sum, row) => sum + row.jobs, 0), 5);
    assert.deepEqual(result.runners.find(row => row.key === labelSetKey(["ubuntu-latest"])).individuals, []);

    const filtered = aggregateSteps({
        jobs, steps, includeAllAttempts: true,
        runner: { kind: "self-hosted", labels: "linux,self-hosted", name: "box-a", nameExact: true },
    });
    assert.equal(filtered.meta.totalJobs, 2);
    assert.equal(filtered.meta.totalStepRows, 2);
    assert.equal(filtered.stepStats[0].samples, 2);
    assert.equal(filtered.typicalTimeline.length, 1);
    assert.deepEqual(filtered.runs.map(row => row.runAttempt).sort(), [1, 2]);
    assert.equal(filtered.runners.length, 1);
    assert.equal(filtered.runners[0].jobs, 2);
    assert.equal(filtered.runners[0].duration.total, 40000);
    assert.deepEqual(filtered.runners[0].individuals.map(row => row.name), ["box-a"]);
    assert.deepEqual(filtered.runnerFacets, result.runnerFacets);
});

test("individual runner summaries respect repository, job and status selections", () => {
    const base = onRunner(job(1, "build", 2, 12, "failure"), ["self-hosted"], "self-hosted", "box-a");
    const jobs = [
        base,
        { ...base, JobID: "2", Repo: "example/other", RunnerName: "other-repository" },
        { ...base, JobID: "3", JobName: "test", RunnerName: "other-job" },
        { ...base, JobID: "4", Conclusion: "success", RunnerName: "other-status" },
    ];
    const result = aggregateSteps({ jobs, repository: base.Repo, selectedJob: "build", jobStatus: "failure" });
    assert.equal(result.runners.length, 1);
    assert.deepEqual(result.runners[0].individuals.map(row => [row.name, row.jobs]), [["box-a", 1]]);
});

test("runner filter narrows statistics and pools while facets keep every runner", () => {
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
    assert.equal(linux.duration.total, 50_000);
    assert.deepEqual(linux.runners.map((item) => item.value), ["box-1"]);

    const filtered = aggregateSteps({ jobs, steps, runner: { kind: "self-hosted" } });
    assert.equal(filtered.stepStats[0].samples, 1);
    assert.equal(filtered.stepStats[0].duration.p50, 10_000);
    assert.equal(filtered.meta.totalJobs, 2);
    assert.equal(filtered.meta.unfilteredJobs, 3);
    assert.equal(filtered.runners.length, 1);
    assert.equal(filtered.runners.find((pool) => pool.key === linux.key).duration.total, 50_000);
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
    assert.equal(filtered.runners.reduce((sum, pool) => sum + pool.jobs, 0), 1);
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
    assert.equal(result.runners.reduce((sum, pool) => sum + pool.jobs, 0), 1);
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
    assert.equal(queued.runners[0].duration.total, 0);
    const empty = aggregateSteps({ jobs, steps: [step(2, "build", 102, 1, "Compile", 1, 11)], jobStatus: "failure" });
    assert.equal(empty.meta.totalJobs, 0);
    assert.equal(empty.meta.totalStepRows, 0);
    for (const key of ["stepStats", "jobStats", "typicalTimeline", "runs", "runners"]) assert.deepEqual(empty[key], []);
    assert.deepEqual(empty.jobStatusFacets, [{ value: "queued", count: 1 }]);
});

function recoveryJob(id, run, attempt, conclusion, patch = {}) {
    return {
        ...onRunner(job(id, "test (linux)", 1, 11, conclusion), ["self-hosted", "linux"], "self-hosted", "box-a"),
        RunID: String(run), RunAttempt: attempt, ...patch,
    };
}

function recoverySteps(jobs) {
    return jobs.map(row => ({
        ...onRunner(step(Number(row.JobID), row.JobName, row.RunID, 1, "Test", 1, 6, row.Conclusion), row.Labels, row.Kind, row.RunnerName),
        Repo: row.Repo, WorkflowPath: row.WorkflowPath, RunAttempt: row.RunAttempt, JobConclusion: row.Conclusion,
    }));
}

test("re-run recovery requires an observed failure before the latest successful job execution", () => {
    assert.equal(isRecoveredJobStatus(" RERUN_SUCCESS "), true);
    assert.equal(isRecoveredJobStatus("success"), false);
    for (const [conclusions, expected] of [
        [["failure", "success"], 2],
        [["timed_out", "success"], 2],
        [["startup_failure", "failure", "success"], 3],
        [["success"], 0],
        [["success", "success"], 0],
        [["cancelled", "success"], 0],
        [["skipped", "success"], 0],
        [["failure", "failure"], 0],
        [["failure", "success", "failure"], 0],
        [["failure", "success", ""], 0],
    ]) {
        const rows = conclusions.map((value, index) => recoveryJob(100 + index, 500, index + 1, value));
        for (const jobs of [rows, [...rows].reverse()]) {
            const result = aggregateSteps({ jobs, steps: recoverySteps(jobs), jobStatus: "rerun_success" });
            assert.equal(result.meta.totalJobs, expected, conclusions.join(" -> "));
            assert.equal(result.meta.totalStepRows, expected);
            assert.equal(result.includeAllAttempts, true);
            assert.equal(result.meta.latestAttemptBasis, false);
            assert.equal(result.runs.length, expected);
        }
    }
    const jobs = [recoveryJob(1, 500, 1, "failure", { Latest: false }), recoveryJob(2, 500, 2, "success", { Latest: false })];
    assert.equal(aggregateSteps({ jobs, jobStatus: "rerun_success" }).meta.totalJobs, 0);
    jobs[1].Latest = true;
    assert.equal(aggregateSteps({ jobs, jobStatus: "rerun_success" }).meta.totalJobs, 2);
});

test("recovery histories never join different repositories, workflows, runs, variants or the same attempt", () => {
    const failed = recoveryJob(1, 500, 1, "failure");
    const success = recoveryJob(2, 500, 2, "success");
    for (const patch of [
        { Repo: "owner/other" },
        { WorkflowPath: ".github/workflows/other.yml" },
        { RunID: "501" },
        { JobName: "test (macos)" },
        { RunAttempt: 1 },
    ]) {
        const result = aggregateSteps({ jobs: [failed, { ...success, ...patch }], jobStatus: "rerun_success" });
        assert.equal(result.meta.totalJobs, 0, JSON.stringify(patch));
    }
    const ambiguous = aggregateSteps({
        jobs: [failed, { ...failed, JobID: "3" }, success], jobStatus: "rerun_success",
    });
    assert.equal(ambiguous.meta.totalJobs, 0);
    assert.equal(ambiguous.meta.recovery.ambiguousJobs, 1);
});

test("recovered jobs retain failed steps and attempts across runner changes before matrix merging", () => {
    const jobs = [
        recoveryJob(1, 500, 1, "failure"),
        recoveryJob(2, 500, 2, "success", { RunnerName: "box-b" }),
        recoveryJob(3, 500, 1, "failure", { JobName: "test (macos)" }),
        recoveryJob(4, 500, 2, "failure", { JobName: "test (macos)" }),
    ];
    const steps = recoverySteps(jobs);
    const options = { jobs, steps, selectedJob: "test", jobStatus: "rerun_success", includeAllAttempts: false };
    const result = aggregateSteps(options);
    assert.equal(result.meta.recovery.matchedJobs, 1);
    assert.equal(result.meta.analysedRuns, 1);
    assert.equal(result.meta.analysedAttempts, 2);
    assert.equal(result.meta.totalJobs, 2);
    assert.equal(result.stepStats[0].job, "test");
    assert.deepEqual(result.stepStats[0].variants, ["test (linux)"]);
    assert.equal(result.stepStats[0].samples, 2);
    assert.equal(result.stepStats[0].failureRate, 0.5);
    assert.equal(result.stepStats[0].trend.points.length, 2);
    assert.equal(result.typicalTimeline[0].steps[0].failureRate, 0.5);
    assert.equal(result.runners[0].jobs, 2);
    assert.equal(result.runners[0].failureRate, 0.5);
    assert.deepEqual(result.runners[0].individuals.map(row => row.name).sort(), ["box-a", "box-b"]);
    assert.deepEqual(result.runs.map(row => [row.runAttempt, row.conclusion]), [[2, "success"], [1, "failure"]]);
    assert.ok(result.runs.every(row => row.recoveredJobs.join() === "test (linux)"));
    const failedRunner = aggregateSteps({ ...options, runner: { names: ["box-a"] } });
    assert.equal(failedRunner.meta.totalJobs, 1);
    assert.equal(failedRunner.runs[0].conclusion, "failure");
    assert.equal(failedRunner.stepStats[0].samples, 1);
    assert.deepEqual(failedRunner.runnerFacets, result.runnerFacets);
    for (const attempt of [1, 2]) {
        const timeline = {
            Repo: "owner/repo", RunID: "500", RunAttempt: attempt, WorkflowPath: ".github/workflows/build.yml",
            Jobs: [
                { Name: "test (linux)", Conclusion: attempt === 1 ? "failure" : "success", Steps: [{ Name: "Test" }] },
                { Name: "test (macos)", Conclusion: "failure", Steps: [] },
            ],
        };
        const shown = filterTimelineJobs(timeline, "rerun_success", "", result.runs);
        assert.deepEqual(shown.map(row => row.Name), ["test (linux)"]);
        assert.equal(shown[0].Steps.length, 1);
        assert.equal(timeline.Jobs.length, 2);
        assert.deepEqual(filterTimelineJobs(timeline, "rerun_success", "owner/other", result.runs), []);
    }
});

test("failed-step inputs preserve exact names and distinguish an occurrence from a step number", () => {
    assert.equal(normalizeFailedStep(), null);
    assert.equal(normalizeFailedStep(null), null);
    assert.equal(normalizeFailedStep({ name: "" }), null);
    assert.deepEqual(normalizeFailedStep({ name: " Compile* " }), { name: " Compile* ", occurrence: 1 });
    assert.deepEqual(normalizeFailedStep({ name: "Upload", occurrence: 2 }), { name: "Upload", occurrence: 2 });
    for (const input of ["Compile", [], {}, { name: 1 }]) assert.throws(() => normalizeFailedStep(input), TypeError);
    for (const occurrence of [0, -1, 1.5, "2", true]) {
        assert.throws(() => normalizeFailedStep({ name: "Upload", occurrence }), RangeError);
    }
});

test("failed-step filtering keeps whole matching job attempts across every statistical surface", () => {
    const jobs = [
        recoveryJob(1, 500, 1, "failure", { Latest: false }),
        recoveryJob(2, 500, 2, "success", { RunnerName: "box-b", Latest: true }),
        recoveryJob(3, 500, 1, "failure", { JobName: "test (macos)", Latest: true }),
        recoveryJob(4, 501, 1, "success", { RunnerName: "box-c", Latest: true }),
    ];
    const tests = recoverySteps(jobs).map((row, index) => ({ ...row, StepConclusion: [0, 3].includes(index) ? "failure" : "success" }));
    const steps = tests.flatMap(row => [
        row,
        { ...row, StepName: "Prepare", StepKey: "Prepare", StepNumber: 2, StepConclusion: "success" },
        { ...row, StepName: "Upload", StepKey: "Upload", StepNumber: 3, StepConclusion: "skipped", StartedAt: null, CompletedAt: null },
    ]);
    const options = { jobs, steps, includeAllAttempts: true, failedStep: { name: "Test" } };
    const result = aggregateSteps(options);
    assert.deepEqual(result.failedStep, { name: "Test", occurrence: 1 });
    assert.equal(result.meta.failedStepSupported, true);
    assert.equal(result.meta.totalJobs, 2);
    assert.equal(result.meta.totalStepRows, 6);
    assert.equal(result.meta.analysedRuns, 2);
    assert.equal(result.meta.analysedAttempts, 2);
    assert.equal(result.stepStats.length, 3);
    assert.equal(result.stepStats.find(row => row.stepName === "Test").failureRate, 1);
    assert.equal(result.stepStats.find(row => row.stepName === "Test").trend.points.length, 2);
    assert.equal(result.stepStats.find(row => row.stepName === "Prepare").samples, 2);
    assert.equal(result.stepStats.find(row => row.stepName === "Upload").skipped, 2);
    assert.equal(result.jobStats[0].runs, 2);
    assert.equal(result.jobStats[0].job, "test");
    assert.deepEqual(result.jobStats[0].variants, ["test (linux)"]);
    assert.equal(result.typicalTimeline[0].steps.find(row => row.name === "Test").failureRate, 1);
    assert.equal(result.typicalTimeline[0].steps.find(row => row.name === "Prepare").failureRate, 0);
    assert.equal(result.runners[0].jobs, 2);
    assert.deepEqual(result.runners[0].individuals.map(row => row.name).sort(), ["box-a", "box-c"]);
    assert.deepEqual(result.runs.map(row => [row.runId, row.runAttempt, row.conclusion]), [["501", 1, "success"], ["500", 1, "failure"]]);
    assert.deepEqual(result.failedStepFacets, [{ name: "Test", occurrence: 1, count: 2 }]);
    for (const patch of [{ failedStep: { name: "test" } }, { failedStep: { name: "Test*" } }, { repository: "owner/other" }, { selectedJob: "missing" }, { runner: { names: ["box-b"] } }]) {
        const empty = aggregateSteps({ ...options, ...patch });
        assert.equal(empty.runs.length, 0, JSON.stringify(patch));
        assert.equal(empty.stepStats.length, 0);
        assert.equal(empty.runners.length, 0);
    }
    const recovery = aggregateSteps({ ...options, includeAllAttempts: false, jobStatus: "rerun_success" });
    assert.equal(recovery.meta.recovery.matchedJobs, 1);
    assert.equal(recovery.meta.totalJobs, 1);
    assert.deepEqual(recovery.runs.map(row => [row.runAttempt, row.conclusion]), [[1, "failure"]]);
    assert.equal(recovery.stepStats.find(row => row.stepName === "Prepare").samples, 1);
    assert.equal(aggregateSteps({ ...options, jobStatus: "success" }).meta.totalJobs, 1);
    const runner = aggregateSteps({ ...options, runner: { names: ["box-a"] } });
    assert.equal(runner.runners[0].jobs, 1);
    assert.deepEqual(runner.failedStepFacets, result.failedStepFacets);
    assert.deepEqual(runner.runnerFacets, result.runnerFacets);
    const latest = aggregateSteps({ ...options, jobs: jobs.filter(row => row.Latest), steps: steps.filter(row => row.JobID !== "1"), includeAllAttempts: false });
    assert.equal(latest.meta.totalJobs, 1);
    assert.equal(latest.includeAllAttempts, false);
});

test("failed steps join exact repository, workflow, run, attempt and job identities without borrowing outcomes", () => {
    const row = recoveryJob(1, 500, 1, "failure");
    const failed = recoverySteps([row])[0];
    const successful = { ...failed, StepConclusion: "success" };
    for (const patch of [
        { Repo: "owner/other" }, { WorkflowPath: ".github/workflows/other.yml" },
        { RunID: "501" }, { RunAttempt: 2 }, { JobID: "2" },
    ]) {
        const result = aggregateSteps({ jobs: [row], steps: [successful, { ...failed, ...patch }], failedStep: { name: "Test" } });
        assert.equal(result.meta.totalJobs, 0, JSON.stringify(patch));
        assert.equal(result.meta.totalStepRows, 0);
        assert.equal(result.runs.length, 0);
    }
    for (const StepConclusion of ["success", "timed_out", "cancelled", "skipped", ""]) {
        assert.equal(aggregateSteps({ jobs: [row], steps: [{ ...failed, StepConclusion }], failedStep: { name: "Test" } }).meta.totalJobs, 0);
    }
    const joined = aggregateSteps({
        jobs: [row],
        steps: [failed, { ...successful, RunAttempt: 2 }, { ...successful, JobID: "2" }],
        failedStep: { name: "Test" },
    });
    assert.equal(joined.meta.totalJobs, 1);
    assert.equal(joined.meta.totalStepRows, 1);
    const unnamedId = { ...row, JobID: "" };
    const fallback = aggregateSteps({
        jobs: [unnamedId, { ...unnamedId, JobName: "other" }],
        steps: [{ ...failed, JobID: "" }],
        failedStep: { name: "Test" },
    });
    assert.equal(fallback.meta.totalJobs, 1);
});

test("failed-step choices distinguish repeated names and literal suffixes before display filtering", () => {
    const row = recoveryJob(1, 500, 1, "failure");
    const base = recoverySteps([row])[0];
    const duplicate = { ...base, StepName: "Upload", StepKey: "Upload #2", StepOccurrence: 2, StepNumber: 8 };
    const steps = [
        { ...base, StepName: "Upload", StepKey: "Upload", StepOccurrence: 1, StepConclusion: "success" },
        duplicate, duplicate,
        { ...base, StepName: "Upload #2", StepKey: "Upload #2", StepOccurrence: 1, StepConclusion: "success" },
        { ...base, StepName: "Post cleanup", StepKey: "Post cleanup", StepOccurrence: 1 },
        { ...base, StepName: "", StepKey: "Unnamed legacy step", StepOccurrence: 1 },
    ];
    const options = { jobs: [row], steps };
    const second = aggregateSteps({ ...options, failedStep: { name: "Upload", occurrence: 2 } });
    assert.equal(second.meta.totalJobs, 1);
    assert.deepEqual(second.failedStepFacets, [{ name: "Post cleanup", occurrence: 1, count: 1 }, { name: "Upload", occurrence: 2, count: 1 }]);
    for (const failedStep of [{ name: "Upload" }, { name: "Upload #2" }, { name: "Upload", occurrence: 8 }]) {
        assert.equal(aggregateSteps({ ...options, failedStep }).meta.totalJobs, 0);
    }
    const infra = aggregateSteps({ ...options, showInfra: false, stepPattern: "Upload*", failedStep: { name: "Post cleanup" } });
    assert.equal(infra.meta.totalJobs, 1);
    assert.ok(infra.stepStats.every(row => row.stepName.startsWith("Upload")));
    assert.deepEqual(infra.failedStepFacets, second.failedStepFacets);
});

test("failed-step run samples separate carried-over attempts even on the latest job-listing basis", () => {
    const jobs = [
        recoveryJob(1, 500, 1, "failure"),
        recoveryJob(2, 500, 2, "failure", { JobName: "other" }),
    ];
    const result = aggregateSteps({ jobs, steps: recoverySteps(jobs), failedStep: { name: "Test" } });
    assert.equal(result.meta.latestAttemptBasis, true);
    assert.deepEqual(result.runs.map(row => [row.runAttempt, row.jobs]), [[2, 1], [1, 1]]);
});

test("single-run failed-step filtering checks the job's own steps and intersects recovery and status", () => {
    const failedSteps = [
        { Name: "Upload", Key: "Upload", Occurrence: 1, Conclusion: "success" },
        { Name: "Upload", Key: "Upload #2", Occurrence: 2, Conclusion: "failure" },
        { Name: "Cleanup", Key: "Cleanup", Occurrence: 1, Conclusion: "skipped" },
    ];
    const timeline = { Repo: "owner/repo", RunID: "500", WorkflowPath: ".github/workflows/build.yml", Jobs: [
        { Name: "test", Conclusion: "failure", Steps: failedSteps },
        { Name: "other", Conclusion: "success", Steps: failedSteps },
        { Name: "retry", Conclusion: "success", Steps: failedSteps.map(step => ({ ...step, Conclusion: "success" })) },
        { Name: "missing", Conclusion: "failure" },
    ] };
    const failedStep = { name: "Upload", occurrence: 2 };
    assert.equal(filterTimelineJobs(timeline, "", "", [], failedStep).length, 2);
    const shown = filterTimelineJobs(timeline, "failure", "", [], failedStep);
    assert.deepEqual(shown.map(job => job.Name), ["test"]);
    assert.equal(shown[0].Steps.length, 3);
    assert.equal(filterTimelineJobs(timeline, "", "", [], { name: "Upload #2" }).length, 0);
    assert.equal(filterTimelineJobs(timeline, "", "", [], { name: "Upload" }).length, 0);
    assert.equal(filterTimelineJobs(timeline, "", "owner/other", [], failedStep).length, 0);
    const membership = [{ repo: "owner/repo", runId: "500", workflowPath: timeline.WorkflowPath, recoveredJobs: ["test", "retry"] }];
    assert.deepEqual(filterTimelineJobs(timeline, "rerun_success", "", membership, failedStep).map(job => job.Name), ["test"]);
    assert.equal(timeline.Jobs.length, 4);
    assert.equal(timeline.Jobs[0].Steps.length, 3);
});

test("step conditions normalize, deduplicate and explicitly override legacy failure selections", () => {
    assert.deepEqual(normalizeStepFilters({ failedStep: { name: "A" } }), {
        failedStep: { name: "A", occurrence: 1 }, stepConditions: [{ name: "A", occurrence: 1, conclusion: "failure" }],
    });
    for (const stepConditions of [[], null]) {
        assert.deepEqual(normalizeStepFilters({ stepConditions, failedStep: { name: "A" } }), { failedStep: null, stepConditions: [] });
    }
    const input = [{ name: " A* ", conclusion: " FAILURE " }, { name: "B", occurrence: 2, conclusion: "success" }, { name: " A* ", conclusion: "failure" }];
    const before = JSON.stringify(input);
    assert.deepEqual(normalizeStepFilters({ stepConditions: input }), {
        failedStep: null, stepConditions: [{ name: " A* ", occurrence: 1, conclusion: "failure" }, { name: "B", occurrence: 2, conclusion: "success" }],
    });
    assert.equal(JSON.stringify(input), before);
    for (const stepConditions of ["A", {}, [null], [{}], [{ name: "", conclusion: "failure" }], [{ name: "A" }], [{ name: "A", conclusion: " " }], [{ name: "A", conclusion: 1 }]]) {
        assert.throws(() => normalizeStepFilters({ stepConditions }), /stepConditions/);
    }
    assert.throws(() => normalizeStepFilters({ stepConditions: [{ name: "A", conclusion: "failure", occurrence: 0 }] }), RangeError);
});

test("AND conditions require A failure and B success in the same job execution on every statistical surface", () => {
    const jobs = [
        recoveryJob(1, 600, 1, "failure"),
        recoveryJob(2, 600, 2, "success", { RunnerName: "box-b" }),
        recoveryJob(3, 601, 1, "failure"),
        recoveryJob(4, 602, 1, "failure"),
        recoveryJob(5, 603, 1, "success", { RunnerName: "box-c" }),
    ];
    const steps = recoverySteps(jobs).flatMap((row, index) => [
        { ...row, StepName: "A", StepKey: "A", StepOccurrence: 1, StepConclusion: index === 1 ? "success" : "failure" },
        { ...row, StepName: "B", StepKey: "B", StepOccurrence: 1, StepConclusion: ["success", "success", "failure", "skipped", "success"][index] },
        { ...row, StepName: "Cleanup", StepKey: "Cleanup", StepOccurrence: 1, StepConclusion: "success" },
    ]);
    const stepConditions = [{ name: "A", conclusion: "failure" }, { name: "B", conclusion: "success" }];
    const options = { jobs, steps, stepConditions, includeAllAttempts: true };
    const result = aggregateSteps(options);
    assert.equal(result.meta.stepConditionsSupported, true);
    assert.equal(result.failedStep, null);
    assert.equal(result.meta.totalJobs, 2);
    assert.equal(result.meta.totalStepRows, 6);
    assert.equal(result.jobStats[0].runs, 2);
    assert.equal(result.runners[0].jobs, 2);
    assert.equal(result.stepStats.length, 3);
    assert.equal(result.stepStats.find(row => row.stepName === "A").failureRate, 1);
    assert.equal(result.stepStats.find(row => row.stepName === "B").failureRate, 0);
    assert.equal(result.stepStats.find(row => row.stepName === "Cleanup").samples, 2);
    assert.equal(result.stepStats[0].trend.points.length, 2);
    assert.equal(result.typicalTimeline[0].steps.length, 3);
    assert.deepEqual(result.runs.map(row => [row.runId, row.runAttempt]), [["603", 1], ["600", 1]]);
    assert.deepEqual(result.stepConditionFacets.find(step => step.name === "B").conclusions, [
        { value: "success", count: 3 }, { value: "failure", count: 1 }, { value: "skipped", count: 1 },
    ]);
    const focused = aggregateSteps({ ...options, runner: { names: ["box-a"] }, jobStatus: "failure", selectedJob: "test (linux)" });
    assert.equal(focused.runners[0].jobs, 1);
    assert.deepEqual(focused.stepConditionFacets, result.stepConditionFacets);
    const recovered = aggregateSteps({ ...options, jobStatus: "rerun_success", includeAllAttempts: false });
    assert.equal(recovered.meta.recovery.matchedJobs, 1);
    assert.deepEqual(recovered.runs.map(row => [row.runId, row.runAttempt]), [["600", 1]]);
    for (const patch of [{ repository: "owner/other" }, { selectedJob: "missing" }, { runner: { names: ["box-b"] } }]) {
        assert.equal(aggregateSteps({ ...options, ...patch }).stepStats.length, 0);
    }
    const cleared = aggregateSteps({ ...options, failedStep: { name: "A" }, stepConditions: [] });
    assert.equal(cleared.meta.totalJobs, 5);
    assert.equal(cleared.failedStep, null);
});

test("AND step conditions never borrow another job, attempt, workflow, run, repository or matrix outcome", () => {
    const row = recoveryJob(1, 600, 1, "failure");
    const a = { ...recoverySteps([row])[0], StepName: "A", StepKey: "A", StepConclusion: "failure" };
    const b = { ...a, StepName: "B", StepKey: "B", StepConclusion: "success" };
    const stepConditions = [{ name: "A", conclusion: "failure" }, { name: "B", conclusion: "success" }];
    for (const patch of [
        { Repo: "owner/other" }, { WorkflowPath: ".github/workflows/other.yml" },
        { RunID: "601" }, { RunAttempt: 2 }, { JobID: "2", JobName: "test (macos)" },
    ]) {
        const result = aggregateSteps({ jobs: [row], steps: [a, a, { ...b, ...patch }], stepConditions });
        assert.equal(result.meta.totalJobs, 0, JSON.stringify(patch));
        assert.equal(result.meta.totalStepRows, 0);
        assert.equal(result.runners.length, 0);
    }
    const result = aggregateSteps({ jobs: [row], steps: [a, a, b, b], stepConditions: [...stepConditions, ...stepConditions] });
    assert.equal(result.meta.totalJobs, 1);
    assert.equal(result.stepConditions.length, 2);
    assert.equal(result.stepConditionFacets.find(step => step.name === "B").count, 1);
    assert.equal(result.stepConditionFacets.find(step => step.name === "B").conclusions[0].count, 1);
});

test("step conditions distinguish occurrences and literal names, with missing and contradictory conditions matching nothing", () => {
    const row = recoveryJob(1, 600, 1, "failure");
    const base = recoverySteps([row])[0];
    const steps = [
        { ...base, StepName: "Upload", StepKey: "Upload", StepOccurrence: 1, StepConclusion: "failure" },
        { ...base, StepName: "Upload", StepKey: "Upload #2", StepOccurrence: 2, StepConclusion: "success" },
        { ...base, StepName: "Upload #2", StepKey: "Upload #2", StepOccurrence: 1, StepConclusion: "failure" },
    ];
    const options = { jobs: [row], steps };
    const conditions = [{ name: "Upload", conclusion: "failure" }, { name: "Upload", occurrence: 2, conclusion: "success" }];
    assert.equal(aggregateSteps({ ...options, stepConditions: conditions }).meta.totalJobs, 1);
    for (const extra of [
        { name: "Upload", occurrence: 2, conclusion: "failure" },
        { name: "upload", conclusion: "failure" },
        { name: "Upload*", conclusion: "failure" },
        { name: "missing", conclusion: "success" },
    ]) {
        assert.equal(aggregateSteps({ ...options, stepConditions: [...conditions, extra] }).meta.totalJobs, 0);
    }
    assert.equal(aggregateSteps({ ...options, stepConditions: [{ name: "Upload #2", conclusion: "failure" }, conditions[1]] }).meta.totalJobs, 1);
});

test("single-run AND conditions keep all job steps but do not combine outcomes from sibling jobs", () => {
    const timeline = { Repo: "owner/repo", RunID: "600", WorkflowPath: ".github/workflows/build.yml", Jobs: [
        { Name: "match", Conclusion: "failure", Steps: [{ Name: "A", Conclusion: "failure" }, { Name: "B", Conclusion: "success" }, { Name: "Other", Conclusion: "skipped" }] },
        { Name: "a-only", Conclusion: "failure", Steps: [{ Name: "A", Conclusion: "failure" }] },
        { Name: "b-only", Conclusion: "success", Steps: [{ Name: "B", Conclusion: "success" }] },
    ] };
    const before = JSON.stringify(timeline);
    const conditions = [{ name: "A", conclusion: "failure" }, { name: "B", conclusion: "success" }];
    const result = filterTimelineJobs(timeline, "", "", [], null, conditions);
    assert.deepEqual(result.map(job => job.Name), ["match"]);
    assert.equal(result[0].Steps.length, 3);
    assert.equal(filterTimelineJobs(timeline, "success", "", [], null, conditions).length, 0);
    assert.equal(JSON.stringify(timeline), before);
});

test("runner totals sum overlapping jobs and included attempts without adding wait or step times", () => {
    const first = onRunner(job(1, "build", 1, 51), ["ubuntu-latest"], "hosted", "GitHub Actions");
    const parallel = onRunner(job(2, "test", 1, 41), ["ubuntu-latest"], "hosted", "GitHub Actions");
    const retry = { ...first, JobID: "3", RunAttempt: 2, CompletedAt: sec(31), Duration: ns(30) };
    const jobs = [first, parallel, retry];
    const steps = [onRunner(step(1, "build", 101, 1, "Compile", 1, 11), ["ubuntu-latest"], "hosted", "GitHub Actions")];
    const all = aggregateSteps({ jobs, steps, includeAllAttempts: true });
    assert.equal(all.runners[0].duration.total, 120_000);
    assert.equal(all.runners[0].duration.samples, 3);
    const latest = aggregateSteps({ jobs: [parallel, retry], steps: [] });
    assert.equal(latest.runners[0].duration.total, 70_000);
    assert.equal(latest.runners[0].duration.samples, 2);
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
