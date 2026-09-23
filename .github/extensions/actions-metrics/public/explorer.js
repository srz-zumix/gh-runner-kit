// The job explorer tab.
//
// Everything on this tab is drawn from one collection of raw job rows that was
// fetched once. Narrowing by workflow, runner, branch, outcome or time never
// goes back to the CLI: the rows are already in the worker, so a filter is a
// re-aggregation that finishes in tens of milliseconds rather than a round trip
// that takes minutes over a busy organization.
//
// That is the whole reason this tab exists alongside the runner activity tab,
// which projects server-side and is therefore authoritative over windows far
// too large to hold in a browser. The two answer different questions and are
// deliberately not merged.

import {
    colorFor,
    conclusionColorFor,
    renderAreaChart,
    renderHistogram,
    renderRankedBars,
    renderShareBar,
    renderStackedTimeline,
} from "./charts.js";
import { emptyExploreFilters, hasActiveExploreFilters } from "/shared/explore.mjs";
import { FIELD_SEPARATOR, UNIDENTIFIED } from "/shared/rows.mjs";

/** Facets the reader can narrow on, in the order they are offered. */
const FACETS = [
    { key: "repo", label: "Repository" },
    { key: "workflow", label: "Workflow" },
    { key: "runner", label: "Runner" },
    { key: "label", label: "Runs-on label" },
    { key: "branch", label: "Branch" },
    { key: "event", label: "Event" },
    { key: "kind", label: "Runner kind" },
    { key: "conclusion", label: "Conclusion" },
    { key: "state", label: "State" },
];

const TIMELINE_SERIES = [
    { key: "success", label: "Succeeded", color: "var(--true-color-green, #1a7f37)" },
    { key: "failure", label: "Failed", color: "var(--true-color-red, #cf222e)" },
    { key: "other", label: "Other", color: "var(--true-color-gray, #8c959f)" },
];

const PAGE_SIZE = 50;

/** How many rows the table will page through before it asks the reader to filter. */
const MAX_TABLE_ROWS = 5000;

// `first` is the direction a column sorts on its first click. Text reads
// naturally from A, durations and timestamps from the largest, which is what
// someone clicking "Duration" is looking for.
const TABLE_COLUMNS = [
    { label: "Queued", sort: "queued", first: "desc" },
    { label: "Repository", sort: "repo", first: "asc" },
    { label: "Workflow", sort: "workflow", first: "asc" },
    { label: "Job", sort: "job", first: "asc" },
    { label: "Runner", sort: "runner", first: "asc" },
    { label: "Wait", sort: "wait", first: "desc" },
    { label: "Duration", sort: "duration", first: "desc" },
    { label: "Result", sort: "conclusion", first: "asc" },
];

/**
 * All of the explorer's own state.
 *
 * Kept in one object rather than scattered across module variables so that a
 * target change can reset it in a single assignment and leave nothing behind
 * describing a repository the panel no longer shows.
 */
const view = {
    root: null,
    worker: null,
    seq: 0,
    pending: new Map(),
    /** The snapshot identity the worker currently holds. */
    loaded: null,
    /** The snapshot identity being fetched, so a re-render does not fetch twice. */
    fetching: null,
    status: "idle",
    error: null,
    snapshot: null,
    health: null,
    aggregate: null,
    facets: null,
    matched: 0,
    total: 0,
    filters: emptyExploreFilters(),
    openFacets: new Set(),
    facetQuery: new Map(),
    sort: "queued",
    direction: "desc",
    offset: 0,
    page: null,
    heatRows: 25,
    searchDraft: "",
    searchTimer: null,
    aggregateSeq: 0,
    pageSeq: 0,
    /** Which fetch the panel wants; a slower earlier one is discarded. */
    fetchSeq: 0,
    fetchAbort: null,
};

let host = null;

/** Wire the explorer to the page once. */
export function initExplorer(context) {
    host = context;
}

function worker() {
    if (view.worker) {
        return view.worker;
    }
    view.worker = new Worker("/worker.js", { type: "module" });
    view.worker.onmessage = (event) => {
        const { id, type, payload } = event.data ?? {};
        const entry = view.pending.get(id);
        view.pending.delete(id);
        if (!entry) {
            return;
        }
        if (type === "error") {
            entry.reject(new Error(payload?.message ?? "The explorer failed to aggregate."));
            return;
        }
        entry.resolve(payload ?? {});
    };
    view.worker.onerror = (event) => {
        // A fatal worker error never answers the requests it was carrying, so
        // they are failed here. Leaving them pending would also leave
        // `view.fetching` set, and the panel would then refuse to retry the
        // very snapshot it failed on.
        discardWorker(event?.message ?? "The explorer worker stopped.");
    };
    return view.worker;
}

/**
 * Tear down a worker that cannot be trusted any more, failing everything it
 * was carrying. The next request builds a fresh one.
 */
function discardWorker(message) {
    const pending = [...view.pending.values()];
    view.pending.clear();
    const failure = new Error(message);
    for (const entry of pending) {
        entry.reject(failure);
    }
    try {
        view.worker?.terminate();
    } catch {
        // A worker that is already gone needs no terminating.
    }
    view.worker = null;
    view.loaded = null;
    view.fetching = null;
    view.status = "error";
    view.error = message;
    paint();
}

function ask(type, payload, transfer) {
    const id = (view.seq += 1);
    return new Promise((resolve, reject) => {
        view.pending.set(id, { resolve, reject });
        worker().postMessage({ id, type, payload }, transfer ?? []);
    });
}

/* ------------------------------------------------------------------ data */

/**
 * Bring the worker in line with the snapshot the extension is holding.
 *
 * Driven by the panel state rather than by a button so that a window change
 * made in the toolbar, or by another panel on the same target, reloads the
 * rows without the reader having to notice that they went stale.
 */
export function syncExplorer(state) {
    const rows = state?.rows;
    if (!rows) {
        return;
    }
    if (rows.status === "error") {
        view.status = "error";
        view.error = rows.error;
        paint();
        return;
    }
    if (rows.status === "loading") {
        view.status = "collecting";
        view.error = null;
        paint();
        return;
    }
    if (rows.status !== "ready" || !rows.revision) {
        return;
    }
    const identity = `${rows.id}@${rows.revision}`;
    if (view.loaded === identity || view.fetching === identity) {
        if (view.status === "collecting") {
            view.status = view.aggregate ? "ready" : "loading";
            paint();
        }
        return;
    }
    view.fetching = identity;
    view.fetchSeq += 1;
    void fetchRows(rows.id, rows.revision, identity, state, view.fetchSeq);
}

/**
 * Pull one snapshot into the worker.
 *
 * Every step checks that it is still the fetch the panel wants. Two can be in
 * flight at once — a forced re-collection supersedes a slow one — and without
 * the check the slower, older payload would land last and leave the panel
 * showing rows that have already been replaced, with no further event due to
 * correct it.
 */
async function fetchRows(id, revision, identity, state, seq) {
    const current = () => seq === view.fetchSeq;
    const controller = new AbortController();
    view.fetchAbort?.abort();
    view.fetchAbort = controller;
    view.status = "loading";
    view.error = null;
    paint();
    try {
        const response = await fetch(`/api/rows?id=${encodeURIComponent(id)}&revision=${encodeURIComponent(revision)}`, {
            signal: controller.signal,
        });
        if (!current()) {
            return;
        }
        if (response.status === 409 || response.status === 404) {
            // The snapshot moved on while it was being fetched. Nothing is
            // drawn from it: the next state broadcast carries the newer
            // revision and this runs again against that one.
            view.fetching = null;
            return;
        }
        if (!response.ok) {
            throw new Error(`The extension refused the row snapshot (${response.status}).`);
        }
        const buffer = await response.arrayBuffer();
        if (!current()) {
            return;
        }
        const windowTo = state?.updatedAt ? Date.parse(state.updatedAt) : Date.now();
        const days = state?.filters?.days ?? 30;
        // Transferred, not copied: at the full row budget the payload is
        // several megabytes and the main thread has no use for it afterwards.
        const loaded = await ask("load", { buffer, windowFrom: windowTo - days * 86400000, windowTo }, [buffer]);
        if (!current()) {
            return;
        }
        view.loaded = identity;
        view.fetching = null;
        view.snapshot = loaded.snapshot;
        view.health = loaded.health;
        view.total = loaded.rowCount;
        view.status = "ready";
        // The worker now holds different rows, so anything still in flight
        // against the previous ones must not be drawn.
        view.aggregateSeq += 1;
        view.pageSeq += 1;
        await refreshAggregate(state);
    } catch (error) {
        if (!current() || error?.name === "AbortError") {
            return;
        }
        view.fetching = null;
        view.status = "error";
        view.error = error?.message ?? String(error);
        paint();
    }
}

function windowOf(state) {
    const to = view.snapshot?.collectedAt ?? (state?.updatedAt ? Date.parse(state.updatedAt) : Date.now());
    const days = state?.filters?.days ?? 30;
    return { windowFrom: to - days * 86400000, windowTo: to };
}

async function refreshAggregate(state) {
    if (!view.loaded) {
        return;
    }
    const seq = (view.aggregateSeq += 1);
    const { windowFrom, windowTo } = windowOf(state ?? host?.state());
    try {
        const result = await ask("aggregate", {
            filters: view.filters,
            windowFrom,
            windowTo,
            topRunners: view.heatRows,
        });
        if (seq !== view.aggregateSeq) {
            // A later filter change already asked for a different aggregate;
            // drawing this one would show numbers for a selection the reader
            // has left.
            return;
        }
        view.aggregate = result.aggregate;
        view.facets = result.facets;
        view.matched = result.matched;
        view.total = result.total;
        view.status = "ready";
        view.error = null;
    } catch (error) {
        if (seq !== view.aggregateSeq) {
            return;
        }
        view.status = "error";
        view.error = error?.message ?? String(error);
    }
    paint();
    void refreshPage();
}

async function refreshPage() {
    if (!view.loaded) {
        return;
    }
    const seq = (view.pageSeq += 1);
    try {
        const result = await ask("page", {
            filters: view.filters,
            sort: view.sort,
            direction: view.direction,
            offset: view.offset,
            limit: PAGE_SIZE,
        });
        if (seq !== view.pageSeq) {
            return;
        }
        view.page = result;
        paint();
    } catch {
        // A failed page leaves the previous one drawn; the aggregate above it
        // is the part that must not be wrong.
    }
}

/* ---------------------------------------------------------------- filters */

function setFilters(next, { resetOffset = true } = {}) {
    view.filters = { ...view.filters, ...next };
    if (resetOffset) {
        view.offset = 0;
    }
    void refreshAggregate();
}

function toggleFacet(key, value) {
    const current = view.filters[key] ?? [];
    const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
    setFilters({ [key]: next });
}

function clearFilters() {
    view.filters = emptyExploreFilters();
    view.searchDraft = "";
    view.offset = 0;
    void refreshAggregate();
}

/* ------------------------------------------------------------------- view */

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key === "class") {
            node.className = value;
        } else if (key === "text") {
            node.textContent = String(value);
        } else if (key.startsWith("on") && typeof value === "function") {
            node.addEventListener(key.slice(2).toLowerCase(), value);
        } else {
            node.setAttribute(key, value === true ? "" : String(value));
        }
    }
    for (const child of [children].flat()) {
        if (child === null || child === undefined || child === false) {
            continue;
        }
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function card(title, body, note, control) {
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: title }), control ?? null]),
        el("div", { class: "card__body" }, body),
        note ? el("p", { class: "card__note", text: note }) : null,
    ]);
}

function duration(ms) {
    if (!Number.isFinite(ms)) {
        return "–";
    }
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${seconds % 60}s`;
    }
    const hours = Math.floor(minutes / 60);
    if (hours < 48) {
        return `${hours}h ${minutes % 60}m`;
    }
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function number(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "–";
}

function percent(ratio) {
    return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "–";
}

function kpi(label, value, hint) {
    return el("div", { class: "kpi" }, [
        el("span", { class: "kpi__label", text: label }),
        el("strong", { class: "kpi__value", text: value }),
        hint ? el("span", { class: "kpi__hint", text: hint }) : null,
    ]);
}

/**
 * How a filter value reads on a chip.
 *
 * Workflows are keyed by `repo` and path together so that two repositories with
 * a `ci.yml` stay apart, but that composite is not what anyone calls it.
 */
function chipText(key, value) {
    if (value === "") {
        return UNIDENTIFIED;
    }
    if (key === "workflow") {
        const parts = String(value).split(FIELD_SEPARATOR);
        return parts[parts.length - 1].replace(/^\.github\/workflows\//, "");
    }
    return value;
}

/* ------------------------------------------------------------- the pieces */

/**
 * What the CLI was asked for.
 *
 * Shown permanently rather than folded away, because every control below it can
 * only narrow this. A reader who cannot find a workflow needs to be able to see
 * at a glance whether it was ever collected.
 */
function scopeBanner(state) {
    const scope = view.snapshot?.scope;
    if (!scope) {
        return null;
    }
    const bits = [
        `${scope.target || "—"}`,
        `${scope.days} day${scope.days === 1 ? "" : "s"}`,
        "both runner kinds",
        scope.maxRuns > 0 ? `at most ${number(scope.maxRuns)} runs per repository` : "every run in the window",
    ];
    if (scope.event) {
        bits.push(`event ${scope.event}`);
    }
    if (scope.branch) {
        bits.push(`branch ${scope.branch}`);
    }
    if (scope.workflow) {
        bits.push(`workflow ${scope.workflow}`);
    }
    if (scope.labels?.length) {
        bits.push(`labels ${scope.labels.join(", ")}`);
    }
    const collected = view.snapshot?.collectedAt ? new Date(view.snapshot.collectedAt).toLocaleString() : "–";
    return el("div", { class: "scope" }, [
        el("div", { class: "scope__line" }, [
            el("span", { class: "scope__title", text: "Collected" }),
            el("span", { class: "scope__body", text: bits.join(" · ") }),
        ]),
        el("div", { class: "scope__line" }, [
            el("span", { class: "scope__title", text: "Rows" }),
            el("span", {
                class: "scope__body",
                text: `${number(view.total)} jobs, read at ${collected}. Filters below are applied in the browser and never re-collect.`,
            }),
        ]),
        view.snapshot?.truncated
            ? el("p", {
                  class: "scope__warn",
                  text:
                      `Only the first ${number(view.snapshot.budget)} job rows were kept. ` +
                      "Everything on this tab describes that prefix, which is ordered by run rather than sampled, " +
                      "so totals are understated and the oldest part of the window is missing. " +
                      "Raise the row budget in Settings or shorten the window.",
              })
            : null,
        view.snapshot?.malformed
            ? el("p", { class: "scope__warn", text: `${number(view.snapshot.malformed)} rows could not be parsed and were dropped.` })
            : null,
    ]);
}

function facetPicker(key, label) {
    const options = view.facets?.[key] ?? [];
    const selected = view.filters[key] ?? [];
    const id = `explore-facet-${key}`;
    const query = (view.facetQuery.get(key) ?? "").toLowerCase();

    // Chosen values are hoisted to the top and synthesized when the current
    // filters have driven their count to zero. Without this a selection can
    // scroll past the 300-option cap or drop out of the list entirely, leaving
    // a filter that is applied but has no checkbox left to switch it off.
    const chosen = new Set(selected);
    const ordered = options.filter((option) => chosen.has(option.value));
    const present = new Set(ordered.map((option) => option.value));
    for (const value of selected) {
        if (!present.has(value)) {
            ordered.push({ value, label: value, count: 0 });
        }
    }
    for (const option of options) {
        if (!chosen.has(option.value)) {
            ordered.push(option);
        }
    }

    const shown = query ? ordered.filter((option) => option.label.toLowerCase().includes(query)) : ordered;

    const list = el(
        "div",
        { class: "facet__list" },
        shown.slice(0, 300).map((option) =>
            el("label", { class: `facet__option${chosen.has(option.value) ? " facet__option--on" : ""}` }, [
                el("input", {
                    type: "checkbox",
                    checked: chosen.has(option.value),
                    onChange: () => toggleFacet(key, option.value),
                }),
                el("span", { class: "facet__name", title: option.value, text: option.label }),
                el("span", { class: "facet__count", text: number(option.count) }),
            ]),
        ),
    );

    return el(
        "details",
        {
            class: `facet${selected.length ? " facet--on" : ""}`,
            open: view.openFacets.has(key),
            onToggle: (event) => {
                if (event.target.open) {
                    view.openFacets.add(key);
                } else {
                    view.openFacets.delete(key);
                }
            },
        },
        [
            el("summary", { class: "facet__summary" }, [
                el("span", { text: label }),
                el("span", {
                    class: "facet__badge",
                    text: selected.length ? `${selected.length} of ${ordered.length}` : String(ordered.length),
                }),
            ]),
            ordered.length > 12
                ? el("input", {
                      class: "facet__search",
                      id: `${id}-search`,
                      type: "search",
                      placeholder: `Find a ${label.toLowerCase()}…`,
                      value: view.facetQuery.get(key) ?? "",
                      onInput: (event) => {
                          view.facetQuery.set(key, event.target.value);
                          paint();
                      },
                  })
                : null,
            list,
            shown.length > 300 ? el("p", { class: "facet__more", text: `${number(shown.length - 300)} more — narrow with the search above.` }) : null,
        ],
    );
}

function activeChips() {
    const chips = [];
    for (const { key, label } of FACETS) {
        for (const value of view.filters[key] ?? []) {
            chips.push(
                el("button", {
                    class: "chip",
                    type: "button",
                    title: `Remove ${label}: ${value}`,
                    text: `${label}: ${chipText(key, value)} ✕`,
                    onClick: () => toggleFacet(key, value),
                }),
            );
        }
    }
    if (view.filters.text) {
        chips.push(
            el("button", {
                class: "chip",
                type: "button",
                text: `Search: ${view.filters.text} ✕`,
                onClick: () => {
                    view.searchDraft = "";
                    setFilters({ text: "" });
                },
            }),
        );
    }
    if (view.filters.from !== null && view.filters.to !== null) {
        chips.push(
            el("button", {
                class: "chip",
                type: "button",
                text: `${new Date(view.filters.from).toLocaleString()} → ${new Date(view.filters.to).toLocaleString()} ✕`,
                onClick: () => setFilters({ from: null, to: null }),
            }),
        );
    }
    if (chips.length === 0) {
        return null;
    }
    return el("div", { class: "chips" }, [
        ...chips,
        el("button", { class: "chip chip--clear", type: "button", text: "Clear all", onClick: clearFilters }),
    ]);
}

function filterBar() {
    return card(
        "Filters",
        [
            el("div", { class: "explore-search" }, [
                el("input", {
                    class: "explore-search__input",
                    id: "explore-search",
                    type: "search",
                    placeholder: "Search repository, workflow, job, runner, branch or label…",
                    value: view.searchDraft,
                    onInput: (event) => {
                        view.searchDraft = event.target.value;
                        clearTimeout(view.searchTimer);
                        // Debounced because every keystroke would otherwise
                        // re-filter the whole row set; at the full budget that
                        // is fast but not free.
                        view.searchTimer = setTimeout(() => setFilters({ text: view.searchDraft }), 200);
                    },
                }),
                el("span", {
                    class: "explore-search__count",
                    text: `${number(view.matched)} of ${number(view.total)} jobs`,
                }),
            ]),
            el("div", { class: "facets" }, FACETS.map(({ key, label }) => facetPicker(key, label))),
            activeChips(),
        ],
        hasActiveExploreFilters(view.filters)
            ? "Every number on this tab describes the filtered selection."
            : "Nothing is filtered, so this is the whole collection.",
    );
}

function headline() {
    const aggregate = view.aggregate;
    if (!aggregate) {
        return null;
    }
    const totals = aggregate.totals;
    return card("Selection", [
        el("div", { class: "kpis" }, [
            kpi("Jobs", number(totals.jobs), `${number(totals.completed)} finished`),
            kpi("Success", percent(aggregate.successRate), `of ${number(totals.decided)} decided`),
            kpi("Median wait", duration(aggregate.wait.p50), `p95 ${duration(aggregate.wait.p95)}`),
            kpi("Median run", duration(aggregate.duration.p50), `p95 ${duration(aggregate.duration.p95)}`),
            kpi("Compute", duration(aggregate.computeMs), "summed job time"),
            kpi("Peak concurrency", number(aggregate.concurrency.max), `p95 ${number(Math.round(aggregate.concurrency.p95))}`),
            kpi("Runners", number(aggregate.distinct.runners), `${number(aggregate.distinct.workflows)} workflows`),
            kpi("Unfinished", number(totals.unfinished), totals.unfinished ? "closed at collection time" : "none"),
        ]),
    ]);
}

function timelineCard() {
    const aggregate = view.aggregate;
    if (!aggregate) {
        return null;
    }
    const selection = view.filters.from !== null && view.filters.to !== null ? { from: view.filters.from, to: view.filters.to } : null;
    return card(
        "Jobs over time",
        [
            renderStackedTimeline(aggregate.timeline, {
                series: TIMELINE_SERIES,
                selection,
                onSelect: (range) => setFilters(range ?? { from: null, to: null }),
            }),
            el(
                "ul",
                { class: "share__legend" },
                TIMELINE_SERIES.map((entry) =>
                    el("li", { class: "share__legend-item" }, [
                        el("span", { class: "share__swatch", style: `background:${entry.color}` }),
                        el("span", { text: entry.label }),
                    ]),
                ),
            ),
        ],
        "Bars count jobs by when they were queued. Drag across the chart to filter to a range; click once inside a selection to clear it.",
    );
}

function concurrencyCard() {
    const aggregate = view.aggregate;
    if (!aggregate) {
        return null;
    }
    const selection = view.filters.from !== null && view.filters.to !== null ? { from: view.filters.from, to: view.filters.to } : null;
    return card(
        "Peak concurrency",
        [
            renderAreaChart(aggregate.concurrency.points, {
                bucketMs: aggregate.concurrency.bucketMs,
                label: "peak jobs",
                selection,
                onSelect: (range) => setFilters(range ?? { from: null, to: null }),
            }),
        ],
        "The most jobs running at once within each bucket, counting a job in every bucket it spans rather than only the one it started in.",
    );
}

function distributionCard() {
    const aggregate = view.aggregate;
    if (!aggregate) {
        return null;
    }
    return card(
        "Wait and run time",
        [
            el("h3", { class: "subhead", text: "Queue wait" }),
            renderHistogram(aggregate.waitHistogram),
            el("p", {
                class: "card__note",
                text: `${number(aggregate.wait.count)} measured · ${number(aggregate.wait.missing)} never started`,
            }),
            el("h3", { class: "subhead", text: "Run time" }),
            renderHistogram(aggregate.durationHistogram),
            el("p", {
                class: "card__note",
                text: `${number(aggregate.duration.count)} measured · ${number(aggregate.duration.missing)} still running or never started`,
            }),
        ],
        "Jobs with no measurement are counted separately rather than folded in as zero, which would pull every percentile down.",
    );
}

function breakdownCard() {
    const aggregate = view.aggregate;
    if (!aggregate) {
        return null;
    }
    return card(
        "Breakdown",
        [
            el("h3", { class: "subhead", text: "Conclusion" }),
            renderShareBar(aggregate.byConclusion, {
                colorOf: conclusionColorFor,
                active: view.filters.conclusion,
                onPick: (entry) => toggleFacet("conclusion", entry.key),
            }),
            el("h3", { class: "subhead", text: "Runner kind" }),
            renderShareBar(aggregate.byKind, {
                colorOf: colorFor,
                active: view.filters.kind,
                onPick: (entry) => toggleFacet("kind", entry.key),
            }),
            el("h3", { class: "subhead", text: "Event" }),
            renderShareBar(aggregate.byEvent, {
                colorOf: colorFor,
                active: view.filters.event,
                onPick: (entry) => toggleFacet("event", entry.key),
            }),
        ],
        "Click a segment to filter to it.",
    );
}

function rankedCard(title, entries, facetKey, note) {
    if (!entries) {
        return null;
    }
    return card(
        title,
        [
            renderRankedBars(entries, {
                valueOf: (entry) => entry.computeMs ?? entry.count,
                formatValue: (entry) => (entry.computeMs !== undefined ? duration(entry.computeMs) : number(entry.count)),
                secondaryOf: (entry) =>
                    entry.count !== undefined
                        ? `${number(entry.count)} jobs${entry.failureRate > 0 ? ` · ${percent(entry.failureRate)} failed` : ""}`
                        : "",
                active: view.filters[facetKey] ?? [],
                onPick: (entry) => toggleFacet(facetKey, entry.key),
            }),
        ],
        note,
    );
}

/* ---------------------------------------------------------------- heatmap */

function heatmapCard() {
    const heatmap = view.aggregate?.heatmap;
    if (!heatmap || heatmap.buckets.length === 0) {
        return null;
    }
    const buckets = heatmap.buckets;
    const bucketMs = buckets[0].end - buckets[0].start;
    // The observable part of each bucket. The axis is epoch-aligned, so the
    // first and last columns are usually clipped by the collection window, and
    // measuring them against a whole bucket would understate them.
    const spans = heatmap.spans ?? buckets.map(() => bucketMs);
    const rows = heatmap.runners.slice(0, view.heatRows);
    if (rows.length === 0) {
        return card("Runner busy state", [el("p", { class: "chart-empty", text: "No named runner ran a job in this selection." })]);
    }

    const head = el("div", { class: "heat__row heat__row--head" }, [
        el("span", { class: "heat__name", text: "Runner" }),
        el(
            "div",
            { class: "heat__cells" },
            buckets.map((bucket, index) =>
                index % Math.max(1, Math.round(buckets.length / 8)) === 0
                    ? el("span", { class: "heat__tick", text: new Date(bucket.start).toLocaleDateString([], { month: "short", day: "numeric" }) })
                    : el("span", { class: "heat__tick" }),
            ),
        ),
        el("span", { class: "heat__total", text: "Busy" }),
    ]);

    const body = rows.map((runner) => {
        const cells = runner.cells.map((busy, index) => {
            const span = spans[index] ?? bucketMs;
            const ratio = span > 0 ? Math.max(0, Math.min(1, busy / span)) : 0;
            return el("span", {
                class: "heat__cell",
                style: `background:${ratio > 0 ? `color-mix(in srgb, var(--true-color-blue, #0969da) ${Math.round(8 + ratio * 92)}%, transparent)` : "transparent"}`,
                title: `${runner.runner}\n${new Date(buckets[index].start).toLocaleString()}\nbusy ${duration(busy)} of ${duration(span)} observed (${percent(ratio)})`,
            });
        });
        return el("div", { class: "heat__row" }, [
            el("button", {
                class: `heat__name heat__name--pick${(view.filters.runner ?? []).includes(runner.runner) ? " heat__name--on" : ""}`,
                type: "button",
                title: `${runner.runner} · ${runner.kind}${runner.group ? ` · ${runner.group}` : ""} — click to filter`,
                text: runner.runner,
                onClick: () => toggleFacet("runner", runner.runner),
            }),
            el("div", { class: "heat__cells" }, cells),
            el("span", { class: "heat__total", title: `${number(runner.jobs)} jobs, ${duration(runner.jobMs)} of job time`, text: duration(runner.busyMs) }),
        ]);
    });

    const notes = [];
    notes.push(
        "Shading is the share of each bucket the runner was occupied. Overlapping jobs on one runner are merged, " +
            "so busy time is real occupancy and is lower than summed job time whenever a runner ran jobs in parallel.",
    );
    if (heatmap.remainder.runners > 0) {
        notes.push(`${number(heatmap.remainder.runners)} further runners are not drawn; together they were busy ${duration(heatmap.remainder.total)}.`);
    }
    if (heatmap.unnamed) {
        notes.push(`${number(heatmap.unnamed.jobs)} jobs reported no runner name and are excluded rather than merged into one row.`);
    }
    // A GitHub-hosted runner is destroyed after the job it ran, so every row
    // here is one job and the chart says nothing about a machine's occupancy.
    // Worth saying plainly: the same picture over a self-hosted fleet means
    // something quite different.
    const ephemeral = rows.filter((runner) => runner.kind === "hosted").length;
    if (ephemeral > rows.length / 2) {
        notes.push(
            `${ephemeral === rows.length ? "These" : "Most of these"} are GitHub-hosted runners, which are created per job and destroyed after it, ` +
                "so each row is a single job rather than a machine's occupancy over time. Filter to self-hosted under Kind to see a reusable fleet.",
        );
    }

    return card(
        "Runner busy state",
        [el("div", { class: "heat" }, [head, ...body])],
        notes.join(" "),
        el("label", { class: "control" }, [
            el("span", { class: "control__label", text: "Rows" }),
            el(
                "select",
                {
                    class: "control__input",
                    onChange: (event) => {
                        view.heatRows = Number(event.target.value);
                        void refreshAggregate();
                    },
                },
                [10, 25, 50, 100].map((count) =>
                    el("option", { value: String(count), selected: view.heatRows === count, text: String(count) }),
                ),
            ),
        ]),
    );
}

/* ------------------------------------------------------------------ table */

/**
 * Where a job lives on GitHub.
 *
 * The table is where a reader stops scanning aggregates and picks out one
 * slow job; without a way through to it they have to copy the workflow name
 * into the web UI and hunt for the run by hand.
 */
function jobUrl(row) {
    if (!row.repo || !row.runId || row.runId === "0") {
        return null;
    }
    const origin = view.snapshot?.scope?.host ? `https://${view.snapshot.scope.host}` : "https://github.com";
    const base = `${origin}/${row.repo}/actions/runs/${row.runId}`;
    return row.jobId && row.jobId !== "0" ? `${base}/job/${row.jobId}` : base;
}

function tableCard() {
    const page = view.page;
    if (!page) {
        return null;
    }
    const head = el(
        "tr",
        {},
        TABLE_COLUMNS.map((column) =>
            el("th", { scope: "col" }, [
                el("button", {
                    class: `sort${view.sort === column.sort ? ` sort--${view.direction}` : ""}`,
                    type: "button",
                    text: column.label,
                    onClick: () => {
                        if (view.sort === column.sort) {
                            view.direction = view.direction === "asc" ? "desc" : "asc";
                        } else {
                            view.sort = column.sort;
                            view.direction = column.first;
                        }
                        view.offset = 0;
                        void refreshPage();
                    },
                }),
            ]),
        ),
    );

    const body = page.rows.map((row) => {
        const url = jobUrl(row);
        return el("tr", {}, [
            el("td", { text: row.queuedAt ? new Date(row.queuedAt).toLocaleString() : "–" }),
            el("td", { title: row.repo, text: row.repo || "–" }),
            el("td", { title: row.workflowPath || row.workflow, text: row.workflow || "–" }),
            el(
                "td",
                { title: `${row.jobName}${url ? `\njob ${row.jobId}` : ""}` },
                [
                    url
                        ? el("a", { class: "table__link", href: url, target: "_blank", rel: "noreferrer", text: row.jobName || "–" })
                        : el("span", { text: row.jobName || "–" }),
                ],
            ),
            el("td", { title: `${row.runnerName || "unidentified"} · ${row.kind}`, text: row.runnerName || "–" }),
            el("td", { class: "num", text: duration(row.waitMs) }),
            el("td", { class: "num", text: duration(row.durationMs) }),
            el("td", {}, [el("span", { class: `pill pill--${row.succeeded ? "ok" : row.failed ? "bad" : "warn"}`, text: row.conclusion || row.state })]),
        ]);
    });

    const from = page.matched === 0 ? 0 : page.offset + 1;
    const to = Math.min(page.offset + page.rows.length, page.matched);
    const reachable = Math.min(page.matched, MAX_TABLE_ROWS);

    return card(
        "Jobs",
        [
            el("div", { class: "table-wrap" }, [
                el("table", { class: "table" }, [el("thead", {}, [head]), el("tbody", {}, body)]),
            ]),
            el("div", { class: "pager" }, [
                el("button", {
                    class: "button",
                    type: "button",
                    disabled: page.offset <= 0,
                    text: "Previous",
                    onClick: () => {
                        view.offset = Math.max(0, view.offset - PAGE_SIZE);
                        void refreshPage();
                    },
                }),
                el("span", { class: "pager__label", text: `${number(from)}–${number(to)} of ${number(page.matched)}` }),
                el("button", {
                    class: "button",
                    type: "button",
                    disabled: page.offset + PAGE_SIZE >= reachable,
                    text: "Next",
                    onClick: () => {
                        view.offset += PAGE_SIZE;
                        void refreshPage();
                    },
                }),
            ]),
        ],
        page.matched > MAX_TABLE_ROWS
            ? `Paging stops at ${number(MAX_TABLE_ROWS)} rows. Narrow the selection to reach the rest; every chart above already counts all ${number(page.matched)}.`
            : null,
    );
}

/* ------------------------------------------------------------------ paint */

/**
 * The one setting this tab owns.
 *
 * Kept next to the scope banner rather than in the toolbar because it is the
 * answer to the warning the banner shows: a reader who has just been told the
 * rows were truncated needs the control that fixes it within reach.
 */
function budgetControl(state) {
    const current = state?.filters?.rowBudget ?? 20000;
    let draft = String(current);
    return el("details", { class: "card card--settings", open: view.snapshot?.truncated === true }, [
        el("summary", { class: "card__header" }, [el("h2", { class: "card__title", text: "Explorer settings" })]),
        el("div", { class: "card__body" }, [
            el("label", { class: "control" }, [
                el("span", { class: "control__label", text: "Row budget" }),
                el("input", {
                    class: "control__input",
                    id: "explore-row-budget",
                    type: "number",
                    min: "500",
                    max: "200000",
                    step: "500",
                    value: draft,
                    onInput: (event) => {
                        draft = event.target.value;
                    },
                    onChange: () => {
                        const value = Number(draft);
                        if (!Number.isFinite(value) || value === current) {
                            return;
                        }
                        // Committed through the panel's own filters so it is
                        // persisted and shared with a second panel on this
                        // target, the same way every other setting is.
                        void host?.applyFilters({ rowBudget: Math.round(value) });
                    },
                }),
                el("span", {
                    class: "control__hint",
                    text: "How many job rows are held in the browser. Raising it costs memory and collection time; lowering it truncates the window.",
                }),
            ]),
        ]),
        el("p", {
            class: "card__note",
            text: "Changing this does not collect on its own, because re-reading every job is minutes over a busy organization. Press Re-collect rows when you are ready.",
        }),
    ]);
}

function collectButton(state) {
    const busy = state?.rows?.status === "loading" || view.status === "collecting" || view.status === "loading";
    return el("button", {
        class: "button button--primary",
        type: "button",
        disabled: busy,
        text: busy ? "Collecting…" : view.loaded ? "Re-collect rows" : "Collect job rows",
        onClick: () => host?.requestRows({ force: Boolean(view.loaded) }),
    });
}

function sections(state) {
    if (view.status === "error") {
        return [
            card("Job explorer", [
                el("p", { class: "empty", text: view.error ?? "Something went wrong." }),
                collectButton(state),
            ]),
        ];
    }
    if (!view.loaded) {
        const busy = view.status === "collecting" || view.status === "loading";
        return [
            card(
                "Job explorer",
                [
                    el("p", {
                        class: "empty",
                        text: busy
                            ? state?.progress || "Reading every job in the window…"
                            : "This tab reads every job in the window once and then answers every filter in the browser.",
                    }),
                    collectButton(state),
                ],
                "Collected with both runner kinds and no runner narrowing, so every filter here can only narrow what is already in hand.",
            ),
        ];
    }
    return [
        scopeBanner(state),
        el("div", { class: "explore__actions" }, [collectButton(state), budgetControl(state)]),
        state?.rows?.stale
            ? el("p", {
                  class: "scope__warn",
                  text: "The window or filters changed since these rows were collected. Re-collect to bring this tab in line with the toolbar.",
              })
            : null,
        filterBar(),
        headline(),
        timelineCard(),
        concurrencyCard(),
        heatmapCard(),
        distributionCard(),
        breakdownCard(),
        rankedCard("Top workflows", view.aggregate?.topWorkflows, "workflow", "Ranked by summed job time. Click a name to filter."),
        rankedCard("Top runners", view.aggregate?.topRunners, "runner", "Ranked by summed job time, not by occupancy — see the heatmap for real busy time."),
        rankedCard("Top runs-on labels", view.aggregate?.topLabels, "label", "A job is counted under every label it requested."),
        view.aggregate?.topRepos?.length > 1
            ? rankedCard("Top repositories", view.aggregate.topRepos, "repo", "Ranked by summed job time.")
            : null,
        tableCard(),
    ];
}

function paint() {
    if (!view.root || host?.activeTab() !== "explore") {
        return;
    }
    const state = host.state();
    // Focus and caret are restored the same way the page does it, because this
    // subtree is rebuilt on every worker answer and the search field would
    // otherwise lose the caret mid-word.
    const focused = document.activeElement;
    const focusId = focused?.id && view.root.contains(focused) ? focused.id : null;
    const caret = focusId ? { start: focused.selectionStart, end: focused.selectionEnd } : null;

    view.root.replaceChildren(...sections(state).filter(Boolean));

    if (focusId) {
        const restored = document.getElementById(focusId);
        if (restored && restored !== document.activeElement) {
            restored.focus({ preventScroll: true });
            if (caret?.start !== null && typeof restored.setSelectionRange === "function") {
                try {
                    restored.setSelectionRange(caret.start, caret.end);
                } catch {
                    // Not every input type carries a selection.
                }
            }
        }
    }
}

/**
 * The tab's root.
 *
 * Retained across renders rather than rebuilt, so that moving it back into the
 * content region does not discard a chart mid-drag or a facet list mid-scroll.
 */
export function renderExplorer(state) {
    if (!view.root) {
        view.root = el("div", { class: "explore" });
    }
    view.root.replaceChildren(...sections(state).filter(Boolean));
    return [view.root];
}

/** Drop everything that describes the target being left. */
export function resetExplorer() {
    view.loaded = null;
    view.fetching = null;
    view.snapshot = null;
    view.aggregate = null;
    view.facets = null;
    view.page = null;
    view.health = null;
    view.status = "idle";
    view.error = null;
    view.matched = 0;
    view.total = 0;
    view.filters = emptyExploreFilters();
    view.searchDraft = "";
    view.offset = 0;
    view.aggregateSeq += 1;
    view.pageSeq += 1;
    // A fetch already in flight belongs to the target being left; letting it
    // land would load another repository's rows into the panel.
    view.fetchSeq += 1;
    view.fetchAbort?.abort();
    view.fetchAbort = null;
    view.openFacets.clear();
    view.facetQuery.clear();
    if (view.searchTimer) {
        clearTimeout(view.searchTimer);
        view.searchTimer = null;
    }
    if (view.worker) {
        void ask("release", {}).catch(() => {});
    }
}
