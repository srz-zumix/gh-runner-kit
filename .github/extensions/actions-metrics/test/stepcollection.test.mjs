import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collection switches attempt scope, caches matching rows and reports historical coverage without GitHub requests", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "actions-metrics-attempt-test-"));
    const previous = { PATH: process.env.PATH, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_TIMELINE_EMPTY: process.env.FAKE_TIMELINE_EMPTY, FAKE_TIMELINE_404: process.env.FAKE_TIMELINE_404 };
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(dir, { recursive: true, force: true });
    });
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.FAKE_GH_LOG = join(dir, "calls.jsonl");
    await writeFile(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const output = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const at = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();
const job = {
    Repo: "owner/repo", RunID: "42", RunAttempt: 2, JobID: "102",
    Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml", JobName: "build",
    Status: "completed", Conclusion: "success", StartedAt: at(102), CompletedAt: at(112),
};
if (args.join(" ") === "runner-kit metrics --help") {
    process.stdout.write("Available Commands:\\n  collect Collect\\n  runs Runs\\n  jobs Jobs\\n  steps Steps\\n\\n");
} else if (args.join(" ") === "runner-kit --version") {
    process.stdout.write("test\\n");
} else if (args.join(" ") === "runner-kit job --help") {
    process.stdout.write("Available Commands:\\n  timeline Timeline\\n\\n");
} else if (args.join(" ") === "runner-kit metrics summary --help") {
    process.stdout.write("Flags:\\n  --include-repo string\\n  --exclude-repo string\\n");
} else if (args[0] === "api" && args[1] === "rate_limit") {
    output({ resources: { core: { remaining: 10000, reset: Math.floor(Date.now() / 1000) + 3600 } } });
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "collect") {
    fs.writeFileSync(args[args.indexOf("--output") + 1], "");
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "jobs" && args.includes("--input")) {
    output(job);
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "steps" && args.includes("--input")) {
    output({ ...job, RunStartedAt: at(100), JobStartedAt: job.StartedAt, JobCompletedAt: job.CompletedAt,
        JobConclusion: "success", StepNumber: 1, StepName: "Compile", StepKey: "Compile", StepOccurrence: 1,
        StepStatus: "completed", StepConclusion: "success", StartedAt: at(103), CompletedAt: at(108), Duration: 5000000000, Offset: 1000000000 });
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "runs" && args.includes("--input")) {
    output({ Repository: "owner/repo", RunID: "42", RunAttempt: 2 });
} else if (args[0] === "runner-kit" && args[1] === "job" && args[2] === "timeline" && process.env.FAKE_TIMELINE_404) {
    process.stderr.write("failed to get attempt 1 of workflow run 42: GET https://api.github.com/repos/owner/repo/actions/runs/42/attempts/1: 404 Not Found []\\n");
    process.exitCode = 1;
} else if (args[0] === "runner-kit" && args[1] === "job" && args[2] === "timeline" && args[args.indexOf("--attempt") + 1] === "1") {
    output({ Repo: "owner/repo", RunID: "42", RunAttempt: 1, Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml", StartedAt: at(0),
        Jobs: process.env.FAKE_TIMELINE_EMPTY ? [] : [{ JobID: "101", Name: "build", Status: "completed", Conclusion: "timed_out",
            StartedAt: at(2), CompletedAt: at(22), Duration: 20000000000, Steps: [{ Number: 1, Name: "Compile", Key: "Compile", Occurrence: 1,
                Status: "completed", Conclusion: "success", StartedAt: at(3), CompletedAt: at(8), Duration: 5000000000, JobOffset: 1000000000 }] }] });
} else {
    process.stderr.write("Unexpected command: " + args.join(" ") + "\\n");
    process.exitCode = 1;
}
`, { mode: 0o700 });
    const { collectStepMetrics } = await import("../lib/steprows.mjs");
    const options = {
        cwd: dir,
        target: { kind: "repo", nwo: "owner/repo", owner: "owner", name: "repo", host: null },
        filters: { days: 7, labels: [], includeRepos: [], excludeRepos: [] },
        limits: { jobConcurrency: 1 },
        workflow: "ci.yml",
        runBudget: 2,
    };
    const calls = async () => (await readFile(process.env.FAKE_GH_LOG, "utf8")).trim().split("\n").map(JSON.parse);
    const all = await collectStepMetrics({ ...options, includeAllAttempts: true });
    assert.equal(all.available, true, all.reason);
    assert.equal(all.includeAllAttempts, true);
    assert.equal(all.meta.latestAttemptBasis, false);
    assert.equal(all.meta.historicalAttemptsRequested, 1);
    assert.equal(all.meta.historicalAttemptsWithJobs, 1);
    assert.equal(all.meta.analysedRuns, 1);
    assert.equal(all.meta.analysedAttempts, 2);
    assert.equal(all.stepStats[0].samples, 2);
    assert.deepEqual(all.runs.map((row) => row.runAttempt), [2, 1]);
    const afterAll = (await calls()).length;
    const filtered = await collectStepMetrics({ ...options, includeAllAttempts: true, jobStatus: "timed_out", reuseRows: true, cache: all.rows });
    assert.equal(filtered.available, true, filtered.reason);
    assert.equal(filtered.meta.reusedRows, true);
    assert.equal(filtered.meta.totalJobs, 1);
    assert.equal(filtered.meta.historicalAttemptsRequested, 1);
    assert.equal((await calls()).length, afterAll);
    const latest = await collectStepMetrics({ ...options, includeAllAttempts: false, reuseRows: true, cache: all.rows });
    assert.equal(latest.available, true, latest.reason);
    assert.equal(latest.meta.latestAttemptBasis, true);
    assert.equal(latest.meta.reusedRows, false);
    assert.equal(latest.meta.historicalAttemptsRequested, 0);
    assert.equal(latest.meta.totalJobs, 1);
    assert.equal(latest.stepStats[0].samples, 1);
    assert.deepEqual(latest.runs.map((row) => row.runAttempt), [2]);
    assert.notEqual(latest.rows.key, all.rows.key);
    process.env.FAKE_TIMELINE_EMPTY = "1";
    const missing = await collectStepMetrics({ ...options, includeAllAttempts: true });
    assert.equal(missing.available, true, missing.reason);
    assert.equal(missing.meta.historicalAttemptsRequested, 1);
    assert.equal(missing.meta.historicalAttemptsWithJobs, 0);
    assert.equal(missing.meta.warnings.length, 1);
    assert.equal(missing.meta.totalJobs, 1);
    delete process.env.FAKE_TIMELINE_EMPTY;
    process.env.FAKE_TIMELINE_404 = "1";
    const gone = await collectStepMetrics({ ...options, includeAllAttempts: true });
    assert.equal(gone.available, true, gone.reason);
    assert.equal(gone.meta.historicalAttemptsRequested, 1);
    assert.equal(gone.meta.historicalAttemptsWithJobs, 0);
    assert.equal(gone.meta.totalJobs, 1);
    assert.equal(gone.meta.warnings.length, 1);
    assert.match(gone.meta.warnings[0], /attempt 1: .*404 Not Found/);
});
