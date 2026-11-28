import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { command, compareIds, id, newest, parseSafeJSON, unique, utcSlices } from './common.mjs';
import { mergeJobs, normalizeJob, normalizeRun } from './baseline.mjs';

export function normalizeSnapshot(snapshot, config, slice) {
  if (snapshot.Version !== 1 || !snapshot.Data || snapshot.Contents?.Jobs !== true || snapshot.Contents?.AllAttempts !== true) throw new Error('unsupported or incomplete runner-kit snapshot');
  if (`${snapshot.Repo?.Owner}/${snapshot.Repo?.Name}` !== config.repository) throw new Error('snapshot repository mismatch');
  const raw = snapshot.Data;
  for (const key of ['Runs', 'Attempts', 'Jobs', 'Warnings', 'Repos']) {
    if (raw[key] != null && !Array.isArray(raw[key])) throw new Error(`invalid snapshot ${key}`);
  }
  const runs = unique((raw.Runs || []).map(normalizeRun).filter(run => Date.parse(run.created_at) >= Date.parse(slice.since) && Date.parse(run.created_at) < Date.parse(slice.until)), run => run.id).sort(newest).slice(0, config.dailyLimit);
  const selected = new Set(runs.map(run => run.id));
  const attempts = (raw.Attempts || []).map(normalizeRun).filter(run => selected.has(run.id));
  const jobs = (raw.Jobs || []).map(row => normalizeJob(row, row.run_id, raw.LatestJobs?.[id(row.id)] === true)).filter(job => selected.has(job.runId));
  const issues = [], optionalIssues = [];
  for (const warning of raw.Warnings || []) {
    // Keep diagnostic categories and identities, not arbitrary CLI stderr or URLs.
    const historical = String(warning).match(/historical run (\d+) attempt (\d+)/);
    if (/skipped the runner inventory/.test(String(warning))) {
      optionalIssues.push({ scope: 'runner-inventory', message: 'Optional current runner inventory unavailable; hosted-job timings do not require it' });
    } else {
      issues.push({
        scope: historical ? `run:${historical[1]}:attempt:${historical[2]}` : 'runner-kit-collection',
        message: historical ? 'Historical attempt metadata/jobs unavailable; see retained snapshot warning' : 'Runner-kit reported unavailable execution evidence; see retained snapshot warning',
      });
    }
  }
  if (!(raw.Repos || []).some(repo => `${repo.Repository?.Owner}/${repo.Repository?.Name}` === config.repository)) {
    issues.push({ scope: 'run-listing', message: 'Snapshot does not confirm successful repository run discovery' });
  }
  // A run with no latest jobs can be warning-free (empty list), so flag it like the REST baseline does.
  const withLatest = new Set(jobs.filter(job => job.latest).map(job => job.runId));
  for (const run of runs) {
    if (!withLatest.has(run.id)) issues.push({ scope: `run:${run.id}:attempt:${run.attempt}`, message: 'Latest jobs returned no rows; retention or pending execution may limit coverage' });
  }
  const truncated = Boolean(raw.Truncated) || (raw.Runs || []).length > config.dailyLimit;
  const expected = runs.reduce((sum, run) => sum + run.attempt - 1, 0);
  if (attempts.length < expected && !issues.some(issue => issue.scope.includes(':attempt:'))) issues.push({ scope: 'historical-attempts', message: 'Snapshot is missing selected historical attempt metadata' });
  return {
    runs, attempts, jobs: mergeJobs(jobs), issues, optionalIssues,
    daily: {
      ...slice, selectedRuns: runs.length,
      status: issues.length ? 'partial' : truncated ? 'truncated' : runs.length ? 'complete' : 'no_activity',
      truncated,
      ...(truncated ? { selectionUncertainty: 'CLI capped discovery cannot prove the newest ID tie-break at a saturated API boundary; normalization sorts only observed IDs' } : {}),
    },
  };
}

export async function collectRunnerKit(config, outputDir, { env = process.env, run = command } = {}) {
  const binary = env.RUNNER_KIT_BIN || 'gh';
  const prefix = env.RUNNER_KIT_BIN ? [] : ['runner-kit'];
  const output = { runs: [], attempts: [], jobs: [], daily: [], issues: [], optionalIssues: [], snapshots: [], tool: null };
  const version = await run(binary, [...prefix, '--version']);
  output.tool = { name: 'runner-kit', version: version.code === 0 ? version.stdout.trim().split('\n')[0].slice(0, 200) : null };
  const directory = join(outputDir, 'snapshots');
  await mkdir(directory, { recursive: true });
  for (const slice of utcSlices(config.since, config.until)) {
    const name = `${slice.day}.json.gz`;
    const path = join(directory, name);
    try {
      const response = await run(binary, [
        ...prefix, 'metrics', 'collect', '--repo', config.repository,
        '--since', slice.since, '--until', slice.until, '--max-runs', String(config.dailyLimit),
        '--all-attempts', '--no-cache', '--concurrency', '6', '--output', path,
      ]);
      if (response.code !== 0) throw new Error(`runner-kit metrics collect failed (exit ${response.code})`);
      // Reuse the raw snapshot offline instead of invoking semantically different fleet aggregates.
      const compressed = await readFile(path);
      if (compressed.length > 256 * 1024 * 1024) throw new Error('snapshot exceeds compressed size bound');
      const snapshot = parseSafeJSON(gunzipSync(compressed, { maxOutputLength: 1024 * 1024 * 1024 }).toString('utf8'));
      const normalized = normalizeSnapshot(snapshot, config, slice);
      output.runs.push(...normalized.runs); output.attempts.push(...normalized.attempts); output.jobs.push(...normalized.jobs);
      output.issues.push(...normalized.issues); output.optionalIssues.push(...normalized.optionalIssues);
      output.daily.push(normalized.daily); output.snapshots.push(`snapshots/${name}`);
    } catch (error) {
      const controlled = /^(runner-kit metrics collect failed|snapshot |unsupported or incomplete runner-kit snapshot|invalid snapshot )/.test(error.message);
      output.issues.push({ scope: slice.day, message: controlled ? error.message : 'Runner-kit snapshot unavailable, invalid or unsafe; collection cannot be treated as complete' });
      output.daily.push({ ...slice, selectedRuns: 0, status: 'failed', truncated: false });
    }
  }
  output.runs = unique(output.runs, run => run.id).sort(newest);
  output.attempts = unique(output.attempts, run => `${run.id}:${run.attempt}`).sort((a, b) => compareIds(a.id, b.id) || a.attempt - b.attempt);
  output.jobs = mergeJobs(output.jobs);
  return output;
}
