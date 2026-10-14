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
    if (progress.status === "collecting" && state.progress) nodes.push(text("p", state.progress));
    if (detail) {
        if (detail.repositoriesTotal > 0) nodes.push(text("p", `Repository ${detail.repositoryIndex}/${detail.repositoriesTotal}${detail.repository ? ` · ${detail.repository}` : ""}`));
        if (detail.stage === "complete") {
            nodes.push(text("p", `${detail.runs.toLocaleString()} runs · ${detail.jobs.toLocaleString()} jobs gathered from API/cache${progress.status !== "complete" ? "; snapshot/report processing is not yet complete" : " in the source dataset"}`));
        } else {
            nodes.push(text("p", progressDescription(detail)));
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
            if (detail.stage === "attempts") nodes.push(text("small", "Cached historical job lists still require attempt-metadata requests."));
        }
        if (progress.updatedAt) nodes.push(text("small", `Last numeric update: ${new Date(progress.updatedAt).toLocaleString()}`));
    } else {
        nodes.push(text("p", "No numeric progress has been reported for this attempt yet."));
    }
    if (progress.interrupted) {
        const previous = progress.interrupted;
        nodes.push(text("p", `Last interrupted attempt: ${progressDescription(previous.detail)}. ${counts(previous.detail)}. Reported ${new Date(previous.updatedAt).toLocaleString()}.`));
    }
    if (progress.supported === false) nodes.push(text("p", progress.reason, "collection-progress__note"));
    if (progress.status === "paused" && state.retryAt) {
        const reset = Date.parse(state.retryAt);
        const seconds = Math.max(0, Math.ceil((reset - now) / 1000));
        nodes.push(text("p", seconds > 0
            ? `Retry after ${new Date(reset).toLocaleString()} (${Math.floor(seconds / 60)}m ${seconds % 60}s remaining). Refresh during the cooldown does not make new collection requests.`
            : "The reported retry time has passed. Press Refresh to resume; GitHub may still impose a new cooldown."));
    }
    if (progress.status !== "complete") nodes.push(text("small", "Ordinary Refresh reuses available completed job/usage listings; uncached records may be fetched again. Counts are records, not API requests; refreshed windows can change the totals. No whole-collection percentage or ETA is estimated."));
    container.replaceChildren(...nodes);
}
