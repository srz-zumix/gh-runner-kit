import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectDatasetJobs } from "../shared/dataset.mjs";

test("all tabs use one all-attempts snapshot, including 6001 runs and exact job IDs", async t => {
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-shared-test-"));
    const previous = { PATH: process.env.PATH, COPILOT_HOME: process.env.COPILOT_HOME, SHARED_CALLS: process.env.SHARED_CALLS };
    process.env.PATH = `${directory}:${process.env.PATH}`;
    process.env.COPILOT_HOME = directory;
    process.env.SHARED_CALLS = join(directory, "calls.jsonl");
    let store;
    t.after(async () => {
        await store?.dispose();
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const zlib = require("node:zlib");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SHARED_CALLS, JSON.stringify(args) + "\\n");
const output = value => process.stdout.write(JSON.stringify(value) + "\\n");
const time = index => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
const runs = Array.from({length: 6001}, (_, i) => ({
    Repository: "owner/repo", RunID: String(i + 1), Workflow: "CI",
    WorkflowPath: ".github/workflows/ci.yml", WorkflowID: "42",
    RunAttempt: i === 0 ? 2 : 1, CreatedAt: time(i), StartedAt: time(i),
    Status: "completed", Conclusion: "success",
}));
const jobs = runs.map((run, i) => ({
    Repo: run.Repository, RunID: run.RunID, RunAttempt: run.RunAttempt,
    JobID: i === 0 ? "9007199254740995" : String(10000 + i),
    Workflow: run.Workflow, WorkflowPath: run.WorkflowPath, JobName: "build",
    Kind: "hosted", Labels: ["ubuntu-latest"], RunnerName: "GitHub Actions",
    Status: "completed", Conclusion: "success", ExecutionStarted: true, StartedAt: time(i), CompletedAt: time(i + 61),
    Duration: 61000000000,
}));
jobs.push({...jobs[0], JobID: "9007199254740993", RunAttempt: 1, RunnerName: "", Conclusion: "cancelled"});
if (args[0] === "api") {
    if (args[1] !== "rate_limit") throw new Error("Unexpected direct API: " + args[1]);
    output({resources: {core: {remaining: 10000, reset: Math.floor(Date.now()/1000)+3600}}});
} else if (args.includes("--help")) {
    process.stdout.write("Available Commands:\\n  collect Collect\\n  report Report\\n  runs Runs\\n  jobs Jobs\\n  steps Steps\\n  timeline Timeline\\n  export Export\\n\\nFlags:\\n  --include-repo string\\n  --exclude-repo string\\n");
} else if (args.includes("--version")) {
    process.stdout.write("fixture\\n");
} else if (args[2] === "collect") {
    const latest = Object.fromEntries(jobs.slice(0, 6001).map(job => [job.JobID, true]));
    const snapshot = {Version: 1, CreatedAt: time(7000), Contents: {Jobs: true, AllAttempts: true},
        Data: {Window: {Start: time(0), End: time(7000)}, LatestJobs: latest, Runners: [], Warnings: [],
            HostedRunners: {}, RepositoryPublic: {"owner/repo": false}, Truncated: false}};
    fs.writeFileSync(args[args.indexOf("--output")+1], zlib.gzipSync(JSON.stringify(snapshot)));
} else {
    if (!args.includes("--input")) throw new Error("A report attempted an independent collection: " + args.join(" "));
    if (args[2] === "runs") runs.forEach(output);
    else if (args[2] === "jobs") jobs.forEach(output);
    else if (args[2] === "steps") jobs.forEach(job => output({...job,
        JobConclusion: job.Conclusion, JobStartedAt: job.StartedAt, JobCompletedAt: job.CompletedAt,
        RunStartedAt: job.StartedAt, StepNumber: 1, StepName: "Compile", StepKey: "Compile",
        StepOccurrence: 1, StepStatus: "completed", StepConclusion: "success", Offset: 0}));
    else if (args[2] === "report") output({summary: {Window: {Start: time(0), End: time(7000)}, Runs: 6001, HostedJobs: 6002}});
    else if (args[2] === "timeline") output({RunID: args[3], RunAttempt: 1, Jobs: []});
    else if (args[2] === "export") output({Runs: 6001});
    else throw new Error("Unexpected command: " + args.join(" "));
}
`, { mode: 0o700 });
    const { DashboardStore } = await import("../lib/store.mjs");
    const { normalizeQuery } = await import("../lib/query.mjs");
    const { collectStepMetrics } = await import("../lib/steprows.mjs");
    const { collectJobRows } = await import("../lib/jobrows.mjs");
    const { collectRunnerTimeline } = await import("../lib/jobs.mjs");
    const { collectRunTimeline } = await import("../lib/timeline.mjs");
    const { exportFleet } = await import("../lib/runnerkit.mjs");
    const { DashboardInstance } = await import("../lib/instance.mjs");
    const { startInstanceServer } = await import("../lib/server.mjs");
    const query = normalizeQuery({ repo: "owner/repo", days: 9, maxRuns: 0 });
    store = new DashboardStore({ cwd: directory });
    await Promise.all([store.refresh(query), store.refresh(query)]);
    const state = store.snapshot("repo:owner/repo");
    assert.equal(state.status, "ready", state.error);
    assert.equal(state.metrics.overview.totals.runs, 6001);
    assert.equal(state.metrics.usage.window.jobs, 6002);
    assert.equal(state.metrics.usage.window.minutes, 12004);
    const calls = async () => (await readFile(process.env.SHARED_CALLS, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal((await calls()).filter(args => args[2] === "collect").length, 1);
    const instance = new DashboardInstance({instanceId: "shared-rows-test", store, query});
    const {server, url} = await startInstanceServer(instance);
    t.after(async () => {
        instance.dispose();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const notices = [];
    instance.onState(value => notices.push(value.rows?.status));
    const request = await fetch(`${url}api/rows`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
    assert.equal(request.status, 202);
    const descriptor = await request.json();
    const rowSignature = store.rows.signature(query);
    await store.rows.entry(rowSignature).inflight;
    const ready = instance.state().rows;
    assert.equal(ready.status, "ready");
    assert.equal(ready.id, descriptor.id);
    assert.equal(ready.stale, false);
    assert.ok(notices.includes("loading"));
    assert.ok(notices.includes("ready"));
    const payloadResponse = await fetch(`${url}api/rows?id=${ready.id}&revision=${ready.revision}`);
    assert.equal(payloadResponse.status, 200);
    const payload = await payloadResponse.json();
    assert.equal(payload.rows.length, 6002);
    assert.equal(typeof payload.collectedAt, "number");
    assert.equal(payload.datasetId, state.metrics.meta.dataset.id);
    assert.deepEqual(payload.window, state.metrics.meta.dataset.window);
    assert.equal((await calls()).filter(args => args[2] === "collect").length, 1);
    await store.withDataset(query, async dataset => {
        assert.ok(dataset.source.jobs.every(job => job.execution_started === true));
        const options = { dataset, cwd: directory, target: {kind: "repo", owner: "owner", name: "repo", nwo: "owner/repo", host: null}, filters: query, limits: {maxRuns: 0}, workflow: "ci.yml", runBudget: 0 };
        const steps = await collectStepMetrics({...options, includeAllAttempts: true});
        assert.equal(steps.meta.totalJobs, state.metrics.usage.window.jobs);
        assert.equal(steps.meta.analysedRuns, 6001);
        assert.equal(steps.meta.analysedAttempts, 6002);
        assert.equal(steps.meta.datasetId, state.metrics.meta.dataset.id);
        assert.equal(steps.meta.truncated, false);
        assert.ok(steps.rows.jobs.rows.some(row => row.JobID === "9007199254740993"));
        const before = (await calls()).length;
        const filtered = await collectStepMetrics({...options, includeAllAttempts: true, job: "missing", reuseRows: true, cache: steps.rows});
        assert.equal(filtered.stepStats.length, 0);
        assert.equal((await calls()).length, before);
        const latest = await collectStepMetrics({...options, includeAllAttempts: false});
        assert.equal(latest.meta.totalJobs, 6001);
        const sampled = await collectStepMetrics({...options, runBudget: 2, includeAllAttempts: true});
        assert.equal(sampled.meta.analysedRuns, 2);
        assert.equal(sampled.meta.truncated, true);
        const explorer = await collectJobRows(options);
        assert.equal(explorer.rows.length, state.metrics.usage.window.jobs);
        assert.equal(explorer.datasetId, dataset.meta.id);
        assert.equal(explorer.truncated, false);
        const projection = await collectRunnerTimeline({...options, query: "*", kind: "all", buckets: [{start: dataset.meta.window.Start, end: dataset.meta.window.End}]});
        assert.equal(projection.matched, 6002);
        const timeline = await collectRunTimeline({...options, input: dataset.input, run: "1", attempt: 1});
        assert.equal(timeline.available, true);
        await exportFleet({...options, input: dataset.input, format: "json"});
    });
    const recorded = await calls();
    assert.equal(recorded.filter(args => args[2] === "collect").length, 1);
    assert.ok(recorded.filter(args => args[0] === "api").every(args => args[1] === "rate_limit"));
    await store.refresh({...query, groupBy: "id", bucket: "1h", targetUtilization: 0.8});
    assert.equal(store.entry(query).dataset.meta.id, state.metrics.meta.dataset.id);
    assert.equal((await calls()).filter(args => args[2] === "collect").length, 1);
    const old = store.entry(query).dataset.acquire();
    const previousRevision = store.rows.signature(query);
    await store.refresh(query, {force: true});
    assert.notEqual(store.rows.signature(query), previousRevision);
    assert.equal(instance.state().rows.stale, true);
    instance.requestRows();
    await store.rows.entry(store.rows.signature(query)).inflight;
    assert.equal(instance.state().rows.status, "ready");
    assert.equal(instance.state().rows.stale, false);
    assert.notEqual(instance.state().rows.id, descriptor.id);
    assert.equal(old.retired, true);
    await access(old.input);
    await old.release();
    await assert.rejects(access(old.input));
});

test("snapshot sampling counts runs without jobs and keeps repositories independent", () => {
    const dataset = {
        runs: [
            {repository: "o/a", id: "2", workflowPath: "ci.yml", created_at: "2026-10-02"},
            {repository: "o/a", id: "1", workflowPath: "ci.yml", created_at: "2026-10-01"},
            {repository: "o/b", id: "3", workflowPath: "ci.yml", created_at: "2026-10-01"},
        ],
        jobs: [{Repo: "o/a", RunID: "1", JobID: "11"}, {Repo: "o/b", RunID: "3", JobID: "13"}],
    };
    const view = selectDatasetJobs(dataset, {workflow: "ci.yml", runBudget: 1});
    assert.equal(view.sampled, true);
    assert.deepEqual(view.jobs.map(row => row.JobID), ["13"]);
});
