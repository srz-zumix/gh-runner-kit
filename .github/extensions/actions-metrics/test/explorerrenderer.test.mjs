import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL((await readFile(new URL("../public/charts.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`));
const source = (await readFile(new URL("../public/explorer.js", import.meta.url), "utf8"))
    .replace('"./charts.js"', JSON.stringify(chartsURL))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { renderKpi, budgetControl, workflowRunsCard, hourlyJobsCard, view } = await import(moduleURL(`${source}\nexport { kpi as renderKpi, budgetControl, workflowRunsCard, hourlyJobsCard, view };`));
const { renderRankedBars } = await import(chartsURL);
const { buildExploreAggregate } = await import("../shared/explore.mjs");
const { normalizeRows } = await import("../shared/rows.mjs");

class TestNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
        this.listeners = {};
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(child) { this.children.push(child); }
    addEventListener(event, listener) { this.listeners[event] = listener; }
}

test("hourly job charts show 24 local-hour labels and separate total and fractional average scales", () => {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: tag => new TestNode(tag),
        createElementNS: (_, tag) => new TestNode(tag),
        createTextNode: text => Object.assign(new TestNode("#text"), { textContent: text }),
    };
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    try {
        view.aggregate = {
            hourlyJobs: {
                days: 3, total: 1, missingTime: 2, outsideWindow: 4,
                hours: Array.from({ length: 24 }, (_, hour) => ({
                    hour, total: hour === 9 ? 1 : 0, average: hour === 9 ? 1 / 3 : 0,
                })),
            },
        };
        view.snapshot = { truncated: true };
        const panel = hourlyJobsCard();
        const nodes = descendants(panel);
        const charts = nodes.filter(node => node.tag === "svg");
        assert.deepEqual(charts.map(chart => chart.attributes["aria-label"]), [
            "Total jobs by local hour", "Average jobs per day by local hour",
        ]);
        for (const chart of charts) {
            const labels = descendants(chart).filter(node => /^\d{2}:00$/.test(node.textContent ?? ""));
            assert.deepEqual(labels.map(node => node.textContent),
                Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, "0")}:00`));
        }
        assert.ok(nodes.some(node => node.tag === "title" && node.textContent.includes("09:00\nTotal jobs: 1")));
        assert.ok(nodes.some(node => node.tag === "title" && node.textContent.includes(`09:00\nAverage jobs per day: ${(1 / 3).toLocaleString(undefined, { maximumFractionDigits: 3 })}`)));
        assert.match(panel.children[2].textContent, /total \/ 3 local calendar days/);
        assert.match(panel.children[2].textContent, /2 jobs have no queue\/start time/);
        assert.match(panel.children[2].textContent, /4 jobs are outside/);
        assert.match(panel.children[2].textContent, /truncated/);
        view.aggregate.hourlyJobs.hours.forEach(hour => { hour.total = hour.average = 0; });
        assert.equal(descendants(hourlyJobsCard()).filter(node => node.tag === "svg").length, 2);
    } finally {
        view.aggregate = null;
        view.snapshot = null;
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("workflow run chart renders distinct unstacked workflow lines, points, tooltips and an explicit empty state", () => {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: tag => new TestNode(tag),
        createElementNS: (_, tag) => new TestNode(tag),
        createTextNode: text => Object.assign(new TestNode("#text"), { textContent: text }),
    };
    const descendants = node => [node, ...node.children.flatMap(descendants)];
    try {
        const from = Date.parse("2026-01-01T00:00:00Z");
        const options = { windowFrom: from, windowTo: from + 3600000, collectedAt: from + 3600000 };
        const job = {
            Repo: "example/project", RunID: "1", JobID: "2", Workflow: "CI",
            WorkflowPath: ".github/workflows/ci.yml", QueuedAt: from + 60000,
        };
        view.aggregate = buildExploreAggregate(normalizeRows([
            job,
            { ...job, RunID: "2", JobID: "3", RunCreatedAt: from + 60000 },
            { ...job, RunID: "3", JobID: "4", Workflow: "Deploy",
                WorkflowPath: ".github/workflows/deploy.yml", RunCreatedAt: from + 180000 },
        ]), options);
        view.snapshot = { truncated: true };
        const panel = workflowRunsCard();
        const nodes = descendants(panel);
        assert.ok(nodes.some(node => node.attributes["aria-label"] === "Workflow runs over time"));
        assert.ok(nodes.some(node => node.textContent === "example/project / CI (.github/workflows/ci.yml): 2"));
        assert.ok(nodes.some(node => node.textContent === "example/project / Deploy (.github/workflows/deploy.yml): 1"));
        assert.ok(nodes.some(node => node.tag === "title" && node.textContent.includes("CI (.github/workflows/ci.yml): 2")));
        const lines = nodes.filter(node => node.attributes.class === "chart__series-line");
        assert.equal(lines.length, 2);
        assert.ok(lines.every(node => node.tag === "path" && node.attributes.fill === "none"));
        assert.notEqual(lines[0].attributes.stroke, lines[1].attributes.stroke);
        assert.notEqual(lines[0].attributes.d, lines[1].attributes.d);
        assert.ok(lines.every(node => node.attributes.d.split("L").length === 60));
        const points = nodes.filter(node => node.attributes.class === "chart__series-point");
        assert.equal(points.length, 2);
        assert.equal(points[0].attributes.cy, "8");
        assert.equal(points[1].attributes.cy, "101");
        assert.notEqual(points[0].attributes.cx, points[1].attributes.cx);
        assert.ok(!nodes.some(node => node.tag === "rect" || node.attributes.class === "chart__area"));
        assert.match(panel.children[2].textContent, /1 runs use their earliest loaded job/);
        assert.match(panel.children[2].textContent, /truncated; run counts may be incomplete/);
        assert.ok(!nodes.some(node => node.attributes.class === "brush__surface"));
        view.aggregate = buildExploreAggregate([], options);
        const empty = descendants(workflowRunsCard());
        assert.ok(empty.some(node => node.textContent === "No workflow runs with a known creation time in this selection."));
        assert.ok(!empty.some(node => node.tag === "svg"));
    } finally {
        view.aggregate = null;
        view.snapshot = null;
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("Explorer settings accept a million rows while preserving the default and existing budgets", () => {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: tag => new TestNode(tag),
        createTextNode: text => Object.assign(new TestNode("#text"), { textContent: text }),
    };
    try {
        for (const [value, expected] of [[undefined, 20000], [200000, 200000], [1000000, 1000000]]) {
            const panel = budgetControl({ filters: { rowBudget: value } });
            const input = panel.children[1].children[0].children.find(node => node.tag === "input");
            assert.equal(input.attributes.min, "500");
            assert.equal(input.attributes.max, "1000000");
            assert.equal(input.attributes.value, String(expected));
        }
    } finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("Selection separates each metric label, value and hint into block rows like the dashboard cards", () => {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: tag => new TestNode(tag),
        createTextNode: text => Object.assign(new TestNode("#text"), {textContent: text}),
    };
    try {
        for (const [label, value, hint] of [
            ["Jobs", "43,968", "43,921 finished"],
            ["Peak concurrency", "72", "p95 43"],
            ["Compute", "46d 20h", "summed job time"],
            ["Unfinished", "47", "closed at collection time"],
            ["Median wait", "12s", undefined],
        ]) {
            const tile = renderKpi(label, value, hint);
            const expected = hint ? [label, value, hint] : [label, value];
            assert.equal(tile.tag, "div");
            assert.equal(tile.className, "kpi");
            assert.deepEqual(tile.children.map(node => node.tag), expected.map(() => "div"));
            assert.deepEqual(tile.children.map(node => node.textContent), expected);
            assert.deepEqual(tile.children.map(node => node.className),
                ["kpi__label", "kpi__value", ...(hint ? ["kpi__hint"] : [])]);
        }
    } finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
});

test("ranked chart scales and renders every entry above the function-argument limit", () => {
    class CountingNode extends TestNode {
        constructor(tag) {
            super(tag);
            this.style = {};
            this.count = 0;
        }
        append(...children) {
            for (const child of children) {
                this.count += 1;
                this.first ??= child;
                this.last = child;
                if (this.tag !== "ul") this.children.push(child);
            }
        }
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    globalThis.document = { createElement: tag => new CountingNode(tag) };
    try {
        const count = 400_003;
        const entries = Array.from({ length: count }, (_, index) => ({ key: String(index), value: index === count - 1 ? 8 : 2 }));
        const chart = renderRankedBars(entries, { valueOf: entry => entry.value });
        assert.equal(chart.count, count);
        assert.equal(chart.first.children[1].children[0].style.width, "25%");
        assert.equal(chart.last.children[1].children[0].style.width, "100%");
        assert.equal(chart.last.children[0].textContent, String(count - 1));
    } finally {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else delete globalThis.document;
    }
});
