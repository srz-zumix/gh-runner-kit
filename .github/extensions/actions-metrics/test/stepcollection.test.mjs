import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("collection switches attempt scope, caches matching rows and reports historical coverage without GitHub requests", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "actions-metrics-attempt-test-"));
    const previous = { PATH: process.env.PATH, COPILOT_HOME: process.env.COPILOT_HOME, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_TIMELINE_EMPTY: process.env.FAKE_TIMELINE_EMPTY, FAKE_TIMELINE_404: process.env.FAKE_TIMELINE_404, FAKE_STEP_UNLIMITED: process.env.FAKE_STEP_UNLIMITED, FAKE_STEP_CONDITIONS: process.env.FAKE_STEP_CONDITIONS };
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(dir, { recursive: true, force: true });
    });
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.COPILOT_HOME = dir;
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
    RunnerName: "box*", Kind: "self-hosted", Labels: ["self-hosted", "linux"], RunnerGroup: "Default",
    Status: "completed", Conclusion: "success", StartedAt: at(102), CompletedAt: at(112),
};
const snapshotJobs = () => {
    const { budget, sharedHistory } = JSON.parse(fs.readFileSync(args[args.indexOf("--input") + 1], "utf8"));
    if (!process.env.FAKE_STEP_UNLIMITED) return sharedHistory
        ? [{ ...job, JobID: "101", RunAttempt: 1, Conclusion: "timed_out", StartedAt: at(2), CompletedAt: at(22) }, job] : [job];
    const count = budget === 0 ? 6001 : Math.min(6001, budget);
    return Array.from({ length: count }, (_, index) => ({
        ...job, RunID: String(1000 + index), JobID: String(2000 + index), RunAttempt: 1,
    }));
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
    fs.writeFileSync(args[args.indexOf("--output") + 1], JSON.stringify({ budget: Number(args[args.indexOf("--max-runs") + 1]) }));
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "jobs" && args.includes("--input")) {
    for (const row of snapshotJobs()) output(row);
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "steps" && args.includes("--input")) {
    for (const row of snapshotJobs()) {
        const step = { ...row, RunStartedAt: at(100), JobStartedAt: row.StartedAt, JobCompletedAt: row.CompletedAt,
        JobConclusion: row.Conclusion, StepNumber: 1, StepName: "Compile", StepKey: "Compile", StepOccurrence: 1,
        StepStatus: "completed", StepConclusion: row.Conclusion === "timed_out" ? "failure" : "success",
        StartedAt: new Date(Date.parse(row.StartedAt) + 1000).toISOString(),
        CompletedAt: new Date(Date.parse(row.StartedAt) + 6000).toISOString(), Duration: 5000000000, Offset: 1000000000 };
        output(step);
        if (process.env.FAKE_STEP_CONDITIONS) output({ ...step, StepName: "Cleanup", StepKey: "Cleanup", StepNumber: 2, StepConclusion: "success" });
    }
} else if (args[0] === "runner-kit" && args[1] === "metrics" && args[2] === "runs" && args.includes("--input")) {
    output({ Repository: "owner/repo", RunID: "42", RunAttempt: 2 });
} else if (args[0] === "runner-kit" && args[1] === "job" && args[2] === "timeline" && process.env.FAKE_TIMELINE_404) {
    process.stderr.write("failed to get attempt 1 of workflow run 42: GET https://api.github.com/repos/owner/repo/actions/runs/42/attempts/1: 404 Not Found []\\n");
    process.exitCode = 1;
} else if (args[0] === "runner-kit" && args[1] === "job" && args[2] === "timeline" && args[args.indexOf("--attempt") + 1] === "1") {
    output({ Repo: "owner/repo", RunID: "42", RunAttempt: 1, Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml", StartedAt: at(0),
        Jobs: process.env.FAKE_TIMELINE_EMPTY ? [] : [{ JobID: "101", Name: "build", Status: "completed", Conclusion: "timed_out",
            Kind: "self-hosted", Labels: ["self-hosted", "linux"], RunnerName: "box*", RunnerGroup: "Default",
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
    for (const job of ["build", "missing", ""]) {
        const focused = await collectStepMetrics({ ...options, includeAllAttempts: true, job, reuseRows: true, cache: all.rows });
        assert.equal(focused.available, true, focused.reason);
        assert.equal(focused.meta.reusedRows, true);
        assert.equal(focused.stepStats.length, job === "missing" ? 0 : 1);
        assert.equal(focused.runs.length, job === "missing" ? 0 : 2);
        assert.equal((await calls()).length, afterAll);
    }
    for (const repository of ["owner/repo", "owner/missing", ""]) {
        const scoped = await collectStepMetrics({ ...options, includeAllAttempts: true, repository, reuseRows: true, cache: all.rows });
        assert.equal(scoped.available, true, scoped.reason);
        assert.equal(scoped.repository, repository);
        assert.equal(scoped.meta.reusedRows, true);
        assert.equal(scoped.stepStats.length, repository === "owner/missing" ? 0 : 1);
        assert.equal(scoped.runs.length, repository === "owner/missing" ? 0 : 2);
        assert.deepEqual(scoped.repositoryFacets, all.repositoryFacets);
        assert.equal((await calls()).length, afterAll);
    }
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
    const { datasetQueryId, normalizeQuery, targetOf, filtersOf, limitsOf } = await import("../lib/query.mjs");
    const { DashboardStore } = await import("../lib/store.mjs");
    const { DashboardInstance } = await import("../lib/instance.mjs");
    const { startInstanceServer } = await import("../lib/server.mjs");
    const query = normalizeQuery({ owner: "owner", days: 7, jobConcurrency: 1 });
    const settings = { workflow: "ci.yml", runBudget: 2, kind: "all", includeAllAttempts: false };
    const { SharedDataset } = await import("../lib/dataset.mjs");
    const sharedDir = await mkdtemp(join(dir, "shared-"));
    const sharedInput = join(sharedDir, "snapshot.json");
    await writeFile(sharedInput, JSON.stringify({ budget: 2, sharedHistory: true }));
    const dataset = new SharedDataset(
        sharedInput, sharedDir,
        [{ repository: "owner/repo", id: "42", workflowPath: ".github/workflows/ci.yml", run_attempt: 2, created_at: "2026-01-01T00:00:00Z" }],
        all.rows.jobs.rows.map(row => ({ ...row, Latest: row.JobID === "102" })),
        { id: "shared-fixture", collectedAt: "2026-01-01T00:00:00Z", truncated: false, warnings: [] },
    );
    const snapshot = await collectStepMetrics({ cwd: dir, target: targetOf(query), filters: filtersOf(query), limits: limitsOf(query), dataset, ...settings });
    assert.equal(snapshot.available, true, snapshot.reason);
    const panel = new DashboardInstance({ instanceId: "repository-filter", store: new DashboardStore({ cwd: dir }), query });
    Object.assign(panel.store.entry(query), { status: "ready", dataset, datasetSignature: datasetQueryId(query), metrics: { meta: { dataset: dataset.meta } } });
    const { generation } = panel.beginStepRequest();
    panel.setStepMetrics(settings, snapshot, generation);
    const { server, url } = await startInstanceServer(panel);
    try {
        const facetModule = await fetch(`${url}shared/facet.mjs`);
        assert.equal(facetModule.status, 200);
        assert.match(facetModule.headers.get("content-type"), /javascript/);
        assert.match(await facetModule.text(), /export function renderFacetPicker/);
        const beforeFilters = (await calls()).length;
        for (const repository of ["owner/missing", "owner/repo", ""]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, repository, reuseRows: true }),
            });
            const result = await response.json();
            assert.equal(response.status, 200, result.reason);
            assert.equal(result.repository, repository);
            assert.equal(result.meta.reusedRows, true);
            assert.equal(result.meta.totalJobs, repository === "owner/missing" ? 0 : 1);
            assert.deepEqual(result.repositoryFacets, snapshot.repositoryFacets);
            assert.equal(panel.state().steps.settings.repository, repository);
            assert.equal((await (await fetch(`${url}api/step-prefs`)).json()).repository, repository);
            assert.equal((await calls()).length, beforeFilters);
        }
        for (const [runnerFilter, expectedJobs] of [
            [{ kind: "self-hosted", name: "box*", nameExact: true }, 1],
            [{ kind: "self-hosted", name: "box-02", nameExact: true }, 0],
            [{ kind: "self-hosted", name: "box*" }, 1],
            [{ kind: "self-hosted", name: "", nameExact: true }, 1],
            [{
                kinds: ["hosted", "self-hosted"], labelSets: ["macos", "LINUX,SELF-HOSTED"],
                groups: ["Other", "Default"], names: ["box*", "box-02"],
            }, 1],
            [{ names: ["box-02"] }, 0],
            [{ names: ["box*"], groups: ["Other"] }, 0],
            [{ name: "box-02", names: ["box*"] }, 1],
            [{ kinds: [], labelSets: [], groups: [], names: [] }, 1],
        ]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, runnerFilter, reuseRows: true }),
            });
            const result = await response.json();
            assert.equal(response.status, 200, result.reason);
            assert.equal(result.meta.reusedRows, true);
            assert.equal(result.meta.totalJobs, expectedJobs);
            assert.equal(result.meta.totalStepRows, expectedJobs);
            assert.equal(result.runners.reduce((sum, pool) => sum + pool.jobs, 0), expectedJobs);
            assert.deepEqual(result.runnerFacets, snapshot.runnerFacets);
            assert.equal(Object.hasOwn(result.runnerFilter, "nameExact"), Boolean(runnerFilter.name && runnerFilter.nameExact));
            assert.deepEqual(panel.state().steps.settings.runnerFilter, result.runnerFilter);
            assert.deepEqual((await (await fetch(`${url}api/step-prefs`)).json()).runnerFilter, result.runnerFilter);
            assert.equal((await calls()).length, beforeFilters);
        }
        for (const runnerFilter of [{}, { names: ["box*"] }]) {
            const before = (await calls()).length;
            const response = await fetch(`${url}api/steps`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, jobStatus: "rerun_success", runnerFilter, reuseRows: true }),
            });
            const result = await response.json();
            assert.equal(response.status, 200, result.reason);
            assert.equal(result.includeAllAttempts, true);
            assert.equal(result.meta.latestAttemptBasis, false);
            assert.equal(result.meta.totalJobs, 2);
            assert.equal(result.meta.totalStepRows, 2);
            assert.equal(result.stepStats[0].samples, 2);
            assert.deepEqual(result.runs.map(row => [row.runAttempt, row.conclusion]), [[2, "success"], [1, "timed_out"]]);
            assert.equal(panel.state().steps.settings.includeAllAttempts, false);
            const prefs = await (await fetch(`${url}api/step-prefs`)).json();
            assert.equal(prefs.jobStatus, "rerun_success");
            assert.equal(prefs.includeAllAttempts, false);
            const recorded = (await calls()).slice(before);
            assert.ok(recorded.every(args => args[0] !== "api" && args[2] !== "collect"));
            if (runnerFilter.names) {
                assert.equal(result.meta.reusedRows, true);
                assert.equal(recorded.length, 0);
            }
        }
        const beforeFailedSteps = (await calls()).length;
        for (const [failedStep, expectedJobs, jobStatus] of [
            [{ name: "Compile" }, 1, "rerun_success"],
            [{ name: "Compile", occurrence: 2 }, 0, "rerun_success"],
            [{ name: "compile" }, 0, "rerun_success"],
            [{ name: "Compile*" }, 0, "rerun_success"],
            [null, 2, "rerun_success"],
            [{ name: "Compile" }, 0, "success"],
            [{ name: "Compile" }, 1, ""],
        ]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, includeAllAttempts: true, failedStep, jobStatus, reuseRows: true }),
            });
            const result = await response.json();
            assert.equal(response.status, 200, result.reason);
            const normalized = failedStep ? { occurrence: 1, ...failedStep } : null;
            assert.deepEqual(result.failedStep, normalized);
            assert.deepEqual(result.meta.failedStep, normalized);
            assert.equal(result.meta.totalJobs, expectedJobs);
            assert.equal(result.meta.totalStepRows, expectedJobs);
            assert.equal(result.runners.reduce((sum, pool) => sum + pool.jobs, 0), expectedJobs);
            assert.deepEqual(result.failedStepFacets, [{ name: "Compile", occurrence: 1, count: 1 }]);
            if (failedStep && expectedJobs) assert.deepEqual(result.runs.map(row => row.runAttempt), [1]);
            assert.deepEqual(panel.state().steps.settings.failedStep, normalized);
            assert.deepEqual((await (await fetch(`${url}api/step-prefs`)).json()).failedStep, normalized);
            assert.equal(result.meta.reusedRows, true);
            assert.equal((await calls()).length, beforeFailedSteps);
        }
        const beforeInvalid = await (await fetch(`${url}api/step-prefs`)).json();
        for (const failedStep of ["Compile", {}, { name: "Compile", occurrence: 0 }]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, failedStep, reuseRows: true }),
            });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error, /failedStep/);
            assert.deepEqual(await (await fetch(`${url}api/step-prefs`)).json(), beforeInvalid);
            assert.equal((await calls()).length, beforeFailedSteps);
        }
        process.env.FAKE_STEP_CONDITIONS = "1";
        const conditions = [{ name: "Compile", conclusion: "failure" }, { name: "Cleanup", conclusion: "success" }];
        const beforeCompound = (await calls()).length;
        const initialConditions = await fetch(`${url}api/steps`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...settings, includeAllAttempts: true, stepConditions: conditions, failedStep: { name: "Missing" } }),
        });
        const initial = await initialConditions.json();
        assert.equal(initialConditions.status, 200, initial.reason);
        assert.equal(initial.meta.totalJobs, 1);
        assert.equal(initial.meta.totalStepRows, 2);
        assert.equal(initial.failedStep, null);
        assert.deepEqual(initial.stepConditions, conditions.map(condition => ({ ...condition, occurrence: 1 })));
        assert.equal(initial.meta.stepConditionsSupported, true);
        assert.deepEqual(initial.runs.map(row => row.runAttempt), [1]);
        assert.ok((await calls()).slice(beforeCompound).every(args => args[0] !== "api" && args[2] !== "collect"));
        const afterCompound = (await calls()).length;
        for (const [stepConditions, expectedJobs] of [[conditions, 1], [[...conditions, { name: "missing", conclusion: "success" }], 0], [[], 2], [null, 2]]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, includeAllAttempts: true, stepConditions, failedStep: { name: "Missing" }, reuseRows: true }),
            });
            const result = await response.json();
            assert.equal(response.status, 200, result.reason);
            assert.equal(result.meta.totalJobs, expectedJobs);
            assert.equal(result.meta.totalStepRows, expectedJobs * 2);
            assert.equal(result.meta.reusedRows, true);
            assert.equal(result.failedStep, null);
            assert.deepEqual(result.stepConditionFacets, initial.stepConditionFacets);
            assert.deepEqual((await (await fetch(`${url}api/step-prefs`)).json()).stepConditions, result.stepConditions);
            assert.deepEqual(panel.state().steps.settings.stepConditions, result.stepConditions);
            assert.equal((await calls()).length, afterCompound);
        }
        const beforeInvalidConditions = await (await fetch(`${url}api/step-prefs`)).json();
        for (const stepConditions of ["A", [{}], [null], [{ name: "A", conclusion: "" }], [{ name: "A", conclusion: "failure", occurrence: 0 }]]) {
            const response = await fetch(`${url}api/steps`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ...settings, stepConditions, reuseRows: true }),
            });
            assert.equal(response.status, 400);
            assert.match((await response.json()).error, /stepConditions/);
            assert.deepEqual(await (await fetch(`${url}api/step-prefs`)).json(), beforeInvalidConditions);
            assert.equal((await calls()).length, afterCompound);
        }
        delete process.env.FAKE_STEP_CONDITIONS;
        const response = await fetch(`${url}api/steps`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...settings, runBudget: 0 }),
        });
        const result = await response.json();
        assert.equal(response.status, 200, result.reason);
        assert.equal(result.runBudget, 0);
        assert.equal(result.meta.runBudget, 0);
        assert.equal(result.meta.truncated, false);
        assert.equal(result.meta.totalJobs, 1);
        assert.equal(result.meta.latestAttemptBasis, true);
        assert.equal(panel.state().steps.settings.runBudget, 0);
        assert.equal((await (await fetch(`${url}api/step-prefs`)).json()).runBudget, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        panel.dispose();
        await panel.store.dispose();
    }
    process.env.FAKE_STEP_UNLIMITED = "1";
    const progress = [];
    const unlimited = await collectStepMetrics({ ...options, runBudget: 0, onProgress: (message) => progress.push(message) });
    assert.equal(unlimited.available, true, unlimited.reason);
    assert.equal(unlimited.runBudget, 0);
    assert.equal(unlimited.meta.runBudget, 0);
    assert.equal(unlimited.meta.totalJobs, 6001);
    assert.equal(unlimited.meta.maxRunsPerRepo, 6001);
    assert.equal(unlimited.meta.truncated, false);
    assert.equal(unlimited.stepStats[0].samples, 6001);
    assert.ok(progress.some((message) => message.startsWith("Collecting all runs")));
    const collected = (await calls()).filter((args) => args[2] === "collect").at(-1);
    assert.equal(collected[collected.indexOf("--max-runs") + 1], "0");
    assert.equal(collected[collected.indexOf("--days") + 1], "7");
    const afterUnlimited = (await calls()).length;
    const reused = await collectStepMetrics({ ...options, runBudget: 0, reuseRows: true, cache: unlimited.rows });
    assert.equal(reused.meta.reusedRows, true);
    assert.equal(reused.meta.totalJobs, 6001);
    assert.equal(reused.meta.truncated, false);
    assert.equal((await calls()).length, afterUnlimited);
    const limited = await collectStepMetrics({ ...options, reuseRows: true, cache: unlimited.rows });
    assert.equal(limited.meta.reusedRows, false);
    assert.equal(limited.meta.totalJobs, 2);
    assert.equal(limited.meta.truncated, true);
});
