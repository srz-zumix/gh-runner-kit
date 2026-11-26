import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { childMatches, extractAnalysis, pair, publishOnce, reportKey, sanitize, settings, validateResult, validateSource } from './coordinator.mjs';

const sha = 'a'.repeat(40);
const defaults = { days: 7, daily_limit: 1000, checks: ['reliability', 'performance', 'configuration'], mode: 'report' };
const context = { repository: 'example-owner/example-repository', sourceSha: sha, branch: 'main', settings: settings({}, defaults, new Date('2026-03-10T12:34:56Z')) };

test('paired settings freeze a rolling window and canonical selected checks', () => {
  assert.equal(context.settings.since, '2026-03-03T12:34:56.000Z');
  assert.equal(context.settings.until, '2026-03-10T12:34:56.000Z');
  assert.equal(context.settings.mode, 'report');
  assert.deepEqual(settings({ INSPECTION_CHECKS: 'configuration,reliability' }, defaults).checks, ['reliability', 'configuration']);
  for (const env of [
    { INSPECTION_CHECKS: 'reliability,reliability' }, { INSPECTION_CHECKS: 'unknown' },
    { INSPECTION_DAILY_LIMIT: '1001' }, { INSPECTION_DAYS: '0' }, { INSPECTION_MODE: 'write' },
    { INSPECTION_UNTIL: '2099-01-01T00:00:00Z' }, { INSPECTION_SINCE: 'not-a-date' },
    { INSPECTION_SINCE: '2020-01-01T00:00:00Z' }, { INSPECTION_UNTIL: '2026-01-01T00:00:00.001Z' },
  ]) assert.throws(() => settings(env, defaults));
});

test('source validation rejects non-default branches, PR events and moved revisions', () => {
  const env = { GITHUB_REPOSITORY: context.repository, GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch' };
  assert.doesNotThrow(() => validateSource(env, { default_branch: 'main' }));
  for (const change of [{ GITHUB_REF: 'refs/heads/topic' }, { GITHUB_EVENT_NAME: 'pull_request' }, { INSPECTION_EXPECTED_SHA: 'b'.repeat(40) }]) {
    assert.throws(() => validateSource({ ...env, ...change }, { default_branch: 'main' }));
  }
});

test('nonce alone cannot establish child provenance and reruns are rejected', () => {
  const child = { workflowId: 123, title: 'Actions inspection baseline / nonce' };
  const run = { workflow_id: 123, display_title: child.title, event: 'workflow_dispatch', head_sha: sha, head_branch: 'main', repository: { full_name: context.repository }, run_attempt: 1 };
  assert.equal(childMatches(run, child, context), true);
  for (const change of [
    { workflow_id: 456 }, { display_title: 'different' }, { event: 'pull_request' },
    { head_sha: 'b'.repeat(40) }, { head_branch: 'topic' }, { run_attempt: 2 },
    { repository: { full_name: 'example-owner/other' } },
  ]) assert.equal(childMatches({ ...run, ...change }, child, context), false);
});

test('neutral result contract binds repository, revision, backend and resolved settings', () => {
  const result = { schemaVersion: 1, repository: context.repository, sourceSha: sha, backend: 'baseline', ...context.settings };
  assert.doesNotThrow(() => validateResult(result, context, 'baseline'));
  for (const change of [{ schemaVersion: 2 }, { backend: 'runner-kit' }, { dailyLimit: 99 }, { until: 'different' }, { sourceSha: 'b'.repeat(40) }, { checks: ['performance'] }]) {
    assert.throws(() => validateResult({ ...result, ...change }, context, 'baseline'));
  }
  assert.notEqual(reportKey(context, 'baseline'), reportKey(context, 'runner-kit'));
  assert.equal(reportKey(context, 'baseline'), reportKey(structuredClone(context), 'baseline'));
});

test('publication deduplicates all states and does not mutate an existing report', async () => {
  let creates = 0;
  const existing = { body: 'report <!-- key -->', number: 12, state: 'closed' };
  const result = await publishOnce({ marker: '<!-- key -->', body: 'new body', list: async () => [existing], create: async () => { creates++; } });
  assert.equal(result.number, 12);
  assert.equal(creates, 0);
  await assert.rejects(publishOnce({ marker: '<!-- key -->', list: async () => [existing, existing] }), /Multiple/);
});

test('uncertain create reconciles instead of blindly posting a second issue', async () => {
  let calls = 0, creates = 0;
  const issue = { body: '<!-- key -->', number: 13 };
  const result = await publishOnce({
    marker: '<!-- key -->', body: 'report',
    list: async () => ++calls === 1 ? [] : [issue],
    create: async () => { creates++; throw new Error('response lost'); },
  });
  assert.equal(result.number, 13);
  assert.equal(creates, 1);
  await assert.rejects(publishOnce({ marker: 'key', list: async () => [], create: async () => { throw new Error('unconfirmed write'); } }), /unconfirmed write/);
});

test('analysis extraction fails closed on missing detection, duplicate submissions and oversized data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'inspection-analysis-'));
  try {
    const input = join(directory, 'input.json'), output = join(directory, 'out');
    const env = { GH_AW_AGENT_OUTPUT: input, GH_AW_DETECTION_CONCLUSION: 'success', GH_AW_ENGINE_MODEL: 'example-model', GH_AW_AGENT_AIC: '0' };
    await writeFile(input, JSON.stringify({ items: [{ type: 'submit_report', body: 'Observation with @example and https://example.invalid' }] }));
    await assert.rejects(extractAnalysis(output, { ...env, GH_AW_DETECTION_CONCLUSION: 'skipped' }), /verdict/);
    await extractAnalysis(output, env);
    assert.ok(!(await readFile(join(output, 'analysis.md'), 'utf8')).includes('@example'));
    const execution = JSON.parse(await readFile(join(output, 'execution.json'), 'utf8'));
    assert.equal(execution.agentAic, 0);
    assert.equal(execution.detectionAic, null);
    for (const bodies of [['one', 'two'], ['x'.repeat(12001)], ['']]) {
      await writeFile(input, JSON.stringify({ items: bodies.map(body => ({ type: 'submit_report', body })) }));
      await assert.rejects(extractAnalysis(output, env), /Exactly one/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('publication text strips marker spoofing, images, HTML, external links and mentions', () => {
  const text = sanitize('<!-- spoof --> <script>bad</script> @example ![image](https://example.invalid) https://outside.invalid');
  assert.ok(!text.includes('<!--'));
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('@example'));
  assert.ok(!text.includes('https://outside.invalid'));
  assert.throws(() => sanitize('x'.repeat(60001)), /limit/);
});

test('paired orchestration discovers same-second dispatches, validates detection, and retains independent reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'inspection-pair-'));
  try {
    for (const blocked of [false, true]) {
      const directory = join(root, String(blocked));
      const now = new Date('2026-03-10T12:34:56.123Z');
      const env = {
        GITHUB_REPOSITORY: context.repository, GITHUB_SHA: sha, GITHUB_REF: 'refs/heads/main',
        GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_RUN_ID: '500', GITHUB_RUN_ATTEMPT: '1',
        INSPECTION_CHECKS: 'configuration', GITHUB_STEP_SUMMARY: join(root, `summary-${blocked}.md`),
      };
      const dispatched = [], routes = [], downloaded = [];
      const request = async (route, method = 'GET', body) => {
        routes.push({ route, method });
        const path = route.split('?')[0];
        if (path === `repos/${context.repository}`) return { default_branch: 'main' };
        if (path.endsWith('/commits/main')) return { sha };
        if (/\/workflows\/actions-inspection-.*\.lock.yml$/.test(path)) {
          return { id: path.endsWith('baseline.lock.yml') ? 101 : 102 };
        }
        if (path.endsWith('/dispatches')) {
          const workflowId = Number(path.split('/').at(-2));
          dispatched.push({
            id: workflowId + 1000, workflow_id: workflowId, display_title: `Actions inspection ${workflowId === 101 ? 'baseline' : 'runner-kit'} / ${body.inputs.correlation}`,
            event: 'workflow_dispatch', head_sha: sha, head_branch: 'main', repository: { full_name: context.repository },
            run_attempt: 1, status: 'completed', conclusion: 'success',
            created_at: '2026-03-10T12:34:56Z', html_url: `https://github.com/${context.repository}/actions/runs/${workflowId + 1000}`,
          });
          return null;
        }
        if (/\/workflows\/\d+\/runs$/.test(path)) {
          const since = new URLSearchParams(route.split('?')[1]).get('created').slice(2);
          assert.equal(since, '2026-03-10T12:34:56.000Z');
          const workflowId = Number(path.split('/').at(-2));
          return { workflow_runs: dispatched.filter(run => run.workflow_id === workflowId && Date.parse(run.created_at) >= Date.parse(since)) };
        }
        if (/\/attempts\/1\/jobs$/.test(path)) {
          const failed = blocked && path.includes('/1102/');
          return { jobs: ['collect', 'agent', 'detection', 'submit_report'].map(name => ({ name, conclusion: failed && name === 'detection' ? 'failure' : 'success' })) };
        }
        if (/\/actions\/runs\/\d+$/.test(path)) return dispatched.find(run => run.id === Number(path.split('/').at(-1)));
        assert.fail(`Unexpected API request: ${method} ${route}`);
      };
      const download = async (runId, name, destination) => {
        downloaded.push({ runId, name });
        await mkdir(destination, { recursive: true });
        if (name === 'inspection-report') {
          const backend = runId === 1101 ? 'baseline' : 'runner-kit';
          const config = settings(env, defaults, now);
          await writeFile(join(destination, 'result.json'), JSON.stringify({ schemaVersion: 1, repository: context.repository, sourceSha: sha, backend, ...config }));
          await writeFile(join(destination, 'report.md'), `# ${backend} facts\n`);
        } else {
          await writeFile(join(destination, 'analysis.md'), 'Observed configuration only.');
          await writeFile(join(destination, 'execution.json'), JSON.stringify({ model: null, agentAic: 0, detectionAic: null }));
        }
      };
      const run = pair(directory, env, { now, request, download, wait: async () => assert.fail('Completed same-second runs must not require polling') });
      if (blocked) await assert.rejects(run, /unavailable/);
      else await run;
      const manifest = JSON.parse(await readFile(join(directory, 'pair.json'), 'utf8'));
      assert.equal(dispatched.length, 2);
      assert.equal(new Set(dispatched.map(run => run.display_title)).size, 2);
      assert.equal(manifest.children[0].reportReady, true);
      assert.equal(Boolean(manifest.children[1].reportReady), !blocked);
      assert.ok((await readFile(join(directory, 'baseline/report.md'), 'utf8')).includes('Observed configuration'));
      assert.equal(downloaded.length, blocked ? 2 : 4);
      assert.ok(!routes.some(({ route }) => route.includes('/issues')));
      assert.ok((await readFile(env.GITHUB_STEP_SUMMARY, 'utf8')).includes('No automatic comparison'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
