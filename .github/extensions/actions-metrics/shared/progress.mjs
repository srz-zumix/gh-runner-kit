export const PROGRESS_STAGES = {
    inventory: "Reading runner inventory",
    repositories: "Finding repositories",
    runs: "Finding workflow runs",
    pricing: "Reading pricing inventory",
    jobs: "Reading latest-attempt job lists",
    attempts: "Reading historical attempts",
    usage: "Reading billable usage",
    complete: "API/cache collection finished",
};

const COUNTS = ["repositoryIndex", "repositoriesTotal", "completed", "total", "cached", "fetched", "skipped", "runs", "jobs"];
const TYPE = "runner-kit.metrics.progress";

/** Other diagnostics are not telemetry; malformed telemetry is an explicit error. */
export function parseCollectionProgress(line) {
    if (!line.trim().startsWith("{") || !line.includes(TYPE)) return null;
    let record;
    try {
        record = JSON.parse(line);
    } catch {
        throw new Error("Invalid collection progress JSON from gh runner-kit");
    }
    if (record.type !== TYPE) return null;
    if (record.version !== 1 || !Object.hasOwn(PROGRESS_STAGES, record.stage)
        || !COUNTS.every(name => Number.isSafeInteger(record[name]) && record[name] >= 0)
        || (record.unit ?? "") !== ({jobs: "runs", attempts: "attempts", usage: "runs"}[record.stage] ?? "")
        || (record.repository !== undefined && typeof record.repository !== "string")
        || record.repositoryIndex > record.repositoriesTotal
        || record.completed > record.total || record.completed !== record.cached + record.fetched + record.skipped
        || (!record.unit && [record.completed, record.total, record.cached, record.fetched, record.skipped].some(count => count !== 0))) {
        throw new Error("Invalid or unsupported collection progress record; update gh runner-kit and the canvas together");
    }
    const search = record.runSearch;
    if (search !== undefined && (record.stage !== "runs" || !search || typeof search !== "object"
        || typeof search.created !== "string" || !search.created
        || !Number.isSafeInteger(search.searches) || search.searches < 0
        || (search.searches === 0 && !(search.cachedWindows > 0))
        || (search.cachedWindows !== undefined && (!Number.isSafeInteger(search.cachedWindows) || search.cachedWindows < 0))
        || !Number.isSafeInteger(search.discovered) || search.discovered < 0)) {
        throw new Error("Invalid or unsupported collection progress record; update gh runner-kit and the canvas together");
    }
    return {
        stage: record.stage, repository: record.repository ?? "", unit: record.unit ?? "",
        ...Object.fromEntries(COUNTS.map(name => [name, record[name]])),
        ...(search === undefined ? {} : {runSearch: {
            created: search.created, searches: search.searches, discovered: search.discovered,
            ...(search.cachedWindows === undefined ? {} : {cachedWindows: search.cachedWindows}),
        }}),
    };
}

/** Retry history is bounded to the last reported interrupted stage, never summed. */
export function beginCollectionProgress(previous, { resume = false, now = Date.now() } = {}) {
    const interrupted = resume && previous && previous.status !== "complete"
        ? previous.detail
            ? { detail: previous.detail, updatedAt: previous.updatedAt }
            : previous.interrupted
        : null;
    return {
        status: "collecting",
        attempt: resume ? (previous?.attempt ?? 0) + 1 : 1,
        supported: resume ? previous?.supported ?? null : null,
        reason: resume ? previous?.reason ?? "" : "",
        startedAt: new Date(now).toISOString(), updatedAt: null,
        detail: null, interrupted,
    };
}

export function progressDescription(detail) {
    const stage = PROGRESS_STAGES[detail.stage];
    const repository = detail.repository ? ` · ${detail.repository}` : "";
    if (detail.runSearch) {
        const search = detail.runSearch;
        const cached = search.cachedWindows === undefined ? "" : ` · ${search.cachedWindows.toLocaleString()} cached days`;
        return `${stage}${repository}: search ${search.searches.toLocaleString()} · ${search.discovered.toLocaleString()} unique runs found${cached}`;
    }
    return detail.unit ? `${stage}${repository}: ${detail.completed}/${detail.total} ${detail.unit}` : `${stage}${repository}`;
}
