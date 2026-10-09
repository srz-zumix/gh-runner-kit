import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeRow, normalizeRunnerName } from "../shared/rows.mjs";
import { applyExploreFilters, buildExploreAggregate, buildExploreFacets } from "../shared/explore.mjs";
import { aggregateSteps, matchRunner, normalizeJobRow, normalizeStepRow } from "../shared/steps.mjs";
import { timelineRows } from "../lib/stepattempts.mjs";
import { buildMetrics } from "../lib/metrics.mjs";

function raw(id, type = "ubuntu-latest-large", kind = "hosted") {
    return {
        Repo: "octo/app", RunID: "1", JobID: String(id), JobName: "build",
        Kind: kind, RunnerID: String(id), RunnerName: `${type}-${id}`, Labels: [type],
        Status: "completed", Conclusion: "success",
        QueuedAt: "2026-01-01T00:00:00Z",
        StartedAt: "2026-01-01T00:00:01Z",
        CompletedAt: "2026-01-01T00:00:11Z",
    };
}

test("hosted names drop only matching instance IDs and preserve every other name", () => {
    for (const [kind, name, id, expected] of [
        ["hosted", "GitHub Actions 42", 42, "GitHub Actions"],
        ["github-hosted", "ubuntu-latest-large-1003372588", 1003372588, "ubuntu-latest-large"],
        ["hosted", "ubuntu-latest-small-42", 42, "ubuntu-latest-small"],
        ["hosted", "pool-8-42", 42, "pool-8"],
        ["hosted", "pool-9007199254740993", "9007199254740993", "pool"],
        ["hosted", "ubuntu-latest-large-42", 43, "ubuntu-latest-large-42"],
        ["self-hosted", "ubuntu-latest-large-42", 42, "ubuntu-latest-large-42"],
        ["unknown", "ubuntu-latest-large-42", 42, "ubuntu-latest-large-42"],
        ["hosted", "ubuntu-latest-large-42", 0, "ubuntu-latest-large-42"],
        ["hosted", "-42", 42, "-42"],
        ["hosted", "pool--42", -42, "pool--42"],
    ]) {
        assert.equal(normalizeRunnerName(kind, name, id), expected);
    }
});

test("explorer listings, facets, filters and heatmaps share stable hosted names", () => {
    const rows = [raw(41), raw(42), raw(43, "ubuntu-latest-small"), raw(44, "ubuntu-latest-large", "self-hosted")]
        .map(normalizeRow);
    assert.equal(rows[0].runnerName, "ubuntu-latest-large");
    assert.equal(rows[0].runnerId, "41");
    const facets = buildExploreFacets(rows);
    assert.equal(facets.runner.length, 3);
    assert.equal(facets.runner.find((row) => row.value === "ubuntu-latest-large").count, 2);
    const selected = applyExploreFilters(rows, { runner: ["ubuntu-latest-large"] });
    assert.deepEqual(selected.map((row) => row.runnerId), ["41", "42"]);
    const aggregate = buildExploreAggregate(rows, { collectedAt: Date.parse("2026-01-01T00:01:00Z") });
    assert.equal(aggregate.distinct.runners, 3);
    assert.equal(aggregate.topRunners.find((row) => row.key === "ubuntu-latest-large").count, 2);
    assert.equal(aggregate.heatmap.runners.find((row) => row.runner === "ubuntu-latest-large").jobs, 2);
    assert.equal(rows[3].runnerName, "ubuntu-latest-large-44");
});

test("job and step selections normalize names without losing the instance ID", () => {
    for (const normalize of [normalizeJobRow, normalizeStepRow]) {
        const row = normalize(raw("9007199254740993"));
        assert.equal(row.runnerName, "ubuntu-latest-large");
        assert.equal(row.runnerId, "9007199254740993");
        assert.equal(matchRunner(row, { name: "ubuntu-latest-large", kind: "github-hosted" }), true);
        assert.equal(normalize(raw(42, "ubuntu-latest-large", "self-hosted")).runnerName, "ubuntu-latest-large-42");
    }
});

test("Step timeline runner pools and selection combine hosted instances into one type", () => {
    const jobs = [raw(41), raw(42)];
    for (const runner of [{}, { name: "ubuntu-latest-large" }]) {
        const result = aggregateSteps({ jobs, runner });
        assert.equal(result.runners.length, 1);
        assert.equal(result.runners[0].jobs, 2);
        assert.deepEqual(result.runners[0].runners, [{ value: "ubuntu-latest-large", count: 2 }]);
    }
});

test("attempt timelines preserve runner IDs in their adapted job and step rows", () => {
    const rows = timelineRows({
        RunID: 1,
        Jobs: [{
            JobID: 2, Kind: "hosted", RunnerID: "42", RunnerName: "ubuntu-latest-large-42",
            Steps: [{ Number: 1, Name: "Compile", Key: "Compile" }],
        }],
    }, "octo/app");
    assert.equal(normalizeJobRow(rows.jobs[0]).runnerId, "42");
    assert.equal(normalizeStepRow(rows.steps[0]).runnerId, "42");
    assert.equal(normalizeStepRow(rows.steps[0]).runnerName, "ubuntu-latest-large");
});

test("registered self-hosted IDs take precedence over hosted-looking instance names", () => {
    const metrics = buildMetrics({
        runners: [{ id: 42, name: "registered-runner" }],
        jobs: [{
            id: 1, runner_id: 42, runner_name: "ubuntu-latest-large-42",
            labels: ["ubuntu-latest-large"], status: "completed", conclusion: "success",
            created_at: "2026-01-01T00:00:00Z",
            started_at: "2026-01-01T00:00:01Z",
            completed_at: "2026-01-01T00:00:11Z",
        }],
    });
    assert.equal(metrics.runners.split.selfHosted.jobs, 1);
    assert.equal(metrics.runners.split.githubHosted.jobs, 0);
    assert.equal(metrics.usage.window.estimatedCost, 0);
});
