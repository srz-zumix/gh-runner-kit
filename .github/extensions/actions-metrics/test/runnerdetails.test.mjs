import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRunnerNames, summarizeRunnerDetails } from "../lib/runnerdetails.mjs";
import { normalizeQuery } from "../lib/query.mjs";
import { startInstanceServer } from "../lib/server.mjs";

const repo = "sample/project";
const workflowPath = ".github/workflows/ci.yml";

function job(JobID, RunID, RunAttempt, RunnerName, Conclusion, Latest, CompletedAt) {
    return {
        Repo: repo,
        JobID,
        RunID,
        RunAttempt,
        Workflow: "CI",
        WorkflowPath: workflowPath,
        JobName: "test",
        Kind: "self-hosted",
        RunnerName,
        RunnerID: RunnerName === "mac-runner" ? "11" : "12",
        Status: "completed",
        Conclusion,
        Latest,
        QueuedAt: "2026-03-01T10:00:00Z",
        StartedAt: "2026-03-01T10:01:00Z",
        CompletedAt,
    };
}

function step(jobRow, StepName, StepConclusion) {
    return {
        Repo: jobRow.Repo,
        JobID: jobRow.JobID,
        RunID: jobRow.RunID,
        RunAttempt: jobRow.RunAttempt,
        Workflow: jobRow.Workflow,
        WorkflowPath: jobRow.WorkflowPath,
        JobName: jobRow.JobName,
        Kind: jobRow.Kind,
        RunnerName: jobRow.RunnerName,
        RunnerID: jobRow.RunnerID,
        StepName,
        StepKey: StepName,
        StepOccurrence: 1,
        StepNumber: 1,
        StepConclusion,
        StartedAt: "2026-03-01T10:01:00Z",
        CompletedAt: "2026-03-01T10:01:10Z",
    };
}

test("runner details use job conclusions for rates and keep attempt scope consistent", () => {
    const latest = job("20", "500", 2, "mac-runner", "success", true, "2026-03-02T10:02:00Z");
    const earlier = job("19", "500", 1, "mac-runner", "failure", false, "2026-03-01T10:02:00Z");
    const cancelled = job("30", "501", 1, "mac-runner", "cancelled", true, "2026-03-03T10:02:00Z");
    const failedBeforeSteps = job("31", "503", 1, "mac-runner", "failure", true, "2026-03-04T10:02:00Z");
    const otherRunner = job("40", "502", 1, "other-runner", "failure", true, "2026-03-03T10:02:00Z");
    const steps = [
        step(latest, "Run actions/checkout@v4", "failure"),
        step(latest, "Run actions/checkout@v4", "failure"),
        step(earlier, "Run actions/checkout@v4", "failure"),
        step(cancelled, "Set up job", "success"),
        step(otherRunner, "Run actions/checkout@v4", "failure"),
    ];

    const latestOnly = summarizeRunnerDetails({
        jobs: [latest, earlier, cancelled, failedBeforeSteps, otherRunner],
        steps,
        runner: "mac-runner",
    });
    assert.equal(latestOnly.attemptScope, "latest");
    assert.equal(latestOnly.summary.jobs, 3);
    assert.equal(latestOnly.summary.decidedJobs, 2);
    assert.equal(latestOnly.summary.failedJobs, 1);
    assert.equal(latestOnly.summary.failureRate, 0.5);
    assert.deepEqual(latestOnly.failedSteps.map(row => [row.name, row.failed, row.executed]), [
        ["Run actions/checkout@v4", 1, 1],
    ]);
    assert.deepEqual(latestOnly.recentJobs.find(row => row.jobId === "20").failedStepNames, ["Run actions/checkout@v4"]);

    const allAttempts = summarizeRunnerDetails({
        jobs: [latest, earlier, cancelled, failedBeforeSteps, otherRunner],
        steps,
        runner: "mac-runner",
        includeAllAttempts: true,
    });
    assert.equal(allAttempts.attemptScope, "all");
    assert.equal(allAttempts.summary.jobs, 4);
    assert.equal(allAttempts.summary.decidedJobs, 3);
    assert.equal(allAttempts.summary.failedJobs, 2);
    assert.equal(allAttempts.summary.failureRate, 2 / 3);
    assert.deepEqual(allAttempts.failedSteps.map(row => [row.name, row.failed, row.executed]), [
        ["Run actions/checkout@v4", 2, 2],
    ]);
    assert.deepEqual(allAttempts.trend.days.map(row => [row.day, row.failed, row.decided]), [
        ["2026-03-01", 1, 1],
        ["2026-03-02", 0, 1],
        ["2026-03-04", 1, 1],
    ]);
    assert.deepEqual(allAttempts.recentJobs.find(row => row.jobId === "31").failedStepNames, []);
});

test("runner names list named runners by job count with attempt-scoped failure rates", () => {
    const jobs = [
        job("20", "500", 2, "mac-runner", "success", true, "2026-03-02T10:02:00Z"),
        job("19", "500", 1, "mac-runner", "failure", false, "2026-03-01T10:02:00Z"),
        job("30", "501", 1, "mac-runner", "cancelled", true, "2026-03-03T10:02:00Z"),
        job("40", "502", 1, "beta-runner", "failure", true, "2026-03-04T10:02:00Z"),
        job("41", "503", 1, "alpha-runner", "success", true, "2026-03-01T10:02:00Z"),
        job("42", "504", 1, "", "failure", true, "2026-03-01T10:02:00Z"),
    ];

    const latest = listRunnerNames(jobs);
    assert.deepEqual(latest.map(row => [row.runner, row.jobs, row.decidedJobs, row.failedJobs]), [
        ["mac-runner", 2, 1, 0],
        ["alpha-runner", 1, 1, 0],
        ["beta-runner", 1, 1, 1],
    ]);
    assert.equal(latest[0].latestAt, "2026-03-03T10:02:00.000Z");
    assert.equal(latest[2].failureRate, 1);

    const all = listRunnerNames(jobs, { includeAllAttempts: true });
    assert.deepEqual([all[0].jobs, all[0].failedJobs, all[0].failureRate], [3, 1, 0.5]);
});

test("daily executions count started jobs by UTC start date with outcome breakdown", () => {
    const started = (id, conclusion, startedAt) => ({ ...job(id, `6${id}`, 1, "mac-runner", conclusion, true, "2026-03-05T00:00:00Z"), StartedAt: startedAt });
    const jobs = [
        started("1", "success", "2026-03-01T23:59:00Z"),
        started("2", "failure", "2026-03-01T01:00:00Z"),
        started("3", "cancelled", "2026-03-03T00:00:00Z"),
        started("4", "", null),
        { ...started("5", "success", "2026-03-01T05:00:00Z"), RunnerName: "other-runner" },
    ];
    const result = summarizeRunnerDetails({ jobs, steps: [], runner: "mac-runner" });
    assert.deepEqual(result.executions.days, [
        { day: "2026-03-01", jobs: 2, succeeded: 1, failed: 1, other: 0 },
        { day: "2026-03-03", jobs: 1, succeeded: 0, failed: 0, other: 1 },
    ]);
    assert.equal(result.executions.unstartedJobs, 1);
});

test("recent job filters combine before the limit without changing other summaries", () => {
    const jobs = Array.from({ length: 120 }, (_, index) => {
        const row = job(String(index + 1), String(index + 100), 1, "mac-runner", "success", true,
            new Date(Date.UTC(2026, 2, 1, 0, index)).toISOString());
        row.Repo = index === 0 ? "sample/legacy" : repo;
        row.Workflow = index === 0 ? "Legacy build" : "CI";
        row.JobName = index === 0 ? "Build mac" : "test";
        return row;
    });
    jobs[1].Conclusion = null;
    const steps = [step(jobs[0], "Checkout", "failure"), step(jobs[1], "Checkout", "success")];
    const unfiltered = summarizeRunnerDetails({ jobs, steps, runner: "mac-runner" });
    assert.equal(unfiltered.recentJobs.length, 100);
    assert.ok(!unfiltered.recentJobs.some(row => row.jobId === "1"));
    const filtered = summarizeRunnerDetails({
        jobs, steps, runner: "mac-runner",
        recentJobFilters: {
            result: "SUCCESS", failedStep: "checkOUT", repository: "LEGACY", workflow: "legacy", job: "mac",
        },
    });
    assert.equal(filtered.meta.totalJobs, 120);
    assert.equal(filtered.meta.matchingJobs, 1);
    assert.equal(filtered.recentJobs[0].jobId, "1");
    assert.deepEqual(filtered.recentJobs[0].failedStepNames, ["Checkout"]);
    assert.deepEqual(filtered.summary, unfiltered.summary);
    assert.deepEqual(filtered.trend, unfiltered.trend);
    assert.deepEqual(filtered.failedSteps, unfiltered.failedSteps);
    assert.ok(filtered.meta.resultOptions.includes("__no_conclusion__"));
    const unfinished = summarizeRunnerDetails({
        jobs, steps, runner: "mac-runner", recentJobFilters: { result: "__no_conclusion__" },
    });
    assert.equal(unfinished.meta.matchingJobs, 1);
    assert.equal(unfinished.recentJobs[0].jobId, "2");
    const nonmatching = summarizeRunnerDetails({
        jobs, steps, runner: "mac-runner", recentJobFilters: { result: "failure", failedStep: "checkout" },
    });
    assert.equal(nonmatching.meta.matchingJobs, 0);
    assert.deepEqual(nonmatching.recentJobs, []);
});

test("runner details HTTP route reads retained jobs and steps without collecting", async t => {
    const dir = await mkdtemp(join(tmpdir(), "runner-details-route-"));
    const previousPath = process.env.PATH;
    const previousLog = process.env.RUNNER_DETAILS_TEST_LOG;
    const previousHold = process.env.RUNNER_DETAILS_TEST_HOLD;
    const log = join(dir, "calls.jsonl");
    const hold = join(dir, "hold.txt");
    let server;
    t.after(async () => {
        if (server) {
            server.closeAllConnections();
            await new Promise(resolve => server.close(resolve));
        }
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousLog === undefined) delete process.env.RUNNER_DETAILS_TEST_LOG;
        else process.env.RUNNER_DETAILS_TEST_LOG = previousLog;
        if (previousHold === undefined) delete process.env.RUNNER_DETAILS_TEST_HOLD;
        else process.env.RUNNER_DETAILS_TEST_HOLD = previousHold;
        await rm(dir, { recursive: true, force: true });
    });

    process.env.PATH = `${dir}:${previousPath ?? ""}`;
    process.env.RUNNER_DETAILS_TEST_LOG = log;
    const latest = job("20", "500", 2, "mac-runner", "success", true, "2026-03-02T10:02:00Z");
    const earlier = job("19", "500", 1, "mac-runner", "failure", false, "2026-03-01T10:02:00Z");
    const other = job("30", "501", 1, "other-runner", "failure", true, "2026-03-03T10:02:00Z");
    const rows = [step(latest, "Checkout", "failure"), step(earlier, "Checkout", "failure"), step(other, "Checkout", "failure")];
    await writeFile(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RUNNER_DETAILS_TEST_LOG, JSON.stringify(args) + "\\n");
if (args[0] !== "runner-kit" || args[1] !== "metrics" || args[2] !== "steps" || !args.includes("--input")) {
    throw new Error("Unexpected command");
}
if (process.env.RUNNER_DETAILS_TEST_HOLD) {
    process.on("SIGTERM", () => {
        fs.writeFileSync(process.env.RUNNER_DETAILS_TEST_HOLD, "cancelled");
        process.exit(0);
    });
    fs.writeFileSync(process.env.RUNNER_DETAILS_TEST_HOLD, "started");
    setTimeout(() => process.exit(0), 10000);
} else {
    for (const row of ${JSON.stringify(rows)}) console.log(JSON.stringify(row));
}
`, { mode: 0o700 });
    const query = normalizeQuery({ repo: "sample/project" });
    const dataset = {
        input: join(dir, "snapshot.json"),
        jobs: [latest, earlier, other],
        meta: { id: "fixture", truncated: false, warnings: [] },
    };
    let retained = true;
    const instance = {
        identity: "repo:sample/project",
        effectiveQuery: query,
        authAbort: new AbortController(),
        store: {
            cwd: dir,
            snapshot: () => retained ? { metrics: { meta: { dataset: { id: "fixture" } } } } : null,
            withRetainedDataset: async (received, callback) => {
                assert.equal(received, query);
                return callback(dataset);
            },
        },
    };
    const listening = await startInstanceServer(instance);
    server = listening.server;
    const post = body => fetch(`${listening.url}api/runner-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });

    const invalid = await post({ runner: "" });
    assert.equal(invalid.status, 400);
    retained = false;
    const missing = await post({ runner: "mac-runner" });
    assert.equal(missing.status, 409);
    retained = true;

    const latestResponse = await post({ runner: " mac-runner " });
    const latestResult = await latestResponse.json();
    assert.equal(latestResponse.status, 200, latestResult.error);
    assert.equal(latestResult.runner, "mac-runner");
    assert.equal(latestResult.summary.jobs, 1);
    assert.equal(latestResult.failedSteps[0].failed, 1);
    assert.equal(latestResult.meta.datasetId, "fixture");

    const allResponse = await post({ runner: "mac-runner", includeAllAttempts: true });
    const allResult = await allResponse.json();
    assert.equal(allResponse.status, 200, allResult.error);
    assert.equal(allResult.summary.jobs, 2);
    assert.equal(allResult.failedSteps[0].failed, 2);
    const filteredResponse = await post({
        runner: "mac-runner", includeAllAttempts: true,
        recentJobFilters: { result: "failure", failedStep: "check" },
    });
    const filteredResult = await filteredResponse.json();
    assert.equal(filteredResponse.status, 200, filteredResult.error);
    assert.equal(filteredResult.meta.matchingJobs, 1);
    assert.equal(filteredResult.recentJobs[0].jobId, "19");
    assert.equal((await post({ runner: "mac-runner", recentJobFilters: { result: 3 } })).status, 400);
    const namesResponse = await fetch(`${listening.url}api/runner-names?attempts=all`);
    const names = await namesResponse.json();
    assert.equal(namesResponse.status, 200, names.error);
    assert.equal(names.datasetId, "fixture");
    assert.equal(names.attemptScope, "all");
    assert.deepEqual(names.runners.map(row => [row.runner, row.jobs]), [["mac-runner", 2], ["other-runner", 1]]);
    retained = false;
    assert.equal((await fetch(`${listening.url}api/runner-names`)).status, 409);
    retained = true;

    const calls = (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(args => args[args.indexOf("--input") + 1] === dataset.input));

    process.env.RUNNER_DETAILS_TEST_HOLD = hold;
    const controller = new AbortController();
    const cancelled = fetch(`${listening.url}api/runner-details`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runner: "mac-runner" }),
        signal: controller.signal,
    }).catch(error => error);
    const waitFor = async expected => {
        for (let attempt = 0; attempt < 100; attempt++) {
            const text = await readFile(hold, "utf8").catch(error => {
                if (error.code === "ENOENT") return "";
                throw error;
            });
            if (text === expected) return;
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.fail(`Timed out waiting for ${expected}`);
    };
    await waitFor("started");
    controller.abort();
    assert.equal((await cancelled).name, "AbortError");
    await waitFor("cancelled");
});
