import test from "node:test";
import assert from "node:assert/strict";
import { GhError, RateLimitError } from "../lib/gh.mjs";
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
