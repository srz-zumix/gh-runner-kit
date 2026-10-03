// Loopback HTTP server backing one canvas instance: static renderer assets,
// a JSON state endpoint, mutation endpoints and an SSE stream for live updates.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { ghTokenSource, setCanvasGhToken } from "./gh.mjs";
import { collectStepMetrics } from "./steprows.mjs";
import { normalizeJobStatus, normalizeRunnerFilter } from "../shared/steps.mjs";
import { collectRunTimeline } from "./timeline.mjs";
import { filtersOf, limitsOf, targetOf, targetKey } from "./query.mjs";
import { loadPrefs, rememberStepSettings } from "./prefs.mjs";

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT_DIR, "public");
// The aggregation modules are imported by the browser as well as by this
// process, so they are served from where the extension keeps them rather than
// duplicated under `public/`: two copies of the interval arithmetic is exactly
// the drift the shared module exists to prevent.
const SHARED_DIR = join(ROOT_DIR, "shared");

const CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
};

function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
}

// Errors carrying an `httpStatus` are treated as client faults by the request
// handler so a bad request never surfaces as an internal server error.
function httpError(status, message) {
    const error = new Error(message);
    error.httpStatus = status;
    return error;
}

async function readBody(req) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
        total += chunk.length;
        if (total > 1024 * 1024) {
            throw httpError(413, "Request body too large");
        }
        chunks.push(chunk);
    }
    if (chunks.length === 0) {
        return {};
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw httpError(400, "Invalid JSON body");
    }
}

async function serveStatic(res, pathname) {
    const shared = pathname.startsWith("/shared/");
    const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const relative = normalize(shared ? raw.slice("shared/".length) : raw);
    if (relative.startsWith("..")) {
        sendJson(res, 403, { error: "Forbidden" });
        return;
    }
    try {
        const data = await readFile(join(shared ? SHARED_DIR : PUBLIC_DIR, relative));
        res.writeHead(200, {
            "Content-Type": CONTENT_TYPES[extname(relative)] ?? "application/octet-stream",
            "Cache-Control": "no-store",
        });
        res.end(data);
    } catch {
        sendJson(res, 404, { error: `Not found: ${relative}` });
    }
}

function startSse(req, res, instance) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
    });
    const send = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
    send(instance.state());
    const unsubscribe = instance.onState(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
    req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
    });
}

/** Start the per-instance loopback server and resolve with its URL. */
export async function startInstanceServer(instance) {
    const server = createServer((req, res) => {
        const url = new URL(req.url, "http://127.0.0.1");
        void handle(req, res, url, instance).catch((error) => {
            sendJson(res, error?.httpStatus ?? 500, { error: error?.message ?? String(error) });
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

async function handle(req, res, url, instance) {
    if (url.pathname === "/api/auth") {
        if (req.method === "GET") {
            sendJson(res, 200, { source: ghTokenSource() });
            return;
        }
        if (req.method === "POST") {
            if (!req.headers["content-type"]?.startsWith("application/json")) {
                sendJson(res, 415, { error: "JSON required" });
                return;
            }
            const body = await readBody(req);
            if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.token !== "string" || body.token.length > 4096) {
                sendJson(res, 400, { error: "Invalid token" });
                return;
            }
            setCanvasGhToken(body.token.trim());
            // The cached job lists, row snapshots and every panel's step state were
            // read under the old token; discard them so a following refresh collects
            // afresh under the new credential instead of serving data it may no
            // longer read.
            instance.store?.invalidateAuthCaches?.();
            sendJson(res, 200, { source: ghTokenSource() });
            return;
        }
        sendJson(res, 405, { error: "Method not allowed" });
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
        startSse(req, res, instance);
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, instance.state());
        return;
    }
    if (req.method === "POST" && (url.pathname === "/api/refresh" || url.pathname === "/api/filters")) {
        const body = await readBody(req);
        try {
            // Fire and forget: the SSE stream carries progress and the result.
            // Only an explicit refresh insists on collecting again; a filter
            // change collects only when it asks for different data. Cached job
            // lists are discarded only when the refresh asks for it with
            // `bypassCache` (Shift+click), so a refresh that follows a rate
            // limit resumes from what was already fetched.
            // The toolbar posts a selector plus the whole settings form, which
            // is folded into one query patch here. An empty selector is left
            // out rather than sent as a cleared target: it means the field was
            // not filled in, not that the panel should stop pointing anywhere.
            const selector = String(body.target ?? "").trim();
            const patch = {
                ...(body.filters ?? {}),
                ...(selector ? (body.scope === "org" ? { owner: selector } : { repo: selector }) : {}),
            };
            void instance
                .apply({
                    patch,
                    force: url.pathname === "/api/refresh",
                    bypassCache: url.pathname === "/api/refresh" && body.bypassCache === true,
                })
                .catch(() => {});
        } catch (error) {
            sendJson(res, 400, { error: error?.message ?? String(error) });
            return;
        }
        sendJson(res, 202, instance.state());
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/timeline") {
        const body = await readBody(req);
        const request = {
            query: body.query ?? "",
            workflow: body.workflow ?? "",
            exclude: body.exclude ?? "",
            all: Boolean(body.all),
            clear: Boolean(body.clear),
        };
        try {
            // Checked before the projection is started, because starting it is
            // fire and forget and a rejection afterwards has nowhere to go.
            instance.planProjection(request);
        } catch (error) {
            sendJson(res, 400, { error: error?.message ?? String(error) });
            return;
        }
        // Fire and forget: progress and the result arrive over SSE.
        void instance.project(request).catch(() => {});
        sendJson(res, 202, instance.state());
        return;
    }

    if (req.method === "GET" && url.pathname === "/api/step-prefs") {
        const prefs = await loadPrefs();
        sendJson(res, 200, prefs.stepTimelineByTarget?.[instance.identity] ?? {});
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/steps") {
        const body = await readBody(req);
        const query = instance.effectiveQuery;
        const settings = {
            workflow: String(body.workflow ?? body.filters?.workflow ?? query.workflow ?? "").trim(),
            job: String(body.job ?? "").trim(),
            jobStatus: normalizeJobStatus(body.jobStatus),
            mergeMatrix: body.mergeMatrix !== false,
            showInfra: body.showInfra !== false,
            runBudget: body.runBudget,
            kind: String(body.kind ?? "all").trim() || "all",
            runner: String(body.runner ?? "").trim(),
            excludeRunners: Array.isArray(body.excludeRunners) ? body.excludeRunners : [],
            step: String(body.step ?? "").trim(),
            limit: Number(body.limit) || 0,
            runnerFilter: normalizeRunnerFilter(body.runnerFilter),
        };
        // Claimed before the preferences are read and written, so a request that
        // started later always supersedes this one however long the file I/O takes.
        const { generation, signal } = instance.beginStepRequest();
        try {
            await rememberStepSettings(targetKey(query), settings, () => !instance.isStaleStepRequest(generation));
            const result = await collectStepMetrics({
                target: targetOf(query),
                filters: { ...filtersOf(query), ...(body.filters ?? {}) },
                limits: limitsOf(query),
                cwd: instance.store.cwd,
                ...settings,
                reuseRows: body.reuseRows === true,
                cache: instance.stepRowCache,
                signal,
            });
            const visible = instance.setStepMetrics(settings, result, generation);
            if (visible === null) {
                sendJson(res, 409, { available: false, superseded: true, reason: "A newer step request replaced this one." });
                return;
            }
            sendJson(res, visible.available === false ? 424 : 200, visible);
        } catch (error) {
            if (instance.setStepError(settings, error, generation) === null) {
                sendJson(res, 409, { available: false, superseded: true, reason: "A newer step request replaced this one." });
                return;
            }
            sendJson(res, 502, { available: false, reason: error?.message ?? String(error) });
        }
        return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/run-timeline") {
        instance.clearRunTimeline();
        sendJson(res, 200, { cleared: true });
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/run-timeline") {
        const query = instance.effectiveQuery;
        const format = url.searchParams.get("format") === "mermaid" ? "mermaid" : "json";
        // Only the JSON request opens the run in the panel; a mermaid copy leaves the
        // drawn run and its pending request alone.
        const claim = format === "json" ? instance.beginRunTimeline() : null;
        // A credential change still has to cancel a mermaid copy read under the old token.
        const authSignal = instance.authAbort.signal;
        try {
            const result = await collectRunTimeline({
                cwd: instance.store.cwd,
                target: targetOf(query),
                repo: url.searchParams.get("repo") ?? "",
                run: url.searchParams.get("run") ?? "",
                attempt: Number(url.searchParams.get("attempt")),
                format,
                signal: claim?.signal ?? authSignal,
            });
            if (format === "mermaid") {
                if (authSignal.aborted) {
                    sendJson(res, 409, { available: false, superseded: true, reason: "The credential changed while the timeline was read." });
                    return;
                }
                const text = result.body ?? "";
                res.writeHead(result.available === false ? 424 : 200, {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Cache-Control": "no-store",
                    "Content-Length": Buffer.byteLength(text),
                });
                res.end(text);
                return;
            }
            if (claim?.generation !== instance.runTimelineGeneration) {
                sendJson(res, 409, { available: false, superseded: true, reason: "A newer run timeline request replaced this one." });
                return;
            }
            if (result.available !== false) {
                instance.setRunTimeline({ run: url.searchParams.get("run") ?? "", repo: url.searchParams.get("repo") ?? "", attempt: Number(url.searchParams.get("attempt")) || null }, result.timeline, null, claim.generation);
            }
            sendJson(res, result.available === false ? 424 : 200, result);
        } catch (error) {
            if (claim && claim.generation !== instance.runTimelineGeneration) {
                sendJson(res, 409, { available: false, superseded: true, reason: "A newer run timeline request replaced this one." });
                return;
            }
            sendJson(res, 502, { available: false, reason: error?.message ?? String(error) });
        }
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/runners") {
        try {
            sendJson(
                res,
                200,
                instance.runnerPage({
                    projection: url.searchParams.get("projection") ?? "",
                    query: url.searchParams.get("q") ?? "",
                    sorts: url.searchParams.has("sorts") ? JSON.parse(url.searchParams.get("sorts")) : undefined,
                    sort: url.searchParams.get("sort") ?? "jobMs",
                    direction: url.searchParams.get("direction") ?? "desc",
                    limit: url.searchParams.get("limit") ?? 40,
                    offset: url.searchParams.get("offset") ?? 0,
                }),
            );
        } catch (error) {
            sendJson(res, error?.status ?? 400, { error: error?.message ?? String(error) });
        }
        return;
    }
    if (req.method === "POST" && url.pathname === "/api/rows") {
        const body = await readBody(req);
        try {
            // Fire and forget, like the other collections: progress and the
            // finished snapshot arrive over the SSE stream, and the panel
            // fetches the rows themselves once it sees the revision change.
            const descriptor = instance.requestRows({ force: Boolean(body.force) });
            sendJson(res, 202, descriptor);
        } catch (error) {
            sendJson(res, 400, { error: error?.message ?? String(error) });
        }
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/rows") {
        const result = instance.rowPayload(url.searchParams.get("id") ?? "", url.searchParams.get("revision") ?? "");
        if (result.missing) {
            sendJson(res, 404, { error: "That row snapshot is no longer held." });
            return;
        }
        if (result.superseded) {
            // Refused rather than answered with the current rows: the caller
            // asked for a revision it can reconcile with what it has drawn,
            // and quietly substituting a newer one would put new data on an
            // axis built for the old.
            sendJson(res, 409, { error: "Superseded", revision: result.revision });
            return;
        }
        if (result.pending) {
            sendJson(res, 202, { status: "loading", revision: result.revision });
            return;
        }
        res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Length": result.bytes.length,
        });
        res.end(result.bytes);
        return;
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
        try {
            const result = await instance.export(url.searchParams.get("format") ?? "prometheus");
            const payload = Buffer.from(result.body, "utf8");
            res.writeHead(200, {
                "Content-Type": result.contentType,
                "Content-Disposition": `attachment; filename="${result.filename}"`,
                "Cache-Control": "no-store",
                "Content-Length": payload.length,
            });
            res.end(payload);
        } catch (error) {
            sendJson(res, 502, { error: error?.message ?? String(error) });
        }
        return;
    }
    if (req.method === "GET") {
        await serveStatic(res, url.pathname);
        return;
    }
    sendJson(res, 405, { error: "Method not allowed" });
}
