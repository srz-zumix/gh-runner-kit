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

function run(args, { cwd, env } = {}) {
    return new Promise((resolve, reject) => {
        const options = { cwd, maxBuffer: MAX_BUFFER, ...(env ? { env: { ...process.env, ...env } } : {}) };
        execFile("gh", args, options, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (error.code === "ENOENT") {
                reject(new GhError("GitHub CLI (gh) was not found on PATH"));
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

/** Invoke `gh` with arbitrary arguments and return raw stdout. */
export function ghRaw(args, { cwd, env } = {}) {
    return run(args, { cwd, env });
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
    const stdout = await run(["repo", "view", "--json", "nameWithOwner,url"], { cwd });
    const parsed = JSON.parse(stdout);
    return parseRepo(parsed.url || parsed.nameWithOwner);
}

/** Call a REST endpoint and return the decoded JSON body. */
export async function ghApi(path, { host, cwd } = {}) {
    const args = ["api", path, "-H", "Accept: application/vnd.github+json"];
    if (host) {
        args.push("--hostname", host);
    }
    const stdout = await run(args, { cwd });
    return stdout.trim() ? JSON.parse(stdout) : null;
}

/**
 * Page through a REST endpoint manually so the caller keeps control over the
 * API budget. `extract` pulls the item array out of each page payload.
 */
export async function ghApiPaged(
    path,
    { host, cwd, perPage = 100, maxPages = 10, maxItems = Infinity, extract, onPage, onTruncated } = {},
) {
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const pagePath = `${path}${separator}per_page=${perPage}&page=${page}`;
        const payload = await ghApi(pagePath, { host, cwd });
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
