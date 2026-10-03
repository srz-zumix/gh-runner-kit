import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL(await readFile(new URL("../public/charts.js", import.meta.url), "utf8"));
const stepsSource = (await readFile(new URL("../public/steps.js", import.meta.url), "utf8"))
    .replace('"./charts.js"', JSON.stringify(chartsURL))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { renderSteps } = await import(moduleURL(stepsSource));

class TestNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
        this.listeners = {};
        this.text = "";
    }

    set textContent(value) {
        this.text = value;
        this.children = [];
    }

    get textContent() {
        return this.text + this.children.map((child) => child.textContent).join("");
    }

    setAttribute(key, value) {
        this.attributes[key] = value;
    }

    addEventListener(event, listener) {
        this.listeners[event] = listener;
    }

    append(child) {
        this.children.push(child);
    }
}

function stepPanels(result, state = {}) {
    const globals = ["document", "Node"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    globalThis.Node = TestNode;
    globalThis.document = {
        createElement: (tag) => new TestNode(tag),
        createTextNode: (text) => Object.assign(new TestNode("#text"), { textContent: text }),
    };
    try {
        return renderSteps({ ...state, steps: { result } });
    } finally {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    }
}

function descendants(node) {
    return [node, ...node.children.flatMap(descendants)];
}

function warningPanel(result) {
    return stepPanels(result).find((node) => node.className?.includes("collection-warnings"));
}

test("collection warnings use a collapsed native disclosure with the count and full messages", () => {
    const warnings = [
        "No jobs were returned for octo/app run 123 attempt 1; historical jobs may no longer be available from GitHub.",
        "<script>Historical collection failed</script>",
    ];
    const panel = warningPanel({ meta: { warnings } });
    assert.equal(panel.tag, "details");
    assert.equal(Object.hasOwn(panel.attributes, "open"), false);
    assert.equal(panel.children[0].tag, "summary");
    assert.equal(panel.children[0].textContent, "Collection warnings (2)");
    assert.equal(panel.children[1].tag, "ul");
    assert.deepEqual(panel.children[1].children.map((node) => node.tag), ["li", "li"]);
    assert.deepEqual(panel.children[1].children.map((node) => node.textContent), warnings);
    assert.ok(panel.children[1].children.every((node) => node.children.length === 0));
});

test("no warning disclosure is rendered for absent or empty collection warnings", () => {
    for (const result of [undefined, {}, { meta: {} }, { meta: { warnings: [] } }]) {
        assert.equal(warningPanel(result), undefined);
    }
});

test("every run-list row keeps its Gantt controls and links to its exact GitHub attempt", () => {
    const runs = [
        { repo: "octo/app", runId: "9007199254740993", runAttempt: 3, durationMs: 1000 },
        { repo: "octo/app", runId: "9007199254740993", runAttempt: 1, durationMs: 2000 },
        { repo: "octo/other", runId: "456", runAttempt: 2, durationMs: 3000 },
    ];
    for (const includeAllAttempts of [false, true]) {
        for (const host of [null, "ghe.example.com"]) {
            const nodes = stepPanels({ runs, includeAllAttempts }, { target: { host }, scope: "org" }).flatMap(descendants);
            const table = nodes.find((node) => node.tag === "table" && node.className === "runs-table");
            const rows = table.children[1].children;
            assert.equal(rows.length, runs.length);
            rows.forEach((row, index) => {
                const run = runs[index];
                const controls = descendants(row);
                const link = controls.find((node) => node.tag === "a");
                assert.equal(link.textContent, "GitHub");
                assert.equal(link.attributes.href, `https://${host || "github.com"}/${run.repo}/actions/runs/${run.runId}/attempts/${run.runAttempt}`);
                assert.equal(link.attributes.target, "_blank");
                assert.equal(link.attributes.rel, "noreferrer");
                assert.ok(link.attributes.title.includes(`attempt ${run.runAttempt}`));
                const gantt = controls.find((node) => node.tag === "button" && node.textContent === "Gantt");
                const runButton = controls.find((node) => node.tag === "button" && node.textContent === run.runId);
                assert.equal(typeof gantt.listeners.click, "function");
                assert.equal(gantt.listeners.click, runButton.listeners.click);
            });
        }
    }
});
