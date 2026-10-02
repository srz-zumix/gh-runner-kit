// Single-run job/step timeline bridge.

import { ghRaw } from "./gh.mjs";
import { hasRunTimeline, runTimelineCommand } from "./runnerkit.mjs";

export async function collectRunTimeline({ cwd, target, repo = "", run, attempt, format = "json", refresh = false, signal } = {}) {
    if (!(await hasRunTimeline(cwd))) {
        return { available: false, reason: "gh runner-kit job timeline is not available in the installed version. Update gh runner-kit to use single-run step timelines." };
    }
    const value = String(run ?? "").trim();
    if (!value) {
        return { available: false, reason: "Pass a workflow run ID or URL." };
    }
    const wanted = format === "mermaid" ? "mermaid" : "json";
    const { args, env } = runTimelineCommand({ repo, run: value, attempt: Number(attempt), format: wanted, target, refresh });
    const body = await ghRaw(args, { cwd, env, host: target?.host ?? null, signal });
    if (wanted === "mermaid") {
        return { available: true, format: "mermaid", body };
    }
    return { available: true, format: "json", timeline: body.trim() ? JSON.parse(body) : null };
}
