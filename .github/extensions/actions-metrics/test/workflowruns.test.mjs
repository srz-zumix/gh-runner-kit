import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRows } from "../shared/rows.mjs";
import { applyExploreFilters, buildExploreAggregate } from "../shared/explore.mjs";
import { collectJobRows } from "../lib/jobrows.mjs";

const start = Date.parse("2026-01-01T00:00:00Z");
const minute = 60000;
const at = value => new Date(start + value * minute).toISOString();
const options = { windowFrom: start, windowTo: start + 60 * minute, collectedAt: start + 60 * minute };
function job(id, run, overrides = {}) {
    return {
        Repo: "example/project", JobID: String(id), RunID: String(run), RunAttempt: 1,
        Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml",
        JobName: "build", Status: "completed", Conclusion: "success",
        RunCreatedAt: at(1), QueuedAt: at(2), StartedAt: at(3), CompletedAt: at(4),
        ...overrides,
    };
}
const timeline = (rows, extra = {}) => buildExploreAggregate(rows, { ...options, ...extra }).workflowRuns;
const nonzero = result => result.buckets.filter(bucket => bucket.total > 0);

test("workflow run timeline deduplicates jobs and retries while keeping repositories and workflow paths separate", () => {
    const result = timeline(normalizeRows([
        job(1, "9007199254740993"),
        job(2, "9007199254740993", { RunAttempt: 2, QueuedAt: at(30) }),
        job(3, "9007199254740995", { RunCreatedAt: at(10) }),
        job(4, "9007199254740993", { Repo: "example/other" }),
        job(5, 5, { WorkflowPath: ".github/workflows/other.yml" }),
    ]));
    assert.equal(result.total, 4);
    assert.equal(result.approximate, 0);
    assert.equal(result.workflowCount, 3);
    assert.deepEqual(result.series.map(entry => entry.count), [2, 1, 1]);
    assert.equal(result.series.filter(entry => entry.label === "CI").length, 3);
    assert.deepEqual(nonzero(result).map(bucket => [bucket.t, bucket.total]), [
        [start + minute, 3], [start + 10 * minute, 1],
    ]);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.total, 0), result.total);
});

test("workflow timestamps are canonical before filtering even with mixed authoritative and legacy rows", () => {
    const rows = normalizeRows([
        job(1, 1, { RunCreatedAt: null, QueuedAt: at(15), StartedAt: at(16), CompletedAt: at(17) }),
        job(2, 1, { RunCreatedAt: at(1), QueuedAt: at(20), StartedAt: at(20), CompletedAt: at(22), Conclusion: "failure" }),
        job(3, 2, { RunCreatedAt: null, QueuedAt: at(5), StartedAt: at(6), CompletedAt: at(7) }),
        job(4, 2, { RunCreatedAt: null, QueuedAt: at(25), StartedAt: at(26), CompletedAt: at(27), Conclusion: "failure" }),
    ]);
    for (const conclusion of ["success", "failure"]) {
        const filtered = applyExploreFilters(rows, { conclusion: [conclusion] });
        const result = timeline(filtered);
        assert.equal(result.total, 2);
        assert.equal(result.approximate, 1);
        assert.deepEqual(nonzero(result).map(bucket => bucket.t), [start + minute, start + 5 * minute]);
    }
    assert.equal(timeline(applyExploreFilters(rows, { repo: ["example/absent"] })).total, 0);
    assert.equal(timeline(applyExploreFilters(rows, { from: start + 20 * minute, to: start + 21 * minute })).total, 1);
});

test("workflow run timeline reports missing identities, missing times and exact half-open coverage separately", () => {
    const result = timeline(normalizeRows([
        job(1, 1, { RunCreatedAt: at(0) }),
        job(2, 2, { RunCreatedAt: at(-1) }),
        job(3, 3, { RunCreatedAt: at(60) }),
        job(4, 4, { RunCreatedAt: "invalid", QueuedAt: null, StartedAt: null }),
        job(5, 4, { RunCreatedAt: null, QueuedAt: null, StartedAt: null }),
        job(6, "", { RunCreatedAt: at(1) }),
        job(7, 0, { RunCreatedAt: at(1) }),
        job(8, 8, { Repo: "" }),
        job(9, 9, { RunCreatedAt: null, QueuedAt: null, StartedAt: at(7) }),
    ]));
    assert.equal(result.total, 2);
    assert.equal(result.missingTime, 1);
    assert.equal(result.outsideWindow, 2);
    assert.equal(result.unidentifiedJobs, 3);
    assert.equal(result.approximate, 1);
    assert.deepEqual(nonzero(result).map(bucket => bucket.t), [start, start + 7 * minute]);
    const empty = timeline([]);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.series, []);
    assert.ok(empty.buckets.every(bucket => bucket.total === 0));
});

test("each workflow retains its own series beyond twelve and respects workflow facets", () => {
    const rows = normalizeRows(Array.from({ length: 15 }, (_, index) =>
        job(index + 1, index + 1, { WorkflowPath: `.github/workflows/flow-${String(index).padStart(2, "0")}.yml` }),
    ));
    const result = timeline(rows);
    assert.equal(result.total, 15);
    assert.equal(result.workflowCount, 15);
    assert.equal(result.series.length, 15);
    assert.ok(result.series.every(entry => entry.workflowKey && entry.count === 1));
    assert.ok(result.series.every(entry => nonzero(result)[0][entry.key] === 1));
    assert.equal(result.series.reduce((sum, entry) => sum + entry.count, 0), 15);
    const last = rows.at(-1);
    const filtered = timeline(applyExploreFilters(rows, { workflow: [last.workflowKey] }));
    assert.equal(filtered.series[0].workflowKey, last.workflowKey);
    assert.equal(filtered.series.length, 1);
    assert.deepEqual(timeline(rows.slice().reverse()), result);
});

test("dataset job collection carries creation times by exact repository/run identity and honors the row cap", async () => {
    const jobs = Array.from({ length: 501 }, (_, index) => job(index + 1, index + 1));
    jobs[0] = job(1, "9007199254740993");
    jobs[1] = job(2, "9007199254740993", { Repo: "example/other" });
    const dataset = {
        meta: { collectedAt: at(60), id: "fixture", window: { Start: at(0), End: at(60) } },
        runs: jobs.map((row, index) => ({ repository: row.Repo, id: row.RunID, created_at: at(index % 60) })),
        select: () => ({ jobs }),
    };
    const result = await collectJobRows({ dataset, filters: { rowBudget: 500 } });
    assert.equal(result.rows.length, 500);
    assert.equal(result.rows[0].RunCreatedAt, at(0));
    assert.equal(result.rows[1].RunCreatedAt, at(1));
    assert.equal(result.truncated, true);
    assert.equal(jobs[0].RunCreatedAt, at(1));
    assert.equal(timeline(normalizeRows(result.rows)).total, 500);
});
