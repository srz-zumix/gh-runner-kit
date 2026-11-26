import { boundedMap, compareIds, id, newest, paginate, positiveInteger, unique, utcSlices } from './common.mjs';

export function normalizeRun(row) {
  if (!Number.isFinite(Date.parse(row.created_at))) throw new Error('run creation time unavailable');
  return {
    id: id(row.id), attempt: positiveInteger(row.run_attempt || 1, 'attempt'),
    workflow: String(row.name || ''), workflowPath: String(row.path || ''),
    created_at: row.created_at, status: row.status || null, conclusion: row.conclusion || null,
    url: row.html_url || null, headSha: row.head_sha || null,
  };
}

export function normalizeJob(row, runId, latest = false) {
  if (row.run_id && id(row.run_id) !== id(runId)) throw new Error('job run identity mismatch');
  const occurrences = new Map();
  const steps = (row.steps || []).map((step, index) => {
    const name = String(step.name || '');
    const occurrence = (occurrences.get(name) || 0) + 1;
    occurrences.set(name, occurrence);
    return {
      number: step.number ?? index + 1, occurrence, name,
      status: step.status || null, conclusion: step.conclusion || null,
      startedAt: step.started_at || null, completedAt: step.completed_at || null,
    };
  });
  const runnerId = row.runner_id && String(row.runner_id) !== '0' ? id(row.runner_id) : null;
  const executionStarted = runnerId !== null || steps.some(step => step.conclusion !== 'skipped' && ['in_progress', 'completed'].includes(step.status) && Number.isFinite(Date.parse(step.startedAt)));
  return {
    id: id(row.id), runId: id(row.run_id || runId),
    attempt: row.run_attempt ? positiveInteger(row.run_attempt, 'job attempt') : null,
    latest, name: String(row.name || ''), status: row.status || null, conclusion: row.conclusion || null,
    createdAt: row.created_at || null, startedAt: row.started_at || null, completedAt: row.completed_at || null,
    url: row.html_url || null, labels: row.labels || [], runnerId, executionStarted, steps,
  };
}

export function mergeJobs(jobs) {
  const merged = new Map();
  for (const job of jobs) {
    const key = `${job.runId}:${job.id}`;
    const previous = merged.get(key);
    if (!previous || (job.latest && !previous.latest)) merged.set(key, { ...job });
    else previous.latest ||= job.latest;
  }
  return [...merged.values()].sort((a, b) => compareIds(a.runId, b.runId) || compareIds(a.id, b.id));
}

export async function discoverRuns(api, repository, slice, limit) {
  const issues = [];
  let skipped = false;
  async function search(start, end, needed) {
    const firstSecond = Math.floor(start / 1000), lastSecond = Math.floor((end - 1) / 1000);
    const created = `${new Date(firstSecond * 1000).toISOString().replace('.000Z', 'Z')}..${new Date(lastSecond * 1000).toISOString().replace('.000Z', 'Z')}`;
    const endpoint = `/repos/${repository}/actions/runs?created=${encodeURIComponent(created)}&per_page=100`;
    const first = await api(`${endpoint}&page=1`);
    if (!Array.isArray(first.workflow_runs) || !Number.isSafeInteger(first.total_count)) throw new Error('invalid workflow runs response');
    if (first.total_count >= 1000 && firstSecond < lastSecond) {
      const middle = (Math.floor((firstSecond + lastSecond) / 2) + 1) * 1000;
      const recent = await search(middle, end, needed);
      if (recent.length >= needed) { skipped = true; return recent; }
      return [...recent, ...await search(start, middle, needed - recent.length)];
    }
    if (first.total_count >= 1000) issues.push('API search saturation within one second; selection cannot be proven complete');
    let rows = first.workflow_runs;
    // Read every discoverable tie before the application cap is applied.
    for (let page = 2; rows.length < Math.min(first.total_count, 1000) && page <= 10; page++) {
      const response = await api(`${endpoint}&page=${page}`);
      if (!Array.isArray(response.workflow_runs)) throw new Error('invalid workflow runs page');
      rows.push(...response.workflow_runs);
      if (response.workflow_runs.length < 100) break;
    }
    if (rows.length < Math.min(first.total_count, 1000)) issues.push('Discovery pagination returned fewer rows than the advertised total; live updates or unavailable history may limit coverage');
    else if (unique(rows, row => id(row.id)).length < Math.min(first.total_count, 1000)) issues.push('Discovery pages contained duplicate IDs and fewer unique runs than advertised; live updates may limit coverage');
    return unique(rows.map(normalizeRun).filter(row => Date.parse(row.created_at) >= start && Date.parse(row.created_at) < end), row => row.id).sort(newest);
  }
  const rows = unique(await search(Date.parse(slice.since), Date.parse(slice.until), limit + 1), row => row.id).sort(newest);
  return { runs: rows.slice(0, limit), truncated: skipped || rows.length > limit, issues };
}

export async function collectBaseline(config, { api, concurrency = 6 }) {
  const data = { runs: [], attempts: [], jobs: [], daily: [], issues: [] };
  for (const slice of utcSlices(config.since, config.until)) {
    try {
      const found = await discoverRuns(api, config.repository, slice, config.dailyLimit);
      data.runs.push(...found.runs);
      data.daily.push({ ...slice, selectedRuns: found.runs.length, status: found.issues.length ? 'partial' : found.truncated ? 'truncated' : found.runs.length ? 'complete' : 'no_activity', truncated: found.truncated });
      data.issues.push(...found.issues.map(message => ({ scope: slice.day, message })));
    } catch (error) {
      data.daily.push({ ...slice, selectedRuns: 0, status: 'failed', truncated: false });
      data.issues.push({ scope: slice.day, message: error.message });
    }
  }
  data.runs = unique(data.runs, run => run.id).sort(newest);
  const collected = await boundedMap(data.runs, concurrency, async run => {
    const output = { jobs: [], attempts: [], issues: [] };
    try {
      const rows = await paginate(api, `/repos/${config.repository}/actions/runs/${run.id}/jobs?filter=latest`, 'jobs');
      output.jobs.push(...rows.map(row => normalizeJob(row, run.id, true)));
      if (!rows.length) output.issues.push({ scope: `run:${run.id}:attempt:${run.attempt}`, message: 'Latest jobs returned no rows; retention or pending execution may limit coverage' });
    } catch (error) {
      output.issues.push({ scope: `run:${run.id}:latest-jobs`, message: error.message });
    }
    // The global run worker pool bounds all historical calls too.
    for (let attempt = 1; attempt < run.attempt; attempt++) {
      try {
        const path = `/repos/${config.repository}/actions/runs/${run.id}/attempts/${attempt}`;
        const metadata = normalizeRun(await api(path));
        if (metadata.id !== run.id || metadata.attempt !== attempt) throw new Error('historical attempt identity mismatch');
        output.attempts.push(metadata);
        const rows = await paginate(api, `${path}/jobs`, 'jobs');
        output.jobs.push(...rows.map(row => normalizeJob(row, run.id, false)));
        if (!rows.length) output.issues.push({ scope: `run:${run.id}:attempt:${attempt}`, message: 'Historical jobs returned no rows; retained history is unavailable' });
      } catch (error) {
        output.issues.push({ scope: `run:${run.id}:attempt:${attempt}`, message: error.message });
      }
    }
    return output;
  });
  const runDay = new Map(data.runs.map(run => [run.id, new Date(run.created_at).toISOString().slice(0, 10)]));
  const incompleteDays = new Set();
  for (const part of collected) {
    data.jobs.push(...part.jobs); data.attempts.push(...part.attempts); data.issues.push(...part.issues);
    for (const issue of part.issues) incompleteDays.add(runDay.get(issue.scope.match(/^run:(\d+):/)?.[1]));
  }
  // Missing per-run evidence makes its UTC day partial, matching the runner-kit backend.
  for (const day of data.daily) {
    if (['complete', 'truncated'].includes(day.status) && incompleteDays.has(day.day)) day.status = 'partial';
  }
  data.jobs = mergeJobs(data.jobs);
  data.attempts = unique(data.attempts, run => `${run.id}:${run.attempt}`).sort((a, b) => compareIds(a.id, b.id) || a.attempt - b.attempt);
  return data;
}
