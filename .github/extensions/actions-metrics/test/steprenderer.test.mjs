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

    get value() {
        if (this.inputValue !== undefined) return this.inputValue;
        if (this.tag === "select") {
            const option = this.children.find((child) => Object.hasOwn(child.attributes, "selected")) ?? this.children[0];
            return option?.value ?? "";
        }
        return this.attributes.value ?? "";
    }

    set value(value) {
        this.inputValue = String(value);
    }

    get checked() {
        return this.inputChecked ?? Object.hasOwn(this.attributes, "checked");
    }

    set checked(value) {
        this.inputChecked = value;
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
        return renderSteps({ ...state, steps: { ...state.steps, result } });
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

test("Runners shows cumulative run time and a dash for missing timing samples", () => {
    const panels = stepPanels({
        runnerFacets: {},
        runners: [2_554_642_000, 123_000, 0, null].map((total, index) => ({
            key: String(index), labels: `pool-${index}`, kinds: [], groups: [], runners: [], jobs: 1,
            wait: { samples: 0 },
            duration: { total, samples: total === null ? 0 : 1, p50: 0, p90: 0 },
            failureRate: 0,
        })),
    }, { identity: "runner-total-test" });
    const nodes = panels.flatMap(descendants);
    const table = nodes.find((node) => node.className === "runners-table");
    const headers = table.children[0].children[0].children.map((node) => node.textContent);
    const index = headers.indexOf("Total run");
    assert.ok(index >= 0);
    const cells = table.children[1].children.map((row) => row.children[index]);
    assert.deepEqual(cells.map((cell) => cell.textContent), ["709h 37m", "2m 3s", "0s", "–"]);
    assert.deepEqual(cells.map((cell) => cell.attributes.title ?? null), [
        `${(42_577.37).toLocaleString(undefined, { maximumFractionDigits: 2 })} min`,
        `${(2.05).toLocaleString(undefined, { maximumFractionDigits: 2 })} min`,
        "0 min",
        null,
    ]);
    assert.ok(nodes.some((node) => node.className === "card__note" && node.textContent.includes("excluding wait")));
});

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

test("typical bars shade red by failure rate while zero-failure and infrastructure colors stay distinct", () => {
    const rates = [0, 0.01, 0.25, 0.5, 1, 0, 0.5];
    const panels = stepPanels({
        typicalTimeline: [{
            job: "build",
            startOffsetMs: 0,
            steps: rates.map((failureRate, index) => ({
                name: `Step ${index}`,
                offsetMs: index * 1000,
                offsetP25Ms: index * 1000,
                offsetP90Ms: index * 1000 + 500,
                durationMs: 1000,
                durationP90Ms: 2000,
                failed: failureRate > 0,
                failureRate,
                infrastructure: index >= 5,
            })),
        }],
    });
    const nodes = panels.flatMap(descendants);
    const timeline = nodes.find((node) => node.attributes["aria-label"] === "Typical step timeline");
    const rows = timeline.children.filter((node) => node.className === "gantt__row");
    assert.equal(rows.length, rates.length);
    const shades = rows.map((row, index) => {
        const bar = descendants(row).find((node) => node.className?.split(" ").includes("gantt__bar"));
        assert.ok(bar.attributes.style.includes(`--failure-rate:${(rates[index] * 100).toFixed(3)}%`));
        assert.ok(row.attributes.title.includes(`failure ${(rates[index] * 100).toFixed(1)}%`));
        assert.equal(bar.className.includes("gantt__bar--failure-rate"), rates[index] > 0);
        return bar.className;
    });
    assert.equal(shades[0], "gantt__bar");
    assert.equal(shades[5], "gantt__bar gantt__bar--infra");
    assert.equal(shades[6].includes("gantt__bar--infra"), false);
    assert.ok(nodes.some((node) => node.className === "card__note" && node.textContent.includes("darker red means a higher failure rate")));
});

test("failure shading stays visible at 1% and increases continuously to solid red", async () => {
    const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
    const rule = css.match(/\.gantt__bar--failure-rate\s*\{([^}]+)\}/)?.[1];
    const scale = rule?.match(/calc\((\d+)% \+ var\(--failure-rate,\s*100%\) \* ([\d.]+)\)/);
    assert.ok(scale);
    const floor = Number(scale[1]);
    const slope = Number(scale[2]);
    const strengths = [0.00001, 0.01, 0.25, 0.5, 1].map(rate => floor + rate * 100 * slope);
    assert.ok(strengths[0] >= 30);
    assert.ok(Math.abs(strengths[1] - 30.7) < 1e-9);
    assert.equal(strengths.at(-1), 100);
    assert.ok(strengths.every((strength, index) => index === 0 || strength > strengths[index - 1]));
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

function interactivePanel(t, steps = {}, statePatch = {}) {
    const globals = ["document", "Node", "CustomEvent", "fetch"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
    t.after(() => {
        for (const [key, descriptor] of globals) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else delete globalThis[key];
        }
    });
    const state = {
        identity: t.name,
        metrics: { fleet: { workflows: [{ workflow: "CI", workflowPath: ".github/workflows/ci.yml" }, { workflow: "Build", workflowPath: ".github/workflows/build.yml" }] } },
        ...statePatch,
        steps: {
            status: "ready",
            settings: { workflow: "ci.yml", job: "", jobStatus: "", includeAllAttempts: false, runBudget: 500, mergeMatrix: true, showInfra: true, kind: "all", runnerFilter: { kind: "all" } },
            result: { available: true, stepStats: [], jobStats: [{ job: "build" }, { job: "test" }], runnerFacets: { kinds: [], labelSets: [], groups: [], names: [] } },
            ...steps,
        },
    };
    let nodes = [];
    const requests = [];
    const panel = {
        state,
        requests,
        runRequests: [],
        render: () => { nodes = renderSteps(state).flatMap(descendants); },
        control: (id) => nodes.find((node) => node.attributes.id === id),
        node: (predicate) => nodes.find(predicate),
        load: () => nodes.find((node) => node.tag === "button" && ["Load steps", "Loading…"].includes(node.textContent)),
        reply: (body) => ({ ok: true, json: async () => ({ ...state.steps.result, repository: body.repository, job: body.job, includeAllAttempts: body.includeAllAttempts }) }),
    };
    globalThis.Node = TestNode;
    globalThis.CustomEvent = class { constructor(type) { this.type = type; } };
    globalThis.document = {
        createElement: (tag) => new TestNode(tag),
        createElementNS: (_namespace, tag) => new TestNode(tag),
        createTextNode: (text) => Object.assign(new TestNode("#text"), { textContent: text }),
        getElementById: (id) => panel.control(id),
        dispatchEvent: () => panel.render(),
    };
    globalThis.fetch = async (url, options) => {
        if (url === "./api/step-prefs") return { json: async () => ({}) };
        if (url.startsWith("./api/run-timeline?")) {
            panel.runRequests.push(url);
            return { ok: true, json: async () => ({ timeline: { Repo: state.steps.settings.repository, Jobs: [] } }) };
        }
        assert.equal(url, "./api/steps");
        const body = JSON.parse(options.body);
        requests.push(body);
        return panel.respond ? panel.respond(body) : panel.reply(body);
    };
    panel.render();
    return panel;
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

function change(panel, id, value, property = "value", event = "change") {
    const control = panel.control(id);
    control[property] = value;
    control.listeners[event]({ target: control });
}

test("workflow choices use names from either report and respect the selected repository", () => {
    const rows = [
        { name: "App CI", repository: "owner/app", workflowPath: ".github/workflows/ci.yml" },
        { name: "Other CI", repository: "owner/other", workflowPath: ".github/workflows/ci.yml" },
        { repository: "owner/other", workflowPath: ".github/workflows/build.yml" },
    ];
    const select = (metrics, repository) => stepPanels({}, { scope: "org", metrics, steps: { settings: { repository } } }).flatMap(descendants).find((node) => node.attributes.id === "steps-workflow");
    const overview = { overview: { byWorkflow: rows } };
    assert.deepEqual(select(overview, "").children.map((node) => node.textContent), ["App CI · ci.yml", "build.yml"]);
    assert.deepEqual(select(overview, "owner/other").children.map((node) => node.textContent), ["Other CI · ci.yml", "build.yml"]);
    const fleet = { fleet: { workflows: rows.map(({ name, ...row }) => ({ ...row, workflow: name })) } };
    assert.deepEqual(select(fleet, "owner/other").children.map((node) => node.textContent), ["Other CI · ci.yml", "build.yml"]);
});

test("org repository selection reuses the loaded rows, keeps other filters and preserves pending collection edits", async (t) => {
    const panel = interactivePanel(t, {
        result: { available: true, stepStats: [], jobStats: [{ job: "build" }], repositoryFacets: [{ value: "owner/app", count: 2 }, { value: "owner/other", count: 1 }] },
    }, {
        scope: "org",
        metrics: { overview: { byWorkflow: [
            { name: "App CI", repository: "owner/app", workflowPath: ".github/workflows/ci.yml" },
            { name: "App build", repository: "owner/app", workflowPath: ".github/workflows/build.yml" },
            { name: "Other CI", repository: "owner/other", workflowPath: ".github/workflows/ci.yml" },
        ] } },
    });
    await settled();
    assert.equal(panel.control("steps-repository").value, "");
    panel.state.steps.settings.job = "build";
    panel.state.steps.settings.jobStatus = "failure";
    panel.render();
    change(panel, "steps-all-attempts", true, "checked");
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "25", "value", "input");
    change(panel, "steps-repository", "owner/other");
    await settled();
    assert.equal(panel.requests.length, 1);
    assert.equal(panel.requests[0].repository, "owner/other");
    assert.equal(panel.requests[0].reuseRows, true);
    assert.equal(panel.requests[0].job, "build");
    assert.equal(panel.requests[0].jobStatus, "failure");
    assert.equal(panel.requests[0].includeAllAttempts, false);
    assert.equal(panel.requests[0].workflow, "ci.yml");
    assert.equal(panel.requests[0].runBudget, 500);
    assert.equal(panel.control("steps-repository").value, "owner/other");
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "25");
    assert.deepEqual(panel.control("steps-workflow").children.map((node) => node.textContent), ["build.yml", "Other CI · ci.yml"]);
    assert.deepEqual(panel.control("steps-repository").children.map((node) => node.value), ["", "owner/app", "owner/other"]);
    change(panel, "steps-repository", "");
    await settled();
    assert.equal(panel.requests.length, 2);
    assert.equal(panel.requests[1].repository, "");
    assert.equal(panel.requests[1].reuseRows, true);
    assert.equal(panel.control("steps-all-attempts").checked, true);
});

test("repository controls are org-only and retain a saved unmatched repository", async (t) => {
    const panel = interactivePanel(t);
    await settled();
    assert.equal(panel.control("steps-repository"), undefined);
    panel.state.scope = "org";
    panel.state.steps.settings.repository = "owner/missing";
    panel.render();
    assert.equal(panel.control("steps-repository").value, "owner/missing");
    assert.equal(panel.control("steps-repository").children[1].textContent, "owner/missing (0 jobs)");
    panel.state.steps.result = null;
    panel.render();
    assert.ok(Object.hasOwn(panel.control("steps-repository").attributes, "disabled"));
    change(panel, "steps-repository", "");
    await settled();
    assert.equal(panel.requests.length, 0);
});

test("a single-run Gantt hides jobs outside the selected repository without discarding the run", () => {
    const timeline = { Repo: "owner/other", Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml", Jobs: [{ Name: "build", Steps: [] }] };
    const result = { stepStats: [] };
    const state = { scope: "org", steps: { settings: { repository: "owner/app", workflow: "ci.yml" }, timeline } };
    const nodes = stepPanels(result, state).flatMap(descendants);
    assert.equal(nodes.filter((node) => node.className === "gantt__row gantt__row--job").length, 0);
    assert.ok(nodes.some((node) => node.textContent.includes("This run belongs to owner/other, not owner/app.")));
    state.steps.settings.repository = "";
    assert.equal(stepPanels(result, state).flatMap(descendants).filter((node) => node.className === "gantt__row gantt__row--job").length, 1);
    assert.equal(timeline.Jobs.length, 1);
});

test("opening a bare run ID in an org uses the selected repository", async (t) => {
    const panel = interactivePanel(t, {}, { scope: "org" });
    await settled();
    panel.state.steps.settings.repository = "owner/app";
    panel.render();
    const input = panel.node((node) => node.attributes.placeholder === "run ID or URL");
    input.value = "42";
    input.listeners.input({ target: input });
    panel.node((node) => node.tag === "button" && node.textContent === "Open run").listeners.click();
    await settled();
    assert.equal(panel.runRequests.length, 1);
    const params = new URL(panel.runRequests[0], "http://127.0.0.1/").searchParams;
    assert.equal(params.get("repo"), "owner/app");
    assert.equal(params.get("run"), "42");
});

test("attempt mode waits for Load steps and stays drafted through renders and cached filters", async (t) => {
    const panel = interactivePanel(t);
    await settled();
    change(panel, "steps-all-attempts", true, "checked");
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "25", "value", "input");
    panel.render();
    assert.equal(panel.requests.length, 0);
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "25");

    for (const [id, value] of [["steps-job", "build"], ["steps-job-status", "failure"], ["steps-runner-kind", "self-hosted"]]) {
        change(panel, id, value);
        await settled();
        const request = panel.requests.at(-1);
        assert.equal(request.reuseRows, true);
        assert.equal(request.includeAllAttempts, false);
        assert.equal(request.workflow, "ci.yml");
        assert.equal(request.runBudget, 500);
        assert.equal(panel.control("steps-all-attempts").checked, true);
        assert.equal(panel.control("steps-workflow").value, "build.yml");
        assert.equal(panel.control("steps-budget").value, "25");
    }
    assert.equal(panel.requests.length, 3);
    assert.equal(panel.requests[0].job, "build");
    assert.equal(panel.requests[1].jobStatus, "failure");
    assert.equal(panel.requests[2].runnerFilter.kind, "self-hosted");

    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests.length, 4);
    assert.equal(panel.requests[3].reuseRows, false);
    assert.equal(panel.requests[3].includeAllAttempts, true);
    assert.equal(panel.requests[3].workflow, "build.yml");
    assert.equal(panel.requests[3].runBudget, 25);
    assert.equal(panel.state.steps.settings.includeAllAttempts, true);

    change(panel, "steps-all-attempts", false, "checked");
    change(panel, "steps-job", "");
    await settled();
    assert.equal(panel.requests.at(-1).includeAllAttempts, true);
    assert.equal(panel.requests.at(-1).reuseRows, true);
    assert.equal(panel.requests.at(-1).job, "");
    assert.equal(panel.control("steps-all-attempts").checked, false);
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests.at(-1).includeAllAttempts, false);
    assert.equal(panel.requests.at(-1).reuseRows, false);
});

test("zero run budget stays pending until Load steps and survives cached filters", async (t) => {
    const panel = interactivePanel(t);
    await settled();
    assert.equal(panel.control("steps-budget").attributes.min, "0");
    change(panel, "steps-budget", "0", "value", "input");
    panel.render();
    assert.equal(panel.requests.length, 0);
    assert.equal(panel.control("steps-budget").value, "0");
    change(panel, "steps-job", "build");
    await settled();
    assert.equal(panel.requests[0].reuseRows, true);
    assert.equal(panel.requests[0].runBudget, 500);
    assert.equal(panel.control("steps-budget").value, "0");
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests[1].reuseRows, false);
    assert.equal(panel.requests[1].runBudget, 0);
    assert.equal(panel.state.steps.settings.runBudget, 0);
    panel.render();
    assert.equal(panel.control("steps-budget").value, "0");
    change(panel, "steps-job", "test");
    await settled();
    assert.equal(panel.requests[2].reuseRows, true);
    assert.equal(panel.requests[2].runBudget, 0);
    change(panel, "steps-budget", "", "value", "input");
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests[3].runBudget, 500);
});

test("unlimited footnotes distinguish no run cap from an incomplete collection", () => {
    for (const truncated of [false, true]) {
        const nodes = stepPanels({
            meta: { workflow: "ci.yml", analysedRuns: 6001, runBudget: 0, truncated },
        }, { identity: `unlimited-footnote-${truncated}` }).flatMap(descendants);
        const note = nodes.find((node) => node.tag === "p" && node.textContent.includes("runs analysed"));
        assert.ok(note.textContent.includes(truncated ? "collection was truncated despite having no run-count limit" : "No run-count limit was applied"));
        assert.ok(!note.textContent.includes("run budget was reached"));
        assert.equal(note.className.includes("notice--warn"), truncated);
    }
});

test("job filters wait for collected rows and cannot supersede a fresh load", async (t) => {
    const panel = interactivePanel(t, { status: "idle", settings: null, result: null });
    await settled();
    assert.ok(Object.hasOwn(panel.control("steps-job").attributes, "disabled"));
    change(panel, "steps-job-status", "failure");
    await settled();
    assert.equal(panel.requests.length, 0);
    let reply;
    panel.respond = (body) => new Promise((resolve) => { reply = () => resolve(panel.reply(body)); });
    panel.load().listeners.click();
    assert.equal(panel.requests.length, 1);
    assert.ok(Object.hasOwn(panel.control("steps-job-status").attributes, "disabled"));
    change(panel, "steps-job-status", "success");
    change(panel, "steps-all-attempts", true, "checked");
    panel.render();
    assert.equal(panel.requests.length, 1);
    reply();
    await settled();
    assert.equal(panel.state.steps.settings.includeAllAttempts, false);
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.equal(Object.hasOwn(panel.control("steps-job").attributes, "disabled"), false);
});

test("a failed load retains its draft while filters still use the loaded attempt mode", async (t) => {
    const panel = interactivePanel(t);
    await settled();
    change(panel, "steps-all-attempts", true, "checked");
    panel.respond = async () => ({ ok: false, status: 502, json: async () => ({ reason: "Collection failed" }) });
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.equal(panel.state.steps.settings.includeAllAttempts, false);
    assert.equal(panel.requests.length, 1);
    // The server broadcasts an error snapshot that keeps the loaded result and settings.
    panel.state.steps = { ...panel.state.steps, status: "error", error: "Collection failed" };
    panel.render();
    assert.equal(Object.hasOwn(panel.control("steps-job").attributes, "disabled"), false);
    change(panel, "steps-job", "test");
    await settled();
    assert.equal(panel.requests.length, 2);
    assert.equal(panel.requests[1].reuseRows, true);
    assert.equal(panel.requests[1].includeAllAttempts, false);
});
