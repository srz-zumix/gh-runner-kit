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

function job(id, at, overrides = {}) {
    return {
        Repo: "example/project", JobID: String(id), RunID: "100", Workflow: "CI",
        QueuedAt: at, StartedAt: at, ...overrides,
    };
}

function aggregate(jobs, from, to, options = {}) {
    return buildExploreAggregate(normalizeRows(jobs), {
        windowFrom: Date.parse(from), windowTo: Date.parse(to), collectedAt: Date.parse(to), ...options,
    }).hourlyJobs;
}

test("local hour totals count every job attempt and average across zero-job days", t => {
    inZone(t, "Asia/Tokyo");
    const result = aggregate([
        job(1, "2026-01-01T15:15:00Z"),
        job(2, "2026-01-01T15:30:00Z", { RunAttempt: 2 }),
        job(3, "2026-01-01T16:00:00Z"),
    ], "2026-01-01T15:00:00Z", "2026-01-04T15:00:00Z");
    assert.equal(result.days, 3);
    assert.equal(result.total, 3);
    assert.equal(result.hours.length, 24);
    assert.deepEqual(result.hours[0], { hour: 0, total: 2, average: 2 / 3 });
    assert.deepEqual(result.hours[1], { hour: 1, total: 1, average: 1 / 3 });
    assert.ok(result.hours.slice(2).every(hour => hour.total === 0 && hour.average === 0));
});

test("queue time takes priority, with start fallback and explicit missing/outside counts", t => {
    inZone(t, "UTC");
    const result = aggregate([
        job(1, "2026-01-01T01:10:00Z", { StartedAt: "2026-01-01T02:10:00Z" }),
        job(2, null, { StartedAt: "2026-01-01T03:00:00Z" }),
        job(3, null),
        job(4, "2025-12-31T23:59:59Z"),
        job(5, "2026-01-02T00:00:00Z"),
    ], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z");
    assert.equal(result.total, 2);
    assert.equal(result.hours[1].total, 1);
    assert.equal(result.hours[2].total, 0);
    assert.equal(result.hours[3].total, 1);
    assert.equal(result.missingTime, 1);
    assert.equal(result.outsideWindow, 2);
});

test("facet filters and brush bounds narrow counts and the calendar-day divisor", t => {
    inZone(t, "UTC");
    const from = "2026-01-01T12:00:00Z";
    const to = "2026-01-03T10:00:00Z";
    const rows = normalizeRows([
        job(1, "2026-01-01T13:00:00Z"),
        job(2, "2026-01-02T09:00:00Z"),
        job(3, "2026-01-02T09:00:00Z", { Repo: "example/other" }),
    ]);
    const filters = { repo: ["example/project"], from: Date.parse(from), to: Date.parse("2026-01-02T10:00:00Z") };
    const subset = applyExploreFilters(rows, filters);
    const result = buildExploreAggregate(subset, {
        windowFrom: Date.parse(from), windowTo: Date.parse(to), collectedAt: Date.parse(to),
        filterFrom: filters.from, filterTo: filters.to,
    }).hourlyJobs;
    assert.equal(result.days, 2);
    assert.equal(result.total, 2);
    assert.equal(result.hours[9].average, 0.5);
    assert.equal(result.hours[13].average, 0.5);
});

test("partial days count once, midnight upper bounds do not add a day, and empty windows stay zero", t => {
    inZone(t, "UTC");
    assert.equal(aggregate([], "2026-01-01T12:00:00Z", "2026-01-02T10:00:00Z").days, 2);
    assert.equal(aggregate([], "2026-01-01T12:00:00Z", "2026-01-02T00:00:00Z").days, 1);
    const empty = aggregate([], "2026-01-01T00:00:00Z", "2026-01-03T00:00:00Z", {
        filterFrom: Date.parse("2026-01-02T12:00:00Z"), filterTo: Date.parse("2026-01-02T12:00:00Z"),
    });
    assert.equal(empty.days, 0);
    assert.ok(empty.hours.every(hour => hour.average === 0));
});

test("DST days use calendar-day divisors and combine repeated local hours", t => {
    inZone(t, "America/New_York");
    const spring = aggregate([
        job(1, "2026-03-08T06:30:00Z"), job(2, "2026-03-08T07:30:00Z"),
    ], "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z");
    assert.equal(spring.days, 1);
    assert.equal(spring.hours[1].average, 1);
    assert.equal(spring.hours[2].total, 0);
    assert.equal(spring.hours[3].average, 1);
    const autumn = aggregate([
        job(1, "2026-11-01T05:30:00Z"), job(2, "2026-11-01T06:30:00Z"),
    ], "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z");
    assert.equal(autumn.days, 1);
    assert.equal(autumn.hours[1].total, 2);
    assert.equal(autumn.hours[1].average, 2);
});
