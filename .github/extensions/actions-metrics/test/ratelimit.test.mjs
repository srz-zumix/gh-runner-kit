// Run with `node --test .github/extensions/actions-metrics/test/`.
//
// Nothing here reaches GitHub: every request is refused by an active cooldown
// before `gh` is spawned, which is exactly the behavior under test.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";

process.env.COPILOT_HOME = mkdtempSync(join(tmpdir(), "actions-metrics-test-"));

const {
    GhError,
    RateLimitError,
    clearRateLimitCooldown,
    ghApi,
    ghRaw,
    hostKey,
    isRateLimitError,
    parseRateReset,
    rateLimitCooldown,
    setRateLimitCooldown,
} = await import("../lib/gh.mjs");
const { JobCache } = await import("../lib/jobcache.mjs");
const { DashboardStore } = await import("../lib/store.mjs");

describe("isRateLimitError", () => {
    const cases = [
        ["gh api primary limit", new GhError("gh: API rate limit exceeded for user ID 1. (HTTP 403)", { status: 403 }), true],
        [
            "go-github primary limit",
            new Error(
                "failed to list the workflow jobs of o/r: GET https://api.github.com/repos/o/r/actions/runs/1/jobs: 403 API rate limit of 5000 still exceeded until 2026-01-01 00:00:00 +0000 UTC, not making remote request. [rate reset in 12m05s]",
            ),
            true,
        ],
        ["secondary limit", new GhError("gh: You have exceeded a secondary rate limit. (HTTP 403)", { status: 403 }), true],
        ["too many requests", new GhError("gh: Too Many Requests", { status: 429 }), true],
        ["limit named only in stderr", new GhError("metrics: collecting", { stderr: "Error: 403 API rate limit exceeded" }), true],
        ["forbidden", new GhError("gh: Resource not accessible by integration (HTTP 403)", { status: 403 }), false],
        ["not found", new GhError("gh: Not Found (HTTP 404)", { status: 404 }), false],
    ];
    for (const [name, error, expected] of cases) {
        test(name, () => assert.equal(isRateLimitError(error), expected));
    }
});

test("parseRateReset reads go-github's reset delay", () => {
    assert.equal(parseRateReset("... [rate reset in 12m05s]"), (12 * 60 + 5) * 1000);
    assert.equal(parseRateReset("... [rate reset in 7s]"), 7000);
    assert.equal(parseRateReset("... [rate limit was reset 3s ago]"), null);
    assert.equal(parseRateReset("no reset here"), null);
});

describe("cooldown", () => {
    beforeEach(() => clearRateLimitCooldown(null));
    afterEach(() => clearRateLimitCooldown(null));

    test("the default host has one spelling", () => {
        assert.equal(hostKey(null), "github.com");
        assert.equal(hostKey(""), "github.com");
        assert.equal(hostKey("GitHub.com"), "github.com");
    });

    test("expires on its own", () => {
        setRateLimitCooldown(null, Date.now() + 60_000);
        assert.ok(rateLimitCooldown(null));
        assert.equal(rateLimitCooldown(null, Date.now() + 120_000), null);
    });

    test("never shortens an active cooldown", () => {
        const until = Date.now() + 60_000;
        setRateLimitCooldown(null, until);
        setRateLimitCooldown(null, until - 30_000);
        assert.equal(rateLimitCooldown(null).until, until);
    });

    test("holds back API calls without spawning gh", async () => {
        setRateLimitCooldown("github.com", Date.now() + 60_000);
        await assert.rejects(ghApi("/repos/o/r/actions/runs", { host: null }), (error) => {
            assert.ok(error instanceof RateLimitError);
            assert.equal(error.code, "rate_limited");
            assert.ok(error.resetAt);
            return true;
        });
        await assert.rejects(ghRaw(["runner-kit", "metrics", "summary"], { host: null }), RateLimitError);
    });

    test("is kept per host", async () => {
        setRateLimitCooldown("ghe.example", Date.now() + 60_000);
        try {
            assert.equal(rateLimitCooldown(null), null);
            await assert.rejects(ghApi("/rate", { host: "ghe.example" }), RateLimitError);
        } finally {
            clearRateLimitCooldown("ghe.example");
        }
    });
});

describe("JobCache", () => {
    const repo = { host: null, nwo: "octo/alpha" };
    const run = (id, attempt = 1, status = "completed") => ({ id, run_attempt: attempt, status });

    test("serves completed runs per attempt and strips the step logs", () => {
        const cache = new JobCache();
        assert.ok(cache.set(repo, run(1), [{ id: 10, steps: [{ name: "x" }] }], cache.epoch(repo)));
        assert.deepEqual(cache.get(repo, run(1)), [{ id: 10 }]);
        assert.equal(cache.get(repo, run(1, 2)), null);
        assert.equal(cache.get({ host: null, nwo: "octo/beta" }, run(1)), null);
    });

    test("never caches a run still in progress", () => {
        const cache = new JobCache();
        assert.equal(cache.set(repo, run(1, 1, "in_progress"), [{ id: 10 }], cache.epoch(repo)), false);
        assert.equal(cache.get(repo, run(1, 1, "in_progress")), null);
    });

    test("invalidate drops a target and rejects writes of collections already running", () => {
        const cache = new JobCache();
        const epoch = cache.epoch(repo);
        cache.set(repo, run(1), [{ id: 10 }], epoch);
        cache.invalidate(repo);
        assert.equal(cache.get(repo, run(1)), null);
        assert.equal(cache.set(repo, run(2), [{ id: 20 }], epoch), false);
        assert.ok(cache.set(repo, run(2), [{ id: 20 }], cache.epoch(repo)));
    });

    test("evicts the least recently used runs past its capacity", () => {
        const cache = new JobCache({ capacity: 3 });
        const epoch = cache.epoch(repo);
        cache.set(repo, run(1), [{ id: 1 }, { id: 2 }], epoch);
        cache.set(repo, run(2), [{ id: 3 }], epoch);
        cache.get(repo, run(1));
        cache.set(repo, run(3), [{ id: 4 }], epoch);
        assert.equal(cache.get(repo, run(2)), null);
        assert.ok(cache.get(repo, run(1)));
        assert.ok(cache.get(repo, run(3)));
        assert.equal(cache.set(repo, run(4), [{}, {}, {}, {}], epoch), false);
    });
});

describe("DashboardStore under a rate limit", () => {
    beforeEach(() => setRateLimitCooldown(null, Date.now() + 60_000));
    afterEach(() => clearRateLimitCooldown(null));

    test("fails fast, keeps the last metrics and reports the retry time", async () => {
        const store = new DashboardStore({ cwd: process.cwd() });
        const query = { repo: "octo/alpha" };
        const entry = store.entry(query);
        entry.metrics = { previous: true };
        entry.status = "ready";

        const state = await store.refresh(query, { force: true });
        assert.equal(state.status, "error");
        assert.equal(state.errorCode, "rate_limited");
        assert.ok(state.retryAt);
        assert.deepEqual(state.metrics, { previous: true });
    });

    test("a plain refresh joins the collection in flight; a hard refresh supersedes it", async () => {
        const store = new DashboardStore({ cwd: process.cwd() });
        const query = { repo: "octo/alpha" };
        // `refresh` wraps its result in a promise of its own, so the collections
        // are told apart by the generation they claimed.
        const first = store.refresh(query, { force: true });
        const second = store.refresh(query, { force: true });
        assert.equal(store.entry(query).generation, 1);

        const hard = store.refresh(query, { force: true, bypassCache: true });
        assert.equal(store.entry(query).generation, 2);
        await Promise.all([first, second, hard]);
    });
});

test("workspace detection is not held back by a REST cooldown", async () => {
    const { detectCurrentRepo } = await import("../lib/gh.mjs");
    setRateLimitCooldown(null, Date.now() + 60_000);
    try {
        // Outside a repository, so `gh` fails locally without reaching GitHub.
        await detectCurrentRepo(mkdtempSync(join(tmpdir(), "actions-metrics-norepo-"))).catch((error) => {
            assert.ok(!(error instanceof RateLimitError), `unexpected ${error?.name}: ${error?.message}`);
        });
    } finally {
        clearRateLimitCooldown(null);
    }
});
