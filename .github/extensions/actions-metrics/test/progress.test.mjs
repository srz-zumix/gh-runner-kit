import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginCollectionProgress, parseCollectionProgress, progressDescription } from "../shared/progress.mjs";
import { clearRateLimitCooldown } from "../lib/gh.mjs";
import { DashboardStore } from "../lib/store.mjs";
import { runLines } from "../lib/jobs.mjs";
import { normalizeQuery } from "../lib/query.mjs";

const detail = {
    stage: "jobs", repository: "example/project", repositoryIndex: 1, repositoriesTotal: 2,
    unit: "runs", completed: 4, total: 10, cached: 2, fetched: 1, skipped: 1, runs: 10, jobs: 0,
};
const record = value => JSON.stringify({type: "runner-kit.metrics.progress", version: 1, ...value});

test("progress schema validates real stage counts and ignores ordinary diagnostics", () => {
    assert.deepEqual(parseCollectionProgress(record(detail)), detail);
    assert.match(progressDescription(detail), /4\/10 runs/);
    for (const line of ["WARN inventory unavailable", '{"type":"other","completed":8}', "not JSON"]) {
        assert.equal(parseCollectionProgress(line), null);
    }
    for (const invalid of [
        {version: 2}, {completed: -1}, {total: 3}, {cached: 5}, {unit: "jobs"}, {stage: "unknown"},
        {stage: "toString"}, {fetched: 0.5}, {repositoriesTotal: 0}, {jobs: Number.MAX_SAFE_INTEGER + 1},
    ]) assert.throws(() => parseCollectionProgress(record({...detail, ...invalid})), /Invalid or unsupported/);
    assert.throws(() => parseCollectionProgress('{"type":"runner-kit.metrics.progress",'), /Invalid collection progress JSON/);
    assert.equal(parseCollectionProgress(record({...detail, stage: "runs", unit: "", completed: 0, total: 0, cached: 0, fetched: 0, skipped: 0})).unit, "");
    assert.equal(Object.hasOwn(parseCollectionProgress(record({...detail, extra: "example-extra"})), "extra"), false);
});

test("ordinary retries retain one interrupted stage without summing counts or growing history", () => {
    let previous = {
        ...beginCollectionProgress(null), status: "paused", supported: true,
        detail, updatedAt: "2026-10-01T00:00:00Z",
    };
    for (let attempt = 2; attempt <= 200; attempt++) {
        previous = {...beginCollectionProgress(previous, {resume: true}), status: "paused"};
        assert.equal(previous.attempt, attempt);
        assert.deepEqual(previous.interrupted, {detail, updatedAt: "2026-10-01T00:00:00Z"});
        assert.equal(previous.detail, null);
        assert.ok(JSON.stringify(previous).length < 1000);
    }
    const hard = beginCollectionProgress(previous, {resume: false});
    assert.equal(hard.attempt, 1);
    assert.equal(hard.interrupted, null);
    assert.equal(beginCollectionProgress({...previous, status: "complete"}, {resume: true}).interrupted, null);
});

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-progress-test-"));
    const previous = {PATH: process.env.PATH, COPILOT_HOME: process.env.COPILOT_HOME, PROGRESS_CALLS: process.env.PROGRESS_CALLS, PROGRESS_MODE: process.env.PROGRESS_MODE};
    process.env.PATH = `${directory}:${process.env.PATH}`;
    process.env.COPILOT_HOME = directory;
    process.env.PROGRESS_CALLS = join(directory, "calls.jsonl");
    process.env.PROGRESS_MODE = "rate-limit";
    clearRateLimitCooldown(null);
    t.after(async () => {
        clearRateLimitCooldown(null);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await rm(directory, {recursive: true, force: true});
    });
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const zlib = require("node:zlib");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PROGRESS_CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
    process.stdout.write(JSON.stringify({resources:{core:{remaining:10000, reset:Math.floor(Date.now()/1000)+3600}}}) + "\\n");
} else if (args.includes("--help")) {
    process.stdout.write("Available Commands:\\n  collect Collect\\n  report Report\\n  runs Runs\\n  jobs Jobs\\n\\nFlags:\\n  --progress\\n  --until string\\n");
} else if (args.includes("--version")) {
    process.stdout.write("fixture\\n");
} else if (args[0] === "invalid-progress") {
    process.stderr.write('{"type":"runner-kit.metrics.progress",');
    setTimeout(() => process.stderr.write("\\n"), 10);
    setTimeout(() => process.stdout.write("must not succeed\\n"), 1000);
} else if (args[0] === "invalid-row") {
    process.stdout.write("invalid row\\n");
    setTimeout(() => process.stdout.write("must not succeed\\n"), 1000);
} else if (args[2] === "collect") {
    if (!args.includes("--progress")) throw new Error("progress was not requested");
    if (process.env.PROGRESS_MODE === "success") {
        const window = {Start:"2026-10-01T00:00:00Z",End:"2026-10-02T00:00:00Z"};
        fs.writeFileSync(args[args.indexOf("--output")+1], zlib.gzipSync(JSON.stringify({
            Version:1, CreatedAt:window.End, Contents:{AllAttempts:true},
            Data:{Window:window, LatestJobs:{}, Runners:[], Runs:[], Jobs:[], Warnings:[]},
        })));
        const progress = {...${JSON.stringify(detail)}, repositoriesTotal:1, completed:0,total:0,cached:0,fetched:0,skipped:0,runs:0};
        for (const value of [progress, {...progress, stage:"complete", unit:""}]) {
            process.stderr.write(JSON.stringify({type:"runner-kit.metrics.progress",version:1,...value})+"\\n");
        }
    } else {
    const record = ${JSON.stringify(record(detail))};
    process.stderr.write("WARN fixture diagnostic\\n" + record.slice(0, 41));
    setTimeout(() => {
        process.stderr.write(record.slice(41) + "\\nError: API rate limit exceeded [rate reset in 30s]\\n");
        process.exitCode = 1;
    }, 10);
    }
} else if (args.includes("--input") && ["runs","jobs","report"].includes(args[2])) {
    if (args[2] === "report") process.stdout.write(JSON.stringify({
        summary:{Window:{Start:"2026-10-01T00:00:00Z",End:"2026-10-02T00:00:00Z"}, Runs:0}, concurrency:[],
    })+"\\n");
} else if (args[0] === "trailing-progress") {
    process.stderr.write(${JSON.stringify(record(detail))});
} else throw new Error("Unexpected fixture command: " + args.join(" "));
`, {mode: 0o700});
    return {
        directory,
        calls: async () => (await readFile(process.env.PROGRESS_CALLS, "utf8")).trim().split("\n").map(JSON.parse),
    };
}

test("streamed counters survive rate limits and repeated cooldown Refresh, but hard refresh/auth changes clear them", async t => {
    const {directory, calls} = await fixture(t);
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    entry.status = "ready";
    entry.metrics = {previous: true};
    const notices = [];
    store.subscribe(entry.key, value => notices.push(value.collectionProgress));
    const first = await store.refresh(query, {force: true});
    assert.equal(first.status, "error");
    assert.equal(first.errorCode, "rate_limited", first.error);
    assert.equal(first.collectionProgress.status, "paused");
    assert.equal(first.collectionProgress.supported, true);
    assert.deepEqual(first.collectionProgress.detail, detail);
    assert.ok(notices.some(value => value?.status === "collecting" && value?.detail?.completed === 4));
    assert.deepEqual(first.metrics, {previous: true});
    const count = (await calls()).filter(args => args[2] === "collect" && !args.includes("--help")).length;
    assert.equal(count, 1);
    for (let attempt = 2; attempt <= 4; attempt++) {
        const paused = await store.refresh(query, {force: true});
        assert.equal(paused.collectionProgress.attempt, attempt);
        assert.equal(paused.collectionProgress.detail, null);
        assert.deepEqual(paused.collectionProgress.interrupted.detail, detail);
        assert.equal(paused.collectionProgress.status, "paused");
        assert.ok(paused.retryAt);
        assert.equal((await calls()).filter(args => args[2] === "collect" && !args.includes("--help")).length, count);
    }
    clearRateLimitCooldown(null);
    const resumed = await store.refresh(query, {force: true});
    assert.equal(resumed.collectionProgress.attempt, 5);
    assert.deepEqual(resumed.collectionProgress.detail, detail);
    assert.deepEqual(resumed.collectionProgress.interrupted.detail, detail);
    assert.equal((await calls()).filter(args => args[2] === "collect" && !args.includes("--help")).length, 2);
    await store.refresh(query, {force: true, bypassCache: true});
    assert.equal(entry.collectionProgress.interrupted, null);
    assert.equal(entry.collectionProgress.detail, null);
    entry.collectionProgress = first.collectionProgress;
    const changed = await store.refresh({...query, days: 7}, {force: true});
    assert.equal(changed.collectionProgress.attempt, 1);
    assert.equal(changed.collectionProgress.detail, null);
    assert.equal(changed.collectionProgress.interrupted, null);
    store.invalidateAuthCaches();
    assert.equal(entry.collectionProgress, null);
});

test("successful telemetry commits with the dataset and survives report-only changes without collecting again", async t => {
    const {directory, calls} = await fixture(t);
    process.env.PROGRESS_MODE = "success";
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const first = await store.refresh(query);
    assert.equal(first.status, "ready", first.error);
    assert.equal(first.collectionProgress.status, "complete");
    assert.equal(first.collectionProgress.supported, true);
    assert.equal(first.collectionProgress.detail.stage, "complete");
    const changed = await store.refresh({...query, targetUtilization: 0.8});
    assert.equal(changed.status, "ready", changed.error);
    assert.deepEqual(changed.collectionProgress, first.collectionProgress);
    const invoked = await calls();
    assert.equal(invoked.filter(args => args[2] === "collect" && !args.includes("--help")).length, 1);
    assert.ok(invoked.filter(args => args[2] === "report" && !args.includes("--help")).every(args => args.includes("--input")));
});

test("stderr chunks and trailing records are parsed, and callback errors abort streams instead of succeeding", async t => {
    const {directory} = await fixture(t);
    const seen = [];
    await runLines(["trailing-progress"], {}, directory, () => true, null, {
        onStderrLine: line => seen.push(parseCollectionProgress(line)),
    });
    assert.deepEqual(seen, [detail]);
    await assert.rejects(runLines(["invalid-progress"], {}, directory, () => true, null, {
        onStderrLine: parseCollectionProgress,
    }), /Invalid collection progress JSON/);
    await assert.rejects(runLines(["invalid-row"], {}, directory, () => { throw new Error("Example row error"); }), /Example row error/);
    await assert.rejects(runLines(["invalid-row"], {}, directory, () => { throw undefined; }), /undefined/);
});

const source = (await readFile(new URL("../public/progress.js", import.meta.url), "utf8"))
    .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
const {renderCollectionProgress} = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);

test("renderer shows stage-only percentages, retained stopped counts and retry countdown without claiming whole-collection completion", t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => {
        if (original) Object.defineProperty(globalThis, "document", original); else delete globalThis.document;
    });
    class Node {
        constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.textContent = ""; }
        setAttribute(key, value) { this.attributes[key] = value; }
        replaceChildren(...children) { this.children = children; }
    }
    globalThis.document = {createElement: tag => new Node(tag)};
    const container = new Node("section");
    const now = Date.parse("2026-10-01T00:00:00Z");
    const progress = {...beginCollectionProgress(null, {now}), status: "paused", detail, supported: true, updatedAt: new Date(now).toISOString()};
    const state = {collectionProgress: progress, retryAt: new Date(now + 190000).toISOString()};
    const content = () => container.children.map(node => node.textContent).join("\n");
    renderCollectionProgress(container, state, now);
    assert.equal(container.hidden, false);
    assert.match(content(), /Collection paused by rate limit/);
    assert.match(content(), /4\/10 runs/);
    assert.match(content(), /40.0% of this stage only/);
    assert.match(content(), /From cache: 2.*Read afresh: 1.*Skipped: 1/);
    assert.match(content(), /3m 10s remaining/);
    const bar = container.children.find(node => node.tag === "progress");
    assert.equal(bar.value, 4);
    assert.equal(bar.max, 10);
    renderCollectionProgress(container, state, now + 200000);
    assert.match(content(), /retry time has passed/);
    renderCollectionProgress(container, {collectionProgress: beginCollectionProgress(progress, {resume: true, now})}, now);
    assert.match(content(), /No numeric progress/);
    assert.match(content(), /Last interrupted attempt:.*4\/10 runs/);
    assert.equal(container.children.some(node => node.tag === "progress"), false);
    renderCollectionProgress(container, {collectionProgress: {...progress, detail: {...detail, stage: "attempts", unit: "attempts"}}}, now);
    assert.match(content(), /still require attempt-metadata requests/);
    renderCollectionProgress(container, {collectionProgress: {...progress, supported: false, reason: "Update gh runner-kit", detail: null}}, now);
    assert.match(content(), /Update gh runner-kit/);
    const complete = {...detail, stage: "complete", unit: "", completed: 0, total: 0, cached: 0, fetched: 0, skipped: 0};
    renderCollectionProgress(container, {collectionProgress: {...progress, status: "failed", detail: complete}}, now);
    assert.match(content(), /snapshot\/report processing is not yet complete/);
    assert.doesNotMatch(content(), /in the source dataset/);
    renderCollectionProgress(container, {collectionProgress: {...progress, status: "complete", detail: complete}}, now);
    assert.match(content(), /in the source dataset/);
    assert.doesNotMatch(content(), /not yet complete/);
    renderCollectionProgress(container, {});
    assert.equal(container.hidden, true);
});
