import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const SCHEMA_VERSION = 1;
export const CHECKS = ['reliability', 'performance', 'configuration'];
const defaults = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

export function positiveInteger(value, name, maximum = 10000) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

export function iso(value, name = 'timestamp') {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp with a timezone`);
  }
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) throw new Error(`${name} has invalid calendar components`);
  if (Date.parse(value) % 1000 !== 0) throw new Error(`${name} must use whole seconds`);
  return new Date(value).toISOString();
}

export function resolveConfig(env = process.env, now = new Date()) {
  const days = positiveInteger(env.INSPECTION_DAYS || defaults.days, 'days', 31);
  const dailyLimit = positiveInteger(env.INSPECTION_DAILY_LIMIT || defaults.daily_limit, 'daily limit', 1000);
  const until = iso(env.INSPECTION_UNTIL || new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString(), 'until');
  if (Date.parse(until) > now.getTime()) throw new Error('until must not be in the future');
  const since = iso(env.INSPECTION_SINCE || new Date(Date.parse(until) - days * 86400000).toISOString(), 'since');
  if (since >= until || Date.parse(until) - Date.parse(since) > 31 * 86400000) {
    throw new Error('period must be positive and no longer than 31 days');
  }
  const requested = (env.INSPECTION_CHECKS || defaults.checks.join(',')).split(',').map(x => x.trim());
  if (requested.some(x => !CHECKS.includes(x)) || new Set(requested).size !== requested.length) {
    throw new Error('checks must be a nonempty, unique comma-separated selection of reliability, performance, configuration');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) throw new Error('GITHUB_REPOSITORY must be owner/repository');
  if (env.GITHUB_REPOSITORY.length > 255) throw new Error('GITHUB_REPOSITORY is too long');
  if (env.GITHUB_REPOSITORY.split('/').some(part => ['.', '..'].includes(part))) throw new Error('GITHUB_REPOSITORY contains an invalid component');
  if (!/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(env.GITHUB_SHA || '')) throw new Error('GITHUB_SHA must be a full trusted commit SHA');
  return {
    repository: env.GITHUB_REPOSITORY, sourceSha: env.GITHUB_SHA.toLowerCase(), since, until,
    checks: CHECKS.filter(x => requested.includes(x)), dailyLimit, days,
    runId: env.GITHUB_RUN_ID ? id(env.GITHUB_RUN_ID) : null,
    runAttempt: env.GITHUB_RUN_ATTEMPT ? positiveInteger(env.GITHUB_RUN_ATTEMPT, 'run attempt') : null,
  };
}

export function utcSlices(since, until) {
  let cursor = Date.parse(iso(since));
  const end = Date.parse(iso(until));
  if (cursor >= end || end - cursor > 31 * 86400000) throw new Error('invalid bounded period');
  const slices = [];
  while (cursor < end) {
    const next = Math.min(end, Math.floor(cursor / 86400000) * 86400000 + 86400000);
    slices.push({ day: new Date(cursor).toISOString().slice(0, 10), since: new Date(cursor).toISOString(), until: new Date(next).toISOString() });
    cursor = next;
  }
  return slices;
}

// Quote large integral tokens before JSON.parse so IDs never pass through a lossy Number.
export function parseSafeJSON(text) {
  let transformed = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i++] === '"') break;
      }
      transformed += text.slice(start, i);
    } else if (text[i] === '-' || /\d/.test(text[i])) {
      const token = text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (!token) throw new Error('invalid JSON numeric token');
      const value = token[0];
      if (/^-?\d+$/.test(value) && (BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER) || BigInt(value) < BigInt(Number.MIN_SAFE_INTEGER))) {
        transformed += JSON.stringify(value);
      } else {
        if (!Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER) throw new Error('unsafe JSON numeric precision');
        transformed += value;
      }
      i += value.length;
    } else transformed += text[i++];
  }
  return JSON.parse(transformed);
}

export function id(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) throw new Error('unsafe numeric ID');
  if (!/^[1-9]\d{0,19}$/.test(String(value)) || BigInt(value) > 18446744073709551615n) throw new Error('invalid ID');
  return String(value);
}

export function compareIds(a, b) { return BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0; }
export function newest(a, b) { return Date.parse(b.created_at) - Date.parse(a.created_at) || -compareIds(a.id, b.id); }
export function unique(rows, key) { return [...new Map(rows.map(row => [key(row), row])).values()]; }

export async function boundedMap(rows, limit, fn) {
  const result = new Array(rows.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor++;
      result[index] = await fn(rows[index], index);
    }
  }));
  return result;
}

export function command(binary, args, options = {}) {
  return new Promise(resolve => {
    execFile(binary, args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 15 * 60 * 1000, ...options }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout: stdout || '', stderr: stderr || '', error: error?.code || null });
    });
  });
}

export function ghAdapter(run = command) {
  return async endpoint => {
    const response = await run('gh', ['api', '--method', 'GET', endpoint]);
    if (response.code !== 0) {
      const status = (response.stderr.match(/HTTP (\d{3})/) || [])[1];
      throw new Error(`gh api ${endpoint.split('?')[0]} failed${status ? ` (HTTP ${status})` : ''} (exit ${response.code})`);
    }
    return parseSafeJSON(response.stdout);
  };
}

export async function paginate(api, endpoint, key) {
  const rows = [];
  for (let page = 1; page <= 10000; page++) {
    const response = await api(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    if (!Array.isArray(response[key])) throw new Error(`missing ${key} array`);
    rows.push(...response[key]);
    if (response[key].length < 100) return rows;
  }
  throw new Error(`pagination bound exceeded for ${key}`);
}
