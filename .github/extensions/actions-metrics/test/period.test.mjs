import test from "node:test";
import assert from "node:assert/strict";
import { filteredWindow, localPeriodValue, normalizePeriodTime, periodNanoseconds, periodTime, periodPreset, PERIOD_PRESETS } from "../shared/period.mjs";
import { applyQueryPatch, collectionId, datasetQueryId, normalizeQuery, persistedFields, rowQueryId, validateQuery, windowFor } from "../lib/query.mjs";
import { DATASET_FIELDS, FIELDS, TARGET_FIELDS } from "../lib/query.mjs";
import { fieldByName, fieldsOfEditor, queryFieldNames, readFieldValue, writeFieldValue } from "../shared/fields.mjs";
import { snapshotCommand } from "../lib/runnerkit.mjs";

test("date boundaries validate calendars, offsets, one-sided filters and exclusive ends", () => {
    assert.equal(normalizePeriodTime("2026-10-01"), "2026-10-01T00:00:00.000Z");
    assert.equal(normalizePeriodTime("2026-10-01T09:00:00+09:00"), "2026-10-01T00:00:00.000Z");
    for (const invalid of ["2026-02-30", "2026-13-01", "tomorrow", "2026-10-01T12:00:00", "2026-10-01T24:00:00Z"]) {
        assert.ok(Number.isNaN(periodTime(invalid)), invalid);
        assert.equal(validateQuery(normalizeQuery({repo: "owner/repo", since: invalid})).code, "period_invalid");
    }
    const window = {Start: "2026-10-01T00:00:00Z", End: "2026-10-03T00:00:00Z"};
    assert.equal(filteredWindow(window, {filterFrom: "2026-10-02"}).End, "2026-10-03T00:00:00.000Z");
    assert.equal(filteredWindow(window, {filterTo: "2026-10-02"}).Start, "2026-10-01T00:00:00.000Z");
    for (const filter of [
        {filterFrom: "2026-09-30"}, {filterTo: "2026-10-04"},
        {filterFrom: "2026-10-02", filterTo: "2026-10-02"},
        {filterFrom: "invalid"},
    ]) assert.throws(() => filteredWindow(window, filter), {code: "period_invalid"});
    assert.equal(validateQuery(normalizeQuery({repo: "owner/repo", since: "2026-10-03", until: "2026-10-02"})).code, "period_invalid");
    assert.equal(validateQuery(normalizeQuery({repo: "owner/repo", until: "9999-01-01"})).code, "period_invalid");
});

test("query collection bounds and dataset filters have separate identities", () => {
    const query = normalizeQuery({repo: "owner/repo", since: "2026-10-01", until: "2026-10-03"});
    const view = applyQueryPatch(query, {filterFrom: "2026-10-02"});
    assert.equal(datasetQueryId(query), datasetQueryId(view));
    assert.notEqual(collectionId(query), collectionId(view));
    assert.notEqual(rowQueryId(query), rowQueryId(view));
    assert.notEqual(datasetQueryId(query), datasetQueryId(applyQueryPatch(query, {until: "2026-10-04"})));
    assert.equal(applyQueryPatch(view, {days: 2}).filterFrom, "");
    assert.equal(applyQueryPatch(view, {bucket: "1h"}).filterFrom, view.filterFrom);
    assert.ok(!Object.hasOwn(persistedFields(view), "filterFrom"));
    const {from, to, days} = windowFor(view, "2026-10-10T00:00:00Z");
    assert.equal(from, periodTime("2026-10-02"));
    assert.equal(to, periodTime("2026-10-03"));
    assert.equal(days, 1);
});

test("retained snapshot comparisons preserve Go nanoseconds and timezone offsets", () => {
    const start = periodNanoseconds("2026-10-01T00:00:00Z");
    assert.equal(periodNanoseconds("2026-10-01T00:00:00.000000001Z"), start + 1n);
    assert.equal(periodNanoseconds("2026-10-01T09:00:00.000123456+09:00"), start + 123456n);
    assert.equal(periodNanoseconds("2026-10-01T00:00:00.123456789Z"), start + 123456789n);
    assert.equal(periodNanoseconds("2026-10-01"), start);
    assert.equal(periodNanoseconds(null), null);
    assert.equal(periodNanoseconds("invalid"), null);
});

test("collection commands use since and until without conflicting days or silent fallback", () => {
    const options = {
        target: {kind: "repo", owner: "owner", name: "repo", nwo: "owner/repo"},
        filters: normalizeQuery({since: "2026-10-01", until: "2026-10-03"}),
        output: "snapshot.json.gz",
    };
    const {args} = snapshotCommand(options);
    assert.ok(!args.includes("--days"));
    assert.equal(args[args.indexOf("--since") + 1], "2026-10-01T00:00:00.000Z");
    assert.equal(args[args.indexOf("--until") + 1], "2026-10-03T00:00:00.000Z");
    assert.throws(() => snapshotCommand({...options, probe: {flags: new Set()}}), /update gh runner-kit/);
    const defaultArgs = snapshotCommand({...options, filters: normalizeQuery({})}).args;
    assert.equal(defaultArgs[defaultArgs.indexOf("--days") + 1], "30");
});

test("every period field is editable and local controls round-trip absolute timestamps", t => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    for (const name of ["since", "until", "filterFrom", "filterTo"]) {
        assert.ok(queryFieldNames().includes(name));
        assert.ok(FIELDS[name]);
        const field = fieldByName(name);
        const value = "2026-10-01T00:00:00.123Z";
        assert.equal(writeFieldValue(field, value), "2026-10-01T09:00:00.123");
        assert.equal(readFieldValue(field, writeFieldValue(field, value)), value);
        assert.equal(readFieldValue(field, ""), "");
        assert.equal(writeFieldValue(field, ""), "");
    }
    assert.equal(localPeriodValue("invalid"), "");
});

test("Collection and Display partition the query according to actual dataset identity", () => {
    const collection = fieldsOfEditor("collection").map(field => field.name);
    const display = fieldsOfEditor("display").map(field => field.name);
    assert.deepEqual(collection.filter(name => name !== "jobConcurrency").sort(),
        DATASET_FIELDS.filter(name => !TARGET_FIELDS.includes(name)).sort());
    assert.deepEqual([...collection, ...display].sort(), queryFieldNames().sort());
    assert.ok(display.every(name => !collection.includes(name)));
    const query = normalizeQuery({repo: "owner/repo"});
    for (const name of display) {
        const field = fieldByName(name);
        const value = field.control === "datetime" ? "2026-10-01" : field.control === "select" ? field.options.find(option => option !== query[name])
            : field.control === "number" ? field.min : field.control === "checkbox" ? !query[name] : ["example-label"];
        assert.equal(datasetQueryId(query), datasetQueryId(applyQueryPatch(query, {[name]: value})), name);
    }
});

test("calendar presets respect local months, leap years, year transitions and Monday weeks", t => {
    const previous = process.env.TZ;
    process.env.TZ = "Asia/Tokyo";
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const now = "2026-10-11T08:30:00Z";
    const expected = {
        today: ["2026-10-10T15:00:00.000Z", "2026-10-11T08:30:00.000Z"],
        yesterday: ["2026-10-09T15:00:00.000Z", "2026-10-10T15:00:00.000Z"],
        "this-week": ["2026-10-04T15:00:00.000Z", "2026-10-11T08:30:00.000Z"],
        "last-week": ["2026-09-27T15:00:00.000Z", "2026-10-04T15:00:00.000Z"],
        "this-month": ["2026-09-30T15:00:00.000Z", "2026-10-11T08:30:00.000Z"],
        "last-month": ["2026-08-31T15:00:00.000Z", "2026-09-30T15:00:00.000Z"],
        "last-7-days": ["2026-10-04T08:30:00.000Z", "2026-10-11T08:30:00.000Z"],
        "last-30-days": ["2026-09-11T08:30:00.000Z", "2026-10-11T08:30:00.000Z"],
    };
    for (const preset of PERIOD_PRESETS) {
        const result = periodPreset(preset.id, {now});
        assert.equal(result.available, true, preset.id);
        assert.equal(result.partial, false, preset.id);
        assert.deepEqual(Object.values(result.window), expected[preset.id], preset.id);
        assert.deepEqual(result.window, result.requested);
    }
    assert.deepEqual(periodPreset("last-month", {now: "2024-03-15T00:00:00Z"}).window,
        {Start: "2024-01-31T15:00:00.000Z", End: "2024-02-29T15:00:00.000Z"});
    assert.deepEqual(periodPreset("last-month", {now: "2026-01-15T00:00:00Z"}).window,
        {Start: "2025-11-30T15:00:00.000Z", End: "2025-12-31T15:00:00.000Z"});
    assert.equal(periodPreset("this-week", {now: "2026-10-12T01:00:00Z"}).window.Start, "2026-10-11T15:00:00.000Z");
});

test("calendar days follow DST while rolling periods retain their elapsed duration", t => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const spring = periodPreset("yesterday", {now: "2026-03-09T16:00:00Z"}).window;
    assert.deepEqual(spring, {Start: "2026-03-08T05:00:00.000Z", End: "2026-03-09T04:00:00.000Z"});
    const autumn = periodPreset("yesterday", {now: "2026-11-02T17:00:00Z"}).window;
    assert.deepEqual(autumn, {Start: "2026-11-01T04:00:00.000Z", End: "2026-11-02T05:00:00.000Z"});
    for (const now of [spring.End, autumn.End]) {
        const rolling = periodPreset("last-7-days", {now}).window;
        assert.equal(periodTime(rolling.End) - periodTime(rolling.Start), 7 * 86400000);
    }
});

test("dataset presets expose partial coverage and never select uncollected or empty periods", t => {
    const previous = process.env.TZ;
    process.env.TZ = "UTC";
    t.after(() => { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; });
    const now = "2026-10-11T08:30:00Z";
    const coverage = {Start: "2026-09-15T00:00:00Z", End: "2026-10-10T00:00:00Z"};
    const lastMonth = periodPreset("last-month", {now, coverage});
    assert.equal(lastMonth.available, true);
    assert.equal(lastMonth.partial, true);
    assert.deepEqual(lastMonth.window, {Start: "2026-09-15T00:00:00.000Z", End: "2026-10-01T00:00:00.000Z"});
    const thisMonth = periodPreset("this-month", {now, coverage});
    assert.deepEqual(thisMonth.window, {Start: "2026-10-01T00:00:00.000Z", End: "2026-10-10T00:00:00.000Z"});
    assert.equal(thisMonth.partial, true);
    assert.equal(periodPreset("last-month", {now, coverage: lastMonth.requested}).partial, false);
    const missing = periodPreset("today", {now, coverage});
    assert.equal(missing.available, false);
    assert.equal(missing.window, null);
    assert.match(missing.reason, /No collected data/);
    assert.equal(periodPreset("today", {now: "2026-10-11T00:00:00Z"}).available, false);
    assert.throws(() => periodPreset("unknown"), /Unknown period preset/);
    assert.throws(() => periodPreset("today", {now: "invalid"}), /invalid current time/);
    assert.throws(() => periodPreset("today", {now, coverage: {Start: coverage.End, End: coverage.Start}}), {code: "period_invalid"});
});
