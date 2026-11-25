import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL((await readFile(new URL("../public/charts.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`));
const linksURL = moduleURL(await readFile(new URL("../public/links.js", import.meta.url), "utf8"));
const source = (await readFile(new URL("../public/runnerdetails.js", import.meta.url), "utf8"))
    .replace('"./charts.js"', JSON.stringify(chartsURL))
    .replace('"./links.js"', JSON.stringify(linksURL))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { trendCard, executionCard, selectRunnerDetails, buildControls, updatePicker, recentFiltersForm, requestDetails, view } = await import(moduleURL(`${source}\nexport { trendCard, executionCard, buildControls, updatePicker, recentFiltersForm, requestDetails, view };`));

class TestNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.text = "";
        this.open = false;
        this.style = {};
        this.offsetWidth = 160;
        this.offsetHeight = 40;
    }

    set textContent(value) {
        this.text = String(value);
        this.children = [];
    }

    get textContent() {
        return this.text + this.children.map(child => child.textContent).join("");
    }

    setAttribute(key, value) {
        this.attributes[key] = String(value);
        if (key === "open") this.open = true;
        if (key === "id") this.id = String(value);
    }

    removeAttribute(key) { delete this.attributes[key]; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 0, top: 0, width: 400, height: 150, bottom: 150 }; }
    querySelectorAll(selector) {
        return descendants(this).slice(1).filter(node => selector.startsWith(".")
            ? node.attributes.class === selector.slice(1)
            : node.tag === selector);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function withDocument(callback) {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: tag => new TestNode(tag),
        createElementNS: (_, tag) => new TestNode(tag),
        createTextNode: text => Object.assign(new TestNode("#text"), { textContent: text }),
    };
    try { callback(); }
    finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
}

test("daily failure chart uses UTC dates, percentage scale and gaps for missing days", () => withDocument(() => {
    selectRunnerDetails("runner-chart");
    const panel = trendCard({
        days: [
            { day: "2026-03-01", failed: 1, decided: 4, failureRate: 0.25 },
            { day: "2026-03-03", failed: 0, decided: 5, failureRate: 0 },
            { day: "2026-03-04", failed: 1, decided: 2, failureRate: 0.5 },
        ],
        unbucketedJobs: 2,
    });
    const nodes = descendants(panel);
    const chart = nodes.find(node => node.tag === "svg");
    assert.equal(chart.attributes.role, "group");
    assert.equal(chart.attributes["aria-label"], "Daily job failure rate by UTC completion date");
    const chartNodes = descendants(chart);
    const labels = chartNodes.filter(node => node.tag === "text").map(node => node.textContent);
    assert.deepEqual(labels.slice(0, 3), ["0%", "50%", "100%"]);
    assert.ok(labels.includes("2026-03-02"));
    const path = chartNodes.find(node => node.tag === "path");
    assert.equal((path.attributes.d.match(/M /g) ?? []).length, 2);
    assert.equal((path.attributes.d.match(/L /g) ?? []).length, 1);
    const points = chartNodes.filter(node => node.attributes.class === "chart__series-point");
    assert.equal(points.length, 3);
    const xs = points.map(point => Number(point.attributes.cx));
    assert.equal(xs[1] - xs[0], 2 * (xs[2] - xs[1]));
    assert.equal(points[0].children[0].textContent, "2026-03-01 (UTC)\nFailed jobs: 1 / 4 (25.0%)");
    assert.equal(points[1].children[0].textContent, "2026-03-03 (UTC)\nFailed jobs: 0 / 5 (0.0%)");
    assert.ok(nodes.some(node => node.className === "notice" && node.textContent.includes("2 decided jobs")));
    const table = descendants(nodes.find(node => node.tag === "details")).find(node => node.tag === "table");
    assert.equal(table.children[1].children.length, 3);
    assert.ok(!table.textContent.includes("2026-03-02"));
}));

test("daily table starts collapsed and retains explicit toggles across redraws", () => withDocument(() => {
    selectRunnerDetails("runner-collapse");
    const trend = { days: [{ day: "2026-03-01", failed: 1, decided: 4, failureRate: 0.25 }], unbucketedJobs: 0 };
    const disclosure = () => descendants(trendCard(trend)).find(node => node.tag === "details");
    const first = disclosure();
    assert.equal(first.open, false);
    assert.equal(first.children[0].textContent, "Daily table");
    first.open = true;
    first.listeners.toggle();
    const second = disclosure();
    assert.equal(second.open, true);
    first.open = false;
    first.listeners.toggle();
    const third = disclosure();
    assert.equal(third.open, true, "a detached disclosure cannot change the current state");
    third.open = false;
    third.listeners.toggle();
    const fourth = disclosure();
    assert.equal(fourth.open, false);
    fourth.open = true;
    fourth.listeners.toggle();
    selectRunnerDetails("another-runner");
    assert.equal(disclosure().open, false);
}));

test("empty trends explain missing data and a single zero-rate day remains visible", () => withDocument(() => {
    selectRunnerDetails("runner-empty");
    const empty = descendants(trendCard({ days: [], unbucketedJobs: 0 }));
    assert.ok(empty.some(node => node.className === "chart-empty" && node.textContent === "No decided jobs with completion timestamps."));
    assert.equal(empty.find(node => node.tag === "details").open, false);
    const single = descendants(trendCard({
        days: [{ day: "2026-03-04", failed: 0, decided: 2, failureRate: 0 }],
        unbucketedJobs: 0,
    }));
    const points = single.filter(node => node.attributes.class === "chart__series-point");
    assert.equal(points.length, 1);
    assert.equal(points[0].children[0].textContent, "2026-03-04 (UTC)\nFailed jobs: 0 / 2 (0.0%)");
}));

test("daily chart point tooltips show on hover and focus and dismiss on escape", () => withDocument(() => {
    const panel = trendCard({
        days: [{ day: "2026-03-04", failed: 1, decided: 4, failureRate: 0.25 }],
        unbucketedJobs: 0,
    });
    const nodes = descendants(panel);
    const chart = nodes.find(node => node.tag === "svg");
    const hit = nodes.find(node => node.attributes.class === "runner-details__chart-hit");
    const tooltip = nodes.find(node => node.attributes.role === "tooltip");
    assert.equal(chart.attributes.role, "group");
    assert.equal(hit.attributes.tabindex, "0");
    assert.equal(tooltip.hidden, true);
    hit.listeners.pointerenter({ pointerType: "mouse" });
    assert.equal(tooltip.hidden, false);
    assert.equal(tooltip.textContent, "2026-03-04 (UTC)\nFailed jobs: 1 / 4 (25.0%)");
    hit.listeners.focus();
    hit.listeners.pointerleave({ pointerType: "mouse" });
    assert.equal(tooltip.hidden, false);
    hit.listeners.keydown({ key: "Escape" });
    assert.equal(tooltip.hidden, true);
    hit.listeners.blur();
    assert.equal(tooltip.hidden, true);
}));

test("daily execution chart fills missing days with zero and uses its own tooltip", () => withDocument(() => {
    selectRunnerDetails("runner-executions");
    const nodes = descendants(executionCard({
        days: [
            { day: "2026-03-01", jobs: 3, succeeded: 2, failed: 1, other: 0 },
            { day: "2026-03-03", jobs: 1, succeeded: 0, failed: 0, other: 1 },
        ],
        unstartedJobs: 2,
    }));
    const chart = nodes.find(node => node.tag === "svg");
    assert.equal(chart.attributes["aria-label"], "Daily job executions by UTC start date");
    const points = descendants(chart).filter(node => node.attributes.class === "chart__series-point");
    assert.deepEqual(points.map(point => point.children[0].textContent), [
        "2026-03-01 (UTC)\nJobs: 3\nSucceeded: 2 · Failed: 1 · Other: 0",
        "2026-03-02 (UTC)\nJobs: 0\nSucceeded: 0 · Failed: 0 · Other: 0",
        "2026-03-03 (UTC)\nJobs: 1\nSucceeded: 0 · Failed: 0 · Other: 1",
    ]);
    const tooltip = nodes.find(node => node.attributes.role === "tooltip");
    assert.equal(tooltip.id, "runner-details-execution-tooltip");
    assert.ok(nodes.filter(node => node.attributes.class === "runner-details__chart-hit")
        .every(hit => hit.attributes["aria-describedby"] === "runner-details-execution-tooltip"));
    assert.equal(nodes.find(node => node.tag === "details").open, false);
    assert.ok(nodes.some(node => node.className === "notice" && node.textContent.includes("2 jobs have no start timestamp")));
}));

test("runner picker filters, supports keyboard and pointer selection, and follows external selections", () => withDocument(() => {
    view.names = [
        { runner: "alpha-runner", jobs: 10, failureRate: 0.1 },
        { runner: "beta-runner", jobs: 5, failureRate: null },
    ];
    view.namesStatus = "ready";
    view.runner = "";
    let updates = 0;
    view.onUpdate = () => { updates++; };
    const controls = view.controls = buildControls();
    globalThis.document.activeElement = controls.input;
    controls.input.listeners.focus();
    assert.equal(controls.list.children.length, 2);
    assert.equal(controls.input.attributes["aria-expanded"], "true");
    controls.input.value = "BETA";
    controls.input.listeners.input();
    assert.equal(controls.list.children.length, 1);
    assert.equal(controls.list.children[0].textContent, "beta-runner5 jobs · Unknown failed");
    const event = key => ({ key, target: controls.input, preventDefault() {} });
    controls.input.listeners.keydown(event("ArrowDown"));
    assert.equal(controls.input.attributes["aria-activedescendant"], "runner-details-option-0");
    controls.input.listeners.keydown(event("Enter"));
    assert.equal(view.runner, "beta-runner");
    assert.equal(controls.input.value, "beta-runner");
    assert.equal(controls.list.hidden, true);
    assert.equal(updates, 1);

    controls.input.listeners.click();
    assert.equal(controls.list.children.length, 2);
    controls.list.children[0].listeners.click();
    assert.equal(view.runner, "alpha-runner");
    assert.equal(updates, 2);
    selectRunnerDetails("beta-runner");
    assert.equal(controls.input.value, "beta-runner");
    controls.input.listeners.focus();
    controls.input.value = "missing";
    controls.input.listeners.input();
    controls.input.listeners.keydown(event("Enter"));
    assert.equal(view.runner, "beta-runner");
    assert.match(controls.hint.textContent, /No runner named missing/);
    controls.input.listeners.keydown(event("Escape"));
    assert.equal(controls.input.attributes["aria-expanded"], "false");
    view.controls = null;
}));

test("runner suggestions update after names load while the input is focused", () => withDocument(() => {
    view.names = [];
    view.namesStatus = "loading";
    const controls = view.controls = buildControls();
    globalThis.document.activeElement = controls.input;
    controls.input.listeners.focus();
    controls.input.value = "mac";
    controls.input.listeners.input();
    view.names = [
        { runner: "mac-runner", jobs: 2, failureRate: 0.5 },
        { runner: "linux-runner", jobs: 1, failureRate: 0 },
    ];
    view.namesStatus = "ready";
    updatePicker();
    assert.equal(controls.input.value, "mac");
    assert.equal(controls.list.hidden, false);
    assert.equal(controls.list.children.length, 1);
    assert.match(controls.list.children[0].textContent, /^mac-runner/);
    view.controls = null;
}));

test("recent job filter form applies and clears the combined draft", () => withDocument(() => {
    selectRunnerDetails("filter-runner");
    let updates = 0;
    view.onUpdate = () => { updates++; };
    const form = recentFiltersForm({ meta: { resultOptions: ["failure", "success", "__no_conclusion__"] }, recentJobs: [] });
    const nodes = descendants(form);
    nodes.find(node => node.attributes["aria-label"] === "Job result").listeners.change({ target: { value: "failure" } });
    nodes.find(node => node.attributes["aria-label"] === "Failed step").listeners.input({ target: { value: " Checkout " } });
    nodes.find(node => node.attributes["aria-label"] === "Repository").listeners.input({ target: { value: "PROJECT" } });
    nodes.find(node => node.attributes["aria-label"] === "Workflow").listeners.input({ target: { value: "build" } });
    nodes.find(node => node.attributes["aria-label"] === "Job").listeners.input({ target: { value: "mac" } });
    assert.equal(view.recentApplied.result, "");
    form.listeners.submit({ preventDefault() {} });
    assert.deepEqual(view.recentApplied, {
        result: "failure", failedStep: "checkout", repository: "project", workflow: "build", job: "mac",
    });
    assert.equal(updates, 1);
    nodes.find(node => node.tag === "button" && node.textContent === "Clear filters").listeners.click();
    assert.ok(Object.values(view.recentApplied).every(value => value === ""));
    assert.ok(Object.values(view.recentDraft).every(value => value === ""));
    assert.equal(updates, 2);
}));

test("recent filter requests ignore stale replies and retain previous results on failure", async () => {
    const originalFetch = globalThis.fetch;
    const pending = [];
    globalThis.fetch = (_, options) => new Promise(resolve => pending.push({ resolve, body: JSON.parse(options.body) }));
    try {
        view.onUpdate = () => {};
        selectRunnerDetails("filter-runner-request");
        const previous = { meta: { matchingJobs: 10 } };
        view.result = previous;
        const state = { identity: "fixture", status: "ready", metrics: { meta: { dataset: { id: "fixture" } } } };
        view.recentApplied.result = "failure";
        requestDetails(state);
        assert.equal(pending[0].body.recentJobFilters.result, "failure");
        view.recentApplied.result = "success";
        requestDetails(state);
        assert.equal(pending[1].body.recentJobFilters.result, "success");
        const latest = { meta: { matchingJobs: 2 } };
        pending[1].resolve({ ok: true, json: async () => latest });
        await new Promise(resolve => setImmediate(resolve));
        pending[0].resolve({ ok: true, json: async () => ({ meta: { matchingJobs: 9 } }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(view.result, latest);
        view.recentApplied.result = "failure";
        requestDetails(state);
        pending[2].resolve({ ok: false, status: 502, json: async () => ({ error: "Request failed" }) });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(view.status, "error");
        assert.equal(view.error, "Request failed");
        assert.equal(view.result, latest);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
