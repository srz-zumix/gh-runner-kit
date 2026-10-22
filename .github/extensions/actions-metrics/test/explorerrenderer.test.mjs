import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL((await readFile(new URL("../public/charts.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`));
const source = (await readFile(new URL("../public/explorer.js", import.meta.url), "utf8"))
    .replace('"./charts.js"', JSON.stringify(chartsURL))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { renderKpi, budgetControl } = await import(moduleURL(`${source}\nexport { kpi as renderKpi, budgetControl };`));
const { renderRankedBars } = await import(chartsURL);

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
