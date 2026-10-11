import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { applyQueryPatch, normalizeQuery } from "../lib/query.mjs";
import { fieldsOfEditor, writeFieldValue, fieldByName } from "../shared/fields.mjs";

const moduleURL = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const source = (await readFile(new URL("../public/query.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const { initQueryEditors } = await import(moduleURL(source));
const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const { el } = await import(moduleURL(`${app.slice(app.indexOf("function el("), app.indexOf("const SVG_NS"))}\nexport { el };`));
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

class TestNode {
    constructor(tag, document) {
        this.tag = tag;
        this.document = document;
        this.children = [];
        this.attributes = {};
        this.listeners = new Map();
        this.value = "";
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        const classes = new Set();
        this.classList = {
            toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
            contains(name) { return classes.has(name); },
        };
    }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === "id") this.document.nodes.set(value, this);
        if (name === "value") this.value = String(value);
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }
    focus() { this.document.activeElement = this; }
    reportValidity() { return this.valid !== false; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    async emit(type) {
        if (this.disabled && type === "click") return;
        await Promise.all((this.listeners.get(type) ?? []).map(callback => callback({preventDefault() {}})));
    }
}

function harness(t) {
    const globals = ["document", "Node"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    const timezone = process.env.TZ;
    process.env.TZ = "UTC";
    t.after(() => {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
        if (timezone === undefined) delete process.env.TZ; else process.env.TZ = timezone;
    });
    const document = {
        nodes: new Map(), activeElement: null,
        createElement(tag) { return new TestNode(tag, this); },
        createTextNode(text) { return Object.assign(new TestNode("#text", this), {textContent: text}); },
        getElementById(id) { return this.nodes.get(id); },
    };
    for (const match of html.matchAll(/<([a-z]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
        const node = document.createElement(match[1]);
        node.setAttribute("id", match[2]);
        node.hidden = /\bhidden\b/.test(match[0]);
    }
    globalThis.Node = TestNode;
    globalThis.document = document;
    const state = {
        identity: "repo:example/project", key: "example/project", status: "ready",
        filters: normalizeQuery({repo: "example/project"}),
        metrics: {meta: {dataset: {
            collectionWindow: {Start: "2026-09-15T00:00:00Z", End: "2026-10-10T00:00:00Z"},
        }}, fleet: {bucket: "1h"}},
    };
    const patches = [];
    let apply = async patch => {
        state.filters = applyQueryPatch(state.filters, patch);
        editor.render();
    };
    const editor = initQueryEditors({
        state: () => state, now: () => Date.UTC(2026, 9, 11, 8, 30),
        el, applyFilters: async patch => { patches.push(patch); await apply(patch); },
    });
    editor.render();
    return {
        state, editor, patches, get: id => document.getElementById(id),
        setApply(callback) { apply = callback; },
        async edit(name, value) {
            const field = fieldByName(name);
            const control = document.getElementById(`query-field-${name}`);
            if (field.control === "checkbox") control.checked = value;
            else control.value = writeFieldValue(field, value);
            await control.emit(["select", "checkbox"].includes(field.control) ? "change" : "input");
        },
        async preset(group, id) {
            const control = document.getElementById(`${group}-period-preset`);
            control.value = id;
            await control.emit("change");
        },
    };
}

test("Collection and Display have disjoint controls, independent drafts, Apply and Reset", async t => {
    const h = harness(t);
    for (const id of ["collection", "display"]) {
        for (const field of fieldsOfEditor(id)) {
            assert.ok(h.get(`${id}-groups`).contains(h.get(`query-field-${field.name}`)), field.name);
        }
    }
    await h.get("collection-toggle").emit("click");
    await h.edit("event", "push");
    await h.get("display-toggle").emit("click");
    assert.equal(h.get("collection-editor").hidden, true);
    assert.equal(h.get("display-editor").hidden, false);
    await h.edit("bucket", "3h");
    assert.equal(h.get("collection-dirty-count").textContent, "1");
    assert.equal(h.get("display-dirty-count").textContent, "1");
    assert.match(h.get("collection-effect").textContent, /collects again/);
    assert.match(h.get("display-effect").textContent, /no github requests/i);
    await h.get("display-form").emit("submit");
    assert.deepEqual(h.patches, [{bucket: "3h"}]);
    assert.equal(h.get("query-field-event").value, "push");
    assert.equal(h.get("collection-dirty-count").hidden, false);
    await h.edit("targetWait", "2m");
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches[1], {event: "push"});
    assert.equal(h.get("display-dirty-count").hidden, false);
    assert.equal(h.get("query-field-targetWait").value, "2m");
    await h.edit("branch", "feature/example");
    await h.get("display-reset").emit("click");
    assert.equal(h.get("query-field-targetWait").value, "1m");
    assert.equal(h.get("query-field-branch").value, "feature/example");
    await h.get("collection-reset").emit("click");
    assert.equal(h.get("query-field-branch").value, "");
});

test("SSE updates preserve edited controls and focus, follow untouched controls and report conflicts while closed", async t => {
    const h = harness(t);
    await h.edit("event", "push");
    await h.edit("bucket", "3h");
    const control = h.get("query-field-event");
    control.focus();
    h.state.filters = applyQueryPatch(h.state.filters, {event: "schedule", bucket: "6h", targetWait: "2m"});
    h.editor.render();
    assert.equal(globalThis.document.activeElement, control);
    assert.equal(control.value, "push");
    assert.equal(h.get("query-field-bucket").value, "3h");
    assert.equal(h.get("query-field-targetWait").value, "2m");
    assert.match(h.get("collection-effect").textContent, /event changed elsewhere/);
    assert.match(h.get("display-effect").textContent, /bucket changed elsewhere/);
    h.state.filters = applyQueryPatch(h.state.filters, {bucket: "3h"});
    h.editor.render();
    assert.equal(h.get("display-dirty-count").hidden, true);
    assert.equal(h.get("collection-dirty-count").hidden, false);
    h.state.identity = "repo:example/another";
    h.state.key = "example/another";
    h.editor.render();
    assert.equal(h.get("collection-dirty-count").hidden, true);
    assert.equal(control.value, "schedule");
    assert.match(h.get("collection-effect").textContent, /draft was discarded/);
});

test("collection presets only stage dates, with historical exclusive ends and an open current end", async t => {
    const h = harness(t);
    await h.edit("bucket", "3h");
    await h.preset("collection", "last-month");
    assert.deepEqual(h.patches, []);
    assert.equal(h.get("query-field-since").value, "2026-09-01T00:00:00.000");
    assert.equal(h.get("query-field-until").value, "2026-10-01T00:00:00.000");
    assert.equal(h.get("query-field-days").disabled, true);
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches, [{since: "2026-09-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z"}]);
    assert.equal(h.get("display-dirty-count").hidden, false);
    await h.preset("collection", "this-month");
    assert.equal(h.get("query-field-until").value, "");
    assert.match(h.get("collection-period-note").textContent, /End remains now/);
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches[1], {since: "2026-10-01T00:00:00.000Z", until: ""});
    await h.edit("since", "");
    assert.equal(h.get("query-field-days").disabled, false);
    assert.equal(h.get("collection-period-preset").value, "");
    await h.preset("collection", "last-7-days");
    assert.equal(h.get("query-field-days").value, "7");
    assert.equal(h.get("query-field-since").value, "");
    assert.match(h.get("collection-period-note").textContent, /rolling 7 days/);
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches[2], {since: "", days: 7});
    await h.preset("collection", "last-30-days");
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches[3], {days: 30});
});

test("dataset presets clip both sides, explicitly mark missing dates, disable absent periods and clear separately", async t => {
    const h = harness(t);
    await h.preset("dataset", "last-month");
    assert.deepEqual(h.patches, []);
    assert.equal(h.get("query-field-filterFrom").value, "2026-09-15T00:00:00.000");
    assert.equal(h.get("query-field-filterTo").value, "2026-10-01T00:00:00.000");
    assert.match(h.get("dataset-period-note").textContent, /Partial coverage: requested.*missing dates are not analysed/);
    const options = h.get("dataset-period-preset").children;
    assert.equal(options.find(option => option.value === "today").disabled, true);
    assert.match(options.find(option => option.value === "last-month").textContent, /partial coverage/);
    await h.get("display-form").emit("submit");
    assert.deepEqual(h.patches[0], {filterFrom: "2026-09-15T00:00:00.000Z", filterTo: "2026-10-01T00:00:00.000Z"});
    assert.match(h.get("dataset-period-note").textContent, /Partial coverage/);
    await h.preset("dataset", "this-month");
    assert.equal(h.get("query-field-filterTo").value, "2026-10-10T00:00:00.000");
    await h.edit("event", "push");
    await h.get("dataset-period-clear").emit("click");
    assert.equal(h.get("query-field-filterFrom").value, "");
    assert.equal(h.get("query-field-filterTo").value, "");
    assert.equal(h.get("dataset-period-preset").value, "");
    await h.get("display-form").emit("submit");
    assert.deepEqual(h.patches[1], {filterFrom: "", filterTo: ""});
    assert.equal(h.get("query-field-event").value, "push");
});

test("failed applies preserve both drafts, block duplicate requests and respect form validation", async t => {
    const h = harness(t);
    await h.edit("event", "push");
    await h.edit("bucket", "3h");
    h.get("collection-form").valid = false;
    await h.get("collection-form").emit("submit");
    assert.deepEqual(h.patches, []);
    h.get("collection-form").valid = true;
    let reject;
    h.setApply(() => new Promise((resolve, rejectPromise) => { reject = rejectPromise; }));
    const pending = h.get("collection-form").emit("submit");
    assert.equal(h.get("collection-apply").disabled, true);
    assert.equal(h.get("display-apply").disabled, true);
    await h.get("display-form").emit("submit");
    assert.equal(h.patches.length, 1);
    reject(new Error("Example request failure"));
    await pending;
    assert.match(h.get("collection-effect").textContent, /Could not apply: Example request failure/);
    assert.equal(h.get("collection-dirty-count").hidden, false);
    assert.equal(h.get("display-dirty-count").hidden, false);
    assert.equal(h.get("display-apply").disabled, false);
});

test("Display cannot request a collection when the dataset is unavailable or loading", async t => {
    const h = harness(t);
    await h.edit("bucket", "3h");
    for (const unavailable of ["loading", "missing"]) {
        h.state.status = unavailable === "loading" ? "loading" : "error";
        if (unavailable === "missing") h.state.metrics = null;
        h.editor.render();
        assert.equal(h.get("display-apply").disabled, true);
        assert.equal(h.get("query-field-bucket").disabled, true);
        assert.equal(h.get("dataset-period-preset").disabled, true);
        await h.get("display-form").emit("submit");
        assert.deepEqual(h.patches, []);
    }
});
