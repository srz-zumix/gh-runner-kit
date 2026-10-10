import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("pricing collection preserves permissions, pagination, user scopes and rate-limit failures", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "actions-metrics-pricing-"));
    const keys = ["PATH", "COPILOT_HOME", "FAKE_PRICING_MODE", "FAKE_PRICING_LOG"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await rm(dir, { recursive: true, force: true });
    });
    process.env.PATH = `${dir}:${process.env.PATH}`;
    process.env.COPILOT_HOME = dir;
    process.env.FAKE_PRICING_LOG = join(dir, "calls.jsonl");
    await writeFile(join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_PRICING_MODE;
const inherited = String(mode || "").startsWith("inherited");
fs.appendFileSync(process.env.FAKE_PRICING_LOG, JSON.stringify(args) + "\\n");
const output = (data) => process.stdout.write(JSON.stringify(data));
const path = String(args[1] || "").replace(/^\\//, "");
if (args.join(" ") === "runner-kit metrics --help") {
    process.stdout.write("Available Commands:\\n  runs Runs\\n  report Report\\n\\n");
} else if (args.join(" ") === "runner-kit --version") {
    process.stdout.write("pricing-test");
} else if (args.join(" ") === "runner-kit job --help" || args.join(" ") === "runner-kit metrics summary --help") {
    process.stdout.write("Flags:\\n");
} else if (args[0] === "runner-kit" && args[2] === "runs") {
    output({ Repository: "octo/demo", RunID: inherited ? 2 : 1, Status: "completed", Conclusion: "success", Workflow: "ci", RunAttempt: 1 });
} else if (args[0] === "runner-kit" && args[2] === "report") {
    if (mode === "report failure") {
        process.stderr.write("failed to collect cost: HTTP 500");
        process.exitCode = 1;
    } else output({ summary: { Runs: 1 }, cost: mode === "legacy" ? [{ OS: "UBUNTU", Jobs: 1, Billable: 60000000000, Rate: 0.008, Cost: 0.008 }] : [
        { OS: "UBUNTU", RunnerClass: "linux_8_core", SKU: "linux_8_core", CPUCores: 8, MemoryGB: 32, Architecture: "x64", Jobs: 1, Billable: 60000000000, Rate: 0.022, Cost: 0.022, KnownCost: 0.022, UnpricedJobs: 0 },
        { OS: "UBUNTU", RunnerClass: "unknown", Jobs: 1, Billable: 60000000000, Rate: null, Cost: null, KnownCost: 0, UnpricedJobs: 1, Reason: "hardware unknown" }
    ] });
} else if (args[0] === "api" && path === "rate_limit") {
    output({ resources: { core: { remaining: 10000, reset: Math.floor(Date.now() / 1000) + 3600 } } });
} else if (args[0] === "api" && (path.includes("/actions/runs/1/jobs") || path.includes("/actions/runs/2/jobs"))) {
    output({ jobs: [{ id: inherited ? 2 : 1, run_id: inherited ? 2 : 1, labels: [inherited ? "ubuntu-latest-large" : "pool-0"], runner_group_id: inherited ? 3 : 2, status: "completed", conclusion: "success", name: "build", workflow_name: "ci", started_at: "2026-10-08T00:00:00Z", completed_at: "2026-10-08T00:00:30Z" }] });
} else if (args[0] === "api" && (path.includes("/actions/runners") || path.includes("/actions/workflows"))) {
    output({ runners: [], workflows: [] });
} else if (args[0] === "api" && path === "repos/octo/demo") {
    if (mode === "visibility missing") {
        process.stderr.write("gh: Not Found (HTTP 404)");
        process.exitCode = 1;
    } else output({ private: true, owner: { type: mode === "user" ? "User" : "Organization" } });
} else if (args[0] === "api" && path.startsWith("orgs/octo/actions/hosted-runners")) {
    if (mode === "forbidden" || mode === "rate limited") {
        process.stderr.write(mode === "forbidden" ? "gh: Forbidden (HTTP 403)" : "gh: API rate limit exceeded (HTTP 403)");
        process.exitCode = 1;
    } else if (inherited) output({ total_count: 0, runners: [] });
    else if (path.includes("page=2")) output({ total_count: 101, runners: [{ id: 101, name: "last", runner_group_id: 2 }] });
    else output({ total_count: 101, runners: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: "pool-" + i, runner_group_id: 2, platform: "linux-x64", machine_size_details: { id: "8-core", cpu_cores: 8, memory_gb: 32, storage_gb: 300 } })) });
} else if (args[0] === "api" && path.startsWith("orgs/octo/actions/runner-groups/")) {
    if (mode === "inherited forbidden" || mode === "inherited rate limited") {
        process.stderr.write(mode === "inherited forbidden" ? "gh: Forbidden (HTTP 403)" : "gh: API rate limit exceeded (HTTP 403)");
        process.exitCode = 1;
    } else {
        const group = Number(path.split("/")[4]);
        const runner = (id) => ({ id, name: group === 3 && id === 1 ? "ubuntu-latest-large" : "pool-" + group + "-" + id, runner_group_id: group, platform: "linux-x64", machine_size_details: { id: "8-core", cpu_cores: 8, memory_gb: 32, storage_gb: 300 } });
        if (group === 103) output({ total_count: 1, runners: [runner(1)] });
        else if (path.includes("page=2")) output({ total_count: 101, runners: [runner(1)] });
        else output({ total_count: 101, runners: Array.from({ length: 100 }, (_, i) => runner(i + 1)) });
    }
} else if (args[0] === "api" && path.startsWith("orgs/octo/actions/runner-groups")) {
    if (!inherited) output({ total_count: 0, runner_groups: [] });
    else if (path.includes("page=2")) output({ total_count: 101, runner_groups: [{ id: 103, inherited: true }] });
    else output({ total_count: 101, runner_groups: Array.from({ length: 100 }, (_, i) => ({ id: i + 3, inherited: i === 0 })) });
} else {
    process.stderr.write("Unexpected command: " + args.join(" "));
    process.exitCode = 1;
}
`, { mode: 0o700 });
    const { fetchHostedPricing, collectSnapshot } = await import("../lib/collect.mjs");
    const { buildMetrics } = await import("../lib/metrics.mjs");
    const { clearRateLimitCooldown, RateLimitError } = await import("../lib/gh.mjs");
    t.after(() => clearRateLimitCooldown(null));
    const target = { kind: "repo", nwo: "octo/demo", owner: "octo", host: "github.com" };
    for (const mode of ["org", "user", "forbidden", "visibility missing", "rate limited", "inherited", "inherited forbidden", "inherited rate limited"]) {
        process.env.FAKE_PRICING_MODE = mode;
        const warnings = [];
        const before = (await readFile(process.env.FAKE_PRICING_LOG, "utf8").catch((error) => {
            if (error.code !== "ENOENT") throw error;
            return "";
        })).split("\n").filter(Boolean).length;
        if (mode === "rate limited" || mode === "inherited rate limited") {
            await assert.rejects(fetchHostedPricing({ target, cwd: dir, warnings }), RateLimitError);
            clearRateLimitCooldown(null);
            continue;
        }
        const result = await fetchHostedPricing({ target, cwd: dir, warnings });
        assert.equal(result.publicRepository, mode === "visibility missing" ? null : false);
        assert.equal(result.hostedRunners.length, ["user", "forbidden", "inherited forbidden"].includes(mode) ? 0 : 101);
        assert.equal(warnings.length, ["forbidden", "visibility missing", "inherited forbidden"].includes(mode) ? 1 : 0);
        if (mode === "inherited") {
            const pool = result.hostedRunners.find((runner) => runner.name === "ubuntu-latest-large");
            assert.equal(pool.machine_size_details.cpu_cores, 8);
            assert.equal(pool.machine_size_details.memory_gb, 32);
            assert.equal(result.hostedRunners.filter((runner) => runner.id === 1).length, 2);
        }
        const calls = (await readFile(process.env.FAKE_PRICING_LOG, "utf8")).trim().split("\n").map(JSON.parse).slice(before);
        const expectedCalls = { user: 1, forbidden: 2, inherited: 7, "inherited forbidden": 5 };
        assert.equal(calls.length, expectedCalls[mode] ?? 4);
    }
    for (const mode of ["snapshot", "legacy", "report failure", "inherited snapshot"]) {
        process.env.FAKE_PRICING_MODE = mode;
        const snapshot = await collectSnapshot({
            target, cwd: dir,
            filters: { days: 7, groupBy: "name", billable: true, labels: [] },
            limits: { maxRuns: 1, jobConcurrency: 1 },
        });
        const metrics = buildMetrics(snapshot);
        assert.equal(metrics.usage.window.estimatedCost, 0.022);
        assert.equal(metrics.usage.window.byRunnerClass[0].cpuCores, 8);
        assert.equal(metrics.usage.window.byRunnerClass[0].memoryGB, 32);
        assert.equal(snapshot.fleet.costAvailable, mode !== "report failure");
        if (mode === "snapshot" || mode === "inherited snapshot") {
            assert.equal(snapshot.fleet.cost[0].rate, 0.022);
            assert.equal(snapshot.fleet.cost[0].cpuCores, 8);
            assert.equal(snapshot.fleet.cost[0].runnerKind, "github-hosted");
            assert.equal(snapshot.fleet.cost[1].cost, null);
            assert.equal(snapshot.fleet.cost[1].runnerKind, "unknown");
        } else if (mode === "legacy") {
            assert.equal(snapshot.fleet.cost[0].cost, null);
            assert.equal(snapshot.fleet.cost[0].rate, null);
            assert.equal(snapshot.fleet.cost[0].unpricedJobs, 1);
            assert.equal(snapshot.fleet.cost[0].runnerKind, "unknown");
        } else {
            assert.ok(snapshot.warnings.some((warning) => warning.includes("failed to collect cost")));
        }
    }
});
