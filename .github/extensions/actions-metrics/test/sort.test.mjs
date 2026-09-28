import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSortValues, sortByCriteria, toggleSort, validateSorts } from "../shared/sort.mjs";
import { sortRows } from "../shared/explore.mjs";
import { DashboardInstance } from "../lib/instance.mjs";

test("plain click replaces priorities; Shift+click appends, toggles and removes a secondary", () => {
    let sorts = toggleSort([], "success", "desc", false, { clearOnThird: true });
    sorts = toggleSort(sorts, "runs", "desc", true);
    assert.deepEqual(sorts, [{ key: "success", direction: "desc" }, { key: "runs", direction: "desc" }]);
    sorts = toggleSort(sorts, "success", "desc", true);
    assert.deepEqual(sorts[0], { key: "success", direction: "asc" });
    sorts = toggleSort(sorts, "runs", "desc", true);
    assert.deepEqual(sorts[1], { key: "runs", direction: "asc" });
    sorts = toggleSort(sorts, "runs", "desc", true);
    assert.deepEqual(sorts, [{ key: "success", direction: "asc" }]);
    sorts = toggleSort(sorts, "success", "desc", false, { clearOnThird: true });
    assert.deepEqual(sorts, []);
    sorts = toggleSort([{ key: "success", direction: "asc" }, { key: "runs", direction: "desc" }],
        "runs", "desc", false, { clearOnThird: true });
    assert.deepEqual(sorts, [{ key: "runs", direction: "desc" }]);
    sorts = toggleSort([{ key: "success", direction: "desc" }, { key: "runs", direction: "asc" }],
        "runs", "desc", false, { clearOnThird: true });
    assert.deepEqual(sorts, [{ key: "runs", direction: "desc" }]);
});

test("criteria sort by raw success then run count, missing last, with stable ties", () => {
    const rows = [
        { name: "missing", success: null, runs: 100 },
        { name: "few", success: 0.401, runs: 5 },
        { name: "many", success: 0.401, runs: 12 },
        { name: "tie", success: 0.401, runs: 12 },
        { name: "rounded", success: 0.404, runs: 100 },
    ];
    const accessors = { success: (row) => row.success, runs: (row) => row.runs };
    const sorts = [{ key: "success", direction: "asc" }, { key: "runs", direction: "desc" }];
    assert.deepEqual(sortByCriteria(rows, sorts, accessors).map((row) => row.name),
        ["many", "tie", "few", "rounded", "missing"]);
    assert.deepEqual(sortByCriteria(rows, [{ key: "success", direction: "desc" }], accessors)
        .map((row) => row.name), ["rounded", "few", "many", "tie", "missing"]);
    assert.equal(compareSortValues(null, 0, "asc"), 1);
    assert.equal(compareSortValues(null, 0, "desc"), 1);
});

test("invalid, duplicate and excessive criteria are refused", () => {
    const keys = { a: () => 1 };
    for (const sorts of [null, "a", [{ key: "b", direction: "asc" }],
        [{ key: "a", direction: "up" }], [{ key: "a", direction: "asc" }, { key: "a", direction: "desc" }]]) {
        assert.throws(() => validateSorts(sorts, keys), /Invalid sort criteria/);
    }
});

test("explorer sorts all rows lexicographically before a page is cut", () => {
    const rows = [
        { i: 0, workflow: "alpha", durationMs: 1 },
        { i: 1, workflow: "beta", durationMs: 10 },
        { i: 2, workflow: "alpha", durationMs: 10 },
        { i: 3, workflow: "alpha", durationMs: null },
    ];
    const sorted = sortRows(rows, [{ key: "workflow", direction: "asc" }, { key: "duration", direction: "desc" }]);
    assert.deepEqual(sorted.map((row) => row.i), [2, 0, 3, 1]);
});

test("runner pages sort all matches by every criterion before slicing", () => {
    const panel = Object.create(DashboardInstance.prototype);
    panel.projectionId = "current";
    panel.timelineAll = [
        { runner: "z", jobs: 3, busyMs: 1, jobMs: 1 },
        { runner: "a", jobs: 1, busyMs: 1, jobMs: 1 },
        { runner: "c", jobs: 3, busyMs: 5, jobMs: 5 },
        { runner: "b", jobs: 3, busyMs: 5, jobMs: 5 },
    ];
    const sorts = [{ key: "jobs", direction: "desc" }, { key: "busyMs", direction: "desc" }];
    assert.deepEqual(panel.runnerPage({ projection: "current", sorts, limit: 2 }).rows.map((row) => row.runner), ["b", "c"]);
    assert.deepEqual(panel.runnerPage({ projection: "current", sorts, limit: 2, offset: 2 }).rows.map((row) => row.runner), ["z", "a"]);
    assert.deepEqual(panel.runnerPage({ projection: "current", sorts: [], limit: 2 }).rows.map((row) => row.runner), ["a", "b"]);
    assert.throws(() => panel.runnerPage({ projection: "current", sorts: [{ key: "jobs", direction: "wrong" }] }),
        (error) => error.status === 400);
    assert.throws(() => panel.runnerPage({ projection: "old", sorts }), (error) => error.status === 409);
});
