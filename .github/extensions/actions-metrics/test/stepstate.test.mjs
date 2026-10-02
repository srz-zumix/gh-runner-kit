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
