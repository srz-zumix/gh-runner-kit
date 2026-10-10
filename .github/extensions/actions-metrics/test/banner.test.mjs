import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/banner.js", import.meta.url), "utf8");
const { renderDataBanner } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

class TestNode {
    constructor(tag) {
        this.tag = tag;
        this.children = [];
        this.listeners = {};
        this.open = false;
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(event, listener) { this.listeners[event] = listener; }
}

function withDocument(callback) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
    globalThis.document = { createElement: tag => new TestNode(tag) };
    try { callback(); }
    finally {
        if (previous) Object.defineProperty(globalThis, "document", previous);
        else delete globalThis.document;
    }
}

test("Partial data starts collapsed, keeps all messages as text and remembers toggles across updates", () => withDocument(() => {
    const banner = new TestNode("div");
    const state = { identity: "repo:a/b", metrics: { meta: { warnings: ["Missing history", "<script>unsafe</script>"] } } };
    renderDataBanner(banner, state);
    const details = banner.children[0];
    assert.equal(details.tag, "details");
    assert.equal(details.open, false);
    assert.equal(details.children[0].tag, "summary");
    assert.equal(details.children[0].children[0].textContent, "Partial data (2)");
    assert.deepEqual(details.children[1].children.map(node => node.textContent), state.metrics.meta.warnings);
    details.open = true;
    details.listeners.toggle();
    renderDataBanner(banner, state);
    assert.equal(banner.children[0].open, true);
    details.open = false;
    details.listeners.toggle();
    renderDataBanner(banner, state);
    assert.equal(banner.children[0].open, true, "detached disclosure must not change current state");
    banner.children[0].open = false;
    banner.children[0].listeners.toggle();
    renderDataBanner(banner, state);
    assert.equal(banner.children[0].open, false);
    banner.children[0].open = true;
    banner.children[0].listeners.toggle();
    renderDataBanner(banner, {...state, identity: "repo:c/d"});
    assert.equal(banner.children[0].open, false, "new targets start collapsed");
}));

test("collection errors remain visible rather than hidden in Partial data, and empty banners disappear", () => withDocument(() => {
    const banner = new TestNode("div");
    for (const errorCode of [undefined, "rate_limited"]) {
        renderDataBanner(banner, { error: "Failed to collect", errorCode, metrics: {meta: {warnings: ["Missing jobs"]}} });
        assert.equal(banner.hidden, false);
        assert.equal(banner.className, "banner banner--error");
        assert.equal(banner.children[0].tag, "strong");
        assert.deepEqual(banner.children[1].children.map(node => node.textContent), ["Failed to collect", "Missing jobs"]);
    }
    renderDataBanner(banner, {metrics: {meta: {warnings: []}}});
    assert.equal(banner.hidden, true);
}));
