import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMetrics } from "../lib/metrics.mjs";
import { priceHostedJob } from "../lib/pricing.mjs";
import { costRunnerTypeLabel, unknownCostText } from "../shared/cost.mjs";

const pool = (platform = "linux-x64", size = "8-core", cpu = 8, memory = 32, name = "pool") => ({
    id: 900, name, platform, runner_group_id: 2,
    machine_size_details: { id: size, cpu_cores: cpu, memory_gb: memory, storage_gb: 300 },
});
const job = (label, duration = 30_000, id = 1) => ({
    id, run_id: 1, status: "completed", conclusion: "success", name: "build", workflow_name: "ci",
    labels: [label], started_at: new Date(0).toISOString(), completed_at: new Date(duration).toISOString(),
    __run: { id: 1, name: "ci", repository: "octo/demo", run_attempt: 1 },
});

test("standard, Larger, architectures and GPU prices are distinct", () => {
    for (const [label, inventory, sku, rate, cpu] of [
        ["ubuntu-slim", [], "actions_linux_slim", 0.002, 1],
        ["ubuntu-latest", [], "actions_linux", 0.006, 2],
        ["ubuntu-24.04-arm", [], "actions_linux_arm", 0.005, 2],
        ["windows-11-arm", [], "actions_windows_arm", 0.010, 2],
        ["macos-15", [], "actions_macos", 0.062, 3],
        ["macos-15-large", [], "macos_l", 0.077, 12],
        ["macos-26-xlarge", [], "macos_xl", 0.102, 5],
        ["pool", [pool()], "linux_8_core", 0.022, 8],
        ["pool", [pool("linux-arm64", "16-core", 16, 64)], "linux_16_core_arm", 0.026, 16],
        ["pool", [pool("win-arm64", "64-core-arm", 64, 208)], "windows_64_core_arm", 0.194, 64],
        ["pool", [pool("linux-x64", "4-core-gpu", 4, 28)], "linux_4_core_gpu", 0.052, 4],
        ["pool", [pool("win-x64", "4-core-gpu", 4, 28)], "windows_4_core_gpu", 0.102, 4],
    ]) {
        const price = priceHostedJob(job(label), { hostedRunners: inventory, publicRepository: false });
        assert.equal(price.sku, sku);
        assert.equal(price.rate, rate);
        assert.equal(price.cpuCores, cpu);
    }
});

test("unknown and ambiguous hardware is never priced as a standard runner", () => {
    for (const [raw, inventory, visibility] of [
        [job("ubuntu-16core"), [], false],
        [{ ...job("build"), runner_id: 900 }, [pool()], false],
        [{ ...job("pool"), runner_group_id: 3 }, [pool()], false],
        [{ ...job("pool"), labels: ["pool", "other"] }, [pool(), pool("linux-x64", "16-core", 16, 64, "other")], false],
        [job("pool"), [pool("linux-x64", "custom", 8, 32)], false],
        [job("pool"), [pool("linux-ppc64", "8-core", 8, 32)], false],
        [job("pool"), [pool("linux-arm64-gpu", "4-core", 4, 28)], false],
        [job("ubuntu-latest"), [], null],
        [{ ...job("ubuntu-latest"), runner_group_name: "custom" }, [], false],
    ]) {
        const price = priceHostedJob(raw, { hostedRunners: inventory, publicRepository: visibility });
        assert.equal(price.rate, null);
        assert.ok(price.reason);
        assert.equal(price.excluded, false);
    }
});

test("public standard runners are free, but public Larger runners remain billed", () => {
    const metrics = buildMetrics({
        publicRepository: true, hostedRunners: [pool()], runners: [],
        jobs: [job("ubuntu-latest"), job("pool", 61_000, 2), job("self-hosted", 30_000, 3)],
    });
    assert.equal(metrics.usage.window.estimatedCost, 0.044);
    assert.equal(metrics.usage.window.billableMinutes, 2);
    assert.equal(metrics.usage.window.selfHostedMinutes, 1);
    const standard = metrics.usage.window.byRunnerClass.find((row) => row.sku === "actions_linux");
    assert.equal(standard.cpuCores, 4);
    assert.equal(standard.memoryGB, 16);
    assert.equal(standard.rate, 0);
});

test("mixed machines round each job, propagate nulls and preserve known subtotals", () => {
    const metrics = buildMetrics({
        publicRepository: false, hostedRunners: [pool()], runners: [],
        jobs: [job("ubuntu-latest"), job("pool", 61_000, 2), job("ubuntu-16core", 1_000, 3)],
        timings: [{ name: "ci", billable: { UBUNTU: { total_ms: 120_000 } } }],
    });
    assert.equal(metrics.usage.window.estimatedCost, null);
    assert.ok(Math.abs(metrics.usage.window.knownCost - 0.050) < 1e-9);
    assert.equal(metrics.usage.window.totalMinutes, 4);
    assert.equal(metrics.usage.window.unpricedJobs, 1);
    assert.equal(metrics.usage.window.unpricedMinutes, 1);
    assert.equal(metrics.usage.window.byWorkflow[0].cost, null);
    assert.equal(metrics.usage.reported.estimatedCost, null);
    assert.equal(metrics.usage.reported.byWorkflow[0].cost, null);
});

test("registered or explicitly self-hosted jobs are excluded from GitHub charges", () => {
    for (const raw of [{ ...job("pool"), runner_id: 9 }, { ...job("ubuntu-latest"), labels: ["self-hosted", "ubuntu-latest"] }]) {
        const price = priceHostedJob(raw, { hostedRunners: [pool()], selfHostedIds: new Set([9]), publicRepository: false });
        assert.equal(price.excluded, true);
    }
});

test("missing self-hosted duration stays unknown without losing the runner type", () => {
    for (const raw of [
        { ...job("custom"), runner_id: 9 },
        { ...job("custom"), runner_id: 10, runner_name: "registered" },
        { ...job("self-hosted"), runner_id: 11 },
    ]) {
        const metrics = buildMetrics({
            runners: [{ id: 9, name: "registered" }],
            jobs: [{ ...raw, completed_at: null }],
        });
        const row = metrics.usage.window.byRunnerClass[0];
        assert.equal(row.runnerKind, "self-hosted");
        assert.equal(row.runnerClass, "SELF_HOSTED");
        assert.equal(row.excluded, true);
        assert.equal(row.rate, 0);
        assert.equal(row.cost, null);
        assert.equal(row.billableMinutes, 0);
        assert.equal(costRunnerTypeLabel(row), "Self-hosted");
        assert.equal(unknownCostText(row), "Unknown (self-hosted)");
    }
});

test("unknown hardware does not merge unidentified jobs with confirmed hosted jobs", () => {
    const metrics = buildMetrics({
        jobs: [
            job("custom"),
            { ...job("custom", 30_000, 2), runner_group_name: "GitHub Actions" },
        ],
    });
    const rows = metrics.usage.window.byRunnerClass;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.runnerKind).sort(), ["github-hosted", "unknown"]);
    assert.ok(rows.every((row) => row.cost === null && row.unpricedJobs === 1));
    assert.equal(metrics.usage.window.unpricedJobs, 2);
    assert.equal(metrics.usage.window.selfHostedMinutes, 0);
    assert.equal(metrics.usage.window.estimatedCost, null);
});

test("unstarted cancellations do not contribute costs, minutes or unknown coverage", () => {
    const cancelled = {
        ...job("custom", 61_000, 2), conclusion: "cancelled",
        runner_id: "0", runner_name: "", steps: [],
    };
    for (const labels of [[], ["ubuntu-latest"], ["self-hosted"], ["custom"]]) {
        const metrics = buildMetrics({
            publicRepository: false,
            jobs: [job("ubuntu-latest"), { ...cancelled, labels }],
        });
        const usage = metrics.usage.window;
        assert.equal(usage.jobs, 1);
        assert.equal(usage.minutes, 1);
        assert.equal(usage.billableMinutes, 1);
        assert.equal(usage.selfHostedMinutes, 0);
        assert.equal(usage.unpricedJobs, 0);
        assert.equal(usage.unpricedMinutes, 0);
        assert.equal(usage.estimatedCost, 0.006);
        assert.equal(usage.byRunnerClass.length, 1);
        assert.equal(usage.byWorkflow[0].jobs, 1);
        assert.equal(usage.byWorkflow[0].cost, 0.006);
    }
    const usage = buildMetrics({ jobs: [cancelled] }).usage.window;
    assert.equal(usage.jobs, 0);
    assert.equal(usage.estimatedCost, 0);
    assert.deepEqual(usage.byWorkflow, []);
});

test("cancellations after runner allocation or a started step remain in cost estimates", () => {
    const cancelled = { ...job("ubuntu-latest", 61_000), conclusion: "cancelled" };
    for (const evidence of [
        { runner_id: 9 },
        { runner_id: "9" },
        { runner_name: "GitHub Actions" },
        { steps: [{ started_at: cancelled.started_at, conclusion: "cancelled" }] },
        { execution_started: true, runner_id: "0", runner_name: "" },
    ]) {
        const usage = buildMetrics({
            publicRepository: false, jobs: [{ ...cancelled, ...evidence }],
        }).usage.window;
        assert.equal(usage.jobs, 1);
        assert.equal(usage.minutes, 2);
        assert.equal(usage.estimatedCost, 0.012);
    }
    const usage = buildMetrics({
        jobs: [{ ...cancelled, labels: ["custom"], runner_id: "9" }],
    }).usage.window;
    assert.equal(usage.unpricedJobs, 1);
    assert.equal(usage.unpricedMinutes, 2);
    assert.equal(usage.estimatedCost, null);
});

test("requested labels, runner groups and skipped steps do not prove execution started", () => {
    const cancelled = { ...job("ubuntu-latest", 61_000), conclusion: "cancelled" };
    for (const metadata of [
        { runner_id: "0", runner_name: "", runner_group_name: "GitHub Actions" },
        { steps: [{ conclusion: "skipped", started_at: cancelled.started_at }] },
        { steps: [{ conclusion: "cancelled", started_at: "invalid" }] },
        { execution_started: false },
    ]) {
        const usage = buildMetrics({ jobs: [{ ...cancelled, ...metadata }] }).usage.window;
        assert.equal(usage.jobs, 0);
        assert.equal(usage.unpricedJobs, 0);
    }
});

test("string zero runner IDs do not create unknown costs for missing duration", () => {
    const usage = buildMetrics({
        jobs: [{ ...job("custom"), runner_id: "0", started_at: null, completed_at: null }],
    }).usage.window;
    assert.equal(usage.jobs, 0);
    assert.equal(usage.unpricedJobs, 0);
});
