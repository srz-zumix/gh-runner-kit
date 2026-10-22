import test from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { readFile } from "node:fs/promises";
import { rowPayloadChunks, decodeRowPayload } from "../shared/rowpayload.mjs";

function encode(payload) {
    return Buffer.concat(Array.from(rowPayloadChunks(payload), chunk => Buffer.from(chunk, "utf8")));
}

test("batched row payloads remain JSON and preserve metadata, row boundaries and Unicode", () => {
    for (const count of [0, 1, 1000, 1001, 2001]) {
        const payload = {
            id: "synthetic-rows", revision: 3, budget: 1000000, truncated: false,
            datasetId: "synthetic-dataset", scope: { target: "example/project" },
            window: { Start: "2026-01-01T00:00:00Z", End: "2026-01-02T00:00:00Z" },
            rows: Array.from({ length: count }, (_, index) => ({
                JobID: String(9007199254740993n + BigInt(index)),
                JobName: 'Compile \u{1f680}\n"quoted",\\path', Labels: ["self-hosted"],
                Values: [null, undefined, NaN, Infinity, -0],
            })),
        };
        const bytes = encode(payload);
        const expected = JSON.parse(JSON.stringify(payload));
        assert.deepEqual(JSON.parse(bytes.toString("utf8")), expected);
        assert.deepEqual(decodeRowPayload(bytes), expected);
        assert.deepEqual(decodeRowPayload(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)), expected);
    }
    assert.deepEqual(decodeRowPayload(encode({ rows: [] })), { rows: [] });
});

test("worker decoding accepts compact payloads retained by an already-open provider", () => {
    const payload = { id: "legacy-rows", revision: 1, rows: [{ JobID: "2000001" }] };
    assert.deepEqual(decodeRowPayload(Buffer.from(JSON.stringify(payload))), payload);
});

test("worker decoding rejects incomplete or malformed batched payloads", () => {
    for (const [text, error] of [
        ['{"wrong":[]}\n', /invalid header/],
        ['{"rows":[\n', /incomplete/],
        ['{"rows":[\n{"JobID":"1"}\n{"JobID":"2"}\n]}\n', /batch separator/],
        ['{"rows":[\n{"JobID":"1"}\n,\n]}\n', /empty batch/],
        ['{"rows":[\n]}\n{"JobID":"1"}\n', /content after/],
        ['{"rows":[\n{"JobID":\n]}\n', SyntaxError],
    ]) assert.throws(() => decodeRowPayload(Buffer.from(text)), error);
});

test("the explorer worker loads every batched row and retains its snapshot metadata", async t => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "self");
    t.after(() => {
        if (previous) Object.defineProperty(globalThis, "self", previous);
        else delete globalThis.self;
    });
    const messages = [];
    globalThis.self = { postMessage: message => messages.push(message) };
    const source = (await readFile(new URL("../public/worker.js", import.meta.url), "utf8"))
        .replaceAll('"/shared/', `"${new URL("../shared/", import.meta.url).href}`);
    await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
    const count = 2001;
    const bytes = encode({
        id: "worker-rows", revision: 2, budget: 1000000, datasetId: "synthetic-dataset",
        collectedAt: Date.parse("2026-01-01T00:02:00Z"),
        rows: Array.from({ length: count }, (_, index) => ({
            JobID: String(2000000 + index), Repo: "example/project",
            Kind: "self-hosted", RunnerName: "test-runner",
            QueuedAt: "2026-01-01T00:00:00Z", StartedAt: "2026-01-01T00:00:01Z",
            CompletedAt: "2026-01-01T00:01:01Z",
        })),
    });
    self.onmessage({
        data: { id: 1, type: "load", payload: { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } },
    });
    assert.equal(messages.length, 1);
    const loaded = messages[0];
    assert.equal(loaded.type, "loaded", loaded.error);
    assert.equal(loaded.payload.rowCount, count);
    assert.equal(loaded.payload.snapshot.raw, count);
    assert.equal(loaded.payload.snapshot.budget, 1000000);
    assert.equal(loaded.payload.snapshot.datasetId, "synthetic-dataset");
    assert.equal(loaded.payload.facets.runner[0].count, count);
});

test("a million realistic rows exceed the V8 string limit and still encode and decode completely", {
    skip: process.env.RUNNER_KIT_LARGE_ROW_TEST !== "1",
}, () => {
    const row = {
        Repo: "example/project", RunID: "1000001", RunAttempt: 1, JobID: "2000001",
        Workflow: "Continuous integration", WorkflowPath: ".github/workflows/ci.yml",
        JobName: "build", Event: "push", Branch: "main", Labels: ["self-hosted", "linux", "x64"],
        Kind: "self-hosted", RunnerID: "3000001", RunnerName: "test-runner", RunnerGroup: "Default",
        Status: "completed", Conclusion: "success", ExecutionStarted: true,
        QueuedAt: "2026-01-01T00:00:00Z", StartedAt: "2026-01-01T00:00:01Z",
        CompletedAt: "2026-01-01T00:01:01Z", Wait: 1000000000, Duration: 60000000000,
    };
    const bytes = encode({ id: "large-rows", budget: 1000000, rows: Array(1000000).fill(row) });
    assert.ok(bytes.length > constants.MAX_STRING_LENGTH);
    assert.throws(() => bytes.toString("utf8"), { code: "ERR_STRING_TOO_LONG" });
    const decoded = decodeRowPayload(bytes);
    assert.equal(decoded.id, "large-rows");
    assert.equal(decoded.budget, 1000000);
    assert.equal(decoded.rows.length, 1000000);
    assert.deepEqual(decoded.rows[0], row);
    assert.deepEqual(decoded.rows.at(-1), row);
});
