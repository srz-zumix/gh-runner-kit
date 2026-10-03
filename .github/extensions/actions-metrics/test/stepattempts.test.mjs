import test from "node:test";
import assert from "node:assert/strict";
import { GhError, RateLimitError, isRateLimitError, statusFromStderr } from "../lib/gh.mjs";
import { matchRunnerPattern } from "../lib/runnerkit.mjs";
import { collectEarlierAttempts, filterAttemptRows, mergeAttemptRows, timelineRows } from "../lib/stepattempts.mjs";
import { aggregateSteps } from "../shared/steps.mjs";

const at = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const ns = (seconds) => seconds * 1e9;

function timeline(attempt = 1, jobID = "9007199254740993", conclusion = "timed_out") {
    const origin = (attempt - 1) * 100;
    return {
        Repo: "owner/repo",
        RunID: "9007199254740995",
        RunAttempt: attempt,
        Workflow: "CI",
        WorkflowPath: ".github/workflows/ci.yml",
        Event: "push",
        Branch: "main",
        StartedAt: at(origin),
        Jobs: [{
            JobID: jobID,
            Name: "build",
            Labels: ["ubuntu-latest"],
            Kind: "hosted",
            RunnerName: "GitHub Actions",
            RunnerGroup: "GitHub Actions",
            Status: "completed",
            Conclusion: conclusion,
            QueuedAt: at(origin),
            StartedAt: at(origin + 2),
            CompletedAt: at(origin + 22),
            Wait: ns(2),
            Duration: ns(20),
            Steps: [
                { Number: 1, Name: "Compile", Key: "Compile", Occurrence: 1, Status: "completed", Conclusion: "success", StartedAt: at(origin + 3), CompletedAt: at(origin + 8), Duration: ns(5), Offset: ns(3), JobOffset: ns(1) },
                { Number: 2, Name: "Upload", Key: "Upload", Occurrence: 1, Status: "completed", Conclusion: "skipped", StartedAt: null, CompletedAt: null, Duration: 0, Offset: 0, JobOffset: 0 },
                { Number: 3, Name: "Upload", Key: "Upload #2", Occurrence: 2, Status: "completed", Conclusion: "skipped", StartedAt: null, CompletedAt: null, Duration: 0, Offset: 0, JobOffset: 0 },
            ],
        }],
    };
}

const run = { Repository: "owner/repo", RunID: "9007199254740995", RunAttempt: 3 };

test("attempt timelines preserve IDs, runner metadata, skipped steps and job-relative offsets", () => {
    const raw = timeline();
    const rows = timelineRows(raw, "ghe.example.com/owner/repo");
    assert.equal(rows.jobs[0].JobID, "9007199254740993");
    assert.equal(rows.jobs[0].RunID, "9007199254740995");
    assert.equal(rows.jobs[0].Repo, "ghe.example.com/owner/repo");
    assert.equal(rows.jobs[0].Conclusion, "timed_out");
    assert.equal(rows.jobs[0].Kind, "hosted");
    assert.equal(rows.jobs[0].Duration, ns(20));
    assert.equal(rows.steps[0].Offset, ns(1));
    assert.equal(rows.steps[0].RunStartedAt, at(0));
    assert.equal(rows.steps[0].JobStartedAt, at(2));
    assert.equal(rows.steps[0].JobConclusion, "timed_out");
    assert.equal(rows.steps.length, 3);
    assert.equal(rows.steps[2].StepOccurrence, 2);
    assert.equal(rows.steps[2].StepKey, "Upload #2");
    assert.equal(rows.steps[2].StartedAt, null);
    assert.equal(raw.Jobs[0].Steps[0].Offset, ns(3));
});

test("merging attempts deduplicates carried-over jobs without merging reruns or repositories", () => {
    const original = timelineRows(timeline(), "owner/repo");
    const carried = { jobs: [...original.jobs], steps: original.steps.map((row) => ({ ...row, RunStartedAt: null })) };
    const rerun = timelineRows(timeline(2, "9007199254740994", "success"), "owner/repo");
    const elsewhere = timelineRows(timeline(), "owner/other");
    const rows = mergeAttemptRows({ jobs: [...carried.jobs, ...rerun.jobs], steps: [...carried.steps, ...rerun.steps] }, [original, elsewhere]);
    assert.equal(rows.jobs.length, 3);
    assert.equal(rows.steps.length, 9);
    assert.equal(rows.steps[0].RunStartedAt, at(0));
    assert.equal(carried.steps[0].RunStartedAt, null);
});

test("merging attempts keeps the snapshot's inventory-backed runner metadata on carried-over jobs", () => {
    const original = timelineRows(timeline(), "owner/repo");
    const snapshot = (row) => ({ ...row, Kind: "self-hosted", RunnerName: "linux-01", RunnerGroup: "Default" });
    const carried = {
        jobs: original.jobs.map(snapshot),
        steps: original.steps.map((row, index) => ({ ...snapshot(row), RunStartedAt: index === 0 ? at(50) : null })),
    };
    const rows = mergeAttemptRows(carried, [original]);
    assert.equal(rows.jobs.length, 1);
    assert.equal(rows.steps.length, 3);
    assert.deepEqual([...rows.jobs, ...rows.steps].map((row) => row.Kind), Array(4).fill("self-hosted"));
    assert.deepEqual(rows.steps.map((row) => row.RunnerName), Array(3).fill("linux-01"));
    assert.deepEqual(rows.steps.map((row) => row.RunStartedAt), [at(50), at(0), at(0)]);
    assert.equal(carried.steps[1].RunStartedAt, null);
    const selfHosted = aggregateSteps({ ...rows, includeAllAttempts: true, runner: { kind: "self-hosted" } });
    assert.equal(selfHosted.meta.totalJobs, 1);
    assert.equal(selfHosted.stepStats.find((row) => row.stepKey === "Compile").samples, 1);
});

test("earlier attempt rows honour collection kind, runner, exclusions and subset label filters", async () => {
    const rows = timelineRows(timeline(), "owner/repo");
    assert.equal(filterAttemptRows(rows, { kind: "github-hosted", runner: "GitHub*", labels: ["UBUNTU-LATEST"] }).jobs.length, 1);
    for (const filters of [{ kind: "self-hosted" }, { runner: "box-*" }, { excludeRunners: ["GitHub*"] }, { labels: ["self-hosted"] }]) {
        assert.deepEqual(filterAttemptRows(rows, filters), { jobs: [], steps: [] });
    }
    const filtered = await collectEarlierAttempts({
        runs: [{ ...run, RunAttempt: 2 }], jobs: [], steps: [], rowFilters: { kind: "self-hosted" },
        fetchTimeline: async () => ({ timeline: timeline() }),
    });
    assert.deepEqual(filtered.jobs, []);
    assert.deepEqual(filtered.steps, []);
    assert.equal(filtered.historicalAttemptsWithJobs, 1);
});

// Expected values were produced by Go's path.Match, which the CLI applies to --runner
// and --exclude-runner.
const PATH_MATCH_CASES = [
    ["box\\[1\\]*", "box[1]-linux", true], ["box[1]*", "box[1]-linux", false], ["box[1]*", "box1-linux", true],
    ["a*", "a/b", false], ["a?c", "a/c", false], ["a?c", "abc", true], ["[^a]x", "bx", true], ["[^a]x", "ax", false],
    ["[!a]x", "!x", true], ["[!a]x", "bx", false], ["[a-c]*", "b-runner", true], ["[\\]]x", "]x", true],
    ["ab\\", "ab\\", false], ["[a", "a", false], ["[]a]", "a", false], ["*x", "yx\n", false], ["日?本", "日本本", true],
    ["日?本", "日x本", true], ["*", "GitHub Actions", true], ["GitHub*", "GitHub Actions", true], ["Git*Act*", "GitHub Actions", true],
    ["a*b*c", "acb", false], ["", "x", false], ["", "", true], ["[a-]", "a", false], ["x[", "x", false], ["*[", "nope", false],
    ["linux-??", "linux-01", true], ["a*\\*", "ab*", true], ["*-[0-9]", "r-7", true],
];

test("runner patterns of earlier attempts follow the CLI's path.Match semantics", () => {
    for (const [pattern, name, expected] of PATH_MATCH_CASES) {
        assert.equal(matchRunnerPattern(pattern, name), expected, `${JSON.stringify(pattern)} against ${JSON.stringify(name)}`);
    }
    const raw = timeline();
    raw.Jobs[0] = { ...raw.Jobs[0], Kind: "self-hosted", RunnerName: "box[1]-linux", Labels: ["self-hosted"] };
    const rows = timelineRows(raw, "owner/repo");
    assert.equal(filterAttemptRows(rows, { runner: "box\\[1\\]*" }).jobs.length, 1);
    assert.equal(filterAttemptRows(rows, { runner: "box\\[1\\]*" }).steps.length, 3);
    assert.equal(filterAttemptRows(rows, { runner: "box[1]*" }).jobs.length, 0);
    assert.equal(filterAttemptRows(rows, { excludeRunners: ["box?[0-9]?-*"] }).jobs.length, 0);
    assert.equal(filterAttemptRows(rows, { excludeRunners: ["box\\[[^1]\\]*"] }).jobs.length, 1);
    assert.equal(filterAttemptRows(rows, { runner: "box*", excludeRunners: ["[box"] }).jobs.length, 1);
});

test("collects every earlier attempt from sampled runs with bounded concurrency and exact attempt inputs", async () => {
    const latest = timelineRows(timeline(3, "9007199254740996", "success"), "owner/repo");
    const signal = new AbortController().signal;
    const calls = [];
    let active = 0;
    let peak = 0;
    const runs = [run, { ...run, Repository: "owner/other", RunAttempt: 2 }, { ...run, RunID: "single", RunAttempt: 1 }];
    const result = await collectEarlierAttempts({
        runs, ...latest, cwd: "/workspace", target: { kind: "org", owner: "owner" }, signal, concurrency: 1,
        fetchTimeline: async (input) => {
            calls.push(input);
            active += 1;
            peak = Math.max(peak, active);
            await new Promise(setImmediate);
            active -= 1;
            return { available: true, timeline: timeline(input.attempt, `${input.repo}-${input.attempt}`) };
        },
    });
    assert.equal(peak, 1);
    assert.deepEqual(calls.map((call) => [call.repo, call.run, call.attempt]), [
        ["owner/repo", run.RunID, 1], ["owner/repo", run.RunID, 2], ["owner/other", run.RunID, 1],
    ]);
    assert.ok(calls.every((call) => call.signal === signal && call.cwd === "/workspace" && call.target.kind === "org"));
    assert.equal(result.jobs.length, 4);
    assert.equal(result.steps.length, 12);
    assert.equal(result.historicalAttemptsRequested, 3);
    assert.equal(result.historicalAttemptsWithJobs, 3);
    assert.deepEqual(result.warnings, []);
});

test("run list separates outcomes by attempt and statistics include the earlier timeout", async () => {
    const latest = timelineRows(timeline(2, "9007199254740994", "success"), "owner/repo");
    const rows = await collectEarlierAttempts({
        runs: [{ ...run, RunAttempt: 2 }], ...latest,
        fetchTimeline: async () => ({ available: true, timeline: timeline() }),
    });
    const all = aggregateSteps({ ...rows, includeAllAttempts: true });
    assert.equal(all.meta.analysedRuns, 1);
    assert.equal(all.meta.analysedAttempts, 2);
    assert.equal(all.meta.maxRunsPerRepo, 1);
    assert.equal(all.meta.latestAttemptBasis, false);
    assert.equal(all.jobStats[0].runs, 2);
    assert.equal(all.stepStats.find((row) => row.stepKey === "Compile").samples, 2);
    assert.equal(all.typicalTimeline[0].startOffsetMs, 2000);
    assert.deepEqual(all.runs.map((row) => [row.runAttempt, row.conclusion]), [[2, "success"], [1, "timed_out"]]);
    const timeouts = aggregateSteps({ ...rows, includeAllAttempts: true, jobStatus: "timed_out" });
    assert.equal(timeouts.meta.totalJobs, 1);
    assert.equal(timeouts.stepStats.find((row) => row.stepKey === "Compile").samples, 1);
    assert.equal(timeouts.stepStats.find((row) => row.stepKey === "Upload").skipped, 1);
    assert.deepEqual(timeouts.runs.map((row) => row.runAttempt), [1]);
    const latestOnly = aggregateSteps(latest);
    assert.equal(latestOnly.meta.latestAttemptBasis, true);
    assert.deepEqual(latestOnly.runs.map((row) => row.conclusion), ["success"]);
    assert.equal(latestOnly.stepStats.find((row) => row.stepKey === "Compile").samples, 1);
});

test("unavailable history is explicit and preserves the latest rows", async () => {
    const latest = timelineRows(timeline(3, "9007199254740996", "success"), "owner/repo");
    const rows = await collectEarlierAttempts({
        runs: [run], ...latest,
        fetchTimeline: async ({ attempt }) => {
            if (attempt === 1) throw new GhError("not found", { status: 404 });
            return { available: true, timeline: { ...timeline(2), Jobs: [] } };
        },
    });
    assert.deepEqual(rows.jobs, latest.jobs);
    assert.deepEqual(rows.steps, latest.steps);
    assert.equal(rows.historicalAttemptsRequested, 2);
    assert.equal(rows.historicalAttemptsWithJobs, 0);
    assert.equal(rows.warnings.length, 2);
    assert.match(rows.warnings[0], /attempt 1: not found/);
    assert.match(rows.warnings[1], /attempt 2; historical jobs may no longer be available/);
});

test("rate limits, unexpected errors and wrong attempts are never treated as missing history", async () => {
    const base = { runs: [{ ...run, RunAttempt: 2 }], jobs: [], steps: [] };
    for (const error of [new RateLimitError("limited"), new Error("invalid JSON")]) {
        await assert.rejects(collectEarlierAttempts({ ...base, fetchTimeline: async () => { throw error; } }), (caught) => caught === error);
    }
    await assert.rejects(collectEarlierAttempts({ ...base, fetchTimeline: async () => ({ available: false, reason: "update required" }) }), /update required/);
    await assert.rejects(collectEarlierAttempts({ ...base, fetchTimeline: async () => ({ timeline: timeline(2) }) }), /different run or attempt/);
    await assert.rejects(collectEarlierAttempts({ ...base, fetchTimeline: async () => ({ timeline: { ...timeline(), RunID: "different" } }) }), /different run or attempt/);
});

test("aborted collections send no historical request and runs without retries need none", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchTimeline = async () => assert.fail("no request expected");
    await assert.rejects(collectEarlierAttempts({ runs: [run], jobs: [], steps: [], signal: controller.signal, fetchTimeline }), /abort/i);
    const result = await collectEarlierAttempts({ runs: [{ ...run, RunAttempt: 1 }], jobs: [], steps: [], fetchTimeline });
    assert.equal(result.historicalAttemptsRequested, 0);
    assert.deepEqual(result.jobs, []);
});

test("HTTP statuses are read from gh api and from go-github errors forwarded by gh runner-kit", () => {
    assert.equal(statusFromStderr("gh: Not Found (HTTP 404)"), 404);
    assert.equal(statusFromStderr("failed to get attempt 1 of workflow run 42: GET https://api.github.com/repos/owner/repo/actions/runs/42/attempts/1: 404 Not Found []"), 404);
    assert.equal(statusFromStderr("failed to list the jobs: GET https://ghe.example.com/api/v3/repos/o/r/actions/runs/1/attempts/1/jobs?per_page=100: 502 Bad Gateway []"), 502);
    const limited = statusFromStderr("GET https://api.github.com/repos/o/r/actions/runs/1: 429 Too Many Requests []");
    assert.equal(limited, 429);
    assert.equal(isRateLimitError(new GhError("limited", { status: limited })), true);
    assert.equal(statusFromStderr("unknown flag: --attempt"), null);
});
