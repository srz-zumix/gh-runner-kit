import test from "node:test";
import assert from "node:assert/strict";
import { buildMetrics } from "../lib/metrics.mjs";

test("full aggregation retains all runs and jobs above the function-argument limit", () => {
    const runCount = 100_001;
    const created = "2026-01-01T00:00:00Z";
    const runs = Array.from({ length: runCount }, (_, index) => ({
        id: String(1_000_000 + index), run_attempt: 1, run_number: index + 1,
        repository: "example/project", name: "CI", workflowPath: ".github/workflows/ci.yml",
        event: "push", status: "completed", conclusion: "success",
        created_at: created, run_started_at: "2026-01-01T00:00:01Z",
    }));
    const times = [1, 2, 3, 9].map(second => ({
        started_at: `2026-01-01T00:00:0${second}Z`,
        completed_at: `2026-01-01T00:01:0${second}Z`,
    }));
    const jobs = Array.from({ length: runCount * times.length }, (_, index) => ({
        id: String(2_000_000 + index), name: "build", workflow_name: "CI",
        status: "completed", conclusion: "success",
        runner_id: 1, runner_name: "test-runner", labels: ["self-hosted"],
        created_at: created, ...times[index % times.length],
        __run: runs[Math.floor(index / times.length)],
    }));
    const metrics = buildMetrics({
        runs, jobs,
        runners: [{ id: 1, name: "test-runner", status: "online", labels: [{ name: "self-hosted" }] }],
    });
    assert.deepEqual(metrics.overview.totals, {
        runs: runCount, completedRuns: runCount, inProgressRuns: 0, jobs: jobs.length, retriedRuns: 0,
    });
    assert.equal(metrics.meta.jobCoverageRuns, runCount);
    assert.deepEqual(metrics.overview.jobQueue, {
        count: jobs.length, avg: 3750, p50: 2500, p90: 9000, p95: 9000, max: 9000,
        total: runCount * 15000,
    });
    assert.equal(metrics.overview.runQueue.count, runCount);
    assert.equal(metrics.overview.runQueue.max, 1000);
    assert.equal(metrics.overview.duration.count, runCount);
    assert.equal(metrics.overview.duration.max, 68000);
    assert.equal(metrics.overview.duration.total, runCount * 68000);
    assert.equal(metrics.overview.daily[0].total, runCount);
    assert.equal(metrics.overview.byWorkflow[0].runs, runCount);
    assert.equal(metrics.overview.byJob[0].runs, jobs.length);
    assert.equal(metrics.runners.split.selfHosted.jobs, jobs.length);
    assert.equal(metrics.runners.byRunner[0].jobs, jobs.length);
    assert.equal(metrics.runners.byRunner[0].minutes, jobs.length);
    assert.equal(metrics.usage.window.jobs, jobs.length);
    assert.equal(metrics.usage.window.totalMinutes, jobs.length);
    assert.equal(metrics.usage.window.estimatedCost, 0);
});

test("empty and invalid timing samples keep their existing missing-value semantics", () => {
    const empty = { count: 0, avg: null, p50: null, p90: null, p95: null, max: null, total: 0 };
    const metrics = buildMetrics({});
    for (const field of ["duration", "runQueue", "jobQueue"]) assert.deepEqual(metrics.overview[field], empty);
    const invalid = buildMetrics({
        jobs: [
            { name: "invalid", created_at: "not-a-date", started_at: "not-a-date" },
            { name: "negative", created_at: "2026-01-01T00:00:02Z", started_at: "2026-01-01T00:00:01Z" },
            { name: "zero", created_at: "2026-01-01T00:00:00Z", started_at: "2026-01-01T00:00:00Z" },
        ],
    });
    assert.equal(invalid.overview.totals.jobs, 3);
    assert.deepEqual(invalid.overview.jobQueue, { count: 1, avg: 0, p50: 0, p90: 0, p95: 0, max: 0, total: 0 });
});
