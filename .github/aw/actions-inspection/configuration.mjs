import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { command, parseSafeJSON } from './common.mjs';

export function isKnownCompilerDiagnostic(diagnostic, file) {
  if (diagnostic.tool !== 'actionlint' || typeof diagnostic.message !== 'string' || !Number.isInteger(diagnostic.line) || diagnostic.line < 1 || !/^\.github\/workflows\/actions-inspection-(?:baseline|runner-kit)\.lock\.yml$/.test(file.path)) return false;
  const header = file.content.match(/^# gh-aw-metadata: ([^\r\n]+)(?:\r?\n|$)/);
  if (!header) return false;
  try {
    const metadata = parseSafeJSON(header[1]);
    if (metadata.schema_version !== 'v4' || metadata.compiler_version !== 'v1.2.2' || metadata.strict !== true) return false;
  } catch { return false; }
  const line = file.content.split(/\r?\n/)[diagnostic.line - 1] || '';
  const property = diagnostic.message.match(/^property "(workflow_ref|workflow_sha)" is not defined in object type /);
  if (diagnostic.rule === 'expression' && property) {
    return new RegExp(`\\$\\{\\{\\s*job\\.${property[1]}\\s*\\}\\}`).test(line);
  }
  return [
    { rule: 'permissions', message: /^unknown permission scope "copilot-requests"\./, source: /^\s+copilot-requests:\s*write(?:\s+#.*)?\s*$/ },
    { rule: 'syntax-check', message: /^unexpected key "cache-mode" for "job" section\./, source: /^\s+cache-mode:\s*read(?:\s+#.*)?\s*$/ },
    { rule: 'syntax-check', message: /^unexpected key "queue" for "concurrency" section\./, source: /^\s+queue:\s*max(?:\s+#.*)?\s*$/ },
  ].some(known => diagnostic.rule === known.rule && known.message.test(diagnostic.message) && known.source.test(line));
}

export function lintDiagnostics(tool, raw, path) {
  const rows = parseSafeJSON(raw);
  if (!Array.isArray(rows)) throw new Error(`${tool} returned unsupported JSON`);
  return rows.filter(row => !row.ignored).map(row => {
    if (tool === 'actionlint') {
      if (typeof row.message !== 'string' || typeof row.kind !== 'string' || !Number.isInteger(row.line)) throw new Error('unsupported actionlint diagnostic');
      return { tool, rule: row.kind, severity: 'warning', message: row.message, path, line: row.line, column: row.column || null };
    }
    if (typeof row.ident !== 'string' || typeof row.desc !== 'string' || !row.determinations || !Array.isArray(row.locations)) throw new Error('unsupported zizmor v1 diagnostic');
    const location = row.locations.find(location => location.symbolic?.kind === 'Primary') || row.locations[0];
    const point = location?.concrete?.location?.start_point;
    return {
      tool, rule: row.ident, severity: String(row.determinations.severity || 'unknown').toLowerCase(),
      confidence: String(row.determinations.confidence || 'unknown').toLowerCase(),
      message: row.desc, path, line: point ? point.row + 1 : null, column: point ? point.column + 1 : null,
    };
  });
}

export async function collectDefinitions(config, outputDir, { run = command }) {
  const evidence = { sourceSha: config.sourceSha, files: [], diagnostics: [], ignoredCompilerDiagnostics: [], settings: [], tools: {}, toolOutputs: [], issues: [] };
  const tree = await run('git', ['ls-tree', '-r', '-z', config.sourceSha, '--', '.github/workflows']);
  if (tree.code !== 0) evidence.issues.push({ scope: 'workflow-definitions', message: `git ls-tree failed (exit ${tree.code})` });
  const entries = tree.code ? [] : tree.stdout.split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/);
    return match && { mode: match[1], blob: match[2], path: match[3] };
  }).filter(entry => entry && ['100644', '100755'].includes(entry.mode) && /^\.github\/workflows\/[^/]+\.ya?ml$/.test(entry.path));
  const fileDir = join(outputDir, 'workflow-definitions');
  await mkdir(fileDir, { recursive: true });
  for (const entry of entries.sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    const content = await run('git', ['show', `${config.sourceSha}:${entry.path}`]);
    if (content.code !== 0) {
      evidence.issues.push({ scope: entry.path, message: `git show failed (exit ${content.code})` });
      continue;
    }
    const file = join(fileDir, entry.path.slice('.github/workflows/'.length));
    await writeFile(file, content.stdout, { mode: 0o600 });
    evidence.files.push({ path: entry.path, blob: entry.blob, content: content.stdout });
  }
  evidence.definitionIssues = [...evidence.issues];
  return evidence;
}

export async function collectConfiguration(config, outputDir, { api, run = command }) {
  const evidence = await collectDefinitions(config, outputDir, { run });
  const fileDir = join(outputDir, 'workflow-definitions');
  await mkdir(join(outputDir, 'tool-output'), { recursive: true });
  for (const tool of ['actionlint', 'zizmor']) {
    const version = await run(tool, [tool === 'actionlint' ? '-version' : '--version']);
    evidence.tools[tool] = { version: version.code === 0 ? version.stdout.trim().split('\n')[0] : null, status: version.code === 0 ? 'available' : 'unavailable' };
    if (version.code !== 0) {
      evidence.issues.push({ scope: tool, message: `${tool} unavailable (exit ${version.code})` });
      continue;
    }
    for (const file of evidence.files) {
      const path = join(fileDir, file.path.slice('.github/workflows/'.length));
      const args = tool === 'actionlint'
        ? ['-no-color', '-shellcheck=', '-pyflakes=', '-format', '{{json .}}', path]
        : ['--offline', '--no-config', '--format', 'json', '--no-progress', '--color', 'never', path];
      const response = await run(tool, args);
      const outputPath = `tool-output/${tool}-${String(evidence.toolOutputs.length + 1).padStart(4, '0')}.json`;
      await writeFile(join(outputDir, outputPath), `${JSON.stringify({ exitCode: response.code, stdout: response.stdout }, null, 2)}\n`, { mode: 0o600 });
      evidence.toolOutputs.push({ tool, workflowPath: file.path, outputPath, exitCode: response.code });
      // Nonzero diagnostic exits are expected; valid JSON remains mandatory.
      try {
        if (response.code < 0 || !response.stdout.trim()) throw new Error(`${tool} failed (exit ${response.code})`);
        for (const diagnostic of lintDiagnostics(tool, response.stdout, file.path)) {
          if (isKnownCompilerDiagnostic(diagnostic, file)) evidence.ignoredCompilerDiagnostics.push(diagnostic);
          else evidence.diagnostics.push(diagnostic);
        }
      } catch {
        evidence.tools[tool].status = 'partial';
        evidence.issues.push({ scope: `${tool}:${file.path}`, message: `${tool} JSON output unavailable or unsupported (exit ${response.code})` });
      }
    }
  }
  const endpoints = [
    ['actions-permissions', `/repos/${config.repository}/actions/permissions`],
    ['workflow-token-permissions', `/repos/${config.repository}/actions/permissions/workflow`],
    ['fork-pull-request-policy', `/repos/${config.repository}/actions/permissions/fork-pr-contributor-approval`],
  ];
  for (const [name, endpoint] of endpoints) {
    try { evidence.settings.push({ name, status: 'available', value: await api(endpoint) }); }
    catch (error) {
      evidence.settings.push({ name, status: 'unavailable', value: null, reason: error.message });
      evidence.issues.push({ scope: name, message: error.message });
    }
  }
  evidence.diagnostics.sort((a, b) => a.path.localeCompare(b.path, 'en') || (a.line || 0) - (b.line || 0) || a.tool.localeCompare(b.tool, 'en') || a.rule.localeCompare(b.rule, 'en'));
  return evidence;
}
