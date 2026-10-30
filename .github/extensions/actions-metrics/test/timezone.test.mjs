import test from "node:test";
import assert from "node:assert/strict";
import { localTimeZone, localDateKey, formatTime, formatTimestamp } from "../shared/timezone.mjs";
import { applyQueryPatch, collectionId, datasetQueryId, normalizeQuery, persistedFields, rowQueryId } from "../lib/query.mjs";
import { fieldByName } from "../shared/fields.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFleet } from "../lib/runnerkit.mjs";

test("the removed timezone setting cannot override local time through preferences or actions", () => {
    assert.equal(fieldByName("timeZone"), undefined);
    assert.equal(normalizeQuery({ timeZone: "UTC" }).timeZone, undefined);
    assert.equal(persistedFields(normalizeQuery({ timeZone: "UTC" })).timeZone, undefined);
});

test("a time zone change re-reads reports without invalidating the dataset, row cache or selected period", () => {
    const original = normalizeQuery({
        repo: "example/project", filterFrom: "2026-01-01T00:00:00Z", filterTo: "2026-01-02T00:00:00Z",
    });
    const zoned = applyQueryPatch(original, { timeZone: "Asia/Tokyo" });
    assert.equal(collectionId(zoned), collectionId(original));
    assert.equal(datasetQueryId(zoned), datasetQueryId(original));
    assert.equal(rowQueryId(zoned), rowQueryId(original));
    assert.equal(zoned.filterFrom, original.filterFrom);
    assert.equal(zoned.filterTo, original.filterTo);
    assert.equal(persistedFields(zoned).timeZone, undefined);
});

test("timestamps, chart labels and calendar dates follow the device local zone", () => {
    const previous = process.env.TZ;
    try {
        const instant = "2026-01-01T16:00:00Z";
        process.env.TZ = "Asia/Tokyo";
        assert.equal(localTimeZone(), "Asia/Tokyo");
        assert.equal(formatTime(instant, { hour: "2-digit", hourCycle: "h23" }), "01");
        assert.equal(formatTime(instant, { day: "numeric" }), "2");
        assert.match(formatTimestamp(instant), /GMT\+9/);
        assert.equal(localDateKey(instant), "2026-01-02");
        process.env.TZ = "UTC";
        assert.equal(formatTime(instant, { hour: "2-digit", hourCycle: "h23" }), "16");
        assert.equal(formatTime(instant, { day: "numeric" }), "1");
    } finally {
        if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
});

test("DST repeated hours have distinct offset-bearing timestamp labels", () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = "America/New_York";
        const first = formatTimestamp("2026-11-01T05:30:00Z");
        const second = formatTimestamp("2026-11-01T06:30:00Z");
        assert.notEqual(first, second);
        assert.match(first, /GMT-4/);
        assert.match(second, /GMT-5/);
    } finally {
        if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
    }
});

test("retained buckets from another zone are hidden while rebuilding and after a failed rebuild", async () => {
    const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
    const notices = source.slice(source.indexOf("function fleetNotice("), source.indexOf("function orgWideNotice("));
    const code = `let state;
const localTimeZone = () => "Asia/Tokyo";
const el = (tag, props) => props;
${notices}
export function notice(filters, fleet, status) { state = { filters, status }; return concurrencyNotice(fleet); }`;
    const { notice } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
    for (const status of ["loading", "error", "ready"]) {
        assert.match(notice({ timeZone: "Asia/Tokyo" }, { available: true, timeZone: "UTC" }, status).text,
            /Report buckets use UTC.*local Asia\/Tokyo/);
    }
    assert.equal(notice({ timeZone: "Asia/Tokyo" }, { available: true, timeZone: "Asia/Tokyo" }, "ready"), null);
    assert.match(notice({}, { available: true }, "ready").text, /Reload the Actions metrics extension/);
});

test("older CLIs explicitly disable unaligned concurrency without disabling unrelated reports", async t => {
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-legacy-timezone-"));
    const previousPath = process.env.PATH;
    process.env.PATH = `${directory}:${previousPath}`;
    t.after(async () => {
        process.env.PATH = previousPath;
        await rm(directory, { recursive: true, force: true });
    });
    const calls = join(directory, "calls.jsonl");
    await writeFile(join(directory, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
if (args.includes("--help")) {
    process.stdout.write("Available Commands:\\n  report Reports\\n\\nFlags:\\n  --bucket string\\n");
} else if (args.includes("--version")) {
    process.stdout.write("legacy-fixture\\n");
} else if (args[2] === "report") {
    process.stdout.write(JSON.stringify({summary: {}, concurrency: [{Start: "2026-01-01T04:30:00Z", End: "2026-01-02T04:30:00Z"}]}));
} else {
    throw new Error("Unexpected request: " + args.join(" "));
}
`, { mode: 0o700 });
    const warnings = [];
    const result = await collectFleet({
        cwd: directory, input: "fixture.json",
        target: { kind: "repo", owner: "example", name: "project", nwo: "example/project", host: null },
        filters: normalizeQuery({ timeZone: "Asia/Tokyo", bucket: "24h" }), warnings,
    });
    assert.equal(result.available, true);
    assert.ok(result.summary);
    assert.deepEqual(result.concurrency, []);
    assert.match(result.concurrencyReason, /update gh runner-kit and reload/);
    assert.ok(warnings.includes(result.concurrencyReason));
    const args = (await readFile(calls, "utf8")).trim().split("\n").map(JSON.parse)
        .find(args => args[2] === "report" && !args.includes("--help"));
    assert.ok(args.includes("--section"));
    assert.ok(!args.includes("concurrency"));
    assert.ok(!args.includes("--time-zone"));
});
