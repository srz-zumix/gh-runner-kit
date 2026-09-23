// Loopback HTTP server backing one canvas instance: static renderer assets,
// a JSON state endpoint, mutation endpoints and an SSE stream for live updates.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

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

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
        if (chunks.reduce((sum, part) => sum + part.length, 0) > 1024 * 1024) {
            throw new Error("Request body too large");
        }
    }
    if (chunks.length === 0) {
        return {};
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
            sendJson(res, 500, { error: error?.message ?? String(error) });
        });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { server, url: `http://127.0.0.1:${port}/` };
}

async function handle(req, res, url, instance) {
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
            // Only an explicit refresh discards the `gh runner-kit` job cache
            // and insists on collecting again; a filter change collects only
            // when it asks for different data.
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
                    bypassCache: url.pathname === "/api/refresh",
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
    if (req.method === "GET" && url.pathname === "/api/runners") {
        try {
            sendJson(
                res,
                200,
                instance.runnerPage({
                    projection: url.searchParams.get("projection") ?? "",
                    query: url.searchParams.get("q") ?? "",
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
