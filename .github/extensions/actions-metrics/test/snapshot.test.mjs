import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:buffer";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip, createGzip } from "node:zlib";
import { collectSharedSnapshot, SharedDataset } from "../lib/dataset.mjs";
import { collectRuns, prepareSnapshot } from "../lib/runnerkit.mjs";

async function fixture(t) {
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-snapshot-test-"));
    const previous = { PATH: process.env.PATH, SNAPSHOT_CALLS: process.env.SNAPSHOT_CALLS };
    process.env.PATH = `${directory}:${process.env.PATH}`;
    process.env.SNAPSHOT_CALLS = join(directory, "calls.jsonl");
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
        await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.SNAPSHOT_CALLS, JSON.stringify(args) + "\\n");
const input = args[args.indexOf("--input") + 1];
if (args.includes("--help")) {
    process.stdout.write("Available Commands:\\n  collect Collect\\n  report Report\\n  runs Runs\\n  snapshot Snapshot\\n\\n");
} else if (args.includes("--version")) {
    process.stdout.write("fixture\\n");
} else if (args[0] === "api") {
    process.stdout.write(JSON.stringify({resources:{core:{remaining:10000,reset:Math.floor(Date.now()/1000)+3600}}}));
} else if (args[2] === "collect") {
    fs.writeFileSync(args[args.indexOf("--output")+1], "invalid");
} else if (input === "arguments") {
    process.stdout.write(JSON.stringify({args}));
} else if (input === "wait") {
    setTimeout(() => process.stdout.write("{}"), 5000);
} else if (input === "large-runs") {
    const row = {Repository:"example/project",Workflow:"CI",Padding:"x".repeat(65536)};
    for (let i = 0; i < 1025; i++) {
        process.stdout.write(JSON.stringify({...row, RunID:String(9007199254740993n + BigInt(i))}) + "\\n");
    }
} else if (input === "invalid" || fs.readFileSync(input).equals(Buffer.from("invalid"))) {
    process.stderr.write("Error: synthetic corrupt snapshot\\n");
    process.exitCode = 1;
} else if (process.env.RUNNER_KIT_BINARY) {
    const result = require("node:child_process").spawnSync(process.env.RUNNER_KIT_BINARY, args.slice(1), {stdio:"inherit"});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
} else throw new Error("Unexpected snapshot fixture command");
`, { mode: 0o700 });
    return {
        directory,
        calls: async () => (await readFile(process.env.SNAPSHOT_CALLS, "utf8")).trim().split("\n").map(JSON.parse),
    };
}

test("snapshot bridge uses offline CLI arguments and propagates errors and cancellation", async t => {
    const { directory } = await fixture(t);
    const window = { Start: "2026-10-02T00:00:00.000Z", End: "2026-10-03T00:00:00.000Z" };
    const metadata = await prepareSnapshot({ input: "arguments", cwd: directory });
    assert.deepEqual(metadata.args, ["runner-kit", "metrics", "snapshot", "--input", "arguments"]);
    const filtered = await prepareSnapshot({ input: "arguments", output: "filtered.json.gz", window, cwd: directory });
    assert.deepEqual(filtered.args, ["runner-kit", "metrics", "snapshot", "--input", "arguments",
        "--output", "filtered.json.gz", "--since", window.Start, "--until", window.End]);
    await assert.rejects(prepareSnapshot({ input: "invalid", cwd: directory }), /synthetic corrupt snapshot/);
    const controller = new AbortController();
    const pending = prepareSnapshot({ input: "wait", cwd: directory, signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /superseded/);
});

test("run rows stream past the former 64 MiB stdout buffer without losing exact IDs", async t => {
    const { directory } = await fixture(t);
    const options = {
        target: { kind: "repo", owner: "example", nwo: "example/project" },
        filters: {}, limits: {}, cwd: directory, input: "large-runs",
    };
    const result = await collectRuns(options);
    assert.equal(result.available, true, result.reason);
    assert.equal(result.rows.length, 1025);
    assert.equal(result.rows[0].id, "9007199254740993");
    assert.equal(result.rows.at(-1).id, String(9007199254740993n + 1024n));
    const warnings = [];
    const failed = await collectRuns({ ...options, input: "invalid", warnings });
    assert.equal(failed.available, false);
    assert.equal(failed.rows.length, 0);
    assert.match(failed.reason, /synthetic corrupt snapshot/);
    assert.ok(warnings.some(message => message.includes("synthetic corrupt snapshot")));
});

test("failed metadata loading and period rewriting clean temporary files without retiring the base", async t => {
    const { directory, calls } = await fixture(t);
    const target = { kind: "repo", owner: "example", name: "project", nwo: "example/project", host: null };
    await assert.rejects(collectSharedSnapshot({
        target, filters: { days: 7 }, limits: { maxRuns: 0 }, cwd: directory,
    }), /synthetic corrupt snapshot/);
    const collect = (await calls()).find(args => args[2] === "collect" && !args.includes("--help"));
    const input = collect[collect.indexOf("--output") + 1];
    await assert.rejects(access(dirname(input)));
    const window = { Start: "2026-10-01T00:00:00Z", End: "2026-10-04T00:00:00Z" };
    const base = new SharedDataset("invalid", null, [], [], { id: "synthetic", window });
    base.source = { warnings: [] };
    t.after(() => base.retire());
    const filters = { filterFrom: "2026-10-02" };
    await assert.rejects(collectSharedSnapshot({ dataset: base, filters, cwd: directory }), /synthetic corrupt snapshot/);
    assert.equal(base.references, 1);
    assert.equal(base.retired, false);
    const view = (await calls()).find(args => args[2] === "snapshot" && args.includes("--output"));
    await assert.rejects(access(dirname(view[view.indexOf("--output") + 1])));
    await assert.rejects(collectSharedSnapshot({
        dataset: base, filters, cwd: directory, signal: AbortSignal.abort(),
    }), { name: "AbortError" });
    assert.equal(base.references, 1);
    assert.equal(base.retired, false);
});

test("snapshots exceeding Node's real string limit load and filter without giant strings", {
    skip: process.env.RUNNER_KIT_LARGE_SNAPSHOT_TEST !== "1",
    timeout: 240000,
}, async t => {
    assert.ok(process.env.RUNNER_KIT_BINARY, "Set RUNNER_KIT_BINARY to a current CLI build");
    const { directory } = await fixture(t);
    const input = join(directory, "large.json.gz");
    const output = join(directory, "filtered.json.gz");
    const step = JSON.stringify({ name: "x".repeat(1024 * 1024), number: 1, status: "completed", conclusion: "success" });
    const count = Math.ceil(constants.MAX_STRING_LENGTH / Buffer.byteLength(step)) + 1;
    const prefix = `{"Version":1,"CreatedAt":"2026-10-04T00:00:00Z",
        "Repo":{"Host":"github.com","Owner":"example","Name":"project"},
        "Contents":{"Jobs":true,"Usage":true,"Runners":true,"AllAttempts":true},
        "Data":{"Window":{"Start":"2026-10-01T00:00:00Z","End":"2026-10-04T00:00:00Z"},
        "Runs":[{"id":9007199254740993,"created_at":"2026-10-02T00:00:00Z","run_attempt":2},
                {"id":2,"created_at":"2026-10-03T00:00:00Z"}],
        "Attempts":[{"id":9007199254740993,"run_attempt":1}],
        "Jobs":[{"id":9007199254740995,"run_id":9007199254740993,"run_attempt":2,"name":"build","steps":[`;
    const suffix = `]},
        {"id":9007199254740997,"run_id":9007199254740993,"run_attempt":1,"started_at":"2026-10-01T01:00:00Z"},
        {"id":12,"run_id":2}],
        "LatestJobs":{"9007199254740995":true,"9007199254740997":false,"12":true},
        "RunRepositories":{"9007199254740993":"example/project","2":"example/project"},
        "Usage":{"9007199254740993":{"billable":{"UBUNTU":{"total_ms":9223372036854775807}}},"2":{}},
        "Runners":[],"HostedRunners":{},"RepositoryPublic":{"example/project":false},
        "Warnings":["synthetic partial history"],"Truncated":true}}`;
    await pipeline(Readable.from((async function* () {
        yield prefix;
        for (let i = 0; i < count; i++) {
            if (i) yield ",";
            yield step;
        }
        yield suffix;
    })()), createGzip(), createWriteStream(input));
    const exec = promisify(execFile);
    const legacy = await exec(process.execPath, ["-e", `
        const fs = require("node:fs"), zlib = require("node:zlib");
        try {
            zlib.gunzipSync(fs.readFileSync(process.argv[1])).toString("utf8");
            throw new Error("legacy path unexpectedly succeeded");
        } catch (error) {
            if (error.code !== "ERR_STRING_TOO_LONG") throw error;
            process.stdout.write(error.code);
        }
    `, input], { timeout: 60000, maxBuffer: 4096 });
    assert.equal(legacy.stdout, "ERR_STRING_TOO_LONG");
    const metadata = await prepareSnapshot({ input, cwd: directory });
    assert.equal(metadata.Data.Runs, 2);
    assert.equal(metadata.Data.Jobs, 3);
    assert.equal(metadata.Contents.AllAttempts, true);
    assert.equal(metadata.Data.LatestJobs["9007199254740995"], true);
    assert.deepEqual(metadata.Data.Warnings, ["synthetic partial history"]);
    const window = { Start: "2026-10-02T00:00:00Z", End: "2026-10-03T00:00:00Z" };
    const filtered = await prepareSnapshot({ input, output, window, cwd: directory });
    assert.equal(filtered.Data.Runs, 1);
    assert.equal(filtered.Data.Jobs, 2);
    assert.deepEqual(filtered.Data.Window, window);
    assert.deepEqual(filtered.Data.LatestJobs, { "9007199254740995": true, "9007199254740997": false });
    let bytes = 0, head = Buffer.alloc(0), tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(output).pipe(createGunzip())) {
        bytes += chunk.length;
        if (head.length < 8192) head = Buffer.concat([head, chunk]).subarray(0, 8192);
        tail = Buffer.concat([tail, chunk]).subarray(-8192);
    }
    assert.ok(bytes > constants.MAX_STRING_LENGTH, "the filtered snapshot must also exceed the real string limit");
    assert.match(head.toString(), /"id":9007199254740995/);
    assert.match(head.toString(), /"run_id":9007199254740993/);
    assert.match(tail.toString(), /"total_ms":9223372036854775807/);
});
