import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { iso, positiveInteger } from './common.mjs';

const exec = promisify(execFile);
const backends = ['baseline', 'runner-kit'];
const checks = ['reliability', 'performance', 'configuration'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const workflowFile = backend => `actions-inspection-${backend}.lock.yml`;

export async function api(route, method = 'GET', body) {
  const args = ['api', '--method', method, route];
  if (body !== undefined) args.push('--input', '-');
  return new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 8 * 1024 * 1024, timeout: 60_000 }, (error, stdout) => {
      if (error) return reject(new Error(`GitHub ${method} ${route.split('?')[0]} failed (exit ${error.code})`));
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : null);
      } catch {
        reject(new Error(`Invalid GitHub response for ${route.split('?')[0]}`));
      }
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

export function settings(env, defaults, now = new Date()) {
  const days = positiveInteger(env.INSPECTION_DAYS || defaults.days, 'days', 31);
  const dailyLimit = positiveInteger(env.INSPECTION_DAILY_LIMIT || defaults.daily_limit, 'daily_limit', 1000);
  const selected = (env.INSPECTION_CHECKS || defaults.checks.join(',')).split(',').map(s => s.trim());
  if (!selected.length || selected.some(s => !checks.includes(s)) || new Set(selected).size !== selected.length) {
    throw new Error('checks must be a nonempty distinct subset of reliability,performance,configuration');
  }
  const timestamp = (value, fallback) => {
    const date = new Date(value ? iso(value) : fallback);
    if (!Number.isFinite(date.getTime()) || date.getMilliseconds()) throw new Error('Timestamps must be valid whole seconds');
    return date;
  };
  const until = timestamp(env.INSPECTION_UNTIL, new Date(Math.floor(now.getTime() / 1000) * 1000));
  const since = timestamp(env.INSPECTION_SINCE, until.getTime() - days * 86400_000);
  if (since >= until || until > now || until - since > 31 * 86400_000) throw new Error('Expected a past period of at most 31 days');
  const mode = env.INSPECTION_MODE || defaults.mode;
  if (!['report', 'issue'].includes(mode)) throw new Error('mode must be report or issue');
  return { since: since.toISOString(), until: until.toISOString(), dailyLimit, checks: checks.filter(c => selected.includes(c)), mode };
}

export function validateSource(env, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('Invalid repository');
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA || '')) throw new Error('Invalid source revision');
  if (env.GITHUB_EVENT_NAME !== 'workflow_dispatch' && env.GITHUB_EVENT_NAME !== 'schedule') throw new Error('Only trusted manual/scheduled execution is supported');
  if (env.GITHUB_REF !== `refs/heads/${repository.default_branch}`) throw new Error('Inspection must run from the default branch');
  if (env.INSPECTION_EXPECTED_SHA && env.INSPECTION_EXPECTED_SHA !== env.GITHUB_SHA) throw new Error('Default branch changed before dispatch; start a new pair');
}

export function childMatches(run, child, context) {
  return run.workflow_id === child.workflowId &&
    run.display_title === child.title &&
    run.event === 'workflow_dispatch' &&
    run.head_sha === context.sourceSha &&
    run.head_branch === context.branch &&
    run.repository?.full_name === context.repository &&
    run.run_attempt === 1;
}

export function reportKey(context, backend) {
  return digest({ repository: context.repository, sourceSha: context.sourceSha, backend, settings: context.settings });
}

export function sanitize(text, repository) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 60_000) throw new Error('Report text exceeds publication limit');
  return text.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/@/g, '@\u200b')
    .replace(/<[^>]*>/g, '')
    .replace(/https?:\/\/[^\s)>\]]+/g, url => repository && (url.startsWith(`https://github.com/${repository}/actions/`) || url.startsWith(`https://github.com/${repository}/blob/`)) ? url : '[external URL omitted]')
    .replace(/!\[/g, '\\![');
}

async function boundedFile(path, max) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) throw new Error(`Invalid or oversized report file: ${path}`);
  return readFile(path, 'utf8');
}

async function jsonFile(path, max = 1024 * 1024) {
  return JSON.parse(await boundedFile(path, max));
}

async function verifySource(env, request = api) {
  const repository = await request(`repos/${env.GITHUB_REPOSITORY}`);
  validateSource(env, repository);
  return repository;
}

async function allPages(route, key, request = api) {
  const values = [];
  for (let page = 1; page <= 100; page++) {
    const response = await request(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = key ? response[key] : response;
    if (!Array.isArray(items)) throw new Error('Invalid paginated GitHub response');
    values.push(...items);
    if (items.length < 100) return values;
  }
  throw new Error('GitHub listing exceeded the bounded pagination limit');
}

async function artifact(runId, name, directory, files, repository) {
  const list = await api(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`);
  const matches = list.artifacts.filter(a => a.name === name && !a.expired);
  if (matches.length !== 1 || matches[0].size_in_bytes > 4 * 1024 * 1024) throw new Error(`Missing, ambiguous or oversized ${name} artifact`);
  const { stdout } = await exec('gh', ['api', `repos/${repository}/actions/artifacts/${matches[0].id}/zip`], {
    encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout: 60_000,
  });
  await mkdir(directory, { recursive: true });
  const archive = join(directory, 'download.zip');
  await writeFile(archive, stdout);
  // Read only fixed expected entries; never extract archive-controlled paths or links.
  await exec('python3', ['-c', `
import pathlib, stat, sys, zipfile
archive, destination, *expected = sys.argv[1:]
with zipfile.ZipFile(archive) as z:
    entries = z.infolist()
    if len(entries) != len(expected) or sorted(i.filename for i in entries) != sorted(expected):
        raise ValueError("unexpected artifact entries")
    for i in entries:
        mode = i.external_attr >> 16
        if i.file_size > 1048576 or stat.S_ISLNK(mode) or "/" in i.filename or "\\\\" in i.filename:
            raise ValueError("invalid artifact entry")
        data = z.read(i)
        if len(data) > 1048576:
            raise ValueError("oversized artifact entry")
        pathlib.Path(destination, i.filename).write_bytes(data)
`, archive, directory, ...files], { timeout: 30_000, maxBuffer: 8192 });
}

export async function pair(directory, env, { now = new Date(), request = api, download = artifact, wait = sleep } = {}) {
  const repo = await verifySource(env, request);
  const defaults = await jsonFile('.github/aw/actions-inspection/config.json');
  const context = {
    version: 1, repository: env.GITHUB_REPOSITORY, sourceSha: env.GITHUB_SHA, branch: repo.default_branch,
    parentRunId: env.GITHUB_RUN_ID, parentAttempt: env.GITHUB_RUN_ATTEMPT,
    settings: settings(env, defaults, now), children: [],
    startedAt: new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(),
  };
  await mkdir(directory, { recursive: true });
  const save = () => writeFile(join(directory, 'pair.json'), `${JSON.stringify(context, null, 2)}\n`);
  for (const backend of backends) {
    const nonce = `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}-${backend}-${randomUUID()}`;
    const child = { backend, nonce, title: `Actions inspection ${backend} / ${nonce}`, state: 'dispatching' };
    context.children.push(child);
    await save();
    try {
      const workflow = await request(`repos/${context.repository}/actions/workflows/${workflowFile(backend)}`);
      child.workflowId = workflow.id;
      const branch = await request(`repos/${context.repository}/commits/${encodeURIComponent(repo.default_branch)}`);
      if (branch.sha !== context.sourceSha) throw new Error('Default branch moved; refusing mismatched inspection code');
      await request(`repos/${context.repository}/actions/workflows/${workflow.id}/dispatches`, 'POST', {
        ref: repo.default_branch,
        inputs: {
          checks: context.settings.checks.join(','), since: context.settings.since, until: context.settings.until,
          daily_limit: String(context.settings.dailyLimit), expected_sha: context.sourceSha, correlation: nonce,
        },
      });
      child.state = 'dispatched';
      child.dispatchedAt = new Date().toISOString();
    } catch (error) {
      child.state = 'failed';
      child.error = error.message;
    }
    await save();
  }
  const deadline = Date.now() + 60 * 60_000;
  while (context.children.some(c => !['completed', 'failed', 'timed_out'].includes(c.state))) {
    for (const child of context.children.filter(c => !['completed', 'failed', 'timed_out'].includes(c.state))) {
      try {
        if (!child.runId) {
          const listed = await allPages(`repos/${context.repository}/actions/workflows/${child.workflowId}/runs?event=workflow_dispatch&created=${encodeURIComponent(`>=${context.startedAt}`)}`, 'workflow_runs', request);
          const candidates = listed.filter(r => r.display_title === child.title);
          if (candidates.length > 1) throw new Error('Ambiguous child dispatch correlation');
          if (candidates.length) {
            const run = await request(`repos/${context.repository}/actions/runs/${candidates[0].id}`);
            if (!childMatches(run, child, context)) throw new Error('Child provenance mismatch');
            child.runId = run.id;
            child.url = run.html_url;
          } else if (Date.now() - Date.parse(child.dispatchedAt) > 5 * 60_000) {
            throw new Error('Child dispatch not observable within five minutes');
          }
        }
        if (child.runId) {
          const run = await request(`repos/${context.repository}/actions/runs/${child.runId}`);
          if (!childMatches(run, child, context)) throw new Error('Child provenance changed');
          child.state = run.status === 'completed' ? 'completed' : 'running';
          child.conclusion = run.conclusion;
          child.startedAt = run.run_started_at;
          child.updatedAt = run.updated_at;
        }
      } catch (error) {
        child.state = 'failed';
        child.error = error.message;
      }
    }
    await save();
    if (Date.now() >= deadline) {
      for (const child of context.children.filter(c => ['running', 'dispatched'].includes(c.state))) {
        child.state = 'timed_out';
        child.error = 'Pair execution exceeded the sixty-minute deadline';
        if (child.runId) {
          try { await request(`repos/${context.repository}/actions/runs/${child.runId}/cancel`, 'POST'); }
          catch (error) { child.error += `; cancellation failed: ${error.message}`; }
        }
      }
      await save();
      break;
    }
    if (context.children.some(c => ['running', 'dispatched'].includes(c.state))) await wait(20_000);
  }
  for (const child of context.children) {
    if (child.state !== 'completed' || child.conclusion !== 'success') continue;
    try {
      const jobs = await allPages(`repos/${context.repository}/actions/runs/${child.runId}/attempts/1/jobs`, 'jobs', request);
      if (!['collect', 'agent', 'detection', 'submit_report'].every(name => jobs.some(j => j.name === name && j.conclusion === 'success'))) {
        throw new Error('Required collection, analysis, detection or report job did not succeed');
      }
      const base = join(directory, child.backend);
      await download(child.runId, 'inspection-report', base, ['report.md', 'result.json'], context.repository);
      await download(child.runId, 'inspection-analysis', join(base, 'analysis'), ['analysis.md', 'execution.json'], context.repository);
      const result = await jsonFile(join(base, 'result.json'));
      validateResult(result, context, child.backend);
      const analysis = await boundedFile(join(base, 'analysis/analysis.md'), 48_000);
      const report = await boundedFile(join(base, 'report.md'), 40_000);
      const execution = await jsonFile(join(base, 'analysis/execution.json'), 8192);
      await writeFile(join(base, 'report.md'), `${sanitize(report, context.repository)}\n\n## Agent interpretation\n\n${sanitize(analysis)}\n\n## Execution\n\n- Run: ${child.url}\n- Reported model: ${sanitize(String(execution.model || 'unavailable'))}\n- Agent AIC: ${execution.agentAic ?? 'unavailable'}\n- Detection AIC: ${execution.detectionAic ?? 'unavailable'}\n\nAI-generated interpretation; verify suggestions before acting. Native accounting may be incomplete.\n`);
      child.reportReady = true;
      child.execution = execution;
    } catch (error) {
      child.error = `Report unavailable: ${error.message}`;
    }
    await save();
  }
  await save();
  await summary(context, env);
  if (context.children.some(c => !c.reportReady)) throw new Error('One or more inspection reports are unavailable; see retained pair.json');
}

export function validateResult(result, context, backend) {
  if (result.schemaVersion !== 1 || result.repository !== context.repository || result.sourceSha !== context.sourceSha ||
      result.backend !== backend || result.since !== context.settings.since || result.until !== context.settings.until ||
      result.dailyLimit !== context.settings.dailyLimit ||
      JSON.stringify(result.checks) !== JSON.stringify(context.settings.checks)) throw new Error('Report contract or resolved settings mismatch');
}

export async function publishOnce({ list, create, body, marker }) {
  const existing = (await list()).filter(i => !i.pull_request && i.body?.includes(marker));
  if (existing.length > 1) throw new Error('Multiple report issues already exist for this report key');
  if (existing.length) return existing[0];
  try { return await create(body); }
  catch (error) {
    const reconciled = (await list()).filter(i => !i.pull_request && i.body?.includes(marker));
    if (reconciled.length === 1) return reconciled[0];
    throw error;
  }
}

async function publish(directory, env) {
  const context = await jsonFile(join(directory, 'pair.json'));
  if (context.repository !== env.GITHUB_REPOSITORY || context.sourceSha !== env.GITHUB_SHA ||
      String(context.parentRunId) !== env.GITHUB_RUN_ID || String(context.parentAttempt) !== env.GITHUB_RUN_ATTEMPT) {
    throw new Error('Pair provenance mismatch');
  }
  if (context.settings.mode !== 'issue') throw new Error('Issue publication requires explicit issue mode');
  const errors = [];
  for (const child of context.children) {
    if (!backends.includes(child.backend) || !child.reportReady) continue;
    try {
      const current = await api(`repos/${context.repository}/actions/runs/${child.runId}`);
      if (!childMatches(current, child, context) || current.conclusion !== 'success') throw new Error('Child changed before publication');
      const marker = `<!-- actions-inspection:${reportKey(context, child.backend)} -->`;
      const text = await boundedFile(join(directory, child.backend, 'report.md'), 60_000);
      const body = `${sanitize(text, context.repository)}\n\n${marker}\n\nGenerated by Actions inspection (${child.backend}): ${child.url}\n`;
      if (body.length > 65_000) throw new Error('Issue report exceeds GitHub body limit');
      const issue = await publishOnce({
        marker, body,
        list: () => allPages(`repos/${context.repository}/issues?state=all&creator=github-actions%5Bbot%5D`),
        create: body => api(`repos/${context.repository}/issues`, 'POST', {
          title: `[Actions inspection: ${child.backend}] ${context.settings.until.slice(0, 10)}`, body,
        }),
      });
      child.issueUrl = issue.html_url;
    } catch (error) {
      child.publicationError = error.message;
      errors.push(error);
    }
    await writeFile(join(directory, 'pair.json'), `${JSON.stringify(context, null, 2)}\n`);
  }
  await summary(context, env);
  if (errors.length) throw new Error('Issue publication failed for one or more backends; do not blindly retry');
}

async function summary(context, env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  const lines = ['## Actions inspection reports', '', `Period: ${context.settings.since} to ${context.settings.until} (exclusive).`, '', '| Backend | Execution | Report | Issue |', '| --- | --- | --- | --- |'];
  for (const child of context.children) {
    lines.push(`| ${child.backend} | ${child.url ? `[run](${child.url})` : child.state} | ${child.reportReady ? 'Available in inspection-pair artifact' : 'Unavailable'} | ${child.issueUrl ? `[issue](${child.issueUrl})` : 'Not created'} |`);
    if (child.error || child.publicationError) lines.push('', `**${child.backend}:** ${sanitize(child.error || child.publicationError)}`);
  }
  lines.push('', 'No automatic comparison is performed. Inspect both reports and native gh-aw execution information.', '');
  await appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n'));
}

export async function extractAnalysis(directory, env) {
  if (env.GH_AW_DETECTION_CONCLUSION !== 'success') throw new Error('A successful threat-detection verdict is required');
  const output = await jsonFile(env.GH_AW_AGENT_OUTPUT);
  const items = output.items?.filter(i => i.type === 'submit_report');
  if (items?.length !== 1 || typeof items[0].body !== 'string' || !items[0].body.trim() || items[0].body.length > 12_000) {
    throw new Error('Exactly one nonempty analysis of at most 12000 characters is required');
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'analysis.md'), `${sanitize(items[0].body)}\n`);
  const number = value => value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  await writeFile(join(directory, 'execution.json'), `${JSON.stringify({
    model: env.GH_AW_ENGINE_MODEL || null,
    agentAic: number(env.GH_AW_AGENT_AIC), detectionAic: number(env.GH_AW_THREAT_DETECTION_AIC),
    source: 'gh-aw safe-job runtime outputs', status: 'observed; final native accounting is available in the child run',
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, directory] = process.argv.slice(2);
  try {
    if (command === 'verify-source') await verifySource(process.env);
    else if (command === 'pair' && directory) await pair(directory, process.env);
    else if (command === 'publish' && directory) await publish(directory, process.env);
    else if (command === 'extract-analysis' && directory) await extractAnalysis(directory, process.env);
    else throw new Error('Expected verify-source, pair DIR, publish DIR or extract-analysis DIR');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
