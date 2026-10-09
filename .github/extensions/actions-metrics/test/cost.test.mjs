import assert from "node:assert/strict";
import { test } from "node:test";
import { costRunnerKind, costRunnerTypeLabel, unknownCostText } from "../shared/cost.mjs";

test("unpriced self-hosted rows retain their runner type", () => {
    for (const row of [
        { runnerKind: "self-hosted" },
        { excluded: true, runnerKind: "github-hosted" },
        { source: "self-hosted" },
        { runnerClass: "SELF_HOSTED" },
    ]) {
        assert.equal(costRunnerKind(row), "self-hosted");
        assert.equal(costRunnerTypeLabel(row), "Self-hosted");
        assert.equal(unknownCostText(row), "Unknown (self-hosted)");
    }
});

test("hosted price evidence does not require a known price", () => {
    for (const row of [
        { runnerKind: "github-hosted", rate: null },
        { sku: "linux_8_core" },
        { source: "current hosted pool", rate: null },
        { source: "workflow label; public standard runner is free" },
    ]) {
        assert.equal(costRunnerKind(row), "github-hosted");
        assert.equal(costRunnerTypeLabel(row), "GitHub-hosted");
        assert.equal(unknownCostText(row), "Unknown");
    }
});

test("unknown jobs are not relabelled from their fleet membership or OS", () => {
    for (const row of [
        undefined, {}, { runnerKind: "unknown", selfHosted: true },
        { os: "UBUNTU", source: "usage API" },
        { source: "legacy CLI", rate: 0 },
        { source: "OS override", rate: 0.006 },
    ]) {
        assert.equal(costRunnerKind(row), "unknown");
        assert.equal(costRunnerTypeLabel(row), "Unknown");
        assert.equal(unknownCostText(row), "Unknown");
    }
});
