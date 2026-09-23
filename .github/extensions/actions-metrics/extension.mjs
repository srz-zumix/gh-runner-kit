// Extension: actions-metrics
// GitHub Actions metrics dashboard - workflow runs, self-hosted runners and
// usage/cost, collected through the `gh` CLI.
//
// This file is wiring only: target resolution, canvas declaration, agent
// actions and per-instance server lifecycle. Data collection lives in
// lib/collect.mjs, aggregation in lib/metrics.mjs and rendering in public/.

import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { detectCurrentRepo, findGitRoot, formatTarget } from "./lib/gh.mjs";
import { DashboardStore } from "./lib/store.mjs";
import {
    PERSISTED_FIELDS,
    applyQueryPatch,
    canonicalizeQuery,
    formatQuery,
    normalizeQuery,
    querySchema,
    scopeOf,
    validateQuery,
} from "./lib/query.mjs";
import { DashboardInstance } from "./lib/instance.mjs";
import { startInstanceServer } from "./lib/server.mjs";
import { loadPrefs } from "./lib/prefs.mjs";

/** instanceId -> { instance, server, url } */
const panels = new Map();

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

let session = null;
let store = null;

function log(message, level = "info") {
    void session?.log?.(`actions-metrics: ${message}`, { level })?.catch?.(() => {});
}

/**
 * Directory `gh` commands run in. `session.workspacePath` is not always
 * populated, so fall back to the git root the extension itself lives in.
 */
function workspaceCwd() {
    for (const candidate of [session?.workspacePath, EXTENSION_DIR, process.cwd()]) {
        const root = candidate ? findGitRoot(candidate) : null;
        if (root) {
            return root;
        }
    }
    return process.cwd();
}

function getStore() {
    if (!store) {
        store = new DashboardStore({
            cwd: workspaceCwd(),
            log: (message) => log(message, "warning"),
        });
    }
    return store;
}

/**
 * Resolve what a panel should show, as one canonical query.
 *
 * The order matters: an input is normalized, the target it leaves unstated is
 * materialized from the workspace or from the last one used, the result is
 * validated, and only then is it canonicalized - which drops values stated
 * twice, and would otherwise silently resolve a contradiction the validator
 * exists to report.
 */
async function resolveQuery(input, base = null) {
    const stated = base ? applyQueryPatch(base, input ?? {}) : normalizeQuery(input ?? {});
    const named = stated.repo || stated.owner;
    let query = stated;

    if (!named) {
        query = await materializeTarget(stated);
    }

    const problem = validateQuery(query);
    if (problem) {
        throw new CanvasError(problem.code, problem.message);
    }
    const canonical = canonicalizeQuery(query);
    if (base) {
        // Re-opening a live panel: what is in force there is newer than
        // anything on disk, so there is nothing to remember back into it.
        return canonical;
    }

    // Opening cold: the settings remembered for this target fill in what
    // neither the input nor the defaults stated. Restricted to the fields that
    // are actually remembered, and applied under the input, so a stored value
    // can neither resurrect a target nor override an explicit one.
    const prefs = await loadPrefs();
    const remembered = prefs.filtersByTarget?.[formatQuery(canonical)] ?? {};
    const stateless = Object.fromEntries(
        PERSISTED_FIELDS.filter((key) => remembered[key] !== undefined && input?.[key] === undefined).map((key) => [key, remembered[key]]),
    );
    return canonicalizeQuery(applyQueryPatch(canonical, stateless));
}

/** Fill in a target the caller left unstated, from the workspace or the last one used. */
async function materializeTarget(query) {
    try {
        const repo = await detectCurrentRepo(workspaceCwd());
        return { ...query, repo: repo.nwo, host: repo.host ?? "" };
    } catch (workspaceError) {
        const prefs = await loadPrefs();
        if (prefs.lastTarget) {
            const field = prefs.lastScope === "org" ? "owner" : "repo";
            const candidate = { ...query, [field]: prefs.lastTarget };
            if (!validateQuery(candidate)) {
                return candidate;
            }
        }
        throw new CanvasError(
            "target_unresolved",
            `Could not determine what to analyse: ${workspaceError?.message ?? workspaceError}. Pass {"repo": "OWNER/REPO"} or {"owner": "ORG"} when opening the canvas.`,
        );
    }
}

function panelFor(instanceId) {
    const panel = panels.get(instanceId);
    if (!panel) {
        throw new CanvasError("canvas_instance_unknown", `No open actions-metrics canvas with instance id "${instanceId}"`);
    }
    return panel;
}

/** Wait until the current collection for this panel settles, then return its state. */
async function settled(instance) {
    const entry = instance.store.entries.get(instance.key);
    if (entry?.inflight) {
        await entry.inflight;
    }
    return instance.state();
}

function requireMetrics(state) {
    if (state.status === "error") {
        throw new CanvasError("collection_failed", state.error ?? "Metric collection failed");
    }
    if (!state.metrics) {
        throw new CanvasError("no_data", "No metrics have been collected yet");
    }
    return state.metrics;
}

function round(value, digits = 2) {
    return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function seconds(ms) {
    return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

/** Compact, analysis-friendly projection of the metrics document. */
function summarize(metrics, section = "all", limit = 10) {
    const { overview, runners, usage, fleet, meta } = metrics;
    const head = (rows) => rows.slice(0, limit);
    const orgWide = meta.scope === "org";
    // The per-job and cost passes walk one repository at a time, so an
    // organization target never populates them. Say so instead of reporting the
    // zeros that would otherwise read as "this organization ran nothing".
    const repoOnly = (build) =>
        orgWide
            ? {
                  available: false,
                  reason: "This section is computed per repository and is not collected for an organization target. Read the fleet section, which gh runner-kit aggregates across every repository in the organization.",
              }
            : build();
    // Workflow runs themselves come from `gh runner-kit metrics runs`, which
    // covers every repository, so the run-derived numbers are available for
    // both scopes. Only their job-derived companions are not.
    const jobDerived = (build) =>
        orgWide
            ? {
                  available: false,
                  reason: "Measured from the jobs of each run, which are collected one repository at a time and are not collected for an organization target.",
              }
            : build();

    const sections = {
        overview: meta.runs?.available === false
            ? {
                  available: false,
                  reason: `Workflow runs could not be collected: ${meta.runs.reason ?? "unknown error"}.`,
              }
            : {
            totals: overview.totals,
            successRate: round(overview.successRate, 4),
            conclusions: overview.conclusions,
            runDurationSeconds: jobDerived(() => ({
                p50: seconds(overview.duration.p50),
                p90: seconds(overview.duration.p90),
                p95: seconds(overview.duration.p95),
                max: seconds(overview.duration.max),
            })),
            jobQueueSeconds: jobDerived(() => ({
                p50: seconds(overview.jobQueue.p50),
                p90: seconds(overview.jobQueue.p90),
                p95: seconds(overview.jobQueue.p95),
                max: seconds(overview.jobQueue.max),
            })),
            daily: overview.daily.map((day) => ({
                date: day.date,
                total: day.total,
                success: day.success,
                failure: day.failure,
                cancelled: day.cancelled,
                other: day.other,
                p50Seconds: seconds(day.p50DurationMs),
            })),
            byWorkflow: head(
                overview.byWorkflow.map((row) => ({
                    name: row.name,
                    // Two repositories routinely share a workflow name, so the
                    // name alone does not identify the row under an org.
                    repository: row.repository || undefined,
                    runs: row.runs,
                    failures: row.failures,
                    successRate: round(row.successRate, 4),
                    p50Seconds: seconds(row.p50DurationMs),
                    p95Seconds: seconds(row.p95DurationMs),
                })),
            ),
            topFailingJobs: jobDerived(() =>
                head(
                    overview.byJob.map((row) => ({
                        name: row.name,
                        repository: row.repository || undefined,
                        runs: row.runs,
                        failures: row.failures,
                        failureRate: round(row.failureRate, 4),
                        p50Seconds: seconds(row.p50DurationMs),
                        queueP50Seconds: seconds(row.p50QueueMs),
                    })),
                ),
            ),
            slowestRuns: jobDerived(() =>
                head(
                    overview.slowest.map((row) => ({
                        name: row.name,
                        repository: row.repository || undefined,
                        runNumber: row.runNumber,
                        branch: row.branch,
                        conclusion: row.conclusion,
                        durationSeconds: seconds(row.durationMs),
                        url: row.url,
                    })),
                ),
            ),
            byEvent: overview.byEvent.map((row) => ({ ...row, successRate: round(row.successRate, 4) })),
        },
        runners: {
            // The inventory is read straight from the runner API, so it covers
            // an organization target too; everything derived from jobs does not.
            summary: runners.summary,
            registered: head(runners.registered),
            split: repoOnly(() => ({
                selfHosted: {
                    jobs: runners.split.selfHosted.jobs,
                    minutes: runners.split.selfHosted.minutes,
                    queueP50Seconds: seconds(runners.split.selfHosted.p50QueueMs),
                    queueP95Seconds: seconds(runners.split.selfHosted.p95QueueMs),
                },
                githubHosted: {
                    jobs: runners.split.githubHosted.jobs,
                    minutes: runners.split.githubHosted.minutes,
                    queueP50Seconds: seconds(runners.split.githubHosted.p50QueueMs),
                    queueP95Seconds: seconds(runners.split.githubHosted.p95QueueMs),
                },
            })),
            labelDemand: repoOnly(() =>
                head(
                    runners.demand.map((row) => ({
                        labelSet: row.labelSet,
                        selfHosted: row.selfHosted,
                        jobs: row.jobs,
                        minutes: row.minutes,
                        matchingRunners: row.matchingRunners,
                        queueP50Seconds: seconds(row.p50QueueMs),
                        queueP95Seconds: seconds(row.p95QueueMs),
                    })),
                ),
            ),
            busiestRunners: repoOnly(() =>
                head(
                    runners.byRunner.map((row) => ({
                        runner: row.runner,
                        registered: row.registered,
                        jobs: row.jobs,
                        minutes: row.minutes,
                        failures: row.failures,
                        p50Seconds: seconds(row.p50DurationMs),
                    })),
                ),
            ),
        },
        usage: repoOnly(() => ({
            rates: usage.rates,
            window: {
                totalMinutes: usage.window.totalMinutes,
                billableMinutes: usage.window.billableMinutes,
                selfHostedMinutes: usage.window.selfHostedMinutes,
                estimatedCost: round(usage.window.estimatedCost),
                byRunnerClass: usage.window.byRunnerClass.map((row) => ({ ...row, cost: round(row.cost) })),
                byWorkflow: head(usage.window.byWorkflow.map((row) => ({ ...row, cost: round(row.cost) }))),
            },
            reportedBillingCycle: {
                available: usage.reported.available,
                totalMinutes: usage.reported.totalMinutes,
                estimatedCost: round(usage.reported.estimatedCost),
                byWorkflow: head(usage.reported.byWorkflow.map((row) => ({ ...row, cost: round(row.cost) }))),
            },
        })),
        fleet: fleet?.available
            ? {
                  source: `gh runner-kit metrics${fleet.version ? ` (${fleet.version})` : ""}`,
                  scope: orgWide
                      ? "Every repository in the organization, collected with --all-repos."
                      : "One repository.",
                  runnerInventory: fleet.runnerType,
                  groupBy: fleet.groupBy,
                  summary: fleet.summary
                      ? {
                            window: fleet.summary.window,
                            registeredRunners: fleet.summary.runners,
                            online: fleet.summary.online,
                            busy: fleet.summary.busy,
                            cordoned: fleet.summary.cordoned,
                            runs: fleet.summary.runs,
                            selfHostedJobs: fleet.summary.jobs,
                            hostedJobs: fleet.summary.hostedJobs,
                            waitP50Seconds: seconds(fleet.summary.waitP50Ms),
                            waitP95Seconds: seconds(fleet.summary.waitP95Ms),
                            durationP50Seconds: seconds(fleet.summary.durationP50Ms),
                            durationP95Seconds: seconds(fleet.summary.durationP95Ms),
                            busyTimeSeconds: seconds(fleet.summary.busyTimeMs),
                            utilization: round(fleet.summary.utilization, 4),
                            failureRate: round(fleet.summary.failureRate, 4),
                            peakConcurrency: fleet.summary.peakConcurrency,
                            truncated: fleet.summary.truncated,
                        }
                      : null,
                  runners: head(
                      fleet.runners.map((row) => ({
                          key: row.key,
                          kind: row.kind,
                          status: row.status,
                          cordoned: row.cordoned,
                          jobs: row.jobs,
                          busyTimeSeconds: seconds(row.busyTimeMs),
                          utilization: round(row.utilization, 4),
                          failureRate: round(row.failureRate, 4),
                          waitP50Seconds: seconds(row.waitP50Ms),
                          durationP50Seconds: seconds(row.durationP50Ms),
                          durationP95Seconds: seconds(row.durationP95Ms),
                          lastJobAt: row.lastJobAt,
                      })),
                  ),
                  queue: head(
                      fleet.queue.map((row) => ({
                          labels: row.labels,
                          kind: row.kind,
                          jobs: row.jobs,
                          waitP50Seconds: seconds(row.waitP50Ms),
                          waitP95Seconds: seconds(row.waitP95Ms),
                          waitMaxSeconds: seconds(row.waitMaxMs),
                          runners: row.runners,
                          peakConcurrency: row.peakConcurrency,
                          saturation: round(row.saturation, 3),
                      })),
                  ),
                  concurrency: {
                      bucket: fleet.bucket,
                      buckets: fleet.concurrency.length,
                      labelFilter: fleet.labelFilter ?? [],
                      // The whole timeline is returned: trimming it to `limit`
                      // would hide exactly the peaks this report exists for.
                      timeline: fleet.concurrency.map((row) => ({
                          start: row.start,
                          end: row.end,
                          jobs: row.jobs,
                          peak: row.peak,
                          runners: row.runners,
                          busyTimeSeconds: seconds(row.busyTimeMs),
                          utilization: round(row.utilization, 4),
                      })),
                  },
                  labels: head(
                      fleet.labels.map((row) => ({
                          label: row.label,
                          status: row.status,
                          jobs: row.jobs,
                          runners: row.runners,
                          waitP50Seconds: seconds(row.waitP50Ms),
                          waitP95Seconds: seconds(row.waitP95Ms),
                          lastJobAt: row.lastJobAt,
                      })),
                  ),
                  workflows: {
                      selfHostedOnly: fleet.selfHostedOnly,
                      rows: head(
                          fleet.workflows.map((row) => ({
                              workflow: row.workflow,
                              repository: row.repository || undefined,
                              runs: row.runs,
                              jobs: row.jobs,
                              // `decided` is the denominator of failureRate and
                              // is not `jobs`: cancelled and skipped jobs reach
                              // no verdict. At zero there is no rate to read.
                              failed: row.failed ?? undefined,
                              decided: row.decided ?? undefined,
                              failureRate: row.decided === 0 ? null : round(row.failureRate, 4),
                              retryRate: round(row.retryRate, 4),
                              waitP50Seconds: seconds(row.waitP50Ms),
                              durationP50Seconds: seconds(row.durationP50Ms),
                              durationP95Seconds: seconds(row.durationP95Ms),
                              busyTimeSeconds: seconds(row.busyTimeMs),
                              lastJobAt: row.lastJobAt,
                          })),
                      ),
                  },
                  // Always self-hosted: `gh runner-kit metrics repository` has
                  // no runner-type switch, so `runs` counts the runs that put
                  // at least one job on a self-hosted runner.
                  repositories:
                      fleet.repositories === null
                          ? {
                                available: false,
                                reason: "The per-repository report is only collected for an organization target.",
                            }
                          : head(
                                fleet.repositories.map((row) => ({
                                    repository: row.repository,
                                    selfHostedRuns: row.runs,
                                    selfHostedJobs: row.jobs,
                                    failed: row.failed,
                                    decided: row.decided,
                                    failureRate: row.decided === 0 ? null : round(row.failureRate, 4),
                                    retryRate: round(row.retryRate, 4),
                                    busyTimeSeconds: seconds(row.busyTimeMs),
                                    lastJobAt: row.lastJobAt,
                                })),
                            ),
                  capacity: {
                      targetWait: fleet.targetWait,
                      targetUtilization: fleet.targetUtilization,
                      model: "M/M/c queue; it assumes jobs arrive independently, so compare estimatedWait against observedWaitP95 before acting on delta.",
                      rows: head(
                          fleet.capacity.map((row) => ({
                              labels: row.labels,
                              jobs: row.jobs,
                              arrivalPerHour: round(row.arrivalPerHour, 3),
                              avgDurationSeconds: seconds(row.avgDurationMs),
                              loadErlangs: round(row.load, 3),
                              runners: row.runners,
                              recommended: row.recommended,
                              delta: row.delta,
                              observedWaitP95Seconds: seconds(row.observedWaitP95Ms),
                              estimatedWaitSeconds: seconds(row.estimatedWaitMs),
                          })),
                      ),
                  },
                  cost: fleet.billable
                      ? {
                            requested: true,
                            totalBillableMinutes: Math.round(
                                fleet.cost.reduce((sum, row) => sum + (row.billableMs ?? 0), 0) / 60000,
                            ),
                            totalCost: round(fleet.cost.reduce((sum, row) => sum + (row.cost ?? 0), 0)),
                            note: "GitHub bills only the jobs it hosted, and public repositories run for free, so a zero here is also what moving this work to self-hosted runners would avoid.",
                            rows: fleet.cost.map((row) => ({
                                os: row.os,
                                runs: row.runs,
                                jobs: row.jobs,
                                billableMinutes: Math.round((row.billableMs ?? 0) / 60000),
                                ratePerMinute: row.rate,
                                cost: round(row.cost),
                            })),
                        }
                      : {
                            requested: false,
                            reason: "Billable time is opt-in because gh runner-kit metrics cost spends one extra API request per run. Set the billable filter to collect it.",
                        },
              }
            : { available: false, reason: fleet?.reason ?? "gh runner-kit metrics was not run" },
    };

    return {
        target: formatTarget(meta.target),
        scope: meta.scope,
        window: meta.filters,
        collectedAt: meta.collectedAt,
        jobCoverageRuns: meta.jobCoverageRuns,
        warnings: meta.warnings,
        costEstimateNote:
            "Cost is estimated from job durations at GitHub-hosted list prices; included free minutes and larger-runner surcharges are not modelled.",
        ...(section === "all" ? sections : { [section]: sections[section] }),
    };
}

const canvas = createCanvas({
    id: "actions-metrics",
    displayName: "Actions metrics",
    description:
        "Dashboard for analysing the GitHub Actions metrics of one repository or of a whole organization: workflow reliability and retry rate, self-hosted runner utilisation, queue saturation, concurrency over time, label supply/demand and recommended pool sizes reported by gh runner-kit, plus billable usage and cost.",
    // One schema for the canvas input and for `set_filters` alike, so a
    // setting can never be reachable from one and not the other.
    inputSchema: querySchema,
    actions: [
        {
            name: "refresh",
            description: "Re-collect the metrics shown in the dashboard and return a summary of the refreshed data.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            handler: async (ctx) => {
                const { instance } = panelFor(ctx.instanceId);
                await instance.apply({ force: true, bypassCache: true });
                return summarize(requireMetrics(await settled(instance)));
            },
        },
        {
            name: "set_filters",
            description:
                "Change what the dashboard analyses - the repository or organization, the analysis window, the filters, the collection limits or the projection settings - and re-collect the metrics. Every field is optional and an omitted one keeps its current value.",
            // Literally the canvas's own schema: a field settable when the
            // panel is opened is settable afterwards, by construction.
            inputSchema: querySchema,
            handler: async (ctx) => {
                const { instance } = panelFor(ctx.instanceId);
                try {
                    await instance.apply({ patch: ctx.input ?? {} });
                } catch (error) {
                    // `apply` validates the patched query; a rejected one is
                    // reported under the validator's own code rather than as a
                    // generic failure.
                    throw error?.code ? new CanvasError(error.code, error.message) : error;
                }
                const state = await settled(instance);
                return { target: state.key, scope: state.scope, filters: state.filters, summary: summarize(requireMetrics(state)) };
            },
        },
        {
            name: "export_metrics",
            description:
                "Publish the metrics of the current window through `gh runner-kit metrics export`, as a Prometheus text exposition or as JSON, so they can be written to a file or pushed to a monitoring system.",
            inputSchema: {
                type: "object",
                properties: {
                    format: {
                        type: "string",
                        enum: ["prometheus", "json"],
                        description: "Output format. Defaults to prometheus.",
                    },
                },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const { instance } = panelFor(ctx.instanceId);
                let result;
                try {
                    result = await instance.export(ctx.input?.format ?? "prometheus");
                } catch (error) {
                    throw new CanvasError("export_failed", error?.message ?? String(error));
                }
                return {
                    target: instance.key,
                    scope: scopeOf(instance.effectiveQuery),
                    window: instance.effectiveFilters,
                    format: result.format,
                    contentType: result.contentType,
                    suggestedFilename: result.filename,
                    body: result.body,
                };
            },
        },
        {
            name: "trace_runner",
            description:
                "Rebuild the concurrency timeline from the jobs of the runners whose name matches a query, using `gh runner-kit metrics jobs`, and draw a per-runner busy heatmap from it. Answers how busy one runner, or one family of runners, was over time - which the aggregate reports cannot, because they are either bucket-level or window-level. Exactly one of `query`, `all` or `clear` per call; `exclude` is not one of them and narrows whichever of the first two runs.",
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Runner name to match. A plain word matches any runner whose name contains it; a query carrying a `*` is used as a wildcard pattern.",
                    },
                    workflow: {
                        type: "string",
                        description:
                            "Narrow the projection to one workflow, for this chart only, without re-running the other reports. Omit to inherit the workflow the dashboard filter carries; pass `*` to ignore it.",
                    },
                    all: {
                        type: "boolean",
                        description:
                            "Project every runner in the window instead of a pattern. This reads every job row the window holds, so it is the expensive path and is capped at 400000 rows.",
                    },
                    exclude: {
                        type: "string",
                        maxLength: 2000,
                        description:
                            "Comma-separated runner patterns to leave out, written like `query`: a plain word matches anywhere in the name, `*` is a wildcard, matching is case-sensitive, and at most 32 patterns are accepted. Passed to `gh runner-kit metrics jobs --exclude-runner`, so the rows are dropped before the stream is written and do not count against the row cap. A bare `*` also drops the jobs whose runner the API did not name. Needs `query` or `all` alongside it; an exclusion is not a request on its own.",
                    },
                    clear: {
                        type: "boolean",
                        description: "Drop the projection and restore the fleet-wide chart.",
                    },
                },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const { instance } = panelFor(ctx.instanceId);
                await settled(instance);
                let state;
                try {
                    state = await instance.project({
                        query: ctx.input?.query ?? "",
                        workflow: ctx.input?.workflow ?? "",
                        exclude: ctx.input?.exclude ?? "",
                        all: Boolean(ctx.input?.all),
                        clear: Boolean(ctx.input?.clear),
                    });
                } catch (error) {
                    throw new CanvasError("timeline_invalid", error?.message ?? String(error));
                }
                if (state.timelineStatus === "error") {
                    throw new CanvasError("timeline_failed", state.timelineError ?? "The runner timeline could not be built.");
                }
                const timeline = state.timeline;
                if (!timeline) {
                    return { target: state.key, query: "", cleared: true };
                }
                return {
                    target: state.key,
                    scope: state.scope,
                    query: timeline.query,
                    pattern: timeline.pattern || "(every runner)",
                    workflow: timeline.workflow,
                    observedRunners: timeline.runnerCount,
                    matchedJobs: timeline.matched,
                    busyTimeMs: timeline.busyTimeMs,
                    // The same jobs with per-runner overlaps merged, which is
                    // the smaller and usually the wanted number.
                    mergedBusyTimeMs: timeline.runnerBusyTimeMs,
                    // Null when gh runner-kit did the excluding: those rows were
                    // never written to the stream, so there is nothing to count.
                    excludedJobs: timeline.excluded,
                    exclusions: timeline.exclusions,
                    // Where the exclusion ran: "cli", "local" on an older
                    // gh runner-kit, or null when nothing was excluded.
                    excludeMode: timeline.excludeMode,
                    skippedUnfinishedJobs: timeline.unfinished,
                    skippedZeroDurationJobs: timeline.zeroDuration,
                    // Jobs the API reported as finishing before they started.
                    skippedInvalidJobs: timeline.negativeDuration,
                    // The row cap stopped the stream, so the ranking below is
                    // drawn from a part of the window only.
                    truncated: timeline.truncated,
                    notShown: timeline.remainder,
                    // `busyMs` merges the jobs that overlapped on one runner,
                    // `jobMs` is their plain sum; the heatmap draws the former.
                    runners: timeline.runners.map((runner) => ({
                        runner: runner.runner,
                        jobs: runner.jobs,
                        busyMs: runner.busyMs,
                        jobMs: runner.jobMs,
                        unidentified: runner.unidentified,
                    })),
                    buckets: timeline.buckets.map((bucket) => ({
                        start: bucket.start,
                        end: bucket.end,
                        jobs: bucket.jobs,
                        peak: bucket.peak,
                        busyTimeMs: bucket.busyTimeMs,
                    })),
                };
            },
        },
        {
            name: "get_metrics",
            description:
                "Read the metrics currently shown in the dashboard as structured JSON so they can be analysed, compared or summarised in chat.",
            inputSchema: {
                type: "object",
                properties: {
                    section: {
                        type: "string",
                        enum: ["overview", "runners", "usage", "fleet", "all"],
                        description:
                            "Which part of the dashboard to return. `fleet` returns the self-hosted numbers computed by gh runner-kit, including the recommended pool sizes. Defaults to all.",
                    },
                    limit: {
                        type: "integer",
                        minimum: 1,
                        maximum: 100,
                        description: "Maximum number of rows per ranked table. Defaults to 10.",
                    },
                },
                additionalProperties: false,
            },
            handler: async (ctx) => {
                const { instance } = panelFor(ctx.instanceId);
                let state = await settled(instance);
                if (!state.metrics && state.status !== "error") {
                    await instance.apply({});
                    state = await settled(instance);
                }
                return summarize(requireMetrics(state), ctx.input?.section ?? "all", ctx.input?.limit ?? 10);
            },
        },
    ],
    open: async (ctx) => {
        let panel = panels.get(ctx.instanceId);
        if (!panel) {
            const query = await resolveQuery(ctx.input);
            const instance = new DashboardInstance({ instanceId: ctx.instanceId, store: getStore(), query });
            const { server, url } = await startInstanceServer(instance);
            panel = { instance, server, url };
            panels.set(ctx.instanceId, panel);
            // Warm the panel up; the iframe streams progress over SSE.
            void instance
                .apply({ force: false })
                .catch((error) => log(`initial collection failed: ${error?.message ?? error}`, "warning"));
        } else if (ctx.input && Object.keys(ctx.input).length > 0) {
            // Patched onto the query in force rather than resolved from
            // scratch: a re-open that names only a window must not reset the
            // target the panel is already showing.
            const query = await resolveQuery(ctx.input, panel.instance.effectiveQuery);
            void panel.instance
                .apply({ patch: query })
                .catch((error) => log(`re-open collection failed: ${error?.message ?? error}`, "warning"));
        }
        const query = panel.instance.effectiveQuery;
        return {
            title: `Actions metrics · ${panel.instance.key}${scopeOf(query) === "org" ? " (org)" : ""}`,
            status: `Last ${query.days} days`,
            url: panel.url,
        };
    },
    onClose: async (ctx) => {
        const panel = panels.get(ctx.instanceId);
        if (!panel) {
            return;
        }
        panels.delete(ctx.instanceId);
        panel.instance.dispose();
        await new Promise((resolve) => panel.server.close(() => resolve()));
    },
});

session = await joinSession({ canvases: [canvas] });
