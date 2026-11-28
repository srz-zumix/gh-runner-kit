import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { collect, compactManifest, renderReport, resolveConfig, utcSlices } from './inspect.mjs';
import { boundedMap, command, ghAdapter, id, parseSafeJSON } from './common.mjs';
import { collectBaseline, discoverRuns, normalizeJob, normalizeRun } from './baseline.mjs';
import { boundedAgentInput, buildChecks, coverage } from './checks.mjs';
import { isKnownCompilerDiagnostic, lintDiagnostics } from './configuration.mjs';
import { collectRunnerKit, normalizeSnapshot } from './runner-kit.mjs';

const env = { GITHUB_REPOSITORY: 'example-owner/example-repository', GITHUB_SHA: 'a'.repeat(40), INSPECTION_SINCE: '2026-01-01T00:00:00Z', INSPECTION_UNTIL: '2026-01-02T00:00:00Z', INSPECTION_CHECKS: 'reliability,performance' };
const config = () => resolveConfig(env);
const rawRun = (id = 10, extra = {}) => ({ id, run_attempt: 1, name: 'Synthetic workflow', path: '.github/workflows/synthetic.yml', created_at: '2026-01-01T12:00:00Z', status: 'completed', conclusion: 'success', ...extra });
const rawJob = (id = 100, extra = {}) => ({ id, run_id: 10, run_attempt: 1, runner_id: 2000, name: 'Synthetic job', status: 'completed', conclusion: 'success', created_at: '2026-01-01T12:00:00Z', started_at: '2026-01-01T12:01:00Z', completed_at: '2026-01-01T12:03:00Z', labels: ['ubuntu-latest'], steps: [], ...extra });
const emptyData = () => ({ runs: [], attempts: [], jobs: [], daily: [], issues: [] });

test('rolling seven days uses eight partial UTC days and default end has whole seconds', () => {
  const resolved = resolveConfig({ ...env, INSPECTION_SINCE: '', INSPECTION_UNTIL: '' }, new Date('2026-01-08T12:00:00.789Z'));
  assert.equal(resolved.until, '2026-01-08T12:00:00.000Z');
  const slices = utcSlices(resolved.since, resolved.until);
  assert.equal(slices.length, 8);
  assert.equal(slices[0].since, resolved.since);
  assert.equal(slices[7].until, resolved.until);
  assert.equal(utcSlices('2026-01-01T00:00:00Z', '2026-01-08T00:00:00Z').length, 7);
});

test('reject invalid, unbounded and duplicate configuration', () => {
  for (const change of [{ INSPECTION_DAYS: '-7' }, { INSPECTION_DAILY_LIMIT: '0' }, { INSPECTION_DAILY_LIMIT: '1001' }, { INSPECTION_DAYS: 'Infinity' }, { INSPECTION_CHECKS: 'reliability,reliability' }, { INSPECTION_CHECKS: 'unknown' }, { INSPECTION_SINCE: '2026-01-03T00:00:00Z' }, { INSPECTION_UNTIL: '2026-02-30T00:00:00Z' }, { GITHUB_SHA: 'main' }]) {
    assert.throws(() => resolveConfig({ ...env, ...change }));
  }
});

test('configuration and UTC slices enforce 31-day bounds, past end and whole seconds', () => {
  const now = new Date('2026-02-02T00:00:00.500Z');
  const resolved = resolveConfig({ ...env, INSPECTION_DAYS: '31', INSPECTION_SINCE: '', INSPECTION_UNTIL: '2026-02-02T00:00:00Z' }, now);
  assert.equal(resolved.since, '2026-01-02T00:00:00.000Z');
  assert.equal(utcSlices(resolved.since, resolved.until).length, 31);
  for (const change of [
    { INSPECTION_DAYS: '32' },
    { INSPECTION_SINCE: '2026-01-01T00:00:00Z', INSPECTION_UNTIL: '2026-02-02T00:00:00Z' },
    { INSPECTION_UNTIL: '2026-02-02T00:00:01Z' },
    { INSPECTION_SINCE: '2026-01-01T00:00:00.001Z' },
    { INSPECTION_UNTIL: '2026-01-02T00:00:00.001Z' },
  ]) assert.throws(() => resolveConfig({ ...env, ...change }, now));
  assert.throws(() => utcSlices('2026-01-01T00:00:00Z', '2026-02-02T00:00:00Z'));
  assert.throws(() => utcSlices('2026-01-01T00:00:00.001Z', '2026-01-02T00:00:00Z'));
});

test('large numeric IDs stay exact, unsafe supplied numbers and exponents are rejected', () => {
  const value = parseSafeJSON('{"id":9007199254740993,"name":"9007199254740993 \\"safe\\"","duration":1.5}');
  assert.equal(value.id, '9007199254740993');
  assert.equal(value.duration, 1.5);
  assert.equal(id(value.id), '9007199254740993');
  assert.throws(() => id(9007199254740993));
  assert.throws(() => parseSafeJSON('{"id":9.007199254740993e15}'));
});

test('gh adapter exposes HTTP failure without subprocess stderr or credentials', async () => {
  const api = ghAdapter(async () => ({ code: 1, stderr: 'gh: forbidden (HTTP 403) token super-secret-value', stdout: '' }));
  await assert.rejects(api('/repos/example-owner/example-repository/actions/runs'), error => error.message.includes('HTTP 403') && !error.message.includes('super-secret'));
});

test('bounded pool limits concurrency and retains input order', async () => {
  let active = 0, maximum = 0;
  const values = await boundedMap([1, 2, 3, 4, 5], 2, async value => {
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 3));
    active--;
    return value * 2;
  });
  assert.equal(maximum, 2);
  assert.deepEqual(values, [2, 4, 6, 8, 10]);
});

test('selection deduplicates, applies exclusive end, stable newest IDs and caps before jobs', async () => {
  const jobs = [];
  const result = await collectBaseline({ ...config(), dailyLimit: 2 }, { api: async endpoint => {
    if (endpoint.includes('/jobs')) { jobs.push(endpoint); return { jobs: [rawJob(endpoint.includes('/12/') ? 120 : 110, { run_id: endpoint.includes('/12/') ? 12 : 11 })] }; }
    return { total_count: 5, workflow_runs: [rawRun(10), rawRun(12), rawRun(12), rawRun(11), rawRun(13, { created_at: '2026-01-02T00:00:00Z' })] };
  } });
  assert.deepEqual(result.runs.map(run => run.id), ['12', '11']);
  assert.equal(jobs.length, 2);
  assert.equal(result.daily[0].status, 'partial');
  assert.equal(result.daily[0].truncated, true);
});

test('saturated discovery splits into seconds, paginates, then keeps newest run IDs', async () => {
  const seen = [];
  const slice = { since: '2026-01-01T00:00:00.000Z', until: '2026-01-01T00:00:04.000Z' };
  const result = await discoverRuns(async endpoint => {
    seen.push(endpoint);
    const url = new URL(endpoint, 'https://api.example.invalid');
    const range = url.searchParams.get('created');
    if (range.includes('00:00:00Z..2026-01-01T00:00:03Z')) return { total_count: 1200, workflow_runs: [] };
    const page = Number(url.searchParams.get('page'));
    return {
      total_count: 101,
      workflow_runs: Array.from({ length: page === 1 ? 100 : 1 }, (_, index) => rawRun(1000 + (page - 1) * 100 + index, { created_at: '2026-01-01T00:00:03Z' })),
    };
  }, config().repository, slice, 2);
  assert.deepEqual(result.runs.map(run => run.id), ['1100', '1099']);
  assert.ok(seen.some(endpoint => endpoint.includes('page=2')));
  assert.equal(result.truncated, true);
});

test('unsplittable search saturation reports incomplete selection', async () => {
  const result = await discoverRuns(async () => ({ total_count: 1001, workflow_runs: [rawRun()] }), config().repository, { since: '2026-01-01T12:00:00Z', until: '2026-01-01T12:00:00.500Z' }, 1000);
  assert.match(result.issues[0], /saturation/);
});

test('exactly 1000 advertised runs within one second also signal search saturation', async () => {
  const result = await discoverRuns(async () => ({
    total_count: 1000, workflow_runs: Array.from({ length: 1000 }, (_, index) => rawRun(index + 1)),
  }), config().repository, { since: '2026-01-01T12:00:00Z', until: '2026-01-01T12:00:01Z' }, 1000);
  assert.equal(result.runs.length, 1000);
  assert.ok(result.issues.some(message => message.includes('saturation')));
});

test('all attempts retained, carried-over job executions counted once, recoveries not called flakiness', async () => {
  const data = await collectBaseline(config(), { api: async endpoint => {
    if (endpoint.includes('/attempts/1/jobs')) return { jobs: [rawJob(100)] };
    if (endpoint.includes('/attempts/1')) return rawRun(10, { conclusion: 'failure' });
    if (endpoint.includes('/jobs')) return { jobs: [rawJob(100), rawJob(101, { run_attempt: 2 })] };
    return { total_count: 1, workflow_runs: [rawRun(10, { run_attempt: 2 })] };
  } });
  assert.equal(data.attempts.length, 1);
  assert.equal(data.jobs.length, 2);
  const checks = buildChecks(config(), data, null);
  assert.equal(checks.reliability.facts.observedFailureToSuccessSequences, 1);
  assert.equal(checks.performance.facts.jobWait.p50, 60);
  assert.equal(checks.performance.facts.jobExecution.p95, 120);
});

test('missing history and failed day are explicit partial coverage, not zero failure evidence', async () => {
  const data = await collectBaseline(config(), { api: async endpoint => {
    if (endpoint.includes('/attempts/')) throw new Error('HTTP 404 retained history unavailable');
    if (endpoint.includes('/jobs')) return { jobs: [] };
    return { total_count: 1, workflow_runs: [rawRun(10, { run_attempt: 2 })] };
  } });
  assert.equal(data.attempts.length, 0);
  assert.equal(data.issues.length, 2);
  assert.equal(data.daily[0].status, 'partial');
});

test('skip/nonstarted timings unavailable, real zero retained, repeated step names keep identities', () => {
  const data = emptyData();
  data.runs = [normalizeRun(rawRun())];
  data.jobs = [
    normalizeJob(rawJob(100, { conclusion: 'skipped' }), 10, true),
    normalizeJob(rawJob(101, { status: 'queued', conclusion: null, started_at: null }), 10, true),
    normalizeJob(rawJob(102, { started_at: '2026-01-01T12:00:00Z', steps: [
      { number: 1, name: 'repeated', status: 'completed', conclusion: 'success', started_at: '2026-01-01T12:00:00Z', completed_at: '2026-01-01T12:00:00Z' },
      { number: 2, name: 'repeated', status: 'completed', conclusion: 'skipped' },
    ] }), 10, true),
  ];
  const result = buildChecks(config(), data, null).performance;
  assert.equal(result.facts.jobWait.samples, 1);
  assert.equal(result.facts.jobWait.p50, 0);
  assert.equal(result.facts.jobsWithoutWait, 2);
  assert.equal(result.facts.stepExecution.samples, 1);
  assert.notEqual(result.measurements.steps[0].key, result.measurements.steps[1].key);
  assert.equal(buildChecks(config(), emptyData(), null).performance.facts.jobWait.p50, null);
});

test('step occurrences count matching names rather than intervening step positions', () => {
  const job = normalizeJob(rawJob(100, { steps: [{ name: 'Upload' }, { name: 'Other' }, { name: 'Upload' }] }), 10);
  assert.deepEqual(job.steps.map(step => [step.name, step.occurrence, step.number]), [['Upload', 1, 1], ['Other', 1, 2], ['Upload', 2, 3]]);
});

test('reruns retain standalone evidence when no recovery is observed', () => {
  const data = emptyData();
  data.runs = [normalizeRun(rawRun(10, { run_attempt: 2, conclusion: 'failure' }))];
  data.attempts = [normalizeRun(rawRun(10, { conclusion: 'failure' }))];
  const results = buildChecks(config(), data, null);
  assert.equal(results.reliability.facts.observedFailureToSuccessSequences, 0);
  assert.ok(results.reliability.findings.some(row => row.key === 'reliability:rerun:10:2' && row.expectedHistoricalAttempts === 1));
  const result = { ...config(), backend: 'baseline', results, coverage: coverage(config(), data, null) };
  assert.ok(boundedAgentInput(result).checks.reliability.evidence.some(row => row.key === 'reliability:rerun:10:2'));
});

test('longest waits have distinct, duration-independent evidence within the agent cap', () => {
  const data = emptyData();
  data.jobs = [
    normalizeJob(rawJob(100, { started_at: '2026-01-01T12:00:10Z', completed_at: '2026-01-01T12:10:10Z' }), 10),
    normalizeJob(rawJob(101, { started_at: '2026-01-01T12:20:00Z', completed_at: '2026-01-01T12:20:01Z' }), 10),
    normalizeJob(rawJob(102, { status: 'in_progress', conclusion: null, started_at: '2026-01-01T12:30:00Z', completed_at: null }), 10),
  ];
  const results = buildChecks(config(), data, null);
  const waits = results.performance.findings.filter(row => row.key.startsWith('performance:wait:'));
  assert.deepEqual(waits.map(row => [row.jobId, row.waitSeconds]), [['102', 1800], ['101', 1200], ['100', 10]]);
  const result = { ...config(), backend: 'baseline', results, coverage: coverage(config(), data, null) };
  const evidence = boundedAgentInput(result).checks.performance.evidence;
  assert.ok(evidence.some(row => row.key === 'performance:wait:10:102'));
  assert.ok(evidence.some(row => row.key === 'performance:job:10:100'));
  assert.ok(evidence.length <= 20);
});

test('JSON lint adapters use actionlint and zizmor concrete locations', () => {
  assert.equal(lintDiagnostics('actionlint', '[{"kind":"expression","message":"synthetic warning","line":3,"column":2}]', '.github/workflows/example.yml')[0].line, 3);
  const rows = lintDiagnostics('zizmor', JSON.stringify([{ ident: 'unpinned-uses', desc: 'synthetic diagnostic', determinations: { severity: 'High', confidence: 'High' }, locations: [{ symbolic: { kind: 'Primary' }, concrete: { location: { start_point: { row: 5, column: 8 } } } }] }]), '.github/workflows/example.yml');
  assert.equal(rows[0].line, 6);
  assert.equal(rows[0].column, 9);
  assert.equal(rows[0].severity, 'high');
  assert.throws(() => lintDiagnostics('zizmor', '[{}]', 'example.yml'));
});

const compilerContent = [
  '# gh-aw-metadata: {"schema_version":"v4","compiler_version":"v1.2.2","strict":true}',
  'permissions:',
  '  copilot-requests: write # Synthetic compiler declaration',
  'concurrency:',
  '  queue: max',
  'jobs:',
  '  synthetic:',
  '    cache-mode: read',
  '    env:',
  '      REF: ${{ job.workflow_ref }}',
  '      SHA: ${{ job.workflow_sha }}',
  '    permissions: write-all',
].join('\n');

const compilerDiagnostics = [
  { message: 'unknown permission scope "copilot-requests". all available permission scopes are "contents"', kind: 'permissions', line: 3 },
  { message: 'unexpected key "queue" for "concurrency" section. expected one of "group"', kind: 'syntax-check', line: 5 },
  { message: 'unexpected key "cache-mode" for "job" section. expected one of "runs-on"', kind: 'syntax-check', line: 8 },
  { message: 'property "workflow_ref" is not defined in object type {status: string}', kind: 'expression', line: 10 },
  { message: 'property "workflow_sha" is not defined in object type {status: string}', kind: 'expression', line: 11 },
];

test('compiler compatibility exclusions require exact paired locks, metadata, kinds and declarations', () => {
  const file = { path: '.github/workflows/actions-inspection-baseline.lock.yml', content: compilerContent };
  const diagnostics = lintDiagnostics('actionlint', JSON.stringify(compilerDiagnostics), file.path);
  for (const diagnostic of diagnostics) {
    assert.equal(isKnownCompilerDiagnostic(diagnostic, file), true);
    assert.equal(isKnownCompilerDiagnostic(diagnostic, { ...file, path: '.github/workflows/actions-inspection-runner-kit.lock.yml' }), true);
    for (const path of ['.github/workflows/actions-inspection-other.lock.yml', '.github/workflows/actions-inspection-baseline.yml', '.github/workflows/nested/actions-inspection-baseline.lock.yml']) {
      assert.equal(isKnownCompilerDiagnostic(diagnostic, { ...file, path }), false);
    }
    for (const content of [compilerContent.split('\n').slice(1).join('\n'), `\n${compilerContent}`, compilerContent.replace('"v1.2.2"', '"v1.3.0"'), compilerContent.replace('"strict":true', '"strict":false'), '# gh-aw-metadata: invalid JSON\n']) {
      assert.equal(isKnownCompilerDiagnostic(diagnostic, { ...file, content }), false);
    }
    assert.equal(isKnownCompilerDiagnostic({ ...diagnostic, rule: 'unrelated-rule' }, file), false);
    assert.equal(isKnownCompilerDiagnostic({ ...diagnostic, tool: 'zizmor' }, file), false);
  }
  assert.equal(isKnownCompilerDiagnostic(diagnostics[0], { ...file, content: compilerContent.replace('copilot-requests: write', 'copilot-requests: invalid') }), false);
  assert.equal(isKnownCompilerDiagnostic(diagnostics[1], { ...file, content: compilerContent.replace('queue: max', 'queue: invalid') }), false);
  assert.equal(isKnownCompilerDiagnostic(diagnostics[2], { ...file, content: compilerContent.replace('cache-mode: read', 'cache-mode: invalid') }), false);
  assert.equal(isKnownCompilerDiagnostic(diagnostics[3], { ...file, content: compilerContent.replace('job.workflow_ref', 'matrix.workflow_ref') }), false);
  assert.equal(isKnownCompilerDiagnostic({ ...diagnostics[0], message: 'unknown permission scope "unrecognized-scope". all available permission scopes are "contents"' }, file), false);
});

test('configuration drops only known compiler diagnostics and preserves permission findings and tool failures', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-compiler-exceptions');
  const paths = ['.github/workflows/actions-inspection-baseline.lock.yml', '.github/workflows/unrelated.lock.yml', '.github/workflows/unknown-schema.yml'];
  try {
    const result = await collect('baseline', output, {
      env: { ...env, INSPECTION_CHECKS: 'configuration' },
      api: async () => ({ enabled: true }),
      run: async (binary, args) => {
        if (binary === 'git' && args[0] === 'ls-tree') return { code: 0, stdout: paths.map(path => `100644 blob ${'d'.repeat(40)}\t${path}\0`).join('') };
        if (binary === 'git') return { code: 0, stdout: compilerContent };
        if (args[0] === '-version' || args[0] === '--version') return { code: 0, stdout: binary === 'actionlint' ? '1.7.12' : 'synthetic version' };
        const paired = args.at(-1).endsWith('actions-inspection-baseline.lock.yml');
        if (args.at(-1).endsWith('unknown-schema.yml')) return { code: binary === 'actionlint' ? 1 : 0, stdout: binary === 'actionlint' ? '[{}]' : '[]' };
        if (binary === 'actionlint') return {
          code: 1,
          stdout: JSON.stringify(paired ? [...compilerDiagnostics, { message: 'unknown permission scope "unrecognized-scope". all available permission scopes are "contents"', kind: 'permissions', line: 12 }] : [compilerDiagnostics[0]]),
        };
        if (paired) return {
          code: 14,
          stdout: JSON.stringify([{ ident: 'excessive-permissions', desc: 'overly broad permissions', determinations: { severity: 'High', confidence: 'High' }, locations: [{ symbolic: { kind: 'Primary' }, concrete: { location: { start_point: { row: 11, column: 4 } } } }] }]),
        };
        return { code: -1, stdout: '', stderr: 'not retained' };
      },
    });
    const evidence = JSON.parse(await readFile(`${output}/evidence.json`, 'utf8'));
    assert.equal(evidence.configuration.ignoredCompilerDiagnostics.length, 5);
    assert.equal(result.results.configuration.facts.ignoredCompilerDiagnostics, 5);
    assert.ok(evidence.configuration.diagnostics.some(row => row.tool === 'zizmor' && row.rule === 'excessive-permissions'));
    assert.ok(evidence.configuration.diagnostics.some(row => row.message.includes('unrecognized-scope')));
    assert.ok(evidence.configuration.diagnostics.some(row => row.path === paths[1] && row.message.includes('copilot-requests')));
    assert.equal(result.coverage.configuration.status, 'partial');
    assert.ok(evidence.configuration.issues.some(issue => issue.scope === `zizmor:${paths[1]}`));
    assert.ok(evidence.configuration.issues.some(issue => issue.scope === `actionlint:${paths[2]}`));
    assert.ok(result.results.configuration.limitations.some(text => text.includes('known actionlint compatibility')));
    assert.equal(evidence.configuration.toolOutputs.length, 6);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('baseline configuration-only never fetches runs or invokes/imports runner CLI; artifacts deterministic', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-configuration');
  const calls = [];
  try {
    const result = await collect('baseline', output, {
      env: { ...env, INSPECTION_CHECKS: 'configuration' },
      api: async endpoint => { calls.push(endpoint); throw new Error('HTTP 403 settings unavailable'); },
      run: async (binary, args) => {
        calls.push(`${binary} ${args.join(' ')}`);
        if (binary === 'git' && args[0] === 'ls-tree') return { code: 0, stdout: `100644 blob ${'b'.repeat(40)}\t.github/workflows/example.yml\0` };
        if (binary === 'git') return { code: 0, stdout: 'on: push\njobs: {}\n' };
        return { code: -1, stdout: '', stderr: 'tool missing' };
      },
    });
    assert.equal(result.coverage.configuration.status, 'partial');
    assert.equal(result.results.configuration.facts.unavailableSettings, 3);
    assert.ok(!calls.some(call => call.includes('/actions/runs') || call.includes('metrics collect')));
    assert.equal(await readFile(`${output}/report.md`, 'utf8'), renderReport(result));
    assert.ok((await readFile(`${output}/agent-input.json`)).length < 150000);
    assert.equal((JSON.parse(await readFile(`${output}/evidence.json`, 'utf8'))).configuration.files[0].content, 'on: push\njobs: {}\n');
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('agent receives no more than 20 evidence records per selected check, full results unchanged', () => {
  const data = emptyData();
  data.runs = Array.from({ length: 30 }, (_, index) => normalizeRun(rawRun(index + 1, { conclusion: 'failure' })));
  const result = { ...config(), schemaVersion: 1, backend: 'baseline', results: buildChecks(config(), data, null), coverage: Object.fromEntries(config().checks.map(check => [check, { status: 'complete', issues: [] }])) };
  assert.equal(boundedAgentInput(result).checks.reliability.evidence.length, 20);
  assert.equal(result.results.reliability.findings.length, 30);
});

const snapshot = () => ({
  Version: 1, Repo: { Host: 'github.com', Owner: 'example-owner', Name: 'example-repository' },
  Contents: { Jobs: true, AllAttempts: true, Runners: true },
  Data: {
    Runs: [rawRun(10, { run_attempt: 2 })], Attempts: [rawRun(10, { conclusion: 'failure' })],
    Jobs: [rawJob(100), rawJob(101, { run_attempt: 2 })], LatestJobs: { 100: true, 101: true },
    Repos: [{ Repository: { Owner: 'example-owner', Name: 'example-repository' }, Runs: 1, Truncated: false }],
    Truncated: false, Warnings: [],
  },
});

test('baseline and snapshots distinguish cancelled timestamps from actual execution evidence', async () => {
  const jobs = [
    rawJob(100, { runner_id: 0, conclusion: 'cancelled' }),
    rawJob(101, { runner_id: '0', conclusion: 'cancelled', steps: [{ name: 'Skipped', status: 'completed', conclusion: 'skipped', started_at: '2026-01-01T12:01:00Z', completed_at: '2026-01-01T12:01:00Z' }] }),
    rawJob(102, { runner_id: null, conclusion: 'cancelled', steps: [{ name: 'Started', status: 'completed', conclusion: 'success', started_at: '2026-01-01T12:01:00Z', completed_at: '2026-01-01T12:02:00Z' }] }),
    rawJob(103, { conclusion: 'cancelled' }),
  ];
  const baseline = await collectBaseline(config(), { api: async endpoint => endpoint.includes('/jobs') ? { jobs } : { total_count: 1, workflow_runs: [rawRun()] } });
  const input = snapshot();
  input.Data.Runs = [rawRun()];
  input.Data.Attempts = [];
  input.Data.Jobs = jobs;
  input.Data.LatestJobs = Object.fromEntries(jobs.map(job => [job.id, true]));
  const optimized = normalizeSnapshot(input, config(), utcSlices(config().since, config().until)[0]);
  for (const data of [baseline, optimized]) {
    assert.deepEqual(data.jobs.map(job => job.executionStarted), [false, false, true, true]);
    const performance = buildChecks(config(), data, null).performance;
    assert.equal(performance.facts.jobExecution.samples, 2);
    assert.equal(performance.facts.jobWait.samples, 2);
    assert.deepEqual(performance.measurements.jobs.map(job => job.executionSeconds), [null, null, 120, 120]);
    assert.ok(!performance.findings.some(row => ['performance:wait:10:100', 'performance:job:10:100'].includes(row.key)));
  }
});

test('baseline and runner-kit normalization independently meet the same synthetic neutral expectation', async () => {
  const baseline = await collectBaseline(config(), { api: async endpoint => {
    if (endpoint.includes('/attempts/1/jobs')) return { jobs: [rawJob(100)] };
    if (endpoint.includes('/attempts/1')) return rawRun(10, { conclusion: 'failure' });
    if (endpoint.includes('/jobs')) return { jobs: [rawJob(100), rawJob(101, { run_attempt: 2 })] };
    return { total_count: 1, workflow_runs: [rawRun(10, { run_attempt: 2 })] };
  } });
  const optimized = normalizeSnapshot(snapshot(), config(), utcSlices(config().since, config().until)[0]);
  for (const data of [baseline, optimized]) {
    const checks = buildChecks(config(), data, null);
    assert.deepEqual(checks.reliability.facts, {
      selectedRuns: 1, latestConclusions: { success: 1 }, latestFailedRuns: 0,
      rerunRuns: 1, rerunDenominator: 1, expectedHistoricalAttempts: 1,
      observedHistoricalAttempts: 1, uniqueJobExecutions: 2, observedFailureToSuccessSequences: 1,
      latestJobConclusions: { success: 2 }, historicalOnlyJobConclusions: {},
    });
    assert.deepEqual(checks.performance.facts.jobExecution, { unit: 'seconds', samples: 2, p50: 120, p95: 120, maximum: 120 });
    assert.deepEqual(data.jobs.map(job => [job.id, job.attempt, job.latest]), [['100', 1, true], ['101', 2, true]]);
  }
});

test('optimized CLI collects each slice once with bounded arguments and reuses gzip offline', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-runner-kit');
  const calls = [];
  try {
    const data = await collectRunnerKit(config(), output, {
      env: { RUNNER_KIT_BIN: '/trusted/bin/gh-runner-kit' },
      run: async (binary, args) => {
        calls.push([binary, args]);
        if (args[0] === '--version') return { code: 0, stdout: 'synthetic runner-kit version' };
        const path = args[args.indexOf('--output') + 1];
        await writeFile(path, gzipSync(JSON.stringify(snapshot())));
        return { code: 0, stdout: '', stderr: 'not persisted' };
      },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1][0], '/trusted/bin/gh-runner-kit');
    assert.deepEqual(calls[1][1].slice(0, 4), ['metrics', 'collect', '--repo', env.GITHUB_REPOSITORY]);
    assert.ok(calls[1][1].includes('--all-attempts'));
    assert.ok(calls[1][1].includes('--no-cache'));
    assert.equal(data.daily[0].status, 'complete');
    assert.equal(data.snapshots.length, 1);
    assert.equal(data.jobs.length, 2);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('optimized inventory warnings optional, unavailable history partial, saturated boundary uncertainty explicit', () => {
  const input = snapshot();
  input.Data.Warnings = ['skipped the runner inventory of example-owner/example-repository: HTTP 403'];
  const slice = utcSlices(config().since, config().until)[0];
  const first = normalizeSnapshot(input, config(), slice);
  assert.equal(first.daily.status, 'complete');
  assert.equal(first.optionalIssues.length, 1);
  input.Data.Warnings.push('historical run 10 attempt 1 is unavailable: HTTP 404');
  input.Data.Attempts = [];
  input.Data.Truncated = true;
  const second = normalizeSnapshot(input, config(), slice);
  assert.equal(second.daily.status, 'partial');
  assert.equal(second.daily.truncated, true);
  assert.match(second.daily.selectionUncertainty, /tie-break/);
  assert.equal(second.issues.length, 1);
  assert.throws(() => normalizeSnapshot({ ...input, Version: 2 }, config(), slice));
});

test('optimized unavailable binary creates explicit failed slices without exposing stderr', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-missing-binary');
  try {
    const data = await collectRunnerKit(config(), output, { env: {}, run: async () => ({ code: -1, stdout: '', stderr: 'secret-value' }) });
    assert.equal(data.daily[0].status, 'failed');
    assert.ok(!JSON.stringify(data).includes('secret-value'));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('safe snapshot JSON retains IDs beyond Number precision', () => {
  const text = JSON.stringify(snapshot()).replaceAll('"id":10,', '"id":9007199254740993,').replaceAll('"run_id":10,', '"run_id":9007199254740993,');
  const data = normalizeSnapshot(parseSafeJSON(text), config(), utcSlices(config().since, config().until)[0]);
  assert.equal(data.runs[0].id, '9007199254740993');
  assert.equal(data.jobs[0].runId, '9007199254740993');
});

test('no activity, failed discovery and intentional truncation have distinct coverage', async () => {
  for (const [status, response] of [
    ['no_activity', { total_count: 0, workflow_runs: [] }],
    ['truncated', { total_count: 2, workflow_runs: [rawRun(10), rawRun(11)] }],
    ['failed', null],
  ]) {
    const resolved = { ...config(), dailyLimit: 1 };
    const data = await collectBaseline(resolved, { api: async endpoint => {
      if (endpoint.includes('/jobs')) return { jobs: [rawJob(100, { run_id: 11 })] };
      if (!response) throw new Error('HTTP 403 unavailable discovery');
      return response;
    } });
    assert.equal(coverage(resolved, data, null).reliability.status, status);
  }
});

test('installed lint tools inspect synthetic definitions as data and emit supported JSON', async t => {
  for (const [binary, args] of [['actionlint', ['-version']], ['zizmor', ['--version']]]) {
    if ((await command(binary, args)).code !== 0) { t.skip(`${binary} not installed`); return; }
  }
  const output = resolve('.github/aw/actions-inspection/.test-output-real-linters');
  try {
    const result = await collect('baseline', output, {
      env: { ...env, INSPECTION_CHECKS: 'configuration' },
      api: async () => ({ enabled: true, allowed_actions: 'all', default_workflow_permissions: 'read' }),
      run: async (binary, args) => {
        if (binary === 'git' && args[0] === 'ls-tree') return { code: 0, stdout: `100644 blob ${'b'.repeat(40)}\t.github/workflows/example.yml\0` };
        if (binary === 'git') return { code: 0, stdout: 'on: push\njobs:\n  synthetic:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: echo "${{ invalid }}"\n' };
        return command(binary, args);
      },
    });
    const findings = JSON.parse(await readFile(`${output}/evidence.json`, 'utf8')).results.configuration.findings;
    assert.ok(findings.some(row => row.tool === 'actionlint' && row.rule === 'expression'));
    assert.ok(findings.some(row => row.tool === 'zizmor'));
    assert.equal(result.coverage.configuration.status, 'complete');
    assert.ok(findings.every(row => row.path === '.github/workflows/example.yml' && row.line > 0));
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('bounded agent JSON and report remain bounded with multibyte hostile evidence names', () => {
  const data = emptyData();
  const name = '🦊"`<>'.repeat(10000);
  data.runs = Array.from({ length: 60 }, (_, index) => normalizeRun(rawRun(index + 1, { conclusion: 'failure', name })));
  data.jobs = Array.from({ length: 60 }, (_, index) => normalizeJob(rawJob(index + 1, { name, conclusion: 'failure', labels: [name], steps: Array.from({ length: 30 }, (_, step) => ({ number: step + 1, name, status: 'completed', conclusion: 'failure', started_at: '2026-01-01T12:00:00Z', completed_at: '2026-01-01T12:02:00Z' })) }), 10, true));
  const resolved = config();
  const result = { ...resolved, schemaVersion: 1, checkVersion: 1, promptVersion: 1, backend: 'baseline', results: buildChecks(resolved, data, null), coverage: coverage(resolved, data, null) };
  const input = boundedAgentInput(result);
  assert.ok(Buffer.byteLength(JSON.stringify(input, null, 2)) < 150000);
  assert.equal(input.checks.reliability.evidence.length, 20);
  assert.equal(input.checks.performance.evidence.length, 20);
  assert.ok(input.checks.performance.evidence.some(row => row.key.startsWith('performance:step:')));
  const report = renderReport(result);
  assert.ok(Buffer.byteLength(report) < 40000);
  assert.ok(report.includes('## Agent interpretations'));
});

test('CLI recognizes collect arguments without running on import', async () => {
  const response = await command(process.execPath, [resolve('.github/aw/actions-inspection/inspect.mjs'), 'collect', 'baseline', '.github/aw/actions-inspection/.test-invalid-cli'], { env: { ...process.env, GITHUB_REPOSITORY: '', GITHUB_SHA: '' } });
  assert.equal(response.code, 1);
  assert.match(response.stderr, /GITHUB_REPOSITORY/);
  assert.ok(!response.stderr.includes('Usage:'));
});

test('compact manifest retains provenance while full deterministic findings stay in evidence', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-compact');
  try {
    const result = await collect('baseline', output, {
      env: { ...env, INSPECTION_CHECKS: 'reliability' },
      api: async endpoint => {
        const jobRunId = endpoint.match(/\/runs\/(\d+)\/jobs/);
        if (jobRunId) return { jobs: [rawJob(Number(jobRunId[1]) + 100, { run_id: jobRunId[1], conclusion: 'failure' })] };
        return { total_count: 30, workflow_runs: Array.from({ length: 30 }, (_, index) => rawRun(index + 1, { conclusion: 'failure' })) };
      },
      run: async (binary, args) => {
        assert.equal(binary, 'gh');
        assert.deepEqual(args, ['--version']);
        return { code: 0, stdout: 'gh version synthetic' };
      },
    });
    const full = JSON.parse(await readFile(`${output}/evidence.json`, 'utf8'));
    assert.equal(result.form, 'summary');
    assert.equal(result.sourceSha, env.GITHUB_SHA);
    assert.equal(result.repository, env.GITHUB_REPOSITORY);
    assert.equal(result.results.reliability.findings.length, 20);
    assert.equal(result.results.reliability.totalFindings, 60);
    assert.equal(full.results.reliability.findings.length, 60);
    assert.equal(full.execution.jobs.length, 30);
    assert.equal(result.fullEvidence, 'evidence.json');
    assert.ok((await readFile(`${output}/result.json`)).length < 200000);
    assert.deepEqual(JSON.parse(await readFile(`${output}/collect.json`, 'utf8')), result);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('performance-only reads definitions without lint tools or permission API requests', async () => {
  const output = resolve('.github/aw/actions-inspection/.test-output-performance-only');
  const calls = [];
  try {
    const result = await collect('baseline', output, {
      env: { ...env, INSPECTION_CHECKS: 'performance' },
      api: async endpoint => {
        assert.ok(endpoint.includes('/actions/runs'));
        return { total_count: 0, workflow_runs: [] };
      },
      run: async (binary, args) => {
        calls.push(binary);
        if (binary === 'gh') return { code: 0, stdout: 'gh synthetic version' };
        if (args[0] === 'ls-tree') return { code: 0, stdout: `100644 blob ${'c'.repeat(40)}\t.github/workflows/example.yml\0` };
        return { code: 0, stdout: 'on: push\njobs: {}\n' };
      },
    });
    assert.deepEqual([...new Set(calls)].sort(), ['gh', 'git']);
    assert.equal(result.results.performance.facts.workflowDefinitions.files, 1);
    assert.ok(result.results.performance.findings.some(row => row.key.startsWith('performance:definition:')));
    const evidence = JSON.parse(await readFile(`${output}/evidence.json`, 'utf8'));
    assert.equal(evidence.configuration.files.length, 1);
    assert.deepEqual(evidence.configuration.settings, []);
  } finally { await rm(output, { recursive: true, force: true }); }
});
