import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { aggregateSteps, stepIdOf } from "../shared/steps.mjs";

const moduleURL = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const chartsURL = moduleURL((await readFile(new URL("../public/charts.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`));
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

test("step and runner filter captions use the same compact font size as other controls", async () => {
    const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
    for (const selector of ["controls__label", "inline-field", "facet__summary"]) {
        const rule = css.match(new RegExp(`\\.${selector}\\s*\\{([^}]+)\\}`))?.[1];
        assert.match(rule ?? "", /font-size:\s*var\(--text-body-small,\s*12px\)\s*;/, selector);
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
        reply: (body) => ({ ok: true, json: async () => ({ ...state.steps.result, repository: body.repository, job: body.job, includeAllAttempts: body.includeAllAttempts, runnerFilter: body.runnerFilter }) }),
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

function runnerResult(runner = {}) {
    const rows = [
        ["box*", "self-hosted", ["self-hosted", "linux"]],
        ["box-02", "self-hosted", ["self-hosted", "linux"]],
        ["", "unknown", ["self-hosted", "linux"]],
        ["GitHub Actions", "hosted", ["ubuntu-latest"]],
    ].map(([name, kind, labels], index) => ({
        Repo: "example/project", Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml",
        JobID: String(2000 + index), RunID: String(1000 + index), RunAttempt: 1, JobName: "build",
        RunnerName: name, Kind: kind, Labels: labels, RunnerGroup: "Default",
        Status: name ? "completed" : "queued", Conclusion: name ? "success" : "",
        QueuedAt: "2026-01-01T00:00:00Z", StartedAt: name ? "2026-01-01T00:00:02Z" : null,
        CompletedAt: name ? "2026-01-01T00:00:12Z" : null, Wait: 2000000000, Duration: 10000000000,
    }));
    return { available: true, ...aggregateSteps({ jobs: rows, runner }) };
}

function runnerPanel(t) {
    const panel = interactivePanel(t, { result: runnerResult() });
    panel.reply = body => ({ ok: true, json: async () => runnerResult(body.runnerFilter) });
    return panel;
}

function recoveryPanel(t, includeAllAttempts = false) {
    const base = {
        Repo: "example/project", Workflow: "CI", WorkflowPath: ".github/workflows/ci.yml",
        RunID: "1000", JobName: "build (linux)", Kind: "self-hosted", Labels: ["self-hosted", "linux"],
        RunnerGroup: "Default", Status: "completed",
        QueuedAt: "2026-01-01T00:00:00Z", StartedAt: "2026-01-01T00:00:01Z",
        CompletedAt: "2026-01-01T00:00:11Z", Duration: 10000000000,
    };
    const jobs = [
        { ...base, JobID: "2000", RunAttempt: 1, Conclusion: "failure", RunnerName: "box-a", Latest: false },
        { ...base, JobID: "2001", RunAttempt: 2, Conclusion: "success", RunnerName: "box-b", Latest: true },
        { ...base, JobID: "2002", RunAttempt: 1, Conclusion: "failure", RunnerName: "box-c", JobName: "build (macos)", Latest: false },
        { ...base, JobID: "2003", RunAttempt: 2, Conclusion: "failure", RunnerName: "box-c", JobName: "build (macos)", Latest: true },
    ];
    const steps = jobs.flatMap(row => ["Compile", "Cleanup"].map((name, index) => ({
        ...row, JobStartedAt: row.StartedAt, JobCompletedAt: row.CompletedAt, JobQueuedAt: row.QueuedAt,
        JobConclusion: row.Conclusion, RunStartedAt: base.QueuedAt,
        StepName: name, StepKey: name, StepOccurrence: 1, StepNumber: index + 1,
        StepConclusion: (index === 0 && row.Conclusion === "failure") || (index === 1 && row.JobID === "2003") ? "failure" : "success",
    })));
    const result = body => {
        const selected = body.includeAllAttempts || body.jobStatus === "rerun_success" ? jobs : jobs.filter(row => row.Latest);
        return {
            available: true,
            ...aggregateSteps({
                jobs: selected, steps: steps.filter(row => selected.some(job => job.JobID === row.JobID)),
                jobStatus: body.jobStatus, failedStep: body.failedStep, stepConditions: body.stepConditions, includeAllAttempts: body.includeAllAttempts, runner: body.runnerFilter,
            }),
        };
    };
    const panel = interactivePanel(t, { result: result({ includeAllAttempts }) });
    panel.state.steps.settings.includeAllAttempts = includeAllAttempts;
    panel.reply = body => ({ ok: true, json: async () => result(body) });
    panel.render();
    return panel;
}

function runnerCheckbox(panel, key, value) {
    return panel.node(node => node.tag === "input" && node.attributes["data-facet"] === key && node.value === value);
}

function addStepCondition(panel, name, conclusion = "failure", occurrence = 1) {
    change(panel, "steps-condition-step", stepIdOf(name, "", occurrence));
    change(panel, "steps-condition-conclusion", conclusion);
    panel.control("steps-condition-add").listeners.click();
}

function pickRunner(panel, key, value) {
    const checkbox = runnerCheckbox(panel, key, value);
    assert.ok(checkbox, `Missing ${key}: ${value}`);
    checkbox.listeners.change({ target: checkbox });
}

function toggleRunners(panel) {
    let stopped = false;
    panel.node(node => node.className === "ghost runners-table__toggle").listeners.click({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true);
}

function runnerButton(panel, name) {
    return panel.node(node => node.className === "ghost runners-table__runner" && node.textContent === name);
}

test("runner pools start collapsed, expand without requests and keep hosted runners aggregated", async t => {
    const panel = interactivePanel(t, { result: runnerResult() });
    await settled();
    assert.equal(runnerButton(panel, "box*"), undefined);
    const toggle = panel.node(node => node.className === "ghost runners-table__toggle");
    assert.equal(toggle.attributes["aria-expanded"], "false");
    const table = panel.node(node => node.className === "runners-table");
    assert.equal(descendants(table).filter(node => node.className === "ghost runners-table__toggle").length, 1);
    toggleRunners(panel);
    assert.equal(panel.requests.length, 0);
    assert.equal(panel.node(node => node.className === "ghost runners-table__toggle").attributes["aria-expanded"], "true");
    assert.ok(runnerButton(panel, "box*"));
    assert.ok(runnerButton(panel, "box-02"));
    assert.equal(runnerButton(panel, "(unassigned)").attributes.disabled, "");
    assert.equal(runnerButton(panel, "GitHub Actions"), undefined);
    const rows = panel.node(node => node.className === "runners-table").children[1].children;
    const individual = rows.find(row => row.className.includes("runners-table__row--individual"));
    assert.equal(individual.children.length, 11);
    const first = rows.find(row => descendants(row).some(node => node.className === "ghost runners-table__runner" && node.textContent === "box*"));
    assert.equal(first.children[4].textContent, "1");
    assert.equal(first.children[9].textContent, "10s");
    const unassigned = rows.find(row => descendants(row).some(node => node.className === "ghost runners-table__runner" && node.textContent === "(unassigned)"));
    assert.equal(unassigned.children[9].textContent, "–");
    toggleRunners(panel);
    assert.equal(runnerButton(panel, "box*"), undefined);
    assert.equal(panel.requests.length, 0);
    toggleRunners(panel);
    for (const { object, key, value } of [
        { object: panel.state, key: "identity", value: `${panel.state.identity}-other-target` },
        { object: panel.state.steps.settings, key: "workflow", value: "other.yml" },
        { object: panel.state.steps.settings, key: "repository", value: "example/other" },
    ]) {
        const original = object[key];
        object[key] = value;
        panel.render();
        assert.equal(runnerButton(panel, "box*"), undefined);
        object[key] = original;
        panel.render();
        assert.ok(runnerButton(panel, "box*"));
    }
    assert.equal(panel.requests.length, 0);
});

test("individual runner clicks filter loaded rows by exact name and toggle without discarding drafts", async t => {
    const panel = runnerPanel(t);
    await settled();
    toggleRunners(panel);
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "0", "value", "input");
    change(panel, "steps-all-attempts", true, "checked");
    runnerButton(panel, "box*").listeners.click({ stopPropagation() {} });
    await settled();
    assert.equal(panel.requests.length, 1);
    const request = panel.requests[0];
    assert.equal(request.reuseRows, true);
    assert.equal(request.workflow, "ci.yml");
    assert.equal(request.runBudget, 500);
    assert.equal(request.includeAllAttempts, false);
    assert.deepEqual(request.runnerFilter.names, ["box*"]);
    assert.equal(request.runnerFilter.kind, "all");
    assert.equal(request.runnerFilter.labels, "");
    assert.equal(runnerButton(panel, "box*").attributes["aria-pressed"], "true");
    assert.equal(runnerCheckbox(panel, "names", "box*").checked, true);
    assert.equal(runnerButton(panel, "box-02"), undefined);
    assert.ok(runnerCheckbox(panel, "names", "box-02"));
    assert.equal(panel.state.steps.result.runners[0].jobs, 1);
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "0");
    assert.equal(panel.control("steps-all-attempts").checked, true);
    runnerButton(panel, "box*").listeners.click({ stopPropagation() {} });
    await settled();
    assert.equal(panel.requests.at(-1).runnerFilter.name, "");
    assert.equal(Object.hasOwn(panel.requests.at(-1).runnerFilter, "names"), false);
    assert.equal(panel.requests.at(-1).runnerFilter.labels, "");
    assert.equal(runnerButton(panel, "box*").attributes["aria-pressed"], "false");
});

test("multiple runner names survive other facets and loading, and chips remove individual values", async t => {
    const panel = runnerPanel(t);
    await settled();
    toggleRunners(panel);
    runnerButton(panel, "box*").listeners.click({ stopPropagation() {} });
    await settled();
    pickRunner(panel, "groups", "Default");
    await settled();
    pickRunner(panel, "names", "box-02");
    await settled();
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box*", "box-02"]);
    assert.deepEqual(panel.requests.at(-1).runnerFilter.groups, ["Default"]);
    assert.equal(panel.state.steps.result.runners[0].jobs, 2);
    assert.ok(runnerButton(panel, "box-02"));
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests.at(-1).reuseRows, false);
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box*", "box-02"]);
    panel.node(node => node.attributes.title === "Remove Name: box*").listeners.click();
    await settled();
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box-02"]);
    assert.deepEqual(panel.requests.at(-1).runnerFilter.groups, ["Default"]);
    assert.equal(runnerButton(panel, "box*"), undefined);
    panel.node(node => node.textContent === "Clear runner filter").listeners.click();
    await settled();
    assert.deepEqual(panel.requests.at(-1).runnerFilter, { kind: "all", labels: "", group: "", name: "" });
    assert.ok(runnerButton(panel, "box*"));
});

test("pending runner selections survive a newer selection and its late response", async t => {
    const panel = runnerPanel(t);
    await settled();
    toggleRunners(panel);
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    panel.respond = body => panel.requests.length === 1 ? first : panel.reply(body);
    try {
        runnerButton(panel, "box*").listeners.click({ stopPropagation() {} });
        assert.equal(runnerCheckbox(panel, "names", "box*").checked, true);
        pickRunner(panel, "names", "box-02");
        await settled();
        assert.equal(panel.requests.length, 2);
        assert.deepEqual(panel.requests[1].runnerFilter.names, ["box*", "box-02"]);
    } finally {
        finish(panel.reply(panel.requests[0]));
    }
    await settled();
    assert.deepEqual(panel.state.steps.result.runnerFilter.names, ["box*", "box-02"]);
    assert.equal(runnerButton(panel, "box*").attributes["aria-pressed"], "true");
    assert.equal(runnerButton(panel, "box-02").attributes["aria-pressed"], "true");
});

test("pool selection can be widened with runs-on checkboxes after other pools disappear", async t => {
    const panel = runnerPanel(t);
    await settled();
    const table = panel.node(node => node.className === "runners-table");
    table.children[1].children.find(row => row.children[0].textContent.includes("self-hosted,linux")).listeners.click();
    await settled();
    assert.equal(panel.state.steps.result.runners.length, 1);
    assert.equal(panel.state.steps.result.runners[0].jobs, 3);
    pickRunner(panel, "labelSets", "ubuntu-latest");
    await settled();
    assert.deepEqual(panel.requests.at(-1).runnerFilter.labelSets, ["self-hosted,linux", "ubuntu-latest"]);
    assert.equal(panel.state.steps.result.runners.length, 2);
    assert.equal(panel.state.steps.result.runners.reduce((sum, pool) => sum + pool.jobs, 0), 4);
    assert.ok(panel.requests.every(request => request.reuseRows));
});

test("saved scalar runner selections render as checkboxes and migrate without losing other facets", async t => {
    const filter = { kind: "self-hosted", labels: "LINUX,SELF-HOSTED", group: "Default", name: "box*", nameExact: true };
    const panel = runnerPanel(t);
    await settled();
    panel.state.steps.result = runnerResult(filter);
    panel.state.steps.settings.runnerFilter = filter;
    panel.render();
    assert.equal(runnerCheckbox(panel, "kinds", "self-hosted").checked, true);
    assert.equal(runnerCheckbox(panel, "kinds", "unknown").checked, true);
    assert.equal(runnerCheckbox(panel, "labelSets", "self-hosted,linux").checked, true);
    assert.equal(runnerCheckbox(panel, "names", "box*").checked, true);
    pickRunner(panel, "names", "box-02");
    await settled();
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box*", "box-02"]);
    assert.equal(panel.requests.at(-1).runnerFilter.kind, filter.kind);
    assert.equal(panel.requests.at(-1).runnerFilter.labels, filter.labels);
    assert.equal(panel.requests.at(-1).runnerFilter.group, filter.group);
    assert.equal(panel.state.steps.result.runners[0].jobs, 2);
});

test("saved wildcard chips can be removed separately from exact starred runner names", async t => {
    const panel = runnerPanel(t);
    await settled();
    panel.state.steps.result = runnerResult({ name: "box*" });
    panel.render();
    assert.equal(runnerCheckbox(panel, "names", "box*").checked, false);
    pickRunner(panel, "names", "box*");
    await settled();
    assert.equal(panel.state.steps.result.meta.totalJobs, 2);
    panel.node(node => node.attributes.title === "Remove the saved wildcard name filter").listeners.click();
    await settled();
    assert.equal(panel.requests.at(-1).runnerFilter.name, "");
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box*"]);
    assert.equal(panel.state.steps.result.meta.totalJobs, 1);
});

test("runner facets retain zero-count selections, cap options and preserve search and disclosure state", async t => {
    const result = runnerResult({ names: ["retired-runner"] });
    result.runnerFacets.names = Array.from({ length: 501 }, (_, index) => ({ value: `runner-${index}`, count: 1 }));
    const panel = interactivePanel(t, { result });
    await settled();
    const picker = () => panel.control("steps-runner-names");
    const checkboxes = () => descendants(picker()).filter(node => node.tag === "input" && node.attributes.type === "checkbox");
    assert.equal(checkboxes().length, 300);
    assert.equal(checkboxes()[0].value, "retired-runner");
    assert.equal(checkboxes()[0].checked, true);
    const chosen = descendants(picker()).find(node => node.className === "facet__option facet__option--on");
    assert.equal(chosen.children.at(-1).textContent, "0");
    picker().listeners.toggle({ target: { open: true } });
    change(panel, "steps-runner-names-search", "runner-499", "value", "input");
    assert.deepEqual(checkboxes().map(node => node.value), ["runner-499"]);
    panel.render();
    assert.ok(Object.hasOwn(picker().attributes, "open"));
    assert.equal(panel.control("steps-runner-names-search").value, "runner-499");
    assert.ok(panel.node(node => node.attributes.title === "Remove Name: retired-runner"));
    panel.state.steps.settings.workflow = "build.yml";
    panel.render();
    assert.equal(Object.hasOwn(picker().attributes, "open"), false);
    assert.equal(panel.control("steps-runner-names-search").value, "");
    assert.equal(panel.requests.length, 0);
});

test("runner facets cannot supersede a fresh collection", async t => {
    const panel = runnerPanel(t);
    await settled();
    let finish;
    panel.respond = body => new Promise(resolve => { finish = () => resolve(panel.reply(body)); });
    panel.load().listeners.click();
    try {
        assert.ok(Object.hasOwn(runnerCheckbox(panel, "names", "box*").attributes, "disabled"));
        const summary = panel.control("steps-runner-names").children[0];
        assert.equal(summary.attributes["aria-disabled"], "true");
        let prevented = false;
        summary.listeners.click({ preventDefault() { prevented = true; } });
        assert.equal(prevented, true);
        pickRunner(panel, "names", "box*");
        assert.equal(panel.requests.length, 1);
    } finally {
        finish();
    }
    await settled();
    assert.equal(Object.hasOwn(runnerCheckbox(panel, "names", "box*").attributes, "disabled"), false);
});

test("re-run success selection displays failed and successful job attempts and filtered runner totals", async t => {
    const panel = recoveryPanel(t);
    await settled();
    assert.ok(panel.control("steps-job-status").children.some(node => node.value === "rerun_success" && node.textContent === "Succeeded on re-run (all attempts)"));
    change(panel, "steps-job-status", "rerun_success");
    await settled();
    assert.equal(panel.requests[0].reuseRows, true);
    assert.equal(panel.requests[0].includeAllAttempts, false);
    assert.equal(panel.state.steps.result.includeAllAttempts, true);
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.ok(Object.hasOwn(panel.control("steps-all-attempts").attributes, "disabled"));
    assert.deepEqual(panel.state.steps.result.runs.map(row => row.conclusion), ["success", "failure"]);
    assert.equal(panel.state.steps.result.runners[0].jobs, 2);
    pickRunner(panel, "names", "box-a");
    await settled();
    assert.equal(panel.requests.at(-1).jobStatus, "rerun_success");
    assert.equal(panel.state.steps.result.runners[0].jobs, 1);
    assert.equal(panel.state.steps.result.runs[0].conclusion, "failure");
});

test("re-run success is not offered by an older provider before its safe reload", async t => {
    const panel = interactivePanel(t);
    await settled();
    assert.equal(panel.control("steps-job-status").children.some(node => node.value === "rerun_success"), false);
    panel.state.steps.result.meta = { jobRecoverySupported: true };
    panel.render();
    assert.equal(panel.control("steps-job-status").children.some(node => node.value === "rerun_success"), true);
});

test("a pending recovery selection survives another facet and its late first response", async t => {
    const panel = recoveryPanel(t);
    await settled();
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    panel.respond = body => panel.requests.length === 1 ? first : panel.reply(body);
    try {
        change(panel, "steps-job-status", "rerun_success");
        pickRunner(panel, "names", "box-b");
        await settled();
        assert.equal(panel.requests[1].jobStatus, "rerun_success");
        assert.equal(panel.state.steps.result.runs.length, 1);
    } finally {
        finish(panel.reply(panel.requests[0]));
    }
    await settled();
    assert.equal(panel.state.steps.result.runs.length, 1);
    assert.equal(panel.state.steps.result.runs[0].conclusion, "success");
    assert.equal(panel.control("steps-all-attempts").checked, true);
});

for (const preference of [false, true]) {
    test(`re-run recovery preserves the ${preference ? "all" : "latest"} attempt preference through loads and clearing`, async t => {
        const panel = recoveryPanel(t, preference);
        await settled();
        change(panel, "steps-workflow", "build.yml");
        change(panel, "steps-budget", "0", "value", "input");
        change(panel, "steps-job-status", "rerun_success");
        await settled();
        assert.equal(panel.requests.at(-1).workflow, "ci.yml");
        assert.equal(panel.requests.at(-1).runBudget, 500);
        assert.equal(panel.control("steps-workflow").value, "build.yml");
        assert.equal(panel.control("steps-budget").value, "0");
        panel.load().listeners.click();
        await settled();
        assert.equal(panel.requests.at(-1).includeAllAttempts, preference);
        assert.equal(panel.requests.at(-1).workflow, "build.yml");
        assert.equal(panel.requests.at(-1).runBudget, 0);
        assert.equal(panel.state.steps.settings.includeAllAttempts, preference);
        change(panel, "steps-job-status", "");
        await settled();
        assert.equal(panel.requests.at(-1).includeAllAttempts, preference);
        assert.equal(panel.control("steps-all-attempts").checked, preference);
        assert.equal(Object.hasOwn(panel.control("steps-all-attempts").attributes, "disabled"), false);
    });
}

test("re-run recovery Gantt keeps the selected job on failed and successful attempts and warns on missing membership", () => {
    const jobs = [
        { Name: "build (linux)", Steps: [], Conclusion: "failure" },
        { Name: "build (macos)", Steps: [], Conclusion: "failure" },
    ];
    const result = { stepStats: [], runs: [{
        repo: "example/project", runId: "1000", runAttempt: 2,
        workflowPath: ".github/workflows/ci.yml", recoveredJobs: ["build (linux)"],
    }], meta: { recovery: { ambiguousJobs: 1 } } };
    for (const attempt of [1, 2]) {
        const timeline = { Repo: "example/project", RunID: "1000", RunAttempt: attempt, WorkflowPath: ".github/workflows/ci.yml", Jobs: jobs };
        const state = { steps: { settings: { workflow: "ci.yml", jobStatus: "rerun_success" }, timeline } };
        const nodes = stepPanels(result, state).flatMap(descendants);
        assert.equal(nodes.filter(node => node.className === "gantt__row gantt__row--job").length, 1);
        assert.ok(nodes.some(node => node.textContent.includes("multiple same-name jobs")));
        timeline.RunID = "1001";
        const outside = stepPanels(result, state).flatMap(descendants);
        assert.ok(outside.some(node => node.textContent.includes("membership is unavailable")));
        assert.equal(outside.filter(node => node.className === "gantt__row gantt__row--job").length, 0);
    }
});

test("failed-step selection keeps all steps of only failing attempts and intersects recovered jobs", async t => {
    const panel = recoveryPanel(t);
    await settled();
    change(panel, "steps-job-status", "rerun_success");
    await settled();
    assert.equal(panel.state.steps.result.runs.length, 2);
    addStepCondition(panel, "Compile");
    await settled();
    assert.equal(panel.requests.at(-1).reuseRows, true);
    assert.deepEqual(panel.requests.at(-1).failedStep, { name: "Compile", occurrence: 1 });
    assert.equal(panel.requests.at(-1).jobStatus, "rerun_success");
    assert.equal(panel.requests.at(-1).includeAllAttempts, false);
    assert.equal(panel.state.steps.result.includeAllAttempts, true);
    assert.deepEqual(panel.state.steps.result.runs.map(row => [row.runAttempt, row.conclusion]), [[1, "failure"]]);
    assert.deepEqual(panel.state.steps.result.stepStats.map(row => row.stepName), ["Cleanup", "Compile"]);
    assert.equal(panel.state.steps.result.runners[0].jobs, 1);
    pickRunner(panel, "names", "box-a");
    await settled();
    assert.deepEqual(panel.requests.at(-1).failedStep, { name: "Compile", occurrence: 1 });
    assert.equal(panel.state.steps.result.runners[0].jobs, 1);
    panel.control("steps-conditions-clear").listeners.click();
    await settled();
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.deepEqual(panel.requests.at(-1).runnerFilter.names, ["box-a"]);
    assert.equal(panel.requests.at(-1).jobStatus, "rerun_success");
});

test("failed-step choices distinguish occurrences, retain saved zero matches and clear without a reload", async t => {
    const panel = interactivePanel(t, {
        result: { available: true, stepStats: [], meta: { failedStepSupported: true }, failedStepFacets: [
            { name: "Upload", occurrence: 1, count: 3 },
            { name: "Upload", occurrence: 2, count: 1 },
            { name: "Upload #2", occurrence: 1, count: 1 },
        ] },
    });
    await settled();
    const options = panel.control("steps-failed-step").children;
    assert.equal(new Set(options.map(node => node.value)).size, 4);
    assert.equal(new Set(options.map(node => node.textContent)).size, 4);
    change(panel, "steps-failed-step", stepIdOf("Upload", "", 2));
    await settled();
    assert.deepEqual(panel.requests.at(-1).failedStep, { name: "Upload", occurrence: 2 });
    panel.state.steps.result.failedStepFacets = [];
    panel.render();
    assert.equal(panel.control("steps-failed-step").value, stepIdOf("Upload", "", 2));
    assert.ok(panel.control("steps-failed-step").children.some(node => node.textContent === "Upload · occurrence 2 (0)"));
    change(panel, "steps-job-status", "failure");
    await settled();
    assert.deepEqual(panel.requests.at(-1).failedStep, { name: "Upload", occurrence: 2 });
    change(panel, "steps-failed-step", "");
    await settled();
    assert.equal(panel.requests.at(-1).failedStep, null);
});

test("a pending failed-step filter survives another facet, preserves drafts and ignores a late response", async t => {
    const panel = recoveryPanel(t);
    await settled();
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "0", "value", "input");
    change(panel, "steps-all-attempts", true, "checked");
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    panel.respond = body => panel.requests.length === 1 ? first : panel.reply(body);
    try {
        addStepCondition(panel, "Compile");
        pickRunner(panel, "names", "box-c");
        await settled();
        assert.deepEqual(panel.requests[1].failedStep, { name: "Compile", occurrence: 1 });
        assert.equal(panel.requests[1].workflow, "ci.yml");
        assert.equal(panel.requests[1].runBudget, 500);
        assert.equal(panel.requests[1].includeAllAttempts, false);
        assert.equal(panel.state.steps.result.meta.totalJobs, 1);
    } finally {
        finish(panel.reply(panel.requests[0]));
    }
    await settled();
    assert.deepEqual(panel.state.steps.settings.runnerFilter.names, ["box-c"]);
    assert.equal(panel.control("steps-condition-step").value, stepIdOf("Compile"));
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "0");
    assert.equal(panel.control("steps-all-attempts").checked, true);
    panel.load().listeners.click();
    await settled();
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.deepEqual(panel.requests.at(-1).stepConditions, []);
    assert.equal(panel.requests.at(-1).workflow, "build.yml");
    assert.equal(panel.requests.at(-1).runBudget, 0);
    assert.equal(panel.requests.at(-1).includeAllAttempts, true);
    assert.equal(panel.requests.at(-1).reuseRows, false);
});

test("failed-step controls wait for provider support and disable during a fresh load", async t => {
    const panel = recoveryPanel(t);
    await settled();
    delete panel.state.steps.result.meta.failedStepSupported;
    delete panel.state.steps.result.meta.stepConditionsSupported;
    panel.render();
    assert.equal(panel.control("steps-failed-step"), undefined);
    panel.state.steps.result.meta.failedStepSupported = true;
    panel.state.steps.result.meta.stepConditionsSupported = true;
    panel.render();
    let finish;
    panel.respond = body => new Promise(resolve => { finish = () => resolve(panel.reply(body)); });
    panel.load().listeners.click();
    try {
        assert.ok(Object.hasOwn(panel.control("steps-condition-step").attributes, "disabled"));
        addStepCondition(panel, "Compile");
        assert.equal(panel.requests.length, 1);
    } finally {
        finish();
    }
    await settled();
    assert.equal(Object.hasOwn(panel.control("steps-condition-step").attributes, "disabled"), false);
});

test("single-run failed-step Gantt keeps a matching job's full steps and excludes successful retries", () => {
    const timeline = {
        Repo: "example/project", RunID: "1000", RunAttempt: 1, WorkflowPath: ".github/workflows/ci.yml",
        Jobs: [
            { Name: "build", Conclusion: "failure", Steps: [
                { Name: "Compile", Key: "Compile", Occurrence: 1, Conclusion: "failure" },
                { Name: "Cleanup", Key: "Cleanup", Occurrence: 1, Conclusion: "success" },
            ] },
            { Name: "other", Conclusion: "failure", Steps: [{ Name: "Compile", Key: "Compile", Occurrence: 1, Conclusion: "success" }] },
        ],
    };
    const before = JSON.stringify(timeline);
    const result = { stepStats: [] };
    const state = { steps: { settings: { workflow: "ci.yml", failedStep: { name: "Compile", occurrence: 1 } }, timeline } };
    const nodes = stepPanels(result, state).flatMap(descendants);
    assert.equal(nodes.filter(node => node.className === "gantt__row gantt__row--job").length, 1);
    assert.equal(nodes.filter(node => node.className === "gantt__row").length, 2);
    assert.ok(nodes.some(node => node.textContent.includes("Copy mermaid exports the full run.")));
    assert.equal(JSON.stringify(timeline), before);
    timeline.RunAttempt = 2;
    for (const job of timeline.Jobs) {
        job.Conclusion = "success";
        for (const step of job.Steps) step.Conclusion = "success";
    }
    const retry = stepPanels(result, state).flatMap(descendants);
    assert.equal(retry.filter(node => node.className === "gantt__row gantt__row--job").length, 0);
    assert.ok(retry.some(node => node.textContent === "No jobs match the selected filters."));
});

test("the condition composer adds A failure AND B success, removes one condition and clears all", async t => {
    const panel = recoveryPanel(t, true);
    await settled();
    assert.equal(panel.control("steps-failed-step"), undefined);
    assert.ok(panel.control("steps-condition-step").children.some(node => node.textContent.startsWith("Cleanup")));
    change(panel, "steps-condition-step", stepIdOf("Compile"));
    change(panel, "steps-condition-conclusion", "failure");
    assert.equal(panel.requests.length, 0);
    panel.control("steps-condition-add").listeners.click();
    await settled();
    assert.equal(panel.state.steps.result.meta.totalJobs, 3);
    addStepCondition(panel, "Cleanup", "success");
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions, [
        { name: "Compile", occurrence: 1, conclusion: "failure" },
        { name: "Cleanup", occurrence: 1, conclusion: "success" },
    ]);
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.equal(panel.requests.at(-1).reuseRows, true);
    assert.equal(panel.state.steps.result.meta.totalJobs, 2);
    assert.equal(panel.state.steps.result.runners[0].jobs, 2);
    assert.ok(panel.state.steps.result.stepStats.some(step => step.stepName === "Cleanup"));
    assert.deepEqual(panel.state.steps.result.runs.map(row => row.runAttempt), [1]);
    panel.node(node => node.attributes.title === "Remove condition: Compile · occurrence 1 = failure").listeners.click();
    await settled();
    assert.equal(panel.state.steps.result.meta.totalJobs, 3);
    assert.deepEqual(panel.requests.at(-1).stepConditions, [{ name: "Cleanup", occurrence: 1, conclusion: "success" }]);
    panel.control("steps-conditions-clear").listeners.click();
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions, []);
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.equal(panel.state.steps.result.meta.totalJobs, 4);
});

test("pending AND conditions survive later filters and collection drafts without a stale response winning", async t => {
    const panel = recoveryPanel(t, true);
    await settled();
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "0", "value", "input");
    let finish;
    const first = new Promise(resolve => { finish = resolve; });
    panel.respond = body => panel.requests.length === 1 ? first : panel.reply(body);
    try {
        addStepCondition(panel, "Compile", "failure");
        addStepCondition(panel, "Cleanup", "success");
        pickRunner(panel, "names", "box-a");
        await settled();
        assert.equal(panel.requests[1].stepConditions.length, 2);
        assert.equal(panel.requests[2].stepConditions.length, 2);
        assert.equal(panel.requests[2].workflow, "ci.yml");
        assert.equal(panel.requests[2].runBudget, 500);
        assert.equal(panel.state.steps.result.meta.totalJobs, 1);
    } finally {
        finish(panel.reply(panel.requests[0]));
    }
    await settled();
    assert.equal(panel.state.steps.settings.stepConditions.length, 2);
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "0");
    panel.load().listeners.click();
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions, []);
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.equal(panel.requests.at(-1).workflow, "build.yml");
    assert.equal(panel.requests.at(-1).runBudget, 0);
});

for (const [name, filters] of [
    ["AND conditions", { stepConditions: [
        { name: "Compile", occurrence: 1, conclusion: "failure" },
        { name: "Cleanup", occurrence: 1, conclusion: "success" },
    ] }],
    ["legacy failed step", { failedStep: { name: "Compile", occurrence: 1 } }],
]) {
    test(`loading another workflow clears ${name} and the composer but preserves other filters`, async t => {
        const panel = recoveryPanel(t, true);
        await settled();
        Object.assign(panel.state.steps.settings, filters);
        panel.render();
        change(panel, "steps-job-status", "rerun_success");
        await settled();
        pickRunner(panel, "names", "box-a");
        await settled();
        change(panel, "steps-job", "build (linux)");
        await settled();
        change(panel, "steps-condition-step", stepIdOf("Cleanup"));
        change(panel, "steps-condition-conclusion", "success");
        change(panel, "steps-budget", "0", "value", "input");
        const previous = panel.requests.at(-1);
        const count = panel.requests.length;
        change(panel, "steps-workflow", "build.yml");
        panel.render();
        assert.equal(panel.requests.length, count);
        assert.ok(panel.control("steps-conditions-clear"));
        panel.load().listeners.click();
        await settled();
        assert.deepEqual(panel.requests.at(-1), {
            ...previous, workflow: "build.yml", runBudget: 0, reuseRows: false, stepConditions: [], failedStep: null,
        });
        assert.deepEqual(panel.state.steps.settings.stepConditions, []);
        assert.equal(panel.state.steps.settings.failedStep, null);
        assert.equal(panel.control("steps-conditions-clear"), undefined);
        assert.equal(panel.control("steps-condition-step").value, "");
        assert.equal(panel.control("steps-condition-conclusion").value, "failure");
        change(panel, "steps-workflow", "ci.yml");
        panel.load().listeners.click();
        await settled();
        assert.deepEqual(panel.requests.at(-1).stepConditions, []);
        assert.equal(panel.control("steps-condition-step").value, "");
        assert.equal(panel.control("steps-condition-conclusion").value, "failure");
    });
}

test("reloading the same workflow preserves conditions and composer choices", async t => {
    const panel = recoveryPanel(t, true);
    await settled();
    addStepCondition(panel, "Compile", "failure");
    await settled();
    addStepCondition(panel, "Cleanup", "success");
    await settled();
    const conditions = panel.state.steps.settings.stepConditions;
    change(panel, "steps-workflow", "ci.yml");
    change(panel, "steps-budget", "0", "value", "input");
    panel.load().listeners.click();
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions, conditions);
    assert.equal(panel.requests.at(-1).workflow, "ci.yml");
    assert.equal(panel.requests.at(-1).runBudget, 0);
    assert.equal(panel.control("steps-condition-step").value, stepIdOf("Cleanup"));
    assert.equal(panel.control("steps-condition-conclusion").value, "success");
});

test("legacy saved failures migrate into a condition chip and do not return after clearing", async t => {
    const panel = recoveryPanel(t);
    await settled();
    panel.state.steps.settings.failedStep = { name: "Compile", occurrence: 1 };
    panel.render();
    assert.ok(panel.node(node => node.attributes.title === "Remove condition: Compile · occurrence 1 = failure"));
    panel.control("steps-conditions-clear").listeners.click();
    await settled();
    pickRunner(panel, "names", "box-c");
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions, []);
    assert.equal(panel.requests.at(-1).failedStep, null);
    assert.equal(panel.node(node => node.attributes.title === "Remove condition: Compile · occurrence 1 = failure"), undefined);
});

test("removing an earlier chip preserves a condition added by a newer pending request", async t => {
    const panel = recoveryPanel(t, true);
    await settled();
    addStepCondition(panel, "Compile", "failure");
    await settled();
    const removeCompile = panel.node(node => node.attributes.title === "Remove condition: Compile · occurrence 1 = failure").listeners.click;
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    panel.respond = body => panel.requests.length === 2 ? pending : panel.reply(body);
    try {
        addStepCondition(panel, "Cleanup", "success");
        removeCompile();
        await settled();
        assert.deepEqual(panel.requests.at(-1).stepConditions, [{ name: "Cleanup", occurrence: 1, conclusion: "success" }]);
    } finally {
        finish(panel.reply(panel.requests[1]));
    }
    await settled();
    assert.deepEqual(panel.state.steps.settings.stepConditions, [{ name: "Cleanup", occurrence: 1, conclusion: "success" }]);
});

test("condition choices retain repeated occurrences and saved zero-match conditions", async t => {
    const panel = interactivePanel(t, {
        settings: { workflow: "ci.yml", stepConditions: [{ name: "Missing", occurrence: 2, conclusion: "success" }] },
        result: { available: true, stepStats: [], meta: { stepConditionsSupported: true }, stepConditionFacets: [
            { name: "Upload", occurrence: 1, count: 2, conclusions: [{ value: "failure", count: 1 }] },
            { name: "Upload", occurrence: 2, count: 1, conclusions: [{ value: "success", count: 1 }] },
            { name: "Upload #2", occurrence: 1, count: 1, conclusions: [{ value: "success", count: 1 }] },
        ] },
    });
    await settled();
    assert.ok(panel.node(node => node.textContent === "Missing · occurrence 2 = success ×"));
    assert.ok(panel.control("steps-condition-step").children.some(node => node.textContent === "Missing · occurrence 2 (0)"));
    addStepCondition(panel, "Upload", "success", 2);
    await settled();
    assert.deepEqual(panel.requests.at(-1).stepConditions.at(-1), { name: "Upload", occurrence: 2, conclusion: "success" });
    assert.equal(new Set(panel.control("steps-condition-step").children.map(node => node.value)).size, 5);
});

test("single-run Gantt applies every step condition to the same job and retains other steps", () => {
    const timeline = {
        Repo: "example/project", RunID: "1000", WorkflowPath: ".github/workflows/ci.yml",
        Jobs: [
            { Name: "match", Steps: [{ Name: "A", Conclusion: "failure" }, { Name: "B", Conclusion: "success" }, { Name: "Cleanup", Conclusion: "success" }] },
            { Name: "other", Steps: [{ Name: "A", Conclusion: "failure" }, { Name: "B", Conclusion: "failure" }] },
        ],
    };
    const state = { steps: { settings: { workflow: "ci.yml", stepConditions: [{ name: "A", conclusion: "failure" }, { name: "B", conclusion: "success" }] }, timeline } };
    const nodes = stepPanels({ stepStats: [] }, state).flatMap(descendants);
    assert.equal(nodes.filter(node => node.className === "gantt__row gantt__row--job").length, 1);
    assert.equal(nodes.filter(node => node.className === "gantt__row").length, 3);
    assert.ok(nodes.some(node => node.textContent.includes("A = failure AND B = success")));
    assert.equal(timeline.Jobs.length, 2);
});

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
    const panel = interactivePanel(t, { result: runnerResult() });
    await settled();
    change(panel, "steps-all-attempts", true, "checked");
    change(panel, "steps-workflow", "build.yml");
    change(panel, "steps-budget", "25", "value", "input");
    panel.render();
    assert.equal(panel.requests.length, 0);
    assert.equal(panel.control("steps-all-attempts").checked, true);
    assert.equal(panel.control("steps-workflow").value, "build.yml");
    assert.equal(panel.control("steps-budget").value, "25");

    for (const action of [
        () => change(panel, "steps-job", "build"),
        () => change(panel, "steps-job-status", "failure"),
        () => pickRunner(panel, "kinds", "self-hosted"),
    ]) {
        action();
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
    assert.deepEqual(panel.requests[2].runnerFilter.kinds, ["self-hosted"]);

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
