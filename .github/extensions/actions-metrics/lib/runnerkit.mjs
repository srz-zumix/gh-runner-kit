// Bridge to the `gh runner-kit metrics` command family.
//
// `gh runner-kit` computes the self-hosted fleet metrics natively - fleet
// summary, per-runner activity, per-label-set queue saturation, concurrency
// over time, label supply/demand, per-workflow reliability, pool sizing and
// billable time, for one repository or for every repository an organization
// owns - so the dashboard delegates to it instead of re-deriving those
// numbers in JavaScript. The extension stays usable without it: every call
// degrades into a warning and the JavaScript pipeline keeps rendering the rest
// of the dashboard.

import { ghRaw, GhError, formatTarget } from "./gh.mjs";

const NS_PER_MS = 1e6;

// The accepted values are declared in shared/fields.mjs so that the toolbar,
// which cannot import from lib/, offers exactly what the normalizer accepts.
import {
    BUCKET_KEYS,
    DEFAULT_TARGET_UTILIZATION,
    DEFAULT_TARGET_WAIT,
    GROUP_BY_KEYS,
    RUNNER_TYPE_KEYS,
    TARGET_WAIT_KEYS,
} from "../shared/fields.mjs";

export { BUCKET_KEYS, DEFAULT_TARGET_UTILIZATION, DEFAULT_TARGET_WAIT, GROUP_BY_KEYS, RUNNER_TYPE_KEYS, TARGET_WAIT_KEYS };

/** Formats `gh runner-kit metrics export` can publish. */
export const EXPORT_FORMATS = ["prometheus", "json"];

/** Widen the bucket with the window so a chart never grows past ~200 columns. */
export function resolveBucket(days, bucket) {
    if (bucket && bucket !== "auto" && BUCKET_KEYS.includes(bucket)) {
        return bucket;
    }
    const window = Number.isFinite(days) ? days : 7;
    if (window <= 1) return "15m";
    if (window <= 3) return "30m";
    if (window <= 7) return "1h";
    if (window <= 21) return "3h";
    if (window <= 45) return "6h";
    if (window <= 90) return "12h";
    return "24h";
}

let probeOnce = null;

function toMs(nanoseconds) {
    return Number.isFinite(nanoseconds) ? nanoseconds / NS_PER_MS : null;
}

/** Go marshals a zero time.Time as year 1; treat it as "never". */
function toTimestamp(value) {
    if (!value || typeof value !== "string") {
        return null;
    }
    return value.startsWith("0001-01-01") ? null : value;
}

function describe(error) {
    if (error instanceof GhError) {
        return error.status && !error.message.includes(`HTTP ${error.status}`)
            ? `${error.message} (HTTP ${error.status})`
            : error.message;
    }
    return error?.message ?? String(error);
}

/**
 * Restate the errors whose CLI wording does not say what to do about them.
 *
 * The include filter is the one that actually strands a panel: it is applied
 * before collection, so a pattern that matches nothing is a hard failure with
 * no rows rather than an empty result, and the CLI reports it in terms of the
 * flag rather than of the filter field the panel shows.
 */
function explain(reason, target) {
    if (/no repositories matched include filter/i.test(reason)) {
        const owner = target?.owner ? ` of ${target.owner}` : "";
        return `no repository${owner} matched the include filter, so nothing was collected. Clear it or widen it in Settings.`;
    }
    return reason;
}

/** Pull the command names out of the "Available Commands:" block of a cobra help text. */
function parseSubcommands(help) {
    const names = new Set();
    let inBlock = false;
    for (const line of String(help ?? "").split(/\r?\n/)) {
        if (/^Available Commands:/.test(line)) {
            inBlock = true;
            continue;
        }
        if (!inBlock) {
            continue;
        }
        if (line.trim() === "") {
            break;
        }
        // Cobra pads the column to the longest command name, so the longest one
        // is followed by a single space - matching on two would drop it.
        const match = /^\s{2,}([a-z][\w-]*)\s+\S/.exec(line);
        if (match) {
            names.add(match[1]);
        }
    }
    return names;
}

/**
 * Detect whether `gh runner-kit metrics` is installed. Cached for the lifetime
 * of the extension process because installing an extension mid-session is rare
 * and a reload re-runs the probe anyway.
 */
export async function probeRunnerKit(cwd) {
    if (!probeOnce) {
        probeOnce = (async () => {
            let help;
            try {
                help = await ghRaw(["runner-kit", "metrics", "--help"], { cwd });
            } catch (error) {
                return {
                    available: false,
                    version: null,
                    subcommands: new Set(),
                    flags: new Set(),
                    reason: `gh runner-kit metrics is unavailable: ${describe(error)}`,
                };
            }
            let version = null;
            try {
                version = (await ghRaw(["runner-kit", "--version"], { cwd })).trim() || null;
            } catch {
                // The version banner is cosmetic.
            }
            const subcommands = parseSubcommands(help);
            // The repository filters live on each subcommand rather than on the
            // `metrics` parent, so the flag set is read off one representative
            // subcommand and applied to all of them. Passing a flag a older
            // build does not know would make cobra fail the whole call.
            let flags = new Set();
            try {
                flags = parseFlags(await ghRaw(["runner-kit", "metrics", "summary", "--help"], { cwd }));
            } catch {
                // An unreadable flag list only costs the optional filters.
            }
            return { available: true, version, subcommands, flags, reason: null };
        })();
    }
    return probeOnce;
}

/**
 * Select the scope of a metrics call. `--owner` alone is rejected by the CLI,
 * so an organization target always collects every repository it owns. `--owner`
 * takes a bare name, so a non-default host is carried in the environment the
 * same way the `gh` CLI itself reads it.
 */
function targetArgs(target) {
    if (target.kind === "org") {
        return { args: ["--owner", target.owner, "--all-repos"], env: hostEnv(target) };
    }
    return { args: ["--repo", formatTarget(target)], env: null };
}

function hostEnv(target) {
    return target.host && target.host !== "github.com" ? { GH_HOST: target.host } : null;
}

/**
 * Which repository filters the installed CLI accepts. An unprobed call is
 * assumed to be current, because the only caller without a probe is a test.
 */
function repoFilterSupport(probe) {
    return {
        include: !probe || Boolean(probe.flags?.has("--include-repo")),
        exclude: !probe || Boolean(probe.flags?.has("--exclude-repo")),
    };
}

/**
 * Report a repository filter the user asked for that cannot be honoured, so a
 * silently widened collection is never mistaken for a filtered one. An
 * organization-wide walk the user meant to narrow is both wrong and expensive.
 */
export function repoFilterWarnings(probe, filters, target) {
    const warnings = [];
    const include = filters?.includeRepos ?? [];
    const exclude = filters?.excludeRepos ?? [];
    if (include.length === 0 && exclude.length === 0) {
        return warnings;
    }
    if (target?.kind !== "org") {
        warnings.push(
            "The repository filters only apply to an organization target; they are ignored while a single repository is selected.",
        );
        return warnings;
    }
    const support = repoFilterSupport(probe);
    if ((include.length > 0 && !support.include) || (exclude.length > 0 && !support.exclude)) {
        warnings.push(
            "The installed gh runner-kit does not accept --include-repo/--exclude-repo, so the repository filters were ignored and every repository in the organization was collected. Upgrade it with `gh extension upgrade runner-kit`.",
        );
    }
    return warnings;
}

function baseArgs(subcommand, { target, filters, limits, force, probe }, format = "json") {
    const args = [
        "runner-kit",
        "metrics",
        subcommand,
        ...targetArgs(target).args,
        "--days",
        String(filters.days),
        "--format",
        format,
    ];
    if (filters.runnerType && filters.runnerType !== "auto") {
        args.push("--type", filters.runnerType);
    }
    if (filters.event) {
        args.push("--event", filters.event);
    }
    if (filters.branch) {
        args.push("--branch", filters.branch);
    }
    if (filters.workflow) {
        args.push("--workflow", filters.workflow);
    }
    // The repository filters are applied before collection, so they shrink the
    // API traffic rather than just the reported rows. They are skipped on a
    // build that predates them, where cobra would reject the unknown flag.
    // The repository filters are applied before collection, so they shrink the
    // API traffic rather than just the reported rows. They only make sense for
    // an organization: against `--repo` a non-matching pattern makes the CLI
    // exit with "no repositories matched include filter", which would break
    // every report the moment the user switched target without clearing them.
    if (target.kind === "org" && repoFilterSupport(probe).include) {
        for (const pattern of filters.includeRepos ?? []) {
            args.push("--include-repo", pattern);
        }
    }
    if (target.kind === "org" && repoFilterSupport(probe).exclude) {
        for (const pattern of filters.excludeRepos ?? []) {
            args.push("--exclude-repo", pattern);
        }
    }
    if (Number.isFinite(limits?.maxRuns)) {
        // 0 is the CLI's own spelling of "no limit", so it is passed through.
        args.push("--max-runs", String(Math.max(0, limits.maxRuns)));
    }
    if (Number.isFinite(limits?.jobConcurrency)) {
        args.push("--concurrency", String(limits.jobConcurrency));
    }
    if (force && subcommand !== "runs") {
        // Bypass the job cache `gh runner-kit` keeps between invocations.
        // `metrics runs` reads no jobs, so it has no --refresh to offer.
        args.push("--refresh");
    }
    return args;
}

async function runMetrics(subcommand, options, extraArgs = []) {
    const stdout = await ghRaw([...baseArgs(subcommand, options), ...extraArgs], {
        cwd: options.cwd,
        env: hostEnv(options.target),
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
}

function normalizeSummary(raw) {
    if (!raw) {
        return null;
    }
    return {
        window: { start: raw.Window?.Start ?? null, end: raw.Window?.End ?? null },
        repos: raw.Repos ?? 0,
        runners: raw.Runners ?? 0,
        online: raw.Online ?? 0,
        busy: raw.Busy ?? 0,
        cordoned: raw.Cordoned ?? 0,
        runs: raw.Runs ?? 0,
        jobs: raw.Jobs ?? 0,
        hostedJobs: raw.HostedJobs ?? 0,
        waitP50Ms: toMs(raw.WaitP50),
        waitP95Ms: toMs(raw.WaitP95),
        durationP50Ms: toMs(raw.DurationP50),
        durationP95Ms: toMs(raw.DurationP95),
        busyTimeMs: toMs(raw.BusyTime),
        utilization: raw.Utilization ?? 0,
        failureRate: raw.FailureRate ?? 0,
        peakConcurrency: raw.PeakConcurrency ?? 0,
        truncated: Boolean(raw.Truncated),
        // A count of repositories that hit `--max-runs`, not their names.
        truncatedRepos: raw.TruncatedRepos ?? 0,
        warnings: raw.Warnings ?? [],
    };
}

function normalizeRunnerRows(raw) {
    return (raw ?? []).map((row) => ({
        key: row.Key ?? "",
        kind: row.Kind ?? "",
        status: row.Status || null,
        cordoned: Boolean(row.Cordoned),
        jobs: row.Jobs ?? 0,
        busyTimeMs: toMs(row.BusyTime),
        utilization: row.Utilization ?? 0,
        failureRate: row.FailureRate ?? 0,
        waitP50Ms: toMs(row.WaitP50),
        durationP50Ms: toMs(row.DurationP50),
        durationP95Ms: toMs(row.DurationP95),
        lastJobAt: toTimestamp(row.LastJobAt),
    }));
}

function normalizeQueueRows(raw) {
    return (raw ?? []).map((row) => {
        const labels = row.Labels ?? [];
        return {
            labels,
            labelSet: labels.join(", "),
            kind: row.Kind ?? "",
            jobs: row.Jobs ?? 0,
            waitP50Ms: toMs(row.WaitP50),
            waitP95Ms: toMs(row.WaitP95),
            waitMaxMs: toMs(row.WaitMax),
            runners: row.Runners ?? 0,
            peakConcurrency: row.PeakConcurrency ?? 0,
            saturation: row.Saturation ?? 0,
        };
    });
}

function normalizeConcurrencyRows(raw) {
    return (raw ?? []).map((row) => ({
        start: toTimestamp(row.Start),
        end: toTimestamp(row.End),
        jobs: row.Jobs ?? 0,
        peak: row.Peak ?? 0,
        busyTimeMs: toMs(row.BusyTime),
        runners: row.Runners ?? 0,
        utilization: row.Utilization ?? 0,
    }));
}

function normalizeLabelRows(raw) {
    return (raw ?? []).map((row) => ({
        label: row.Label ?? "",
        status: row.Status ?? "",
        jobs: row.Jobs ?? 0,
        runners: row.Runners ?? 0,
        waitP50Ms: toMs(row.WaitP50),
        waitP95Ms: toMs(row.WaitP95),
        lastJobAt: toTimestamp(row.LastJobAt),
    }));
}

function normalizeWorkflowRows(raw) {
    return (raw ?? []).map((row) => ({
        // Reported per repository: the CLI keys a workflow by repository first,
        // so under an organization two repositories with a `ci` workflow stay
        // apart and the name alone no longer identifies the row.
        repository: row.Repository ?? "",
        workflow: row.Workflow ?? "",
        workflowPath: row.WorkflowPath ?? "",
        runs: row.Runs ?? 0,
        jobs: row.Jobs ?? 0,
        // `Decided` counts the jobs that reached a success/failure verdict, so
        // it is the denominator of FailureRate and is always <= `jobs`. A build
        // that predates these fields reports null, which renders as "no data"
        // rather than as a real zero.
        failed: row.Failed ?? null,
        decided: row.Decided ?? null,
        retried: row.Retried ?? null,
        failureRate: row.FailureRate ?? 0,
        retryRate: row.RetryRate ?? 0,
        waitP50Ms: toMs(row.WaitP50),
        durationP50Ms: toMs(row.DurationP50),
        durationP95Ms: toMs(row.DurationP95),
        busyTimeMs: toMs(row.BusyTime),
        lastJobAt: toTimestamp(row.LastJobAt),
    }));
}

/**
 * A workflow run as `gh runner-kit metrics runs` reports it.
 *
 * The keys keep the REST spelling the dashboard already aggregates on, so the
 * run pipeline stays the same shape whichever repository the row came from.
 * `RunRow` additionally carries the repository and the workflow path, which the
 * REST payload of a single repository never needed.
 */
function normalizeRunRows(raw) {
    return (raw ?? []).map((row) => ({
        repository: row.Repository ?? "",
        name: row.Workflow || "(unnamed)",
        workflowPath: row.WorkflowPath ?? "",
        workflowId: row.WorkflowID ?? null,
        id: row.RunID ?? null,
        run_number: row.RunNumber ?? null,
        run_attempt: row.RunAttempt ?? 1,
        event: row.Event ?? null,
        head_branch: row.Branch ?? null,
        head_sha: row.HeadSHA ?? null,
        status: row.Status ?? null,
        conclusion: row.Conclusion || null,
        created_at: toTimestamp(row.CreatedAt),
        run_started_at: toTimestamp(row.StartedAt),
        updated_at: toTimestamp(row.UpdatedAt),
        html_url: row.HTMLURL ?? null,
    }));
}

function normalizeRepositoryRows(raw) {
    return (raw ?? []).map((row) => ({
        repository: row.Repository ?? "",
        runs: row.Runs ?? 0,
        jobs: row.Jobs ?? 0,
        failed: row.Failed ?? 0,
        decided: row.Decided ?? 0,
        retried: row.Retried ?? 0,
        failureRate: row.FailureRate ?? 0,
        retryRate: row.RetryRate ?? 0,
        busyTimeMs: toMs(row.BusyTime),
        lastJobAt: toTimestamp(row.LastJobAt),
    }));
}

/**
 * Collect the workflow runs of the target through `gh runner-kit metrics runs`.
 *
 * This is the only run source the dashboard uses. Walking the REST API here
 * would re-window the data differently from every `gh runner-kit` report - the
 * CLI cuts the window at an exact instant while a hand-built `created>=` query
 * can only cut it at a date boundary - and would leave an organization target
 * with no runs at all, because fanning out over every repository it owns is
 * exactly the work the CLI already does.
 */
export async function collectRuns({ target, filters, limits, cwd, onProgress, warnings = [] } = {}) {
    const probe = await probeRunnerKit(cwd);
    const empty = { available: false, rows: [], reason: null };
    if (!probe.available) {
        return { ...empty, reason: probe.reason };
    }
    if (!probe.subcommands.has("runs")) {
        const reason = "gh runner-kit metrics runs is not available in the installed version";
        warnings.push(`${reason}; update the extension with \`gh extension upgrade runner-kit\` to see workflow runs.`);
        return { ...empty, reason };
    }
    onProgress?.("Running gh runner-kit metrics runs");
    try {
        // `runs` reads no jobs and no usage, so it neither fills nor consults
        // the job cache the other subcommands share; `force` has nothing to do.
        const rows = normalizeRunRows(await runMetrics("runs", { target, filters, limits, cwd, force: false, probe }));
        return { available: true, rows, reason: null };
    } catch (error) {
        const reason = explain(describe(error), target);
        warnings.push(`gh runner-kit workflow runs: ${reason}`);
        return { ...empty, reason };
    }
}

function normalizeCapacityRows(raw) {
    return (raw ?? []).map((row) => {
        const labels = row.Labels ?? [];
        return {
            labels,
            labelSet: labels.join(", "),
            jobs: row.Jobs ?? 0,
            arrivalPerHour: row.ArrivalPerHour ?? 0,
            avgDurationMs: toMs(row.AvgDuration),
            // Offered load in Erlangs: runners kept busy on average.
            load: row.Load ?? 0,
            runners: row.Runners ?? 0,
            recommended: row.Recommended ?? 0,
            delta: row.Delta ?? 0,
            observedWaitP95Ms: toMs(row.ObservedWaitP95),
            estimatedWaitMs: toMs(row.EstimatedWait),
        };
    });
}

function normalizeCostRows(raw) {
    return (raw ?? []).map((row) => ({
        os: row.OS ?? "",
        runs: row.Runs ?? 0,
        jobs: row.Jobs ?? 0,
        billableMs: toMs(row.Billable),
        rate: row.Rate ?? 0,
        cost: row.Cost ?? 0,
    }));
}

/**
 * Collect the self-hosted fleet metrics through `gh runner-kit`.
 *
 * The subcommands run sequentially on purpose: they share a local job cache, so
 * the first call pays for the API traffic and the other two read from the cache.
 */
export async function collectFleet({ target, filters, limits, cwd, force = false, onProgress, warnings = [] } = {}) {
    const probe = await probeRunnerKit(cwd);
    const shape = {
        scope: target.kind,
        groupBy: GROUP_BY_KEYS.includes(filters.groupBy) ? filters.groupBy : "name",
        bucket: resolveBucket(filters.days, filters.bucket),
        runnerType: RUNNER_TYPE_KEYS.includes(filters.runnerType) ? filters.runnerType : "auto",
        targetWait: TARGET_WAIT_KEYS.includes(filters.targetWait) ? filters.targetWait : DEFAULT_TARGET_WAIT,
        targetUtilization: filters.targetUtilization ?? DEFAULT_TARGET_UTILIZATION,
        selfHostedOnly: Boolean(filters.selfHostedOnly),
        billable: Boolean(filters.billable),
        labelFilter: Array.isArray(filters.labels) ? filters.labels : [],
        summary: null,
        runners: [],
        queue: [],
        concurrency: [],
        labels: [],
        workflows: [],
        // null until the report runs: an empty array is a real "no repository
        // placed a job on a self-hosted runner", which is a different answer
        // from "the report did not run".
        repositories: null,
        capacity: [],
        cost: [],
    };
    if (!probe.available) {
        warnings.push(`${probe.reason}. Install it with \`gh extension install srz-zumix/gh-runner-kit\` to enable the fleet metrics.`);
        return { available: false, reason: probe.reason, version: null, ...shape };
    }

    const options = { target, filters, limits, cwd, force, probe };
    const result = { available: true, reason: null, version: probe.version, ...shape };

    const steps = [
        {
            name: "summary",
            label: "fleet summary",
            run: async () => {
                result.summary = normalizeSummary(await runMetrics("summary", options));
            },
        },
        {
            name: "runner",
            label: "runner activity",
            run: async () => {
                result.runners = normalizeRunnerRows(await runMetrics("runner", options, ["--group-by", result.groupBy]));
            },
        },
        {
            name: "queue",
            label: "queue saturation",
            run: async () => {
                result.queue = normalizeQueueRows(await runMetrics("queue", options));
            },
        },
        {
            name: "concurrency",
            label: "concurrency timeline",
            run: async () => {
                // `--label` is the only runner-side filter the CLI offers, and
                // only `concurrency` accepts it: it keeps the jobs whose runs-on
                // set carries every given label, and counts only the runners
                // that can serve that set.
                const extra = ["--bucket", result.bucket];
                for (const label of result.labelFilter) {
                    extra.push("--label", label);
                }
                result.concurrency = normalizeConcurrencyRows(await runMetrics("concurrency", options, extra));
            },
        },
        {
            name: "label",
            label: "label supply and demand",
            run: async () => {
                result.labels = normalizeLabelRows(await runMetrics("label", options));
            },
        },
        {
            name: "workflow",
            label: "workflow reliability",
            run: async () => {
                const extra = result.selfHostedOnly ? ["--self-hosted-only"] : [];
                result.workflows = normalizeWorkflowRows(await runMetrics("workflow", options, extra));
            },
        },
        {
            name: "repository",
            label: "self-hosted activity per repository",
            // Only an organization spans more than one repository, so under a
            // single-repository target the report would restate the summary.
            skip: target.kind !== "org",
            run: async () => {
                result.repositories = normalizeRepositoryRows(await runMetrics("repository", options));
            },
        },
        {
            name: "capacity",
            label: "pool sizing",
            run: async () => {
                result.capacity = normalizeCapacityRows(
                    await runMetrics("capacity", options, [
                        "--target-wait",
                        result.targetWait,
                        "--target-utilization",
                        String(result.targetUtilization),
                    ]),
                );
            },
        },
        {
            name: "cost",
            label: "billable time",
            // Opt-in: unlike the other reports this one reads the usage of every
            // run, which costs one extra API request per run.
            skip: !result.billable,
            run: async () => {
                result.cost = normalizeCostRows(await runMetrics("cost", options));
            },
        },
    ];

    for (const step of steps) {
        if (step.skip) {
            continue;
        }
        if (!probe.subcommands.has(step.name)) {
            warnings.push(`gh runner-kit metrics ${step.name} is not available in the installed version.`);
            continue;
        }
        onProgress?.(`Running gh runner-kit metrics ${step.name}`);
        try {
            // Only the first call may bypass the cache; repeating --refresh
            // would make the other subcommands re-download the same jobs.
            await step.run();
            options.force = false;
        } catch (error) {
            warnings.push(`gh runner-kit ${step.label}: ${explain(describe(error), target)}`);
        }
    }

    // The CLI reports its own permission problems inside the summary payload.
    for (const warning of result.summary?.warnings ?? []) {
        warnings.push(`gh runner-kit: ${warning}`);
    }
    return result;
}

/**
 * Publish the fleet metrics through `gh runner-kit metrics export`.
 *
 * On demand only: the dashboard already renders the same numbers, so this runs
 * when the user asks for something to feed a monitoring system. `--summary` is
 * deliberately not exposed because it only works inside GitHub Actions.
 */
export async function exportFleet({ target, filters, limits, cwd, format = "prometheus" } = {}) {
    const probe = await probeRunnerKit(cwd);
    if (!probe.available) {
        throw new Error(`${probe.reason}. Install it with \`gh extension install srz-zumix/gh-runner-kit\`.`);
    }
    if (!probe.subcommands.has("export")) {
        throw new Error("gh runner-kit metrics export is not available in the installed version.");
    }
    const wanted = EXPORT_FORMATS.includes(format) ? format : "prometheus";
    // baseArgs always requests JSON, so the format flag is replaced rather than appended.
    const args = baseArgs("export", { target, filters, limits, force: false, probe });
    args[args.indexOf("--format") + 1] = wanted;
    const body = await ghRaw(args, { cwd, env: hostEnv(target) });
    return {
        format: wanted,
        contentType: wanted === "json" ? "application/json; charset=utf-8" : "text/plain; version=0.0.4; charset=utf-8",
        filename: `${formatTarget(target).replace(/[/.]/g, "-")}-metrics.${wanted === "json" ? "json" : "prom"}`,
        body,
    };
}

/**
 * Translate what the user typed in the runner field into a pattern
 * `gh runner-kit metrics jobs --runner` understands. The field has always
 * behaved as a substring search, so a plain word is widened into `*word*`;
 * a query that already carries a `*` is taken literally. The other glob
 * metacharacters are escaped, because a runner name holding a `[` must not
 * turn into a character class the user never asked for.
 */
export function runnerPattern(query) {
    const text = String(query ?? "").trim();
    if (text === "") {
        return "";
    }
    const escaped = text.replace(/[?\[\]\\]/g, "\\$&");
    return escaped.includes("*") ? escaped : `*${escaped}*`;
}

/**
 * The local equivalent of one runner pattern, for the paths that have to match
 * names in JavaScript rather than hand them to the CLI.
 *
 * It reads the pattern `runnerPattern` produced, so the two cannot drift: `*`
 * is the only wildcard, a backslash makes the next character literal, and
 * everything else stands for itself. `*` becomes `[^/]*` rather than `.*`
 * because Go's `path.Match` stops a wildcard at a separator, and a matcher that
 * was more generous than the CLI would drop rows the CLI would have kept.
 */
export function runnerPatternMatcher(pattern) {
    let source = "";
    const text = String(pattern ?? "");
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\\" && index + 1 < text.length) {
            index += 1;
            source += text[index].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            continue;
        }
        if (char === "*") {
            // A run of wildcards matches exactly what one does.
            while (text[index + 1] === "*") {
                index += 1;
            }
            source += "[^/]*";
            continue;
        }
        source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${source}$`);
}

/**
 * Command for one `gh runner-kit metrics jobs` run, as NDJSON so the caller can
 * consume it row by row. `--refresh` is deliberately never forwarded: this runs
 * after the reports that populate the job cache, and re-fetching the window a
 * second time would double the API cost for identical rows.
 */
export function jobRowsCommand({ target, filters, limits, pattern = "", exclusions = [], kind = "self-hosted", limit = 0, probe = null }) {
    const args = baseArgs("jobs", { target, filters, limits, force: false, probe }, "ndjson");
    args.push("--kind", kind);
    for (const label of Array.isArray(filters.labels) ? filters.labels : []) {
        args.push("--label", label);
    }
    if (pattern) {
        args.push("--runner", pattern);
    }
    // `--exclude-runner` wins over `--runner` when a name matches both, so the
    // two are passed together rather than resolved here.
    for (const exclusion of Array.isArray(exclusions) ? exclusions : []) {
        args.push("--exclude-runner", exclusion);
    }
    if (limit > 0) {
        args.push("--limit", String(limit));
    }
    return { args, env: hostEnv(target) };
}

/** Whether the installed `gh runner-kit` carries the `metrics jobs` subcommand. */
export async function hasJobRows(cwd) {
    const probe = await probeRunnerKit(cwd);
    return probe.available && probe.subcommands.has("jobs");
}

let jobsFlagsOnce = null;

/** Pull the flag names out of the "Flags:" blocks of a cobra help text. */
function parseFlags(help) {
    const names = new Set();
    for (const line of String(help ?? "").split(/\r?\n/)) {
        const match = /^\s{2,}(?:-\w,\s+)?(--[a-z][\w-]*)/.exec(line);
        if (match) {
            names.add(match[1]);
        }
    }
    return names;
}

/**
 * The flags the installed `gh runner-kit metrics jobs` accepts.
 *
 * Probed rather than assumed because the dashboard ships inside the CLI's
 * repository but the CLI is installed separately as a `gh` extension, so the
 * two versions drift. Memoized for the lifetime of the extension process, the
 * same way the subcommand probe is.
 */
export async function jobRowsFlags(cwd) {
    if (!jobsFlagsOnce) {
        jobsFlagsOnce = (async () => {
            if (!(await hasJobRows(cwd))) {
                return new Set();
            }
            try {
                return parseFlags(await ghRaw(["runner-kit", "metrics", "jobs", "--help"], { cwd }));
            } catch {
                // An unreadable help text means no flag can be relied on; the
                // caller falls back to filtering the rows itself.
                return new Set();
            }
        })();
    }
    return jobsFlagsOnce;
}

/** Whether the installed `gh runner-kit metrics jobs` can drop runners itself. */
export async function hasExcludeRunner(cwd) {
    return (await jobRowsFlags(cwd)).has("--exclude-runner");
}
