// Pure aggregation layer: turns the raw payloads from collect.mjs into the
// numbers the dashboard renders and the agent analyses. No I/O here.

/** Per-minute list price for GitHub-hosted standard runners (USD). */
export const COST_RATES = { UBUNTU: 0.008, WINDOWS: 0.016, MACOS: 0.08 };

const CONCLUSION_ORDER = [
    "success",
    "failure",
    "cancelled",
    "timed_out",
    "startup_failure",
    "action_required",
    "neutral",
    "skipped",
];

function toMs(value) {
    if (!value) {
        return null;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : null;
}

function diff(from, to) {
    const start = toMs(from);
    const end = toMs(to);
    if (start === null || end === null) {
        return null;
    }
    const delta = end - start;
    return delta >= 0 ? delta : null;
}

function percentile(values, p) {
    if (values.length === 0) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const rank = (p / 100) * (sorted.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) {
        return sorted[low];
    }
    return sorted[low] + (sorted[high] - sorted[low]) * (rank - low);
}

function stats(values) {
    const clean = values.filter((value) => Number.isFinite(value));
    if (clean.length === 0) {
        return { count: 0, avg: null, p50: null, p90: null, p95: null, max: null, total: 0 };
    }
    const total = clean.reduce((sum, value) => sum + value, 0);
    return {
        count: clean.length,
        avg: total / clean.length,
        p50: percentile(clean, 50),
        p90: percentile(clean, 90),
        p95: percentile(clean, 95),
        max: Math.max(...clean),
        total,
    };
}

function countBy(items, keyOf) {
    const map = new Map();
    for (const item of items) {
        const key = keyOf(item);
        if (key === null || key === undefined) {
            continue;
        }
        map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
}

function groupBy(items, keyOf) {
    const map = new Map();
    for (const item of items) {
        const key = keyOf(item);
        if (key === null || key === undefined) {
            continue;
        }
        const bucket = map.get(key);
        if (bucket) {
            bucket.push(item);
        } else {
            map.set(key, [item]);
        }
    }
    return map;
}

function dayKey(value) {
    const time = toMs(value);
    return time === null ? null : new Date(time).toISOString().slice(0, 10);
}

/** Infer the runner class of a job from its requested labels and runner group. */
export function classifyJob(job, selfHostedNames) {
    const labels = (job.labels ?? []).map((label) => String(label).toLowerCase());
    const group = String(job.runner_group_name ?? "");
    const selfHosted =
        labels.includes("self-hosted") ||
        (job.runner_name && selfHostedNames.has(job.runner_name)) ||
        (group !== "" && group !== "GitHub Actions");

    let os = "UBUNTU";
    if (labels.some((label) => label.startsWith("windows"))) {
        os = "WINDOWS";
    } else if (labels.some((label) => label.startsWith("macos") || label.startsWith("mac-"))) {
        os = "MACOS";
    } else if (labels.some((label) => label.startsWith("ubuntu") || label === "linux")) {
        os = "UBUNTU";
    } else if (selfHosted) {
        os = "UNKNOWN";
    }

    const sorted = labels.slice().sort();
    return {
        selfHosted: Boolean(selfHosted),
        os,
        // The sorted label list, kept so grouping and matching can work off the
        // structure rather than a display string that a label may contain.
        labelList: sorted,
        // A collision-free key: a separator inside a custom label cannot forge
        // the boundary between two labels, the same way labelSetKey does in the
        // Go reports. Two distinct label sets never share a key.
        labelKey: labelSetKey(sorted),
        labelSet: sorted.join(", ") || "(none)",
    };
}

/** Encode a label set so a separator inside one label cannot collide with the boundary between labels. */
function labelSetKey(labels) {
    return labels.map((label) => `${label.length}:${label}`).join("");
}

function billableMinutes(durationMs) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
        return 0;
    }
    // GitHub rounds each job up to the next whole minute.
    return Math.max(1, Math.ceil(durationMs / 60000));
}

function decorateJobs(jobs, selfHostedNames) {
    return jobs.map((job) => {
        const classification = classifyJob(job, selfHostedNames);
        const queueMs = diff(job.created_at, job.started_at);
        const durationMs = diff(job.started_at, job.completed_at);
        return {
            raw: job,
            name: job.name,
            workflow: job.workflow_name ?? job.__run?.name ?? "(unknown)",
            conclusion: job.conclusion,
            runnerName: job.runner_name ?? null,
            queueMs,
            durationMs,
            minutes: billableMinutes(durationMs),
            ...classification,
        };
    });
}

/** Identify a run attempt across repositories. */
function runKey(run) {
    return `${run.repository ?? ""}\u0000${run.id}\u0000${run.run_attempt ?? 1}`;
}

/**
 * Identify a workflow across repositories.
 *
 * Two repositories routinely share a workflow name - `ci` is the common case -
 * so an organization-wide view has to key on the repository first. The path
 * identifies the file inside its repository; the name is only the display label
 * and changes whenever someone edits `name:`.
 */
function workflowKey(run) {
    return `${run.repository ?? ""}\u0000${run.workflowPath || run.name || "(unnamed)"}`;
}

/**
 * The wall-clock end of every run, measured from the jobs it ran.
 *
 * `updated_at` is deliberately not used. GitHub keeps touching it after a run
 * has finished - re-running a job, a check-suite update, a deployment status -
 * so `updated_at - run_started_at` overstates the duration by an unbounded
 * amount. `gh runner-kit metrics runs` refuses to report a duration for exactly
 * that reason, and the last job to finish is the run's real end.
 *
 * Runs whose jobs were not collected get no duration rather than a wrong one.
 */
function runEndTimes(jobs) {
    const ends = new Map();
    for (const job of jobs) {
        const run = job.raw?.__run;
        const end = Date.parse(job.raw?.completed_at ?? "");
        if (!run || !Number.isFinite(end)) {
            continue;
        }
        const key = runKey(run);
        const previous = ends.get(key);
        if (previous === undefined || end > previous) {
            ends.set(key, end);
        }
    }
    return ends;
}

function overviewMetrics(runs, jobs) {
    const completed = runs.filter((run) => run.status === "completed");
    const conclusions = countBy(completed, (run) => run.conclusion ?? "unknown");
    const successCount = conclusions.get("success") ?? 0;

    const ends = runEndTimes(jobs);
    const runDuration = (run) => {
        // Only a finished run has a duration. An in-progress run whose first
        // job has already completed would otherwise contribute the elapsed time
        // so far and drag every percentile down.
        if (run.status !== "completed") {
            return NaN;
        }
        const end = ends.get(runKey(run));
        const start = Date.parse(run.run_started_at ?? run.created_at ?? "");
        return Number.isFinite(end) && Number.isFinite(start) && end >= start ? end - start : NaN;
    };

    const durations = runs.map(runDuration);
    const runQueues = runs.map((run) => diff(run.created_at, run.run_started_at));
    const jobQueues = jobs.map((job) => job.queueMs);

    const daily = [...groupBy(runs, (run) => dayKey(run.created_at)).entries()]
        .map(([date, dayRuns]) => {
            const dayConclusions = countBy(dayRuns, (run) => run.conclusion ?? "running");
            return {
                date,
                total: dayRuns.length,
                success: dayConclusions.get("success") ?? 0,
                failure: dayConclusions.get("failure") ?? 0,
                cancelled: dayConclusions.get("cancelled") ?? 0,
                other:
                    dayRuns.length -
                    (dayConclusions.get("success") ?? 0) -
                    (dayConclusions.get("failure") ?? 0) -
                    (dayConclusions.get("cancelled") ?? 0),
                p50DurationMs: percentile(dayRuns.map(runDuration).filter(Number.isFinite), 50),
            };
        })
        .sort((a, b) => a.date.localeCompare(b.date));

    const byWorkflow = [...groupBy(runs, workflowKey).entries()]
        .map(([, workflowRuns]) => {
            const done = workflowRuns.filter((run) => run.status === "completed");
            const failures = done.filter((run) => run.conclusion === "failure").length;
            const workflowDurations = workflowRuns.map(runDuration).filter(Number.isFinite);
            return {
                name: workflowRuns[0].name ?? "(unnamed)",
                repository: workflowRuns[0].repository ?? "",
                workflowPath: workflowRuns[0].workflowPath ?? "",
                runs: workflowRuns.length,
                failures,
                successRate: done.length > 0 ? done.filter((run) => run.conclusion === "success").length / done.length : null,
                p50DurationMs: percentile(workflowDurations, 50),
                p95DurationMs: percentile(workflowDurations, 95),
                totalDurationMs: workflowDurations.reduce((sum, value) => sum + value, 0),
            };
        })
        .sort((a, b) => b.runs - a.runs);

    const byJob = [...groupBy(jobs, (job) => `${job.raw?.__run?.repository ?? ""}\u0000${job.workflow} / ${job.name}`).entries()]
        .map(([, jobGroup]) => {
            const done = jobGroup.filter((job) => job.conclusion && job.conclusion !== "skipped");
            const failures = done.filter((job) => job.conclusion === "failure").length;
            return {
                name: `${jobGroup[0].workflow} / ${jobGroup[0].name}`,
                repository: jobGroup[0].raw?.__run?.repository ?? "",
                runs: jobGroup.length,
                failures,
                failureRate: done.length > 0 ? failures / done.length : null,
                p50DurationMs: percentile(jobGroup.map((job) => job.durationMs).filter(Number.isFinite), 50),
                p95DurationMs: percentile(jobGroup.map((job) => job.durationMs).filter(Number.isFinite), 95),
                p50QueueMs: percentile(jobGroup.map((job) => job.queueMs).filter(Number.isFinite), 50),
            };
        })
        .sort((a, b) => b.failures - a.failures || b.runs - a.runs);

    const byEvent = [...groupBy(runs, (run) => run.event ?? "(unknown)").entries()]
        .map(([event, eventRuns]) => {
            const done = eventRuns.filter((run) => run.status === "completed");
            return {
                event,
                runs: eventRuns.length,
                successRate: done.length > 0 ? done.filter((run) => run.conclusion === "success").length / done.length : null,
            };
        })
        .sort((a, b) => b.runs - a.runs);

    const slowest = runs
        .map((run) => ({
            name: run.name ?? "(unnamed)",
            repository: run.repository ?? "",
            runNumber: run.run_number,
            branch: run.head_branch,
            conclusion: run.conclusion ?? run.status,
            durationMs: runDuration(run),
            url: run.html_url,
        }))
        .filter((run) => Number.isFinite(run.durationMs))
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 10);

    return {
        totals: {
            runs: runs.length,
            completedRuns: completed.length,
            inProgressRuns: runs.length - completed.length,
            jobs: jobs.length,
            retriedRuns: runs.filter((run) => (run.run_attempt ?? 1) > 1).length,
        },
        conclusions: CONCLUSION_ORDER.filter((key) => conclusions.has(key)).map((key) => ({
            conclusion: key,
            count: conclusions.get(key),
        })),
        successRate: completed.length > 0 ? successCount / completed.length : null,
        duration: stats(durations),
        runQueue: stats(runQueues),
        jobQueue: stats(jobQueues),
        daily,
        byWorkflow,
        byJob: byJob.slice(0, 25),
        byEvent,
        slowest,
    };
}

function runnerMetrics(runners, jobs) {
    const registered = runners.map((runner) => {
        const labels = (runner.labels ?? []).map((label) => label.name ?? String(label));
        const cordonedGroup = labels.find((label) => label.startsWith("cordoned-group-"));
        return {
            id: runner.id,
            name: runner.name,
            os: runner.os,
            status: runner.status,
            busy: Boolean(runner.busy),
            scope: runner.scope,
            labels,
            cordoned: labels.includes("cordoned"),
            cordonedFromGroup: cordonedGroup ? cordonedGroup.slice("cordoned-group-".length) : null,
        };
    });

    const summary = {
        total: registered.length,
        online: registered.filter((runner) => runner.status === "online").length,
        offline: registered.filter((runner) => runner.status !== "online").length,
        busy: registered.filter((runner) => runner.busy).length,
        idle: registered.filter((runner) => runner.status === "online" && !runner.busy).length,
        cordoned: registered.filter((runner) => runner.cordoned).length,
        repository: registered.filter((runner) => runner.scope === "repository").length,
        organization: registered.filter((runner) => runner.scope === "organization").length,
    };

    const labelCounts = new Map();
    for (const runner of registered) {
        for (const label of runner.labels) {
            labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
        }
    }
    const byLabel = [...labelCounts.entries()]
        .map(([label, count]) => ({ label, runners: count }))
        .sort((a, b) => b.runners - a.runners);

    const selfHostedJobs = jobs.filter((job) => job.selfHosted);
    const hostedJobs = jobs.filter((job) => !job.selfHosted);

    const demand = [...groupBy(jobs, (job) => job.labelKey).entries()]
        .map(([, group]) => ({
            labelSet: group[0].labelSet,
            selfHosted: group.some((job) => job.selfHosted),
            jobs: group.length,
            minutes: group.reduce((sum, job) => sum + job.minutes, 0),
            p50QueueMs: percentile(group.map((job) => job.queueMs).filter(Number.isFinite), 50),
            p95QueueMs: percentile(group.map((job) => job.queueMs).filter(Number.isFinite), 95),
            matchingRunners: registered.filter((runner) => {
                const runnerLabels = new Set(runner.labels.map((label) => label.toLowerCase()));
                return group[0].labelList.filter(Boolean).every((label) => runnerLabels.has(label));
            }).length,
        }))
        .sort((a, b) => b.jobs - a.jobs);

    // Only self-hosted runners have stable names worth ranking; GitHub-hosted
    // runner names are ephemeral per-job identifiers.
    const byRunner = [...groupBy(selfHostedJobs.filter((job) => job.runnerName), (job) => job.runnerName).entries()]
        .map(([name, group]) => ({
            runner: name,
            registered: registered.some((runner) => runner.name === name),
            jobs: group.length,
            minutes: group.reduce((sum, job) => sum + job.minutes, 0),
            failures: group.filter((job) => job.conclusion === "failure").length,
            p50DurationMs: percentile(group.map((job) => job.durationMs).filter(Number.isFinite), 50),
            p50QueueMs: percentile(group.map((job) => job.queueMs).filter(Number.isFinite), 50),
        }))
        .sort((a, b) => b.minutes - a.minutes);

    return {
        summary,
        registered: registered.sort((a, b) => a.name.localeCompare(b.name)),
        byLabel,
        demand,
        byRunner,
        split: {
            selfHosted: {
                jobs: selfHostedJobs.length,
                minutes: selfHostedJobs.reduce((sum, job) => sum + job.minutes, 0),
                p50QueueMs: percentile(selfHostedJobs.map((job) => job.queueMs).filter(Number.isFinite), 50),
                p95QueueMs: percentile(selfHostedJobs.map((job) => job.queueMs).filter(Number.isFinite), 95),
            },
            githubHosted: {
                jobs: hostedJobs.length,
                minutes: hostedJobs.reduce((sum, job) => sum + job.minutes, 0),
                p50QueueMs: percentile(hostedJobs.map((job) => job.queueMs).filter(Number.isFinite), 50),
                p95QueueMs: percentile(hostedJobs.map((job) => job.queueMs).filter(Number.isFinite), 95),
            },
        },
    };
}

function usageMetrics(jobs, timings) {
    const byOs = new Map();
    for (const job of jobs) {
        const key = job.selfHosted ? "SELF_HOSTED" : job.os;
        const bucket = byOs.get(key) ?? { runnerClass: key, jobs: 0, minutes: 0, cost: 0 };
        bucket.jobs += 1;
        bucket.minutes += job.minutes;
        bucket.cost += job.selfHosted ? 0 : job.minutes * (COST_RATES[job.os] ?? 0);
        byOs.set(key, bucket);
    }

    const byWorkflow = [...groupBy(jobs, (job) => job.workflow).entries()]
        .map(([name, group]) => ({
            name,
            jobs: group.length,
            minutes: group.reduce((sum, job) => sum + job.minutes, 0),
            selfHostedMinutes: group.filter((job) => job.selfHosted).reduce((sum, job) => sum + job.minutes, 0),
            cost: group.reduce((sum, job) => sum + (job.selfHosted ? 0 : job.minutes * (COST_RATES[job.os] ?? 0)), 0),
        }))
        .sort((a, b) => b.cost - a.cost || b.minutes - a.minutes);

    const reported = timings
        .map((timing) => {
            const perOs = Object.entries(timing.billable ?? {}).map(([os, value]) => ({
                os,
                minutes: Math.round((value?.total_ms ?? 0) / 60000),
            }));
            return {
                name: timing.name,
                perOs,
                totalMinutes: perOs.reduce((sum, entry) => sum + entry.minutes, 0),
                cost: perOs.reduce((sum, entry) => sum + entry.minutes * (COST_RATES[entry.os] ?? 0), 0),
            };
        })
        .filter((entry) => entry.totalMinutes > 0)
        .sort((a, b) => b.totalMinutes - a.totalMinutes);

    return {
        rates: COST_RATES,
        window: {
            byRunnerClass: [...byOs.values()].sort((a, b) => b.minutes - a.minutes),
            totalMinutes: jobs.reduce((sum, job) => sum + job.minutes, 0),
            billableMinutes: jobs.filter((job) => !job.selfHosted).reduce((sum, job) => sum + job.minutes, 0),
            selfHostedMinutes: jobs.filter((job) => job.selfHosted).reduce((sum, job) => sum + job.minutes, 0),
            estimatedCost: [...byOs.values()].reduce((sum, bucket) => sum + bucket.cost, 0),
            byWorkflow,
        },
        reported: {
            available: reported.length > 0,
            byWorkflow: reported,
            totalMinutes: reported.reduce((sum, entry) => sum + entry.totalMinutes, 0),
            estimatedCost: reported.reduce((sum, entry) => sum + entry.cost, 0),
        },
    };
}

/** Build the full metrics document rendered by the canvas and read by the agent. */
export function buildMetrics(snapshot) {
    const selfHostedNames = new Set((snapshot.runners ?? []).map((runner) => runner.name));
    const jobs = decorateJobs(snapshot.jobs ?? [], selfHostedNames);
    const runs = snapshot.runs ?? [];

    return {
        meta: {
            target: snapshot.target,
            scope: snapshot.target?.kind ?? "repo",
            filters: snapshot.filters,
            limits: snapshot.limits,
            collectedAt: snapshot.collectedAt,
            collectionMs: snapshot.durationMs,
            warnings: snapshot.warnings ?? [],
            // Whether the run collection actually ran. Without it a failed
            // `metrics runs` is indistinguishable from a window that genuinely
            // held no runs, and the dashboard would report a confident zero.
            runs: {
                available: snapshot.runsAvailable !== false,
                reason: snapshot.runsReason ?? null,
            },
            // How many runs the per-job cards actually describe: the runs that
            // really produced jobs, not the runs the collector aimed at.
            jobCoverageRuns: new Set(
                jobs.map((job) => (job.raw?.__run ? runKey(job.raw.__run) : null)).filter(Boolean),
            ).size,
        },
        overview: overviewMetrics(runs, jobs),
        runners: runnerMetrics(snapshot.runners ?? [], jobs),
        usage: usageMetrics(jobs, snapshot.timings ?? []),
        // Already normalized by lib/runnerkit.mjs; `gh runner-kit` owns these numbers.
        fleet: snapshot.fleet ?? null,
    };
}
