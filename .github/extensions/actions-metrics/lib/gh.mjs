// Thin wrapper around the `gh` CLI. Using `gh api` instead of raw fetch keeps
// authentication, GitHub Enterprise hosts and proxy settings consistent with
// whatever the user already configured for the GitHub CLI.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_BUFFER = 64 * 1024 * 1024;

export class GhError extends Error {
    constructor(message, { status, stderr } = {}) {
        super(message);
        this.name = "GhError";
        this.status = status ?? null;
        this.stderr = stderr ?? "";
    }
}

function firstLine(text) {
    return String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
}

function statusFromStderr(stderr) {
    const match = /HTTP (\d{3})/.exec(String(stderr ?? ""));
    return match ? Number(match[1]) : null;
}

// A secondary rate limit reports no reset time. GitHub asks clients to wait at
// least a minute before retrying, so that is how long every call is held back.
const SECONDARY_COOLDOWN_MS = 60_000;

const RATE_LIMIT_PATTERN = /\brate limit|abuse detection/i;

/**
 * Raised when GitHub refused a request for exceeding a rate limit, or when a
 * request was not sent at all because the host is still cooling down from one.
 */
export class RateLimitError extends GhError {
    constructor(message, { status, stderr, resetAt, host } = {}) {
        super(message, { status, stderr });
        this.name = "RateLimitError";
        this.code = "rate_limited";
        this.rateLimited = true;
        this.resetAt = resetAt ?? null;
        this.host = host ?? null;
    }
}

/** Whether an error, from `gh api` or from `gh runner-kit`, is a rate limit refusal. */
export function isRateLimitError(error) {
    if (!error) {
        return false;
    }
    if (error.rateLimited === true || error.status === 429) {
        return true;
    }
    return RATE_LIMIT_PATTERN.test(`${error.message ?? ""}\n${error.stderr ?? ""}`);
}

/**
 * Read the reset delay go-github appends to a rate limit error, such as
 * `[rate reset in 12m05s]`, as milliseconds. Null when the text carries none.
 */
export function parseRateReset(text) {
    const match = /\[rate reset in (?:(\d+)m)?(\d+)s\]/.exec(String(text ?? ""));
    if (!match) {
        return null;
    }
    return (Number(match[1] ?? 0) * 60 + Number(match[2])) * 1000;
}

/** Normalize a host so that the default host has one spelling. */
export function hostKey(host) {
    const value = String(host ?? "").trim().toLowerCase();
    return value === "" ? "github.com" : value;
}

// Rate limits belong to the token, so one cooldown per host holds back every
// target, every panel and every superseded collection that shares it.
const cooldowns = new Map();
const cooldownProbes = new Map();

/** The active cooldown of a host, or null once it has expired. */
export function rateLimitCooldown(host, now = Date.now()) {
    const key = hostKey(host);
    const entry = cooldowns.get(key);
    if (!entry) {
        return null;
    }
    if (entry.until <= now) {
        cooldowns.delete(key);
        return null;
    }
    return entry;
}

/** Hold back every request to a host until `until` (epoch milliseconds). */
export function setRateLimitCooldown(host, until, reason = "primary") {
    const key = hostKey(host);
    const current = cooldowns.get(key);
    if (!current || current.until < until) {
        cooldowns.set(key, { host: key, until, reason });
    }
    return cooldowns.get(key);
}

/** Forget a host's cooldown. Only tests need this. */
export function clearRateLimitCooldown(host) {
    cooldowns.delete(hostKey(host));
}

function cooldownError(entry, detail) {
    const when = new Date(entry.until).toLocaleTimeString();
    const kind = entry.reason === "secondary" ? "secondary rate limit" : "API rate limit";
    const message = `GitHub ${kind} reached on ${entry.host}; requests are paused until ${when}. Data fetched before the limit is cached, so the next Refresh resumes from there instead of starting over.`;
    return new RateLimitError(message, {
        status: detail?.status ?? null,
        stderr: detail?.stderr ?? "",
        resetAt: new Date(entry.until).toISOString(),
        host: entry.host,
    });
}

function coreLimit(payload) {
    const core = payload?.resources?.core ?? payload?.rate ?? null;
    if (!core || !Number.isFinite(core.remaining)) {
        return null;
    }
    return {
        limit: core.limit ?? null,
        remaining: core.remaining,
        resetAt: Number.isFinite(core.reset) ? core.reset * 1000 : null,
    };
}

/**
 * Read the REST budget of a host. `GET /rate_limit` does not count against the
 * limit, so it is always sent, cooldown or not. Null when the host does not
 * report one - GitHub Enterprise Server with rate limiting disabled answers 404.
 */
export async function fetchRateLimit({ host, cwd } = {}) {
    const args = ["api", "rate_limit", "-H", "Accept: application/vnd.github+json"];
    if (host) {
        args.push("--hostname", host);
    }
    try {
        const stdout = await exec(args, { cwd });
        return coreLimit(stdout.trim() ? JSON.parse(stdout) : null);
    } catch {
        return null;
    }
}

/**
 * Record a rate limit refusal as a cooldown for its host and return the error
 * to raise. Concurrent refusals share one `/rate_limit` probe.
 */
export async function noteRateLimit(host, error, { cwd } = {}) {
    const key = hostKey(host);
    let probe = cooldownProbes.get(key);
    if (!probe) {
        probe = (async () => {
            const now = Date.now();
            const budget = await fetchRateLimit({ host, cwd });
            if (budget && budget.remaining === 0 && budget.resetAt > now) {
                return setRateLimitCooldown(key, budget.resetAt, "primary");
            }
            const parsed = parseRateReset(`${error?.message ?? ""}\n${error?.stderr ?? ""}`);
            if (parsed !== null && !(budget && budget.remaining > 0)) {
                return setRateLimitCooldown(key, now + Math.max(parsed, 1000), "primary");
            }
            return setRateLimitCooldown(key, now + SECONDARY_COOLDOWN_MS, "secondary");
        })().finally(() => cooldownProbes.delete(key));
        cooldownProbes.set(key, probe);
    }
    return cooldownError(await probe, error);
}

/**
 * Refuse to start a collection against a host whose budget is spent. A cooldown
 * left by an earlier refusal answers without any request; otherwise the free
 * `/rate_limit` endpoint is asked, so an exhausted primary limit fails at once
 * instead of after the first expensive request.
 */
export async function assertRateBudget(host, { cwd } = {}) {
    const active = rateLimitCooldown(host);
    if (active) {
        throw cooldownError(active);
    }
    const budget = await fetchRateLimit({ host, cwd });
    if (budget && budget.remaining === 0 && budget.resetAt > Date.now()) {
        throw cooldownError(setRateLimitCooldown(host, budget.resetAt, "primary"));
    }
    return budget;
}

/** Throw the cooldown of a host as an error when one is active. */
export function throwIfRateLimited(host) {
    const active = rateLimitCooldown(host);
    if (active) {
        throw cooldownError(active);
    }
}

function exec(args, { cwd, env, signal } = {}) {
    return new Promise((resolve, reject) => {
        const options = {
            cwd,
            maxBuffer: MAX_BUFFER,
            ...(env ? { env: { ...process.env, ...env } } : {}),
            ...(signal ? { signal } : {}),
        };
        execFile("gh", args, options, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (error.code === "ENOENT") {
                reject(new GhError("GitHub CLI (gh) was not found on PATH"));
                return;
            }
            if (error.name === "AbortError") {
                reject(new GhError("The request was superseded"));
                return;
            }
            reject(
                new GhError(firstLine(stderr) || error.message, {
                    status: statusFromStderr(stderr),
                    stderr: String(stderr ?? ""),
                }),
            );
        });
    });
}

/**
 * Run `gh`, holding the call back while its host cools down from a rate limit
 * and turning a fresh refusal into a cooldown, so that one refusal stops every
 * other request to the host instead of each of them being refused in turn.
 */
async function run(args, { cwd, env, host, signal, gate = true } = {}) {
    if (gate) {
        throwIfRateLimited(host);
    }
    try {
        return await exec(args, { cwd, env, signal });
    } catch (error) {
        if (gate && error instanceof GhError && isRateLimitError(error)) {
            throw await noteRateLimit(host, error, { cwd });
        }
        throw error;
    }
}

/**
 * Invoke `gh` with arbitrary arguments and return raw stdout.
 *
 * Only a call that names the GitHub `host` it talks to - even as null for the
 * default host - is held back by, and feeds, that host's rate limit cooldown.
 * A local call such as `gh runner-kit --help` names none, so a cooldown can
 * never make it fail and have its result memoized as a missing extension.
 */
export function ghRaw(args, { cwd, env, host, signal } = {}) {
    return run(args, { cwd, env, host, signal, gate: host !== undefined });
}

/** Split a selector into its path segments, tolerating URLs and `.git` suffixes. */
function selectorParts(spec) {
    return String(spec ?? "")
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\.git$/, "")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean);
}

/** Parse a `[HOST/]OWNER/REPO` (or repository URL) selector. */
export function parseRepo(spec) {
    const parts = selectorParts(spec);
    if (parts.length === 2) {
        return { kind: "repo", host: null, owner: parts[0], name: parts[1], nwo: `${parts[0]}/${parts[1]}` };
    }
    if (parts.length >= 3) {
        const [host, owner, name] = parts.slice(-3);
        return { kind: "repo", host, owner, name, nwo: `${owner}/${name}` };
    }
    throw new GhError(`Invalid repository selector: "${spec}". Use [HOST/]OWNER/REPO`);
}

/** Parse a `[HOST/]OWNER` selector naming an organization. */
export function parseOrg(spec) {
    const parts = selectorParts(spec);
    if (parts.length === 1) {
        return { kind: "org", host: null, owner: parts[0], name: null, nwo: null };
    }
    if (parts.length === 2) {
        return { kind: "org", host: parts[0], owner: parts[1], name: null, nwo: null };
    }
    throw new GhError(`Invalid organization selector: "${spec}". Use [HOST/]OWNER`);
}

/**
 * Parse a dashboard target. The kind has to be passed in because `A/B` is a
 * repository on the default host and an organization on host `A` alike.
 */
export function parseTarget(spec, kind = "repo") {
    return kind === "org" ? parseOrg(spec) : parseRepo(spec);
}

/** Format a target back into the selector form the UI displays. */
export function formatTarget(target) {
    const path = target.kind === "org" ? target.owner : target.nwo;
    return target.host && target.host !== "github.com" ? `${target.host}/${path}` : path;
}

/** Walk up from `startDir` to the closest directory holding a `.git` entry. */
export function findGitRoot(startDir) {
    let dir = startDir;
    while (dir) {
        if (existsSync(join(dir, ".git"))) {
            return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
    return null;
}

/** Resolve the repository of the current workspace via `gh repo view`. */
export async function detectCurrentRepo(cwd) {
    // Not gated: the host is not known until this answers, and `gh repo view`
    // spends the GraphQL budget rather than the REST one the cooldown tracks.
    const stdout = await run(["repo", "view", "--json", "nameWithOwner,url"], { cwd, gate: false });
    const parsed = JSON.parse(stdout);
    return parseRepo(parsed.url || parsed.nameWithOwner);
}

/** Call a REST endpoint and return the decoded JSON body. */
export async function ghApi(path, { host, cwd, signal } = {}) {
    const args = ["api", path, "-H", "Accept: application/vnd.github+json"];
    if (host) {
        args.push("--hostname", host);
    }
    const stdout = await run(args, { cwd, host, signal });
    return stdout.trim() ? JSON.parse(stdout) : null;
}

/**
 * Page through a REST endpoint manually so the caller keeps control over the
 * API budget. `extract` pulls the item array out of each page payload.
 */
export async function ghApiPaged(
    path,
    { host, cwd, signal, perPage = 100, maxPages = 10, maxItems = Infinity, extract, onPage, onTruncated } = {},
) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const pagePath = `${path}${separator}per_page=${perPage}&page=${page}`;
        const payload = await ghApi(pagePath, { host, cwd, signal });
        const pageItems = extract ? extract(payload) : payload;
        if (!Array.isArray(pageItems) || pageItems.length === 0) {
            break;
        }
        items.push(...pageItems);
        onPage?.(items.length, page);
        if (items.length >= maxItems || pageItems.length < perPage) {
            break;
        }
        // A full final page reached exactly on the last allowed page cannot be
        // told apart from a collection that ends there, so the cap is reported
        // as a possible - not certain - truncation.
        if (page === maxPages) {
            onTruncated?.(items.length);
        }
    }
    return items.length > maxItems ? items.slice(0, maxItems) : items;
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
export async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    const lanes = new Array(Math.max(1, Math.min(limit, items.length))).fill(null).map(async () => {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(lanes);
    return results;
}
