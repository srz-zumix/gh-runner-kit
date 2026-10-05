import test from "node:test";
import assert from "node:assert/strict";

import { DashboardStore } from "../lib/store.mjs";
import { DashboardInstance } from "../lib/instance.mjs";

function panels(count) {
    const store = new DashboardStore({ cwd: process.cwd() });
    const instances = Array.from({ length: count }, (_, index) => new DashboardInstance({ instanceId: String(index), store, query: { repo: "octo/app" } }));
    return { store, instances };
}

test("a newer step request aborts and supersedes the older one", () => {
    const { instances: [panel] } = panels(1);
    const first = panel.beginStepRequest();
    const second = panel.beginStepRequest();
    assert.equal(first.signal.aborted, true);
    assert.equal(panel.setStepMetrics({}, { rows: { key: "old" } }, first.generation), null);
    assert.notEqual(panel.setStepMetrics({}, { rows: { key: "new" }, stepStats: [] }, second.generation), null);
    assert.equal(panel.stepRowCache.key, "new");
    panel.dispose();
});

test("a credential change drops every panel's step state and pending requests", () => {
    const { store, instances: [a, b] } = panels(2);
    const step = a.beginStepRequest();
    a.setStepMetrics({}, { rows: { key: "rows" }, stepStats: [] }, step.generation);
    const run = b.beginRunTimeline();
    store.invalidateAuthCaches();
    assert.equal(a.stepRowCache, null);
    assert.equal(a.state().steps.result, null);
    assert.equal(run.signal.aborted, true);
    assert.equal(b.setRunTimeline({ run: "1" }, { RunID: 1 }, null, run.generation), null);
    assert.equal(b.state().steps.timeline, null);
    a.dispose();
    b.dispose();
});

test("closing the run timeline supersedes a pending open", () => {
    const { instances: [panel] } = panels(1);
    const run = panel.beginRunTimeline();
    panel.clearRunTimeline();
    assert.equal(run.signal.aborted, true);
    assert.equal(panel.setRunTimeline({ run: "1" }, { RunID: 1 }, null, run.generation), null);
    panel.dispose();
});

test("switching the target drops the step state", () => {
    const { instances: [panel] } = panels(1);
    const step = panel.beginStepRequest();
    panel.setStepMetrics({}, { rows: { key: "rows" }, stepStats: [] }, step.generation);
    panel.query = { ...panel.query, repo: "octo/other" };
    panel.attach();
    assert.equal(panel.state().steps.result, null);
    assert.equal(panel.stepRowCache, null);
    panel.dispose();
});

test("a failed step request keeps the settings of the retained result", () => {
    const { instances: [panel] } = panels(1);
    const failedFirst = panel.beginStepRequest();
    panel.setStepError({ workflow: "first.yml" }, new Error("boom"), failedFirst.generation);
    assert.equal(panel.state().steps.settings.workflow, "first.yml");
    const loaded = panel.beginStepRequest();
    panel.setStepMetrics({ workflow: "ci.yml", includeAllAttempts: false }, { rows: { key: "rows" }, stepStats: [] }, loaded.generation);
    const failed = panel.beginStepRequest();
    panel.setStepError({ workflow: "build.yml", includeAllAttempts: true }, new Error("boom"), failed.generation);
    const { steps } = panel.state();
    assert.equal(steps.status, "error");
    assert.equal(steps.error, "boom");
    assert.deepEqual(steps.settings, { workflow: "ci.yml", includeAllAttempts: false });
    assert.ok(steps.result);
    assert.equal(panel.stepRowCache.key, "rows");
    panel.dispose();
});

test("an unavailable step response keeps the retained result and its settings", () => {
    const { instances: [panel] } = panels(1);
    const loaded = panel.beginStepRequest();
    panel.setStepMetrics({ workflow: "ci.yml" }, { rows: { key: "rows" }, stepStats: [] }, loaded.generation);
    const failed = panel.beginStepRequest();
    const visible = panel.setStepMetrics({ workflow: "build.yml" }, { available: false, reason: "nope" }, failed.generation);
    assert.equal(visible.available, false);
    const { steps } = panel.state();
    assert.equal(steps.status, "error");
    assert.equal(steps.error, "nope");
    assert.deepEqual(steps.settings, { workflow: "ci.yml" });
    assert.equal(steps.result.available, undefined);
    assert.equal(panel.stepRowCache.key, "rows");
    panel.dispose();
});
