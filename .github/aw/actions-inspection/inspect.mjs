import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { command, ghAdapter, resolveConfig, SCHEMA_VERSION, utcSlices } from './common.mjs';
import { collectBaseline } from './baseline.mjs';
import { collectConfiguration, collectDefinitions } from './configuration.mjs';
import { boundedAgentInput, buildChecks, coverage } from './checks.mjs';

export { resolveConfig, utcSlices };

function escaped(value, limit = 500) {
  const text = String(value ?? 'unavailable').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}[\]()<>!|#]/g, '\\$&');
  return Buffer.byteLength(text) > limit ? `${Buffer.from(text).subarray(0, limit - 16).toString('utf8')} [truncated]` : text;
}

export function renderReport(result) {
  const lines = [
    '# GitHub Actions inspection', '',
    `- Backend: ${escaped(result.backend)}`,
    `- Repository: ${escaped(result.repository)}`,
    `- Trusted source/configuration SHA: \`${result.sourceSha}\``,
    `- Period: \`${result.since}\` inclusive to \`${result.until}\` exclusive`,
    `- Daily limit: ${result.dailyLimit} unique runs per intersecting UTC day`,
    `- Checks: ${result.checks.join(', ')}`,
    `- Schema/check/prompt versions: ${result.schemaVersion}/${result.checkVersion}/${result.promptVersion}`,
    '- Compact manifest: result.json. Complete typed facts, measurements, definitions and evidence: evidence.json; snapshots when applicable.',
    '', '## Deterministic facts', '',
  ];
  for (const name of result.checks) {
    const check = result.results[name], scope = result.coverage[name];
    const factsText = JSON.stringify(check.facts, null, 2);
    const shownFacts = Buffer.byteLength(factsText) <= 3000 ? factsText : JSON.stringify({ summary: 'Aggregate display exceeds the report budget; full typed facts are retained in evidence.json' }, null, 2);
    lines.push(`### ${name}`, '', `Coverage: **${scope.status}**.`, '', '```json', shownFacts, '```', '');
    if (scope.daily.length) {
      lines.push('| UTC day | Selected runs | Status |', '| --- | ---: | --- |');
      for (const day of scope.daily.slice(0, 32)) lines.push(`| ${day.day} | ${day.selectedRuns} | ${day.status} |`);
      const omitted = (scope.totalDailySlices ?? scope.daily.length) - Math.min(scope.daily.length, 32);
      if (omitted > 0) lines.push(`| Additional days retained in evidence.json | ${omitted} days | see artifact |`);
      lines.push('');
      if (scope.daily.some(day => day.selectionUncertainty)) lines.push('- Selection uncertainty: capped CLI discovery cannot prove the newest ID tie-break at saturated API boundaries.', '');
    }
    for (const issue of scope.issues.slice(0, 5)) lines.push(`- Coverage: ${escaped(issue.scope)}: ${escaped(issue.message, 250)}`);
    if ((scope.totalIssues ?? scope.issues.length) > 5) lines.push(`- ${(scope.totalIssues ?? scope.issues.length) - 5} additional coverage issues retained in evidence.json.`);
    lines.push('', `Findings/evidence: ${check.totalFindings ?? check.findings.length} total; first ${Math.min(10, check.findings.length)} shown.`, '');
    for (const finding of check.findings.slice(0, 10)) lines.push(`- \`${escaped(finding.key, 180)}\`: ${escaped(finding.details || JSON.stringify(finding), 300)}`);
    lines.push('', ...check.limitations.map(text => `- Limitation: ${text}`), '');
  }
  lines.push('## Agent interpretations', '', 'Not included in deterministic collection. Any appended analysis is interpretation, not a measured fact.', '', '## Execution and accounting', '', `- Producing run ID/attempt: ${result.runId || 'unavailable'}/${result.runAttempt || 'unavailable'}`, '- Actual model, token and credit usage: unavailable at collection; consult native gh-aw run logs/audit. No billing estimate is inferred.', '');
  const report = lines.join('\n');
  if (Buffer.byteLength(report) > 39000) {
    return `${Buffer.from(report).subarray(0, 38000).toString('utf8')}\n\nReport display truncated; complete deterministic results are retained in evidence.json.\n`;
  }
  return report;
}

export function compactManifest(result, agent = boundedAgentInput(result)) {
  const { results: fullResults, coverage: fullCoverage, ...metadata } = result;
  const manifest = { ...metadata, form: 'summary', fullEvidence: 'evidence.json', coverage: {}, results: {} };
  for (const name of result.checks) {
    const scope = fullCoverage[name];
    manifest.coverage[name] = {
      status: scope.status, issues: agent.checks[name].coverage.issues, totalIssues: scope.issues.length,
      daily: scope.daily.slice(0, 16), totalDailySlices: scope.daily.length,
      omittedDailySlices: Math.max(0, scope.daily.length - 16),
      selectedRuns: scope.daily.reduce((sum, day) => sum + day.selectedRuns, 0),
      truncatedDays: scope.daily.filter(day => day.truncated).length,
    };
    manifest.results[name] = {
      facts: agent.checks[name].facts, findings: agent.checks[name].evidence,
      totalFindings: fullResults[name].findings.length, limitations: fullResults[name].limitations,
      evidencePath: `evidence.json#/results/${name}`,
    };
  }
  if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) > 200000) throw new Error('bounded compact manifest exceeded 200000 bytes');
  return manifest;
}

export async function collect(backend, outputDir, { env = process.env, now = new Date(), api = ghAdapter(), run = command } = {}) {
  if (!['baseline', 'runner-kit'].includes(backend)) throw new Error('backend must be baseline or runner-kit');
  const config = resolveConfig(env, now);
  await mkdir(outputDir, { recursive: true });
  const ghVersion = await run('gh', ['--version']);
  let execution = { runs: [], attempts: [], jobs: [], daily: [], issues: [] };
  if (config.checks.some(check => check !== 'configuration')) {
    if (backend === 'baseline') execution = await collectBaseline(config, { api });
    else {
      const { collectRunnerKit } = await import('./runner-kit.mjs');
      execution = await collectRunnerKit(config, outputDir, { env, run });
    }
  }
  const definitions = config.checks.includes('configuration')
    ? await collectConfiguration(config, outputDir, { api, run })
    : config.checks.includes('performance') ? await collectDefinitions(config, outputDir, { run }) : null;
  const result = {
    schemaVersion: SCHEMA_VERSION, checkVersion: 1, promptVersion: 1, ...config, backend,
    runtime: { node: process.version, gh: ghVersion.code === 0 ? ghVersion.stdout.trim().split('\n')[0].slice(0, 200) : null, runnerKit: execution.tool || null },
    optionalCoverage: execution.optionalIssues || [],
    coverage: coverage(config, execution, definitions), results: buildChecks(config, execution, definitions),
  };
  const evidence = { ...result, form: 'full-evidence', execution, configuration: definitions };
  const agentInput = boundedAgentInput(result);
  const manifest = compactManifest(result, agentInput);
  for (const [name, value] of [['result.json', manifest], ['collect.json', manifest], ['evidence.json', evidence], ['agent-input.json', agentInput]]) {
    await writeFile(resolve(outputDir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  }
  await writeFile(resolve(outputDir, 'report.md'), renderReport(manifest), { mode: 0o600 });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, backend, outputDir] = process.argv.slice(2);
  if (operation !== 'collect' || !backend || !outputDir || process.argv.length !== 5) {
    console.error('Usage: node inspect.mjs collect {baseline|runner-kit} OUTPUT_DIR');
    process.exitCode = 1;
  } else {
    collect(backend, resolve(outputDir)).catch(error => {
      const controlled = /^(backend |GITHUB_|checks |days |daily limit |period |since |until |run attempt |bounded agent input|rendered report)/.test(error.message);
      console.error(controlled ? `Inspection failed: ${error.message}` : 'Inspection failed before a valid report could be written; inspect deterministic artifact coverage when present');
      process.exitCode = 1;
    });
  }
}
