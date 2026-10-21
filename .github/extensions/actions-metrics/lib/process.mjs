import { spawn } from "node:child_process";
import { assertRateBudget, ghCliEnv, isRateLimitError, noteRateLimit, statusFromStderr } from "./gh.mjs";

/** Stream CLI rows and progress without accumulating the full stdout/stderr. */
export async function runLines(args, env, cwd, onLine, signal, { host, onStderrLine } = {}) {
    const gated = host !== undefined;
    if (gated) {
        await assertRateBudget(host, { cwd });
    }
    try {
        return await streamLines(args, env, cwd, onLine, signal, onStderrLine);
    } catch (error) {
        if (gated && isRateLimitError(error)) {
            throw await noteRateLimit(host, error, { cwd });
        }
        throw error;
    }
}

function streamLines(args, env, cwd, onLine, signal, onStderrLine) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error("The runner timeline was superseded."));
            return;
        }
        const child = spawn("gh", args, {
            cwd,
            env: ghCliEnv(env),
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stderr = "";
        let pendingStderr = "";
        let pending = "";
        let stopped = false;
        let aborted = false;
        let streamError = null;

        const stop = () => {
            if (!stopped) {
                stopped = true;
                child.kill("SIGTERM");
            }
        };
        const onAbort = () => {
            aborted = true;
            stop();
        };
        const dispatch = (callback, line) => {
            if (streamError) return false;
            try {
                return callback(line);
            } catch (error) {
                streamError = error instanceof Error ? error : new Error(String(error));
                stop();
                return false;
            }
        };
        signal?.addEventListener?.("abort", onAbort, { once: true });

        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr = (stderr + chunk).slice(-8192);
            if (onStderrLine) {
                pendingStderr += chunk;
                let cut = pendingStderr.indexOf("\n");
                while (cut >= 0) {
                    dispatch(onStderrLine, pendingStderr.slice(0, cut));
                    pendingStderr = pendingStderr.slice(cut + 1);
                    cut = pendingStderr.indexOf("\n");
                }
            }
        });

        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
            if (stopped) {
                return;
            }
            pending += chunk;
            let cut = pending.indexOf("\n");
            while (cut >= 0) {
                const line = pending.slice(0, cut);
                pending = pending.slice(cut + 1);
                if (line.trim() && dispatch(onLine, line) === false) {
                    stop();
                    return;
                }
                cut = pending.indexOf("\n");
            }
        });

        child.on("error", (error) => {
            signal?.removeEventListener?.("abort", onAbort);
            reject(error.code === "ENOENT" ? new Error("GitHub CLI (gh) was not found on PATH") : error);
        });
        child.on("close", (code) => {
            signal?.removeEventListener?.("abort", onAbort);
            if (onStderrLine && pendingStderr) {
                dispatch(onStderrLine, pendingStderr);
                pendingStderr = "";
            }
            if (streamError) {
                reject(streamError);
                return;
            }
            if (aborted) {
                reject(new Error("The runner timeline was superseded."));
                return;
            }
            if (stopped) {
                resolve({ truncated: true, stderr });
                return;
            }
            if (pending.trim()) {
                dispatch(onLine, pending);
            }
            if (streamError) {
                reject(streamError);
                return;
            }
            if (code === 0) {
                resolve({ truncated: false, stderr });
                return;
            }
            const message = stderr.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Error:"));
            const error = new Error(message ? message.replace(/^Error:\s*/, "") : `gh ${args.slice(0, 3).join(" ")} exited with ${code}`);
            error.stderr = stderr;
            error.status = statusFromStderr(stderr);
            reject(error);
        });
    });
}
