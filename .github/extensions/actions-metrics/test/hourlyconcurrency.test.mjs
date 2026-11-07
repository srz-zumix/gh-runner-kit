import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRows } from "../shared/rows.mjs";
import { applyExploreFilters, buildExploreAggregate } from "../shared/explore.mjs";

function inZone(t, zone) {
    const previous = process.env.TZ;
    process.env.TZ = zone;
    t.after(() => {
        if (previous === undefined) delete process.env.TZ;
        else process.env.TZ = previous;
    });
}

function job(id, startedAt, completedAt, overrides = {}) {
    return {
        Repo: "example/project", JobID: String(id), RunID: "100", Workflow: "CI", Status: "completed",
        Conclusion: "success", QueuedAt: startedAt, StartedAt: startedAt, CompletedAt: completedAt,
        ...overrides,
    };
}

function aggregate(jobs, from, to, options = {}) {
    return buildExploreAggregate(normalizeRows(jobs), {
        windowFrom: Date.parse(from), windowTo: Date.parse(to), collectedAt: Date.parse(to), ...options,
    }).hourlyConcurrency;
}

test("hourly peaks count jobs in every hour they span and distinguish idle from unobserved", t => {
    inZone(t, "UTC");
    const result = aggregate([
        job(1, "2026-01-05T01:10:00Z", "2026-01-05T02:30:00Z"),
        job(2, "2026-01-05T01:20:00Z", "2026-01-05T01:40:00Z"),
        job(3, "2026-01-06T01:00:00Z", "2026-01-06T01:30:00Z"),
    ], "2026-01-05T00:00:00Z", "2026-01-07T00:00:00Z");
    assert.equal(result.days, 2);
    assert.equal(result.hours.length, 24);
    const first = result.hours[1];
    assert.deepEqual([first.average, first.max, first.samples], [1.5, 2, 2]);
    assert.deepEqual([first.monday, first.tuesday, first.weekday, first.weekend], [2, 1, 1.5, null]);
    assert.deepEqual([first.counts.monday, first.counts.tuesday, first.counts.weekday, first.counts.weekend], [1, 1, 2, 0]);
    assert.equal(first.wednesday, null);
    assert.equal(result.hours[2].average, 0.5);
    assert.deepEqual([result.hours[0].average, result.hours[0].max, result.hours[0].weekday], [0, 0, 0]);
});

test("weekday and weekend profiles average individual observed days rather than category averages", t => {
    inZone(t, "UTC");
    const jobs = [];
    for (const [date, count] of [["2026-01-05", 1], ["2026-01-06", 2], ["2026-01-10", 4], ["2026-01-12", 3]]) {
        for (let index = 0; index < count; index++) {
            jobs.push(job(jobs.length + 1, `${date}T10:00:00Z`, `${date}T10:30:00Z`));
        }
    }
    const result = aggregate([
        ...jobs,
    ], "2026-01-05T00:00:00Z", "2026-01-14T00:00:00Z");
    const hour = result.hours[10];
    assert.equal(result.days, 9);
    assert.deepEqual([hour.average, hour.max, hour.samples], [10 / 9, 4, 9]);
    assert.deepEqual(
        [hour.monday, hour.tuesday, hour.wednesday, hour.thursday, hour.friday, hour.saturday, hour.sunday],
        [2, 1, 0, 0, 0, 4, 0],
    );
    assert.deepEqual([hour.weekday, hour.weekend], [6 / 7, 2]);
    assert.deepEqual(
        [hour.counts.monday, hour.counts.tuesday, hour.counts.weekday, hour.counts.weekend],
        [2, 2, 7, 2],
    );
});

test("hours follow the local zone and a selected range limits the observed hours", t => {
    inZone(t, "Asia/Kolkata");
    const result = aggregate([
        job(1, "2026-01-05T00:40:00Z", "2026-01-05T00:50:00Z"),
    ], "2026-01-04T00:00:00Z", "2026-01-07T00:00:00Z", {
        filterFrom: Date.parse("2026-01-05T00:00:00Z"), filterTo: Date.parse("2026-01-05T02:00:00Z"),
    });
    // 00:40Z is 06:10 IST; the range covers 05:30-07:30 IST.
    assert.deepEqual(
        [result.hours[6].average, result.hours[6].max, result.hours[6].monday, result.hours[6].weekday],
        [1, 1, 1, 1],
    );
    assert.equal(result.hours[5].samples, 1);
    assert.equal(result.hours[7].samples, 1);
    assert.equal(result.hours[8].samples, 0);
    assert.equal(result.hours[8].average, null);
    assert.equal(result.hours[6].weekend, null);
    assert.equal(result.days, 1);
});

test("a repeated DST hour keeps the higher peak and is sampled once", t => {
    inZone(t, "America/New_York");
    // 2026-11-01 01:00-02:00 local repeats: 05:00-06:00Z (EDT) and 06:00-07:00Z (EST).
    const result = aggregate([
        job(1, "2026-11-01T05:10:00Z", "2026-11-01T05:20:00Z"),
        job(2, "2026-11-01T06:10:00Z", "2026-11-01T06:40:00Z"),
        job(3, "2026-11-01T06:20:00Z", "2026-11-01T06:50:00Z"),
    ], "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z");
    assert.deepEqual(
        [result.hours[1].average, result.hours[1].max, result.hours[1].samples, result.hours[1].sunday],
        [2, 2, 1, 2],
    );
    assert.equal(result.days, 1);

    const partial = aggregate([
        job(1, "2026-11-01T05:10:00Z", "2026-11-01T05:20:00Z"),
        job(2, "2026-11-01T06:10:00Z", "2026-11-01T06:40:00Z"),
        job(3, "2026-11-01T06:20:00Z", "2026-11-01T06:50:00Z"),
    ], "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z", {
        filterFrom: Date.parse("2026-11-01T06:25:00Z"),
        filterTo: Date.parse("2026-11-01T06:35:00Z"),
    });
    assert.deepEqual([partial.hours[1].average, partial.hours[1].samples, partial.hours[1].weekend], [2, 1, 2]);
    assert.equal(partial.hours.filter(hour => hour.samples > 0).length, 1);
});

test("spring DST gaps are unobserved instead of being zero", t => {
    inZone(t, "America/New_York");
    const result = aggregate([
        job(1, "2026-03-08T06:30:00Z", "2026-03-08T07:30:00Z"),
    ], "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z");
    assert.equal(result.hours[1].sunday, 1);
    assert.deepEqual([result.hours[2].average, result.hours[2].sunday, result.hours[2].samples], [null, null, 0]);
    assert.equal(result.hours[3].weekend, 1);
});

test("half-hour DST shifts preserve repeated and partial local hours", t => {
    inZone(t, "Australia/Lord_Howe");
    const fallJobs = [
        job(1, "2026-04-04T14:40:00Z", "2026-04-04T15:10:00Z"),
        job(2, "2026-04-04T15:05:00Z", "2026-04-04T15:20:00Z"),
    ];
    const fall = aggregate(fallJobs, "2026-04-04T14:00:00Z", "2026-04-04T16:00:00Z");
    assert.deepEqual([fall.hours[1].average, fall.hours[1].samples, fall.hours[1].sunday], [2, 1, 2]);
    assert.equal(fall.hours[2].average, 0);

    const partial = aggregate(fallJobs, "2026-04-04T14:00:00Z", "2026-04-04T16:00:00Z", {
        filterFrom: Date.parse("2026-04-04T15:05:00Z"),
        filterTo: Date.parse("2026-04-04T15:25:00Z"),
    });
    assert.deepEqual([partial.hours[1].average, partial.hours[1].samples, partial.hours[1].sunday], [2, 1, 2]);
    assert.equal(partial.hours.filter(hour => hour.samples > 0).length, 1);

    const spring = aggregate([
        job(1, "2026-10-03T15:20:00Z", "2026-10-03T15:40:00Z"),
    ], "2026-10-03T15:15:00Z", "2026-10-03T16:00:00Z");
    assert.deepEqual([spring.hours[1].sunday, spring.hours[2].sunday, spring.hours[3].sunday], [1, 1, null]);
    assert.equal(spring.days, 1);
});

test("DST transitions between clock-hour boundaries split samples at the offset change", t => {
    inZone(t, "Pacific/Chatham");
    const fall = aggregate([
        job(1, "2026-04-04T14:05:00Z", "2026-04-04T14:10:00Z"),
    ], "2026-04-04T13:15:00Z", "2026-04-04T14:15:00Z");
    assert.deepEqual([fall.hours[2].sunday, fall.hours[3].sunday], [1, 0]);

    const repeated = aggregate([
        job(1, "2026-04-04T13:00:00Z", "2026-04-04T13:10:00Z"),
        job(2, "2026-04-04T14:05:00Z", "2026-04-04T14:10:00Z"),
        job(3, "2026-04-04T14:05:00Z", "2026-04-04T14:10:00Z"),
    ], "2026-04-04T12:45:00Z", "2026-04-04T14:15:00Z");
    assert.deepEqual([repeated.hours[2].sunday, repeated.hours[2].counts.sunday, repeated.hours[3].sunday], [2, 1, 0]);

    const spring = aggregate([
        job(1, "2026-09-26T14:05:00Z", "2026-09-26T14:10:00Z"),
    ], "2026-09-26T13:15:00Z", "2026-09-26T14:15:00Z");
    assert.deepEqual([spring.hours[2].sunday, spring.hours[3].sunday], [0, 1]);
});

test("job facets and clipped time ranges apply to every profile, independent of timeline buckets", t => {
    inZone(t, "UTC");
    const from = Date.parse("2026-01-05T00:00:00Z");
    const to = Date.parse("2026-01-06T00:00:00Z");
    const selectedFrom = Date.parse("2026-01-05T09:20:00Z");
    const selectedTo = Date.parse("2026-01-05T09:30:00Z");
    const rows = normalizeRows([
        job(1, "2026-01-05T09:00:00Z", "2026-01-05T10:00:00Z"),
        job(2, "2026-01-05T09:00:00Z", "2026-01-05T10:00:00Z", { Repo: "example/other" }),
    ]);
    const subset = applyExploreFilters(rows, { repo: ["example/project"], from: selectedFrom, to: selectedTo });
    const options = { windowFrom: from, windowTo: to, collectedAt: to, filterFrom: selectedFrom, filterTo: selectedTo };
    const narrow = buildExploreAggregate(subset, { ...options, targetBuckets: 4 }).hourlyConcurrency;
    const wide = buildExploreAggregate(subset, { ...options, targetBuckets: 80 }).hourlyConcurrency;
    assert.deepEqual(narrow, wide);
    assert.deepEqual([narrow.hours[9].average, narrow.hours[9].monday, narrow.hours[9].weekday], [1, 1, 1]);
    assert.equal(narrow.hours[10].average, null);
});

test("an empty selection has no observed categories, and adjacent jobs do not overlap", t => {
    inZone(t, "UTC");
    const jobs = [
        job(1, "2026-01-05T10:00:00Z", "2026-01-05T10:30:00Z"),
        job(2, "2026-01-05T10:30:00Z", "2026-01-05T11:00:00Z"),
    ];
    const result = aggregate(jobs, "2026-01-05T10:00:00Z", "2026-01-05T11:00:00Z");
    assert.deepEqual([result.hours[10].average, result.hours[10].max, result.hours[10].monday], [1, 1, 1]);
    assert.equal(result.hours[11].average, null);

    const empty = aggregate(jobs, "2026-01-05T00:00:00Z", "2026-01-06T00:00:00Z", {
        filterFrom: Date.parse("2026-01-05T12:00:00Z"),
        filterTo: Date.parse("2026-01-05T12:00:00Z"),
    });
    assert.equal(empty.days, 0);
    assert.ok(empty.hours.every(hour => hour.samples === 0 && hour.average === null && hour.max === null));
    assert.ok(empty.hours.every(hour => hour.weekday === null && hour.weekend === null));
});
