// Collects the raw GitHub Actions data the dashboard aggregates: workflow runs,
// their jobs, self-hosted runner registrations and billing timings.
// Every optional source degrades gracefully - a 403/404 becomes a warning
// instead of failing the whole snapshot, because most of these endpoints need
// permissions (org owner, billing read) the operator may not have.

import { GhError, assertRateBudget, ghApi, ghApiPaged, mapLimit, rateLimitCooldown, throwIfRateLimited } from "./gh.mjs";
import { jobCache } from "./jobcache.mjs";
import { collectFleet, collectRuns, probeRunnerKit, repoFilterWarnings, runnerTypeWarnings } from "./runnerkit.mjs";

export const DEFAULTS = {
    days: 30,
    // 0 means no limit everywhere below, the same way
    // `gh runner-kit metrics --max-runs` reads it.
    maxRuns: 0,
    maxJobRuns: 0,
    maxTimingWorkflows: 0,
    jobConcurrency: 6,
};

function describe(error) {
    if (error instanceof GhError) {
        // `gh` already embeds "(HTTP nnn)" in most messages; don't repeat it.
        return error.status && !error.message.includes(`HTTP ${error.status}`)
            ? `${error.message} (HTTP ${error.status})`
            : error.message;
    }
    return error?.message ?? String(error);
}

async function optional(warnings, label, fn) {
    try {
        return await fn();
    } catch (error) {
        warnings.push(`${label}: ${describe(error)}`);
        return null;
    }
}

async function fetchJobs({ repo, runs, limits, cwd, signal, onProgress, warnings }) {
    const targets = limits.maxJobRuns > 0 ? runs.slice(0, limits.maxJobRuns) : runs;
    if (targets.length < runs.length) {
        warnings.push(
            `Job-level metrics (queue time, runner usage, cost) cover the ${targets.length} most recent runs out of ${runs.length}.`,
        );
    }
    let done = 0;
    let jobsTruncated = false;
    let cached = 0;
    // Captured before the first request, so a hard refresh that starts while
    // this collection is still running is not undone by its late writes.
    const epoch = jobCache.epoch(repo);
    const tick = () => {
        done += 1;
        if (done % 10 === 0 || done === targets.length) {
            onProgress?.(`Fetched jobs for ${done}/${targets.length} runs${cached > 0 ? ` (${cached} from cache)` : ""}`);
        }
    };
    const perRun = await mapLimit(targets, limits.jobConcurrency, async (run) => {
        const hit = jobCache.get(repo, run);
        if (hit) {
            cached += 1;
            tick();
            return hit.map((job) => ({ ...job, __run: run }));
        }
        // Once the host is rate limited every remaining request would be
        // refused too; the caller turns the cooldown into the snapshot's error.
        if (rateLimitCooldown(repo.host) || signal?.aborted) {
            tick();
            return [];
        }
        try {
            let truncated = false;
            const jobs = await ghApiPaged(`/repos/${repo.nwo}/actions/runs/${run.id}/jobs?filter=latest`, {
                host: repo.host,
                cwd,
                signal,
                maxPages: 3,
                extract: (payload) => payload?.jobs ?? [],
                onTruncated: () => {
                    truncated = true;
                    jobsTruncated = true;
                },
            });
            // A truncated list is not cached: a hit could not re-raise the warning.
            if (!truncated) {
                jobCache.set(repo, run, jobs, epoch);
            }
            return jobs.map((job) => ({ ...job, __run: run }));
        } catch (error) {
            if (rateLimitCooldown(repo.host)) {
                return [];
            }
            warnings.push(`Jobs for run #${run.run_number ?? run.id}: ${describe(error)}`);
            return [];
        } finally {
            tick();
        }
    });
    if (jobsTruncated) {
        warnings.push(
            "At least one run has more jobs than were read (the per-run job listing stops after 300 jobs), so the queue-time, runner-usage, duration and cost cards may undercount that run.",
        );
    }
    return perRun.flat();
}

async function fetchRunners({ target, runnerType, cwd, signal, onProgress, warnings }) {
    onProgress?.("Fetching self-hosted runners");
    // Match the CLI's `--type` semantics: a repository target reads its own
    // runners by default (auto/repo) and the shared organization runners only
    // when `--type org` is asked for, while an organization target always reads
    // the organization runners. Fetching both for a repository target would mix
    // out-of-scope organization runners into its inventory, labels and totals.
    const wantsOrg = target.kind === "org" || runnerType === "org";
    const wantsRepo = target.kind === "repo" && runnerType !== "org";
    const orgRunners = wantsOrg
        ? await optional(warnings, "Organization runners", () =>
              ghApiPaged(`/orgs/${target.owner}/actions/runners`, {
                  host: target.host,
                  cwd,
                  signal,
                  maxPages: 5,
                  extract: (payload) => payload?.runners ?? [],
                  onTruncated: () =>
                      warnings.push(
                          "This organization has more registered runners than were read (the runner listing stops after 500), so the fleet inventory, utilization, label supply and matching-runner counts may be incomplete.",
                      ),
              }),
          )
        : null;
    throwIfRateLimited(target.host);
    const repoRunners = wantsRepo
        ? await optional(warnings, "Repository runners", () =>
              ghApiPaged(`/repos/${target.nwo}/actions/runners`, {
                  host: target.host,
                  cwd,
                  signal,
                  maxPages: 5,
                  extract: (payload) => payload?.runners ?? [],
                  onTruncated: () =>
                      warnings.push(
                          "This repository has more registered runners than were read (the runner listing stops after 500), so the fleet inventory, utilization, label supply and matching-runner counts may be incomplete.",
                      ),
              }),
          )
        : null;
    return [
        ...(repoRunners ?? []).map((runner) => ({ ...runner, scope: "repository" })),
        ...(orgRunners ?? []).map((runner) => ({ ...runner, scope: "organization" })),
    ];
}

async function fetchTiming({ repo, limits, cwd, signal, onProgress, warnings }) {
    const workflows = await optional(warnings, "Workflow list", () =>
        ghApiPaged(`/repos/${repo.nwo}/actions/workflows`, {
            host: repo.host,
            cwd,
            signal,
            maxPages: 3,
            extract: (payload) => payload?.workflows ?? [],
        }),
    );
    if (!workflows) {
        return { workflows: [], timings: [] };
    }
    const enabled = workflows.filter((workflow) => workflow.state === "active");
    const active = limits.maxTimingWorkflows > 0 ? enabled.slice(0, limits.maxTimingWorkflows) : enabled;
    onProgress?.(`Fetching billable timing for ${active.length} workflows`);
    throwIfRateLimited(repo.host);
    const timings = await mapLimit(active, limits.jobConcurrency, async (workflow) => {
        if (rateLimitCooldown(repo.host) || signal?.aborted) {
            return null;
        }
        try {
            const timing = await ghApi(`/repos/${repo.nwo}/actions/workflows/${workflow.id}/timing`, {
                host: repo.host,
                cwd,
                signal,
            });
            return { workflowId: workflow.id, name: workflow.name, billable: timing?.billable ?? {} };
        } catch {
            return null;
        }
    });
    throwIfRateLimited(repo.host);
    const usable = timings.filter(Boolean);
    if (active.length > 0 && usable.length === 0) {
        warnings.push("Reported billable timing is unavailable (the token likely lacks billing read access).");
    }
    return { workflows, timings: usable };
}

/**
 * Collect a full dashboard snapshot. Returns raw API payloads; aggregation
 * happens in metrics.mjs so the two concerns stay independently testable.
 *
 * Workflow runs come from `gh runner-kit metrics runs` for every target. The
 * dashboard used to walk the REST API itself for a single repository, which cut
 * the window at a date boundary while every `gh runner-kit` report cuts it at an
 * exact instant - so one dashboard mixed two different periods - and left an
 * organization target with no runs at all.
 *
 * The per-job and billing passes below still walk one repository at a time, so
 * an organization target skips them and leans on the fleet reports, which
 * already aggregate the whole organization from a shared job cache.
 *
 * A rate limit fails the whole snapshot rather than committing what was read
 * before it: a dashboard assembled from the few reports that finished would
 * replace the last complete one with mostly empty cards. What was read is not
 * lost - completed runs' job lists are cached here and in `gh runner-kit` - so
 * the next Refresh resumes instead of starting over. `force` is the explicit
 * hard refresh that discards both caches.
 */
export async function collectSnapshot({ target, filters, limits = {}, cwd, force = false, signal, onProgress } = {}) {
    const effective = { ...DEFAULTS, ...limits };
    const warnings = [];
    const startedAt = Date.now();
    const orgWide = target.kind === "org";
    // Between phases: a cooldown left by any refused request ends the snapshot,
    // and a superseded one stops spending budget on rows nobody will read.
    const checkpoint = () => {
        throwIfRateLimited(target.host);
        if (signal?.aborted) {
            throw new GhError("The collection was superseded");
        }
    };

    onProgress?.("Checking the API rate limit");
    await assertRateBudget(target.host, { cwd });
    // Only after the budget check: a hard refresh refused for a rate limit must
    // not throw away the job lists the next attempt would resume from.
    if (force && target.kind === "repo") {
        jobCache.invalidate(target);
    }

    if (orgWide) {
        warnings.push(
            "Per-job metrics (queue time, runner usage, cost estimates) are computed one repository at a time and are hidden for an organization; the fleet reports reported by `gh runner-kit metrics` cover the whole organization instead.",
        );
    }

    onProgress?.("Fetching workflow runs");
    warnings.push(...repoFilterWarnings(await probeRunnerKit(cwd), filters, target));
    warnings.push(...runnerTypeWarnings(filters, target));
    const runsResult = await collectRuns({ target, filters, limits: effective, cwd, signal, onProgress, warnings });
    checkpoint();
    const runs = runsResult.rows;
    const jobs =
        !orgWide && runs.length > 0
            ? await fetchJobs({ repo: target, runs, limits: effective, cwd, signal, onProgress, warnings })
            : [];
    checkpoint();
    const runners = await fetchRunners({ target, runnerType: filters?.runnerType, cwd, signal, onProgress, warnings });
    checkpoint();
    const { workflows, timings } = orgWide
        ? { workflows: [], timings: [] }
        : await fetchTiming({ repo: target, limits: effective, cwd, signal, onProgress, warnings });
    checkpoint();
    const fleet = await collectFleet({ target, filters, limits: effective, cwd, force, signal, onProgress, warnings });
    checkpoint();

    // `--max-runs` caps each repository independently, so a truncated report is
    // only visible through the count the CLI reports back.
    if (fleet.summary?.truncatedRepos > 0) {
        warnings.push(
            `Workflow runs were capped at ${effective.maxRuns} per repository in ${fleet.summary.truncatedRepos} ${
                fleet.summary.truncatedRepos === 1 ? "repository" : "repositories"
            }; those repositories report only their most recent runs in the window.`,
        );
    }

    return {
        target,
        filters,
        limits: effective,
        runs,
        runsAvailable: runsResult.available,
        runsReason: runsResult.reason,
        jobs,
        runners,
        workflows,
        timings,
        fleet,
        warnings,
        collectedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
    };
}
