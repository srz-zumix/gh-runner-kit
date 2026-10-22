import { progressDescription } from "/shared/progress.mjs";

function text(tag, value, className) {
    const node = document.createElement(tag);
    node.textContent = value;
    if (className) node.className = className;
    return node;
}

function counts(detail) {
    return `From cache: ${detail.cached.toLocaleString()} · Read afresh: ${detail.fetched.toLocaleString()} · Skipped: ${detail.skipped.toLocaleString()}`;
}

function elapsed(since, now) {
    const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Progress belongs to the current collection attempt, not the older metrics on screen. */
export function renderCollectionProgress(container, state, now = Date.now()) {
    const progress = state?.collectionProgress;
    container.hidden = !progress;
    if (!progress) return;
    const headings = {
        collecting: "Collecting dataset",
        paused: "Collection paused by rate limit",
        failed: "Collection interrupted",
        complete: "Source dataset collected",
    };
    container.className = `collection-progress${progress.status === "paused" ? " collection-progress--paused" : ""}`;
    const nodes = [text("strong", `${headings[progress.status]} · attempt ${progress.attempt}`)];
    const detail = progress.detail;
    if (progress.status === "collecting") {
        nodes.push(text("p", `Elapsed: ${elapsed(progress.startedAt, now)} · ${progress.updatedAt
            ? `Last collector update ${elapsed(progress.updatedAt, now)} ago`
            : "Waiting for the first collector update"}`));
    }
    if (progress.status === "collecting" && state.progress) nodes.push(text("p", state.progress));
    if (detail) {
        if (detail.repositoriesTotal > 0) nodes.push(text("p", `Repository ${detail.repositoryIndex}/${detail.repositoriesTotal}${detail.repository ? ` · ${detail.repository}` : ""}`));
        if (detail.stage === "complete") {
            nodes.push(text("p", `${detail.runs.toLocaleString()} runs · ${detail.jobs.toLocaleString()} jobs gathered from API/cache${progress.status !== "complete" ? "; snapshot/report processing is not yet complete" : " in the source dataset"}`));
        } else {
            nodes.push(text("p", progressDescription(detail)));
        }
        if (detail.stage === "runs") {
            if (detail.runSearch) nodes.push(text("p", `Current search period (UTC): ${detail.runSearch.created}`));
            nodes.push(text("small", detail.runSearch?.cachedWindows !== undefined
                ? "Recent runs are listed from GitHub. Complete UTC days older than 24 hours can use a one-hour listing cache; boundary periods are read afresh. Cached days are separate from API searches. Older reruns and deletions can take up to one hour to appear; Shift+click Refresh bypasses caches. Unique runs found are not yet the final selected total."
                : "Workflow runs are listed from GitHub before cached job lists are read. Large periods may need multiple searches and pages; counts update between searches, not on every page. Unique runs found are not yet the final selected total."));
            if (!detail.runSearch && progress.supported !== false) nodes.push(text("small", "This CLI does not report run-search counters; update gh runner-kit for discovery details."));
        }
        if (detail.unit) {
            if (detail.total > 0) {
                const bar = document.createElement("progress");
                bar.max = detail.total;
                bar.value = detail.completed;
                bar.setAttribute("aria-label", "Current collection stage");
                nodes.push(bar, text("small", `${(detail.completed / detail.total * 100).toFixed(1)}% of this stage only, not of the whole collection.`));
            }
            nodes.push(text("p", counts(detail)));
            if (detail.stage === "attempts") nodes.push(text("small", "Historical attempts count as cached when both completed metadata and job lists are reused; older CLI versions may still fetch metadata."));
        }
        if (progress.updatedAt) nodes.push(text("small", `Last collector update: ${new Date(progress.updatedAt).toLocaleString()}`));
    } else {
        nodes.push(text("p", "No numeric progress has been reported for this attempt yet."));
    }
    if (progress.interrupted) {
        const previous = progress.interrupted;
        const previousCounts = previous.detail.unit ? ` ${counts(previous.detail)}.` : "";
        nodes.push(text("p", `Last interrupted attempt: ${progressDescription(previous.detail)}.${previousCounts} Reported ${new Date(previous.updatedAt).toLocaleString()}.`));
    }
    if (progress.supported === false) nodes.push(text("p", progress.reason, "collection-progress__note"));
    if (progress.status === "paused" && state.retryAt) {
        const automatic = Boolean(state.autoRetryAt);
        const reset = Date.parse(state.autoRetryAt || state.retryAt);
        const seconds = Math.max(0, Math.ceil((reset - now) / 1000));
        nodes.push(text("p", automatic
            ? seconds > 0
                ? `Collection will resume automatically at ${new Date(reset).toLocaleString()} (${Math.floor(seconds / 60)}m ${seconds % 60}s remaining). Completed data is reused and the collection period stays fixed.`
                : "Waiting to resume automatically. GitHub may still impose a new cooldown."
            : seconds > 0
            ? `Retry after ${new Date(reset).toLocaleString()} (${Math.floor(seconds / 60)}m ${seconds % 60}s remaining). Refresh during the cooldown does not make new collection requests.`
            : "The reported retry time has passed. Press Refresh to resume; GitHub may still impose a new cooldown."));
    }
    if (progress.status !== "complete") nodes.push(text("small", "Ordinary Refresh reuses available completed job/usage listings; uncached records may be fetched again. Counts are records, not API requests; refreshed windows can change the totals. No whole-collection percentage or ETA is estimated."));
    container.replaceChildren(...nodes);
}
