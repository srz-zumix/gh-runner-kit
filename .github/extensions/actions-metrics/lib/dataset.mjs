import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { collectFleet, collectRuns, jobRowsCommand, prepareSnapshot, probeRunnerKit, snapshotCommand } from "./runnerkit.mjs";
import { runLines } from "./jobs.mjs";
import { selectDatasetJobs } from "../shared/dataset.mjs";
import { filteredWindow, periodNanoseconds, periodTime } from "../shared/period.mjs";
import { parseCollectionProgress, progressDescription } from "../shared/progress.mjs";

/** A retained snapshot owns its file until the last active reader releases it. */
export class SharedDataset {
    constructor(input, directory, runs, jobs, meta, base = null) {
        Object.assign(this, { input, directory, runs, jobs, meta, base });
        this.references = 1;
        this.retired = false;
    }

    acquire() {
        if (this.retired) throw new Error("The shared dataset was superseded; request the current dataset");
        this.references++;
        return this;
    }

    async release() {
        if (--this.references === 0) {
            try {
                if (this.directory) await rm(this.directory, { recursive: true, force: true });
            } finally {
                await this.base?.release();
            }
        }
    }

    async retire() {
        if (this.retired) return;
        this.retired = true;
        await this.release();
    }

    select(options) {
        return selectDatasetJobs(this, options);
    }
}

async function datasetView(base, filters, cwd, signal) {
    const resolved = filteredWindow(base.meta.window, filters);
    const window = {
        Start: periodTime(resolved.Start) === periodTime(base.meta.window.Start) ? base.meta.window.Start : resolved.Start,
        End: periodTime(resolved.End) === periodTime(base.meta.window.End) ? base.meta.window.End : resolved.End,
    };
    const filtered = Boolean(filters.filterFrom || filters.filterTo);
    const from = periodTime(window.Start);
    const to = periodTime(window.End);
    const start = periodNanoseconds(window.Start), end = periodNanoseconds(window.End);
    const runs = filtered ? base.runs.filter(run => {
        const created = periodNanoseconds(run.created_at);
        return created !== null && created >= start && created < end;
    }) : base.runs;
    const selected = new Set(runs.map(run => JSON.stringify([run.repository, String(run.id)])));
    const jobs = filtered ? base.jobs.filter(job => selected.has(JSON.stringify([job.Repo, String(job.RunID)]))) : base.jobs;
    const meta = {
        ...base.meta,
        id: filtered ? `${base.meta.id}:${from}:${to}` : base.meta.id,
        sourceId: base.meta.id, collectionWindow: base.meta.window,
        collectedRuns: base.meta.runs, collectedJobs: base.meta.jobs,
        window, runs: runs.length, jobs: jobs.length, filtered,
    };
    if (!filtered) return new SharedDataset(base.input, null, runs, jobs, meta, base);
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-period-"));
    try {
        signal?.throwIfAborted();
        const input = join(directory, "snapshot.json.gz");
        await prepareSnapshot({ input: base.input, output: input, window, cwd, signal });
        signal?.throwIfAborted();
        return new SharedDataset(input, directory, runs, jobs, meta, base);
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

function nativeJob(row, runs) {
    return {
        id: row.JobID, run_id: row.RunID, run_attempt: row.RunAttempt,
        name: row.JobName, workflow_name: row.Workflow, labels: row.Labels,
        runner_id: row.RunnerID, runner_name: row.RunnerName, runner_group_name: row.RunnerGroup,
        status: row.Status, conclusion: row.Conclusion || null,
        execution_started: row.ExecutionStarted,
        created_at: row.QueuedAt, started_at: row.StartedAt, completed_at: row.CompletedAt,
        __run: runs.get(JSON.stringify([row.Repo, String(row.RunID)])),
    };
}

/** One collection supplies every dashboard report and every subsequent tab view. */
export async function collectSharedSnapshot({ target, filters, limits, cwd, dataset: retained, force = false, signal, onProgress, onCollectionProgress } = {}) {
    const started = Date.now();
    if (retained?.source) {
        const base = (retained.base ?? retained).acquire();
        return readDataset(base, { target, filters, limits, cwd, signal, onProgress, started });
    }
    const probe = await probeRunnerKit(cwd);
    if (!["collect", "report", "snapshot"].every(name => probe.subcommands?.has(name))) {
        throw new Error("The shared dataset requires gh runner-kit metrics collect, metrics report and metrics snapshot; update gh runner-kit");
    }
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-dataset-"));
    let dataset;
    try {
        const input = join(directory, "snapshot.json.gz");
        onProgress?.("Collecting one shared dataset, including all attempts");
        const command = snapshotCommand({ target, filters, limits, output: input, allAttempts: true, pricing: true, usage: filters.billable === true, force, probe });
        const supported = probe.collectFlags?.has("--progress") === true;
        const reason = supported ? "" : "Detailed collection progress requires metrics collect --progress; update gh runner-kit.";
        onCollectionProgress?.({ supported, reason });
        if (supported) command.args.push("--progress");
        await runLines(command.args, command.env, cwd, () => true, signal, {
            host: target.host ?? null,
            onStderrLine: line => {
                const detail = parseCollectionProgress(line);
                if (detail) {
                    onCollectionProgress?.({ supported: true, reason: "", detail });
                    if (!onCollectionProgress) onProgress?.(progressDescription(detail));
                }
            },
        });
        onProgress?.("Reading shared snapshot metadata");
        const snapshot = await prepareSnapshot({ input, cwd, signal });
        if (snapshot.Version !== 1 || snapshot.Contents?.AllAttempts !== true || !snapshot.Data || !snapshot.Data.LatestJobs) {
            throw new Error("The CLI did not produce an all-attempts dataset with latest-job coverage; update gh runner-kit");
        }
        const warnings = [...(snapshot.Data.Warnings ?? [])];
        const runResult = await collectRuns({ target, filters, limits, cwd, input, signal, onProgress, warnings });
        if (!runResult.available) throw new Error(runResult.reason);
        const jobs = [];
        const rows = jobRowsCommand({ target, filters: { ...filters, labels: [] }, limits, cwd, input, kind: "all", probe });
        await runLines(rows.args, rows.env, cwd, line => {
            const row = JSON.parse(line);
            jobs.push({ ...row, Latest: snapshot.Data.LatestJobs[String(row.JobID)] === true });
            return true;
        }, signal);
        const meta = {
            id: randomUUID(), collectedAt: snapshot.CreatedAt,
            window: snapshot.Data.Window, allAttempts: true,
            runs: runResult.rows.length, jobs: jobs.length,
            truncated: snapshot.Data.Truncated === true, warnings,
        };
        dataset = new SharedDataset(input, directory, runResult.rows, jobs, meta);
        const runByID = new Map(dataset.runs.map(run => [JSON.stringify([run.repository, String(run.id)]), run]));
        const owner = target.owner.toLowerCase();
        dataset.source = {
            target, filters, limits, dataset,
            runs: dataset.runs, runsAvailable: true,
            jobs: jobs.map(row => nativeJob(row, runByID)),
            runners: (snapshot.Data.Runners ?? []).map(runner => ({ ...runner, scope: target.kind === "org" || filters.runnerType === "org" ? "organization" : "repository" })),
            hostedRunners: snapshot.Data.HostedRunners?.[owner] ?? [],
            publicRepository: snapshot.Data.RepositoryPublic?.[target.nwo] ?? null,
            timings: [], workflows: [], warnings,
            collectedAt: snapshot.CreatedAt, durationMs: Date.now() - started,
        };
    } catch (error) {
        if (dataset) await dataset.retire();
        else await rm(directory, { recursive: true, force: true });
        throw error;
    }
    return readDataset(dataset, { target, filters, limits, cwd, signal, onProgress, started });
}

/** Transfer one base reference to a view; a failed or retired view releases it. */
async function readDataset(base, { target, filters, limits, cwd, signal, onProgress, started }) {
    let dataset;
    try {
        dataset = await datasetView(base, filters, cwd, signal);
        const warnings = [...base.source.warnings];
        const days = (periodTime(dataset.meta.window.End) - periodTime(dataset.meta.window.Start)) / 86400000;
        const fleet = await collectFleet({ target, filters: { ...filters, days }, limits, cwd, input: dataset.input, signal, onProgress, warnings });
        if (!fleet.summary) throw new Error("The shared dataset's fleet report could not be read; see collection warnings");
        const selected = new Set(dataset.runs.map(run => JSON.stringify([run.repository, String(run.id)])));
        dataset.source = {
            ...base.source, target, filters, limits, dataset, fleet, warnings,
            runs: dataset.runs,
            jobs: dataset.meta.filtered
                ? base.source.jobs.filter(job => selected.has(JSON.stringify([job.__run?.repository, String(job.__run?.id)])))
                : base.source.jobs,
            durationMs: Date.now() - started,
        };
        return dataset.source;
    } catch (error) {
        if (dataset) await dataset.retire();
        else await base.release();
        throw error;
    }
}
