import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { assertRateBudget, ghRaw } from "./gh.mjs";
import { collectFleet, collectRuns, jobRowsCommand, probeRunnerKit, snapshotCommand } from "./runnerkit.mjs";
import { runLines } from "./jobs.mjs";
import { selectDatasetJobs } from "../shared/dataset.mjs";

/** A retained snapshot owns its file until the last active reader releases it. */
export class SharedDataset {
    constructor(input, directory, runs, jobs, meta) {
        Object.assign(this, { input, directory, runs, jobs, meta });
        this.references = 1;
        this.retired = false;
    }

    acquire() {
        if (this.retired) throw new Error("The shared dataset was superseded; request the current dataset");
        this.references++;
        return this;
    }

    async release() {
        if (--this.references === 0) await rm(this.directory, { recursive: true, force: true });
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
export async function collectSharedSnapshot({ target, filters, limits, cwd, dataset: retained, force = false, signal, onProgress } = {}) {
    const started = Date.now();
    if (retained?.source) {
        retained.acquire();
        try {
            const warnings = [...retained.source.warnings];
            const fleet = await collectFleet({ target, filters, limits, cwd, input: retained.input, signal, onProgress, warnings });
            if (!fleet.summary) throw new Error("The shared dataset's fleet report could not be read; see collection warnings");
            return { ...retained.source, target, filters, limits, dataset: retained, fleet, warnings, durationMs: Date.now() - started };
        } finally {
            await retained.release();
        }
    }
    await assertRateBudget(target.host, { cwd });
    const probe = await probeRunnerKit(cwd);
    if (!probe.subcommands?.has("collect") || !probe.subcommands?.has("report")) {
        throw new Error("The shared dataset requires gh runner-kit metrics collect and metrics report; update gh runner-kit");
    }
    const directory = await mkdtemp(join(tmpdir(), "actions-metrics-dataset-"));
    let dataset;
    try {
        const input = join(directory, "snapshot.json.gz");
        onProgress?.("Collecting one shared dataset, including all attempts");
        const command = snapshotCommand({ target, filters, limits, output: input, allAttempts: true, pricing: true, usage: filters.billable === true, force, probe });
        await ghRaw(command.args, { cwd, env: command.env, host: target.host ?? null, signal });
        const snapshot = JSON.parse(gunzipSync(await readFile(input)).toString("utf8"));
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
        const fleet = await collectFleet({ target, filters, limits, cwd, input, signal, onProgress, warnings });
        if (!fleet.summary) throw new Error("The shared dataset's fleet report could not be read; see collection warnings");
        const runByID = new Map(dataset.runs.map(run => [JSON.stringify([run.repository, String(run.id)]), run]));
        const owner = target.owner.toLowerCase();
        dataset.source = {
            target, filters, limits, dataset,
            runs: dataset.runs, runsAvailable: true,
            jobs: jobs.map(row => nativeJob(row, runByID)),
            runners: (snapshot.Data.Runners ?? []).map(runner => ({ ...runner, scope: target.kind === "org" || filters.runnerType === "org" ? "organization" : "repository" })),
            hostedRunners: snapshot.Data.HostedRunners?.[owner] ?? [],
            publicRepository: snapshot.Data.RepositoryPublic?.[target.nwo] ?? null,
            timings: [], workflows: [], fleet, warnings,
            collectedAt: snapshot.CreatedAt, durationMs: Date.now() - started,
        };
        return dataset.source;
    } catch (error) {
        if (dataset) await dataset.retire();
        else await rm(directory, { recursive: true, force: true });
        throw error;
    }
}
