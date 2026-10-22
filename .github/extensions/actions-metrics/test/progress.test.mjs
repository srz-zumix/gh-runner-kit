import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginCollectionProgress, parseCollectionProgress, progressDescription } from "../shared/progress.mjs";
import { clearRateLimitCooldown, setRateLimitCooldown } from "../lib/gh.mjs";
import { DashboardStore } from "../lib/store.mjs";
import { runLines } from "../lib/jobs.mjs";
import { normalizeQuery } from "../lib/query.mjs";

const detail = {
    stage: "jobs", repository: "example/project", repositoryIndex: 1, repositoriesTotal: 2,
    unit: "runs", completed: 4, total: 10, cached: 2, fetched: 1, skipped: 1, runs: 10, jobs: 0,
};
const record = value => JSON.stringify({type: "runner-kit.metrics.progress", version: 1, ...value});
const discovery = {
    ...detail, stage: "runs", unit: "", completed: 0, total: 0, cached: 0, fetched: 0, skipped: 0,
    runSearch: {created: "2026-10-01T00:00:00Z..2026-10-01T23:59:59Z", searches: 3, discovered: 1200},
};

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

test("run discovery accepts optional unknown-total counters without treating searches as pages or final totals", () => {
    assert.deepEqual(parseCollectionProgress(record(discovery)), discovery);
    assert.match(progressDescription(discovery), /search 3.*1,200 unique runs found/);
    const {runSearch, ...legacy} = discovery;
    assert.deepEqual(parseCollectionProgress(record(legacy)), legacy);
    for (const invalid of [
        null, [], {}, {...runSearch, created: ""}, {...runSearch, searches: 0},
        {...runSearch, searches: 0.5}, {...runSearch, discovered: -1},
        {...runSearch, discovered: Number.MAX_SAFE_INTEGER + 1},
    ]) assert.throws(() => parseCollectionProgress(record({...discovery, runSearch: invalid})), /Invalid or unsupported/);
    assert.throws(() => parseCollectionProgress(record({...detail, runSearch})), /Invalid or unsupported/);
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

test("run discovery reports cached days separately, including a cache-only historical window", () => {
    for (const searches of [0, 2]) {
        const cached = {...discovery, runSearch: {...discovery.runSearch, searches, cachedWindows: 3}};
        assert.deepEqual(parseCollectionProgress(record(cached)), cached);
        assert.match(progressDescription(cached), /1,200 unique runs found.*3 cached days/);
    }
    for (const cachedWindows of [-1, 1.5, "3", null, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => parseCollectionProgress(record({
            ...discovery, runSearch: {...discovery.runSearch, cachedWindows},
        })), /Invalid or unsupported/);
    }
    const empty = {...discovery, runSearch: {...discovery.runSearch, cachedWindows: 0}};
    assert.deepEqual(parseCollectionProgress(record(empty)), empty);
    assert.throws(() => parseCollectionProgress(record({
        ...empty, runSearch: {...empty.runSearch, searches: 0},
    })), /Invalid or unsupported/);
});

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-progress-test-"));
    const previous = {PATH: process.env.PATH, COPILOT_HOME: process.env.COPILOT_HOME, PROGRESS_CALLS: process.env.PROGRESS_CALLS, PROGRESS_MODE: process.env.PROGRESS_MODE};
    process.env.PATH = `${directory}:${process.env.PATH}`;
    process.env.COPILOT_HOME = directory;
    process.env.PROGRESS_CALLS = join(directory, "calls.jsonl");
    process.env.PROGRESS_MODE = "rate-limit";
    await writeFile(process.env.PROGRESS_CALLS, "");
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
    process.stdout.write("Available Commands:\\n  collect Collect\\n  report Report\\n  runs Runs\\n  jobs Jobs\\n  snapshot Snapshot\\n\\nFlags:\\n  --progress\\n  --until string\\n");
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
    } else if (process.env.PROGRESS_MODE === "failure") {
        process.stderr.write("Error: fixture collection failure\\n");
        process.exitCode = 1;
    } else {
    const record = ${JSON.stringify(record(detail))};
    process.stderr.write("WARN fixture diagnostic\\n" + ${JSON.stringify(record(discovery))} + "\\n" + record.slice(0, 41));
    setTimeout(() => {
        process.stderr.write(record.slice(41) + "\\nError: API rate limit exceeded [rate reset in 30s]\\n");
        process.exitCode = 1;
    }, 10);
    }
} else if (args[2] === "snapshot") {
    process.stdout.write(zlib.gunzipSync(fs.readFileSync(args[args.indexOf("--input")+1])));
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
        calls: async () => (await readFile(process.env.PROGRESS_CALLS, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse),
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
    assert.ok(notices.some(value => value?.detail?.runSearch?.discovered === 1200));
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

test("automatic retries reuse caches and one fixed period across cooldowns; manual Refresh starts a new period", async t => {
    const {directory, calls} = await fixture(t);
    t.mock.timers.enable({apis: ["Date", "setTimeout"], now: Date.parse("2026-10-01T00:00:00Z")});
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    store.subscribe(entry.key, () => {});
    const first = await store.refresh(query, {force: true, bypassCache: true});
    const collected = async () => (await calls()).filter(args => args[2] === "collect" && !args.includes("--help"));
    assert.equal(first.collectionProgress.status, "paused", first.error);
    assert.equal(Date.parse(first.autoRetryAt) - Date.now(), 61000);
    assert.equal(first.query.until, "");
    t.mock.timers.tick(60000);
    assert.equal((await collected()).length, 1, "cooldown must not send collection requests");
    t.mock.timers.tick(1000);
    assert.ok(entry.inflight);
    await entry.inflight;
    assert.equal(entry.collectionProgress.attempt, 2);
    assert.equal(entry.collectionProgress.status, "paused");
    assert.equal(Date.parse(entry.autoRetryAt) - Date.now(), 61000);
    process.env.PROGRESS_MODE = "success";
    t.mock.timers.tick(61000);
    await entry.inflight;
    assert.equal(entry.status, "ready", entry.error);
    assert.equal(entry.collectionProgress.attempt, 3);
    assert.equal(entry.autoRetryAt, null);
    const automatic = await collected();
    assert.equal(automatic.length, 3);
    const until = args => args[args.indexOf("--until") + 1];
    assert.ok(automatic.every(args => args.includes("--all-attempts")));
    assert.ok(automatic.every(args => until(args) === "2026-10-01T00:00:00.000Z"));
    assert.equal(automatic[0].includes("--refresh"), true);
    assert.ok(automatic.slice(1).every(args => !args.includes("--refresh")));
    t.mock.timers.tick(5000);
    await store.refresh(query, {force: true});
    assert.notEqual(until((await collected()).at(-1)), until(automatic[0]));
    assert.equal(entry.query.until, "", "effective bounds must not overwrite the user's query");
    setRateLimitCooldown(null, Date.now() + 30000);
    const primary = await store.refresh(query, {force: true});
    assert.equal(Date.parse(primary.autoRetryAt) - Date.now(), 31000);
    t.mock.timers.tick(31000);
    await entry.inflight;
    assert.equal(entry.status, "ready", entry.error);
});

for (const operation of ["manual refresh", "query change", "credentials", "unsubscribe", "dispose"]) {
    test(`${operation} cancels stale automatic retries`, async t => {
        const {directory, calls} = await fixture(t);
        t.mock.timers.enable({apis: ["Date", "setTimeout"], now: Date.parse("2026-10-01T00:00:00Z")});
        const store = new DashboardStore({cwd: directory});
        t.after(() => store.dispose());
        const query = normalizeQuery({repo: "example/project"});
        const entry = store.entry(query);
        const unsubscribe = store.subscribe(entry.key, () => {});
        await store.refresh(query);
        assert.ok(entry.autoRetryAt);
        const oldRetry = Date.parse(entry.autoRetryAt);
        t.mock.timers.tick(1000);
        if (operation === "manual refresh" || operation === "query change") {
            clearRateLimitCooldown(null);
            await store.refresh(operation === "query change" ? {...query, days: 7} : query, {force: true});
            assert.ok(Date.parse(entry.autoRetryAt) > oldRetry);
        } else if (operation === "credentials") {
            store.invalidateAuthCaches();
            assert.equal(entry.collectionUntil, null);
        } else if (operation === "unsubscribe") {
            unsubscribe();
        } else {
            await store.dispose();
        }
        const count = (await calls()).length;
        t.mock.timers.tick(oldRetry - Date.now());
        assert.equal(entry.inflight, null);
        assert.equal((await calls()).length, count);
        if (operation !== "manual refresh" && operation !== "query change") assert.equal(entry.autoRetryAt, null);
    });
}

test("only the last subscriber cancels a retry and a reopened target schedules one retry", async t => {
    const {directory} = await fixture(t);
    t.mock.timers.enable({apis: ["Date", "setTimeout"], now: Date.parse("2026-10-01T00:00:00Z")});
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    const first = store.subscribe(entry.key, () => {});
    const second = store.subscribe(entry.key, () => {});
    await store.refresh(query);
    const when = entry.autoRetryAt;
    first();
    assert.equal(entry.autoRetryAt, when);
    second();
    assert.equal(entry.autoRetryAt, null);
    t.mock.timers.tick(70000);
    process.env.PROGRESS_MODE = "success";
    store.subscribe(entry.key, () => {});
    assert.equal(Date.parse(entry.autoRetryAt), Date.now() + 1000);
    t.mock.timers.tick(1000);
    await entry.inflight;
    assert.equal(entry.status, "ready", entry.error);
    assert.equal(entry.collectionProgress.attempt, 2);
});

test("non-rate-limit failures do not schedule automatic retries", async t => {
    const {directory} = await fixture(t);
    process.env.PROGRESS_MODE = "failure";
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    store.subscribe(entry.key, () => {});
    const state = await store.refresh(query);
    assert.equal(state.status, "error");
    assert.match(state.error, /fixture collection failure/);
    assert.equal(state.errorCode, null);
    assert.equal(state.autoRetryAt, null);
    assert.equal(entry.retryTimer, null);
});

test("disposal during a rate-limited collection cannot re-arm its retry", async t => {
    const {directory} = await fixture(t);
    t.mock.timers.enable({apis: ["Date", "setTimeout"], now: Date.parse("2026-10-01T00:00:00Z")});
    const store = new DashboardStore({cwd: directory});
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    store.subscribe(entry.key, () => {});
    setRateLimitCooldown(null, Date.now() + 30000);
    const pending = store.refresh(query);
    await store.dispose();
    await pending;
    assert.equal(entry.autoRetryAt, null);
    assert.equal(entry.retryTimer, null);
    t.mock.timers.tick(60000);
    assert.equal(entry.inflight, null);
    await assert.rejects(store.refresh(query), /disposed/);
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
    assert.match(content(), /both completed metadata and job lists are reused/);
    renderCollectionProgress(container, {...state, autoRetryAt: new Date(now + 191000).toISOString()}, now);
    assert.match(content(), /will resume automatically/);
    assert.match(content(), /3m 11s remaining/);
    assert.match(content(), /collection period stays fixed/);
    assert.doesNotMatch(content(), /Press Refresh/);
    renderCollectionProgress(container, {...state, autoRetryAt: new Date(now + 191000).toISOString()}, now + 200000);
    assert.match(content(), /Waiting to resume automatically/);
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

test("discovery renderer updates elapsed and last-update times even while the collector is silent", t => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "document");
    t.after(() => {
        if (original) Object.defineProperty(globalThis, "document", original); else delete globalThis.document;
    });
    class Node {
        constructor(tag) { this.tag = tag; this.textContent = ""; }
        replaceChildren(...children) { this.children = children; }
    }
    globalThis.document = {createElement: tag => new Node(tag)};
    const container = new Node("section");
    const now = Date.parse("2026-10-01T00:00:00Z");
    const progress = {
        ...beginCollectionProgress(null, {now}),
        supported: true, detail: discovery, updatedAt: new Date(now + 5000).toISOString(),
    };
    const content = () => container.children.map(node => node.textContent).join("\n");
    renderCollectionProgress(container, {collectionProgress: progress}, now + 65000);
    assert.match(content(), /Elapsed: 1m 5s.*Last collector update 1m 0s ago/);
    assert.match(content(), /search 3.*1,200 unique runs found/);
    assert.match(content(), /Current search period \(UTC\): 2026-10-01/);
    assert.match(content(), /before cached job lists are read/);
    assert.match(content(), /between searches, not on every page/);
    renderCollectionProgress(container, {collectionProgress: {
        ...progress, detail: {...discovery, runSearch: {...discovery.runSearch, cachedWindows: 27}},
    }}, now + 65000);
    assert.match(content(), /27 cached days/);
    assert.match(content(), /older than 24 hours.*one-hour listing cache/);
    assert.match(content(), /Older reruns and deletions can take up to one hour/);
    assert.match(content(), /Shift\+click Refresh bypasses caches/);
    assert.equal(container.children.some(node => node.tag === "progress"), false);
    assert.doesNotMatch(content(), /%|ETA.*\d/);
    renderCollectionProgress(container, {collectionProgress: progress}, now + 125000);
    assert.match(content(), /Elapsed: 2m 5s.*Last collector update 2m 0s ago/);
    assert.equal(progress.detail.runSearch.discovered, 1200, "a timer tick must not invent collector progress");
    const {runSearch, ...legacy} = discovery;
    renderCollectionProgress(container, {collectionProgress: {...progress, detail: legacy}}, now + 125000);
    assert.match(content(), /does not report run-search counters/);
    renderCollectionProgress(container, {collectionProgress: beginCollectionProgress(null, {now})}, now + 15000);
    assert.match(content(), /Elapsed: 0m 15s.*Waiting for the first collector update/);
    renderCollectionProgress(container, {collectionProgress: {...progress, status: "failed"}}, now + 125000);
    assert.doesNotMatch(content(), /Elapsed:/);
    assert.match(content(), /search 3.*1,200 unique runs found/);
    renderCollectionProgress(container, {collectionProgress: beginCollectionProgress({...progress, status: "paused"}, {resume: true, now})}, now + 125000);
    assert.match(content(), /Last interrupted attempt:.*search 3.*1,200 unique runs found/);
    assert.doesNotMatch(content(), /From cache:/, "discovery has not checked the job cache yet");
});

test("reading a retained dataset during a cooldown keeps the interrupted collection's retry", async t => {
    const {directory, calls} = await fixture(t);
    t.mock.timers.enable({apis: ["Date", "setTimeout"], now: Date.parse("2026-10-01T00:00:00Z")});
    const store = new DashboardStore({cwd: directory});
    t.after(() => store.dispose());
    const query = normalizeQuery({repo: "example/project"});
    const entry = store.entry(query);
    store.subscribe(entry.key, () => {});
    process.env.PROGRESS_MODE = "success";
    await store.refresh(query, {force: true, bypassCache: true});
    assert.equal(entry.status, "ready", entry.error);
    process.env.PROGRESS_MODE = "rate-limit";
    await store.refresh(query, {force: true});
    assert.equal(entry.errorCode, "rate_limited");
    const until = entry.collectionUntil;
    const collected = async () => (await calls()).filter(args => args[2] === "collect" && !args.includes("--help")).length;
    const before = await collected();
    assert.equal(await store.withDataset(query, () => "read"), "read");
    assert.equal(await collected(), before, "a retained read must not collect");
    assert.equal(entry.status, "error");
    assert.equal(entry.errorCode, "rate_limited");
    assert.equal(entry.collectionProgress.status, "paused");
    assert.equal(entry.collectionUntil, until);
    assert.ok(entry.autoRetryAt);
    process.env.PROGRESS_MODE = "success";
    t.mock.timers.tick(Date.parse(entry.autoRetryAt) - Date.now());
    assert.ok(entry.inflight, "the automatic resume must still fire");
    await entry.inflight;
    assert.equal(entry.status, "ready", entry.error);
    assert.equal(await collected(), before + 1);
});
