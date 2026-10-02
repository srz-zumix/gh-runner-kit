// Single-run job/step timeline bridge.

import { ghRaw } from "./gh.mjs";
import { hasRunTimeline, runTimelineCommand } from "./runnerkit.mjs";

const RUN_URL = /^https?:\/\//i;

/**
 * The host a single-run timeline reads from, for the rate limit cooldown. A run URL
 * and a `HOST/OWNER/REPO` selector name their own host, which can differ from the
 * dashboard target's; anything else reads from the target's host.
 */
export function runTimelineHost({ target = null, repo = "", run = "" } = {}) {
    const value = String(run ?? "").trim();
    if (RUN_URL.test(value)) {
        try {
            // host keeps a non-default port, which is part of a GHES host name.
            return new URL(value).host || null;
        } catch {
            // Let the CLI report the malformed URL.
        }
    }
    const parts = String(repo ?? "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\.git$/, "").split("/").filter(Boolean);
    if (parts.length === 3) {
        return parts[0];
    }
    return target?.host ?? null;
}

export async function collectRunTimeline({ cwd, target, repo = "", run, attempt, format = "json", refresh = false, signal } = {}) {
    if (!(await hasRunTimeline(cwd))) {
        return { available: false, reason: "gh runner-kit job timeline is not available in the installed version. Update gh runner-kit to use single-run step timelines." };
    }
    const value = String(run ?? "").trim();
    if (!value) {
        return { available: false, reason: "Pass a workflow run ID or URL." };
    }
    // Only a repository target lets a bare run ID stand on its own.
    if (!repo && !RUN_URL.test(value) && target?.kind !== "repo") {
        return { available: false, reason: "A run ID needs a repository when the dashboard targets an organization. Pass the run URL or the repository as [HOST/]OWNER/REPO." };
    }
    const wanted = format === "mermaid" ? "mermaid" : "json";
    const { args, env } = runTimelineCommand({ repo, run: value, attempt: Number(attempt), format: wanted, target, refresh });
    const body = await ghRaw(args, { cwd, env, host: runTimelineHost({ target, repo, run: value }), signal });
    if (wanted === "mermaid") {
        return { available: true, format: "mermaid", body };
    }
    return { available: true, format: "json", timeline: body.trim() ? JSON.parse(body) : null };
}
