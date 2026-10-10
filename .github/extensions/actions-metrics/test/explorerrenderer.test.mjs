import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL(await readFile(new URL("../public/charts.js", import.meta.url), "utf8"));
const source = (await readFile(new URL("../public/explorer.js", import.meta.url), "utf8"))
    .replace('"./charts.js"', JSON.stringify(chartsURL))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { renderKpi } = await import(moduleURL(`${source}\nexport { kpi as renderKpi };`));

class TestNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.attributes = {};
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    append(child) { this.children.push(child); }
}

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
