import { svg } from "./charts.js";
import { sortByCriteria, toggleSort } from "/shared/sort.mjs";
import { displayStepName, formatDuration, formatLabelSet, isRunnerFilterActive, labelSetKey, normalizeRunnerFilter, splitLabelSet, stepIdOf, timelineMatchesWorkflow } from "/shared/steps.mjs";

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === "class") node.className = value;
        else if (key === "text") node.textContent = String(value);
        else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of [children].flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function number(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "–";
}

function percent(value) {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "–";
}

function workflowFile(pathOrName) {
    const text = String(pathOrName ?? "");
    return text.split("/").filter(Boolean).at(-1) ?? text;
}

let loading = false;
let error = null;
// The id of the selected step statistic: repository, workflow file, job and step
// occurrence, so steps sharing a display name in different jobs stay apart.
let selectedStepId = "";
let stepSorts = [{ key: "offset", direction: "asc" }];
let runInput = "";
let attemptInput = "";
let stepRequestSeq = 0;
let runTimelineSeq = 0;
// The pending close request, which a following open waits for so that a late close
// cannot clear or abort the run opened after it.
let closingRunTimeline = Promise.resolve();
const prefsByIdentity = new Map();
const prefsLoading = new Set();

function workflowOptions(state) {
    const rows = state?.metrics?.fleet?.workflows?.length ? state.metrics.fleet.workflows : state?.metrics?.overview?.byWorkflow ?? [];
    const seen = new Map();
    for (const row of rows) {
        const value = workflowFile(row.workflowPath || row.workflow || row.name);
        if (!value) continue;
        const label = row.workflowPath ? `${row.workflow} · ${value}` : row.workflow || row.name || value;
        if (!seen.has(value)) seen.set(value, label);
    }
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
}

const RUNNER_KIND_LABELS = { hosted: "GitHub-hosted", "self-hosted": "Self-hosted", unknown: "Unknown" };

function kindLabel(kind) {
    return RUNNER_KIND_LABELS[kind] ?? kind ?? "–";
}

// listSummary shows the most frequent value and how many others there are, with every
// value in the tooltip.
function listSummary(values, empty = "–") {
    const names = (values ?? []).map((item) => (typeof item === "string" ? item : item.value)).filter(Boolean);
    if (names.length === 0) return { text: empty, title: null };
    return { text: names.length === 1 ? names[0] : `${names[0]} +${names.length - 1}`, title: names.length > 1 ? names.join("\n") : null };
}

function summaryCell(values, props = {}) {
    const summary = listSummary(values);
    return el("td", { ...props, title: summary.title, text: summary.text });
}

function runnerFilterFromControls(patch = {}) {
    return normalizeRunnerFilter({
        kind: document.getElementById("steps-runner-kind")?.value ?? "all",
        labels: document.getElementById("steps-runner-labels")?.value ?? "",
        group: document.getElementById("steps-runner-group")?.value ?? "",
        name: document.getElementById("steps-runner-name")?.value ?? "",
        ...patch,
    });
}

// applyRunnerFilter re-aggregates the rows already collected for this workflow, so it
// does not call the CLI unless the workflow or run budget changed.
function applyRunnerFilter(state, patch = {}) {
    void loadSteps(state, { reuseRows: true, runnerFilter: runnerFilterFromControls(patch) });
}

async function loadSteps(state, { reuseRows = false, runnerFilter = runnerFilterFromControls() } = {}) {
    const workflow = document.getElementById("steps-workflow")?.value?.trim() ?? "";
    if (!workflow) {
        error = "Choose a workflow file first.";
        renderSoon();
        return;
    }
    const body = {
        workflow,
        job: document.getElementById("steps-job")?.value?.trim() ?? "",
        mergeMatrix: document.getElementById("steps-merge")?.checked !== false,
        showInfra: document.getElementById("steps-infra")?.checked !== false,
        runBudget: Number(document.getElementById("steps-budget")?.value) || 500,
        kind: "all",
        runnerFilter,
        reuseRows,
    };
    const seq = ++stepRequestSeq;
    loading = true;
    error = null;
    renderSoon();
    try {
        const response = await fetch("./api/steps", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const result = await response.json().catch(() => ({}));
        // A newer request owns the panel; its response or the SSE snapshot will render.
        if (seq !== stepRequestSeq || result.superseded) return;
        if (!response.ok) throw new Error(result.reason ?? result.error ?? `Request failed with HTTP ${response.status}`);
        const stale = !timelineMatchesWorkflow(state.steps?.timeline, workflow);
        const { reuseRows: _reuse, ...settings } = body;
        state.steps = { ...(state.steps ?? {}), ...(stale ? { timeline: null, timelineRequest: null } : {}), status: "ready", settings, result };
        if (!reuseRows || !(result.stepStats ?? []).some((row) => row.id === selectedStepId)) {
            selectedStepId = result.stepStats?.[0]?.id ?? "";
        }
    } catch (caught) {
        if (seq === stepRequestSeq) error = caught.message;
    } finally {
        if (seq === stepRequestSeq) {
            loading = false;
            renderSoon();
        }
    }
}

async function openRunTimeline(state, run, repo = "", attemptValue = attemptInput) {
    const value = String(run ?? runInput ?? "").trim();
    if (!value) return;
    // An organization target names no repository, so a bare run ID cannot be resolved.
    if (state?.scope === "org" && !repo && !/^https?:\/\//i.test(value)) {
        error = "This dashboard targets an organization; paste the run URL to open a run by hand.";
        renderSoon();
        return;
    }
    const seq = ++runTimelineSeq;
    loading = true;
    error = null;
    renderSoon();
    const params = new URLSearchParams({ run: value });
    if (repo) params.set("repo", repo);
    const parsed = Math.floor(Number(attemptValue));
    const attempt = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    if (attempt) params.set("attempt", String(attempt));
    try {
        await closingRunTimeline;
        if (seq !== runTimelineSeq) return;
        const response = await fetch(`./api/run-timeline?${params}`);
        const result = await response.json().catch(() => ({}));
        // A newer open or a close owns the panel; its response or the SSE snapshot renders.
        if (seq !== runTimelineSeq || result.superseded) return;
        if (!response.ok) throw new Error(result.reason ?? result.error ?? `Request failed with HTTP ${response.status}`);
        state.steps = { ...(state.steps ?? {}), timeline: result.timeline, timelineRequest: { run: value, repo, attempt } };
    } catch (caught) {
        if (seq === runTimelineSeq) error = caught.message;
    } finally {
        if (seq === runTimelineSeq) {
            loading = false;
            renderSoon();
        }
    }
}

function renderSoon() {
    document.dispatchEvent(new CustomEvent("actions-metrics:render"));
}

function controlPanel(state) {
    const settings = state?.steps?.settings ?? prefsByIdentity.get(state?.identity) ?? {};
    const options = workflowOptions(state);
    const currentWorkflow = settings.workflow || state?.filters?.workflow || options[0]?.value || "";
    const jobs = state?.steps?.result?.jobStats ?? [];
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Step timeline" })]),
        el("div", { class: "card__body" }, [
            el("div", { class: "controls" }, [
                el("label", { class: "inline-field" }, [
                    el("span", { text: "Workflow" }),
                    el("select", { id: "steps-workflow" }, options.length ? options.map((option) => el("option", { value: option.value, text: option.label, selected: option.value === currentWorkflow })) : [el("option", { value: currentWorkflow, text: currentWorkflow || "No workflow rows yet" })]),
                ]),
                el("label", { class: "inline-field" }, [
                    el("span", { text: "Job" }),
                    el("select", { id: "steps-job" }, [el("option", { value: "", text: "All jobs" }), ...jobs.map((job) => el("option", { value: job.job, text: job.variants?.length > 1 ? `${job.job} (${job.variants.length} variants)` : job.job, selected: settings.job === job.job }))]),
                ]),
                el("label", { class: "inline-field" }, [el("span", { text: "Runs" }), el("input", { id: "steps-budget", type: "number", min: "1", max: "5000", value: String(settings.runBudget ?? 500) })]),
                el("label", { class: "inline-field inline-field--check" }, [el("input", { id: "steps-merge", type: "checkbox", checked: settings.mergeMatrix !== false }), el("span", { text: "Merge matrix" })]),
                el("label", { class: "inline-field inline-field--check" }, [el("input", { id: "steps-infra", type: "checkbox", checked: settings.showInfra !== false }), el("span", { text: "Show infra" })]),
                el("button", { type: "button", class: "button button--primary", disabled: loading, text: loading ? "Loading…" : "Load steps", onclick: () => void loadSteps(state) }),
            ]),
            runnerControls(state, settings),
            error ? el("p", { class: "notice notice--warn", text: error }) : null,
        ]),
        el("p", { class: "card__note", text: "Statistics are sampled by newest runs of one workflow file with --max-runs. Workflow display names are not accepted by the CLI; use the file name such as ci.yml." }),
    ]);
}

function runnerControls(state, settings) {
    const facets = state?.steps?.result?.runnerFacets;
    if (!facets) return null;
    const filter = normalizeRunnerFilter(state?.steps?.result?.runnerFilter ?? settings.runnerFilter);
    if (filter.labels) {
        const key = labelSetKey(splitLabelSet(filter.labels));
        filter.labels = (facets.labelSets ?? []).find((item) => labelSetKey(splitLabelSet(item.value)) === key)?.value ?? filter.labels;
    }
    const choice = (values, current, allText, format = (value) => value) => {
        const options = values.map((item) => ({ value: item.value, text: `${format(item.value)} (${number(item.count)})` }));
        if (current && !options.some((option) => option.value === current)) options.unshift({ value: current, text: `${format(current)} (0)` });
        return [el("option", { value: "", text: allText }), ...options.map((option) => el("option", { value: option.value, text: option.text, selected: option.value === current }))];
    };
    const onChange = () => applyRunnerFilter(state);
    return el("div", { class: "controls controls--runner" }, [
        el("span", { class: "controls__label", text: "Runner" }),
        el("label", { class: "inline-field" }, [
            el("span", { text: "Kind" }),
            el("select", { id: "steps-runner-kind", onchange: onChange }, [
                ["all", "All kinds"],
                ["self-hosted", "Self-hosted"],
                ["github-hosted", "GitHub-hosted"],
            ].map(([value, text]) => el("option", { value, text, selected: filter.kind === value }))),
        ]),
        el("label", { class: "inline-field" }, [el("span", { text: "Runs-on" }), el("select", { id: "steps-runner-labels", onchange: onChange }, choice(facets.labelSets ?? [], filter.labels, "All label sets", (value) => value || "(no labels)"))]),
        el("label", { class: "inline-field" }, [el("span", { text: "Group" }), el("select", { id: "steps-runner-group", onchange: onChange }, choice(facets.groups ?? [], filter.group, "All groups"))]),
        el("label", { class: "inline-field" }, [
            el("span", { text: "Name" }),
            el("input", { id: "steps-runner-name", type: "search", list: "steps-runner-names", placeholder: "runner name, * wildcard", value: filter.name, onchange: onChange }),
            el("datalist", { id: "steps-runner-names" }, (facets.names ?? []).map((item) => el("option", { value: item.value }))),
        ]),
        isRunnerFilterActive(filter) ? el("button", { type: "button", class: "ghost", text: "Clear runner filter", onclick: () => applyRunnerFilter(state, normalizeRunnerFilter()) }) : null,
    ]);
}

function runnersCard(state) {
    const result = state?.steps?.result;
    const pools = result?.runners ?? [];
    if (!result?.runnerFacets) return null;
    const filter = normalizeRunnerFilter(result.runnerFilter);
    const filterKey = filter.labels ? labelSetKey(splitLabelSet(filter.labels)) : null;
    const body = pools.length === 0
        ? el("p", { class: "empty", text: "No jobs to group by runner." })
        : el("table", { class: "runners-table" }, [
            el("thead", {}, [el("tr", {}, [el("th", { text: "Runs-on" }), el("th", { text: "Kind" }), el("th", { text: "Group" }), el("th", { text: "Runners" }), el("th", { class: "num", text: "Jobs" }), el("th", { class: "num", text: "Wait p50" }), el("th", { class: "num", text: "Wait p90" }), el("th", { class: "num", text: "Run p50" }), el("th", { class: "num", text: "Run p90" }), el("th", { class: "num", text: "Fail" })])]),
            el("tbody", {}, pools.map((pool) => {
                const active = filterKey !== null && filterKey === pool.key;
                // A job without runs-on labels cannot be selected, because an empty
                // label filter means every label set.
                const selectable = pool.labels !== "";
                return el("tr", {
                    class: `${active ? "row--selected" : ""}${selectable ? " runners-table__row--selectable" : ""}`.trim() || null,
                    title: !selectable ? null : active ? "Click to show every runs-on set" : "Click to filter the statistics by this runs-on set",
                    onclick: selectable ? () => applyRunnerFilter(state, { labels: active ? "" : pool.labels }) : null,
                }, [
                    el("td", { class: "runners-table__labels", text: pool.labels || "(no labels)" }),
                    summaryCell(pool.kinds.map((item) => kindLabel(item.value))),
                    summaryCell(pool.groups),
                    summaryCell(pool.runners.map((item) => `${item.value} (${number(item.count)})`)),
                    el("td", { class: "num", text: number(pool.jobs) }),
                    el("td", { class: "num", text: pool.wait.samples ? formatDuration(pool.wait.p50) : "–" }),
                    el("td", { class: "num", text: pool.wait.samples ? formatDuration(pool.wait.p90) : "–" }),
                    el("td", { class: "num", text: pool.duration.samples ? formatDuration(pool.duration.p50) : "–" }),
                    el("td", { class: "num", text: pool.duration.samples ? formatDuration(pool.duration.p90) : "–" }),
                    el("td", { class: "num", text: percent(pool.failureRate) }),
                ]);
            })),
        ]);
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Runners" })]),
        el("div", { class: "card__body" }, [body]),
        el("p", { class: "card__note", text: "Jobs grouped by their runs-on label set, before the runner filter is applied. Hosted runners are reported as GitHub Actions. Wait and run percentiles only use jobs that started or finished." }),
    ]);
}

function byRunnerTable(step) {
    const pools = step?.byRunner ?? [];
    if (pools.length === 0) return null;
    return el("table", { class: "runners-table runners-table--compact" }, [
        el("caption", { text: "This step by runs-on set" }),
        el("thead", {}, [el("tr", {}, [el("th", { text: "Runs-on" }), el("th", { class: "num", text: "Samples" }), el("th", { class: "num", text: "p50" }), el("th", { class: "num", text: "p90" })])]),
        el("tbody", {}, pools.map((pool) => el("tr", {}, [
            el("td", { class: "runners-table__labels", text: pool.labels || "(no labels)" }),
            el("td", { class: "num", text: number(pool.samples) }),
            el("td", { class: "num", text: formatDuration(pool.p50) }),
            el("td", { class: "num", text: formatDuration(pool.p90) }),
        ]))),
    ]);
}

function footnote(result) {
    if (!result?.meta) return null;
    const meta = result.meta;
    const range = meta.oldest && meta.newest ? `${new Date(meta.oldest).toLocaleString()} – ${new Date(meta.newest).toLocaleString()}` : "no timestamp range";
    const filtered = isRunnerFilterActive(meta.runnerFilter) ? ` The runner filter keeps ${number(meta.totalJobs)} of ${number(meta.unfilteredJobs)} jobs.` : "";
    return el("p", { class: `notice${meta.truncated ? " notice--warn" : ""}`, text: `${number(meta.analysedRuns)} runs analysed for ${meta.workflow}; ${range}. ${meta.truncated ? "The run budget was reached, so this is a sample of newest runs." : "The run budget was not reached."} Job lists use GitHub's latest-attempt basis, including carried-over jobs.${filtered}` });
}

// Gantt charts are laid out as an HTML grid (name | track | duration) rather than
// SVG so step names never overlap bars and can ellipsize with a full-name tooltip.
function pct(value, max) {
    const ratio = max > 0 ? value / max : 0;
    return `${(Math.min(1, Math.max(0, ratio)) * 100).toFixed(3)}%`;
}

function span(start, length, max, minPx = 2) {
    return `left:${pct(start, max)};width:max(${minPx}px, ${pct(length, max)})`;
}

function ganttAxis(max) {
    return el("div", { class: "gantt__row gantt__row--axis" }, [
        el("span"),
        el("div", { class: "gantt__ticks" }, [0, 0.25, 0.5, 0.75, 1].map((ratio) => el("span", { class: "gantt__tick", style: `left:${ratio * 100}%`, text: formatDuration(max * ratio) }))),
        el("span"),
    ]);
}

function ganttStepRow({ name, tooltip, duration, segments }) {
    const label = displayStepName(name);
    return el("div", { class: "gantt__row", title: tooltip }, [
        el("span", { class: "gantt__name", text: label }),
        el("div", { class: "gantt__track" }, segments),
        el("span", { class: "gantt__dur", text: formatDuration(duration) }),
    ]);
}

function typicalTimeline(result) {
    const jobs = result?.typicalTimeline ?? [];
    if (jobs.length === 0) return el("p", { class: "empty", text: "Load a workflow to draw the typical step timeline." });
    const max = Math.max(1000, ...jobs.flatMap((job) => job.steps.map((step) => Math.max(job.startOffsetMs + step.offsetMs + step.durationMs, job.startOffsetMs + step.offsetP90Ms + step.durationP90Ms))));
    const rows = [ganttAxis(max)];
    for (const job of jobs) {
        rows.push(el("div", { class: "gantt__group", text: job.job }));
        for (const step of job.steps) {
            const start = job.startOffsetMs + step.offsetMs;
            const rangeStart = job.startOffsetMs + step.offsetP25Ms;
            const rangeLength = step.offsetP90Ms - step.offsetP25Ms + step.durationP90Ms;
            const variant = step.failed ? " gantt__bar--failed" : step.infrastructure ? " gantt__bar--infra" : "";
            rows.push(ganttStepRow({
                name: step.name,
                tooltip: `${job.job} / ${step.name}\np50 ${formatDuration(step.durationMs)} · p90 ${formatDuration(step.durationP90Ms)}`,
                duration: step.durationMs,
                segments: [
                    el("span", { class: "gantt__range", style: span(rangeStart, rangeLength, max) }),
                    el("span", { class: `gantt__bar${variant}`, style: span(start, step.durationMs, max) }),
                ],
            }));
        }
    }
    // A group rather than an image: an image role would hide the step names and
    // durations inside from assistive technology.
    return el("div", { class: "gantt", role: "group", "aria-label": "Typical step timeline" }, rows);
}

function sortedSteps(rows) {
    const accessors = {
        step: (row) => row.stepKey.toLowerCase(),
        job: (row) => row.job.toLowerCase(),
        p50: (row) => row.duration.p50,
        p90: (row) => row.duration.p90,
        cv: (row) => row.duration.cv,
        failure: (row) => row.failureRate,
        share: (row) => row.share,
        trend: (row) => row.trend.deltaP50Ms,
        presence: (row) => row.presence,
        offset: (row) => row.offsetMs,
    };
    return sortByCriteria(rows, stepSorts, accessors, (a, b) => a.job.localeCompare(b.job) || a.offsetMs - b.offsetMs);
}

function stepHeader(label, key, first = "desc") {
    const current = stepSorts.find((entry) => entry.key === key);
    return el("th", { class: current ? "th--sorted" : "" }, [el("button", { type: "button", class: "th__button", onclick: (event) => { stepSorts = toggleSort(stepSorts, key, first, event.shiftKey, { clearOnThird: true }); renderSoon(); } }, [label, current ? ` ${current.direction === "asc" ? "▲" : "▼"}` : ""])]);
}

function stepsTable(result) {
    const rows = result?.stepStats ?? [];
    if (rows.length === 0) return el("p", { class: "empty", text: "No step statistics collected yet." });
    const ordered = sortedSteps(rows);
    return el("table", { class: "steps-table" }, [
        el("thead", {}, [el("tr", {}, [stepHeader("Job", "job", "asc"), stepHeader("Step", "step", "asc"), stepHeader("p50", "p50"), stepHeader("p90", "p90"), stepHeader("CV", "cv"), stepHeader("Fail", "failure"), stepHeader("Share", "share"), stepHeader("Trend", "trend"), stepHeader("Presence", "presence")])]),
        el("tbody", {}, ordered.map((row) => el("tr", { class: selectedStepId === row.id ? "row--selected" : "", onclick: () => { selectedStepId = row.id; renderSoon(); } }, [
            el("td", { text: row.variantCount > 1 ? `${row.job} ×${row.variantCount}` : row.job }),
            // The step name is a button so the trend can be selected from the keyboard;
            // its click bubbles to the row handler.
            el("td", { class: "step-name" }, [el("button", { type: "button", class: "link-button", "aria-pressed": selectedStepId === row.id ? "true" : "false", title: displayStepName(row.stepKey) === row.stepKey ? "Show this step's trend" : row.stepKey, text: displayStepName(row.stepKey) })]),
            el("td", { class: "num", text: formatDuration(row.duration.p50) }),
            el("td", { class: "num", text: formatDuration(row.duration.p90) }),
            el("td", { class: "num", text: row.duration.cv ? row.duration.cv.toFixed(2) : "–" }),
            el("td", { class: "num", text: percent(row.failureRate) }),
            el("td", { class: "num", text: percent(row.share) }),
            el("td", { class: "num", text: `${row.trend.deltaP50Ms >= 0 ? "+" : ""}${formatDuration(row.trend.deltaP50Ms)}` }),
            el("td", { class: "num", text: percent(row.presence) }),
        ]))),
    ]);
}

function trendChart(step) {
    if (!step) return el("p", { class: "empty", text: "Select a step to show its trend." });
    const daily = step.trend.daily ?? [];
    const points = step.trend.points ?? [];
    if (daily.length === 0 && points.length === 0) return el("p", { class: "empty", text: "This step has no timed samples." });
    const width = 960;
    const height = 180;
    const plot = { x: 50, y: 10, width: width - 70, height: height - 38 };
    const max = Math.max(1000, ...daily.flatMap((day) => [day.p50Ms, day.p90Ms]), ...points.map((point) => point.durationMs));
    const root = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none" });
    for (const ratio of [0, 0.5, 1]) {
        const y = plot.y + plot.height * (1 - ratio);
        root.append(svg("line", { class: "chart__grid", x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y }));
        root.append(svg("text", { class: "chart__label", x: plot.x - 6, y: y + 4, "text-anchor": "end", text: formatDuration(max * ratio) }));
    }
    daily.forEach((day, index) => {
        const x = plot.x + (daily.length <= 1 ? 0 : (index / (daily.length - 1)) * plot.width);
        const p50 = plot.y + plot.height * (1 - day.p50Ms / max);
        const p90 = plot.y + plot.height * (1 - day.p90Ms / max);
        root.append(svg("circle", { class: "trend__p90", cx: x, cy: p90, r: 3 }, [svg("title", { text: `${day.date} p90 ${formatDuration(day.p90Ms)}` })]));
        root.append(svg("circle", { class: "trend__p50", cx: x, cy: p50, r: 4 }, [svg("title", { text: `${day.date} p50 ${formatDuration(day.p50Ms)}` })]));
    });
    return root;
}

function runList(result, state) {
    const rows = result?.runs ?? [];
    if (rows.length === 0) return el("p", { class: "empty", text: "No run list for this job yet." });
    const open = state?.steps?.timeline;
    return el("table", { class: "runs-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Run" }), el("th", { class: "num", text: "Attempts" }), el("th", { text: "Result" }), el("th", { text: "Runner" }), el("th", { class: "num", text: "Total" }), el("th", { text: "Open" })])]),
        el("tbody", {}, rows.slice(0, 30).map((row) => {
            const show = () => void openRunTimeline(state, row.runId, row.repo ?? "", row.runAttempt);
            const active = open && String(open.RunID) === String(row.runId) && Number(open.RunAttempt) === Number(row.runAttempt);
            return el("tr", { class: active ? "row--selected" : "" }, [
                el("td", {}, [el("button", { type: "button", class: "link-button", title: "Show this run's Gantt", text: row.runId, onclick: show })]),
                el("td", { class: `num${row.runAttempt > 1 ? " runs-table__retried" : ""}`, title: row.runAttempt > 1 ? `Re-run ${row.runAttempt - 1} time(s); statistics use attempt ${row.runAttempt}` : null, text: number(row.runAttempt) }),
                el("td", { text: row.conclusion ?? "–" }),
                (() => {
                    const summary = listSummary(row.runners);
                    const labels = (row.labelSets ?? []).filter(Boolean);
                    const title = [summary.title ?? (row.runners?.length === 1 ? row.runners[0] : null), labels.length ? `runs-on: ${labels.join(" | ")}` : null].filter(Boolean).join("\n");
                    return el("td", { class: "runs-table__runner", title: title || null, text: summary.text });
                })(),
                el("td", { class: "num", text: formatDuration(row.durationMs) }),
                el("td", {}, [el("button", { type: "button", class: "ghost", text: "Gantt", onclick: show })]),
            ]);
        })),
    ]);
}

function runTimeline(timeline, stats, workflow, onClose) {
    if (!timeline) return el("p", { class: "empty", text: "Open a run to show a single-run Gantt." });
    const jobs = timeline.Jobs ?? [];
    const sameWorkflow = timelineMatchesWorkflow(timeline, workflow);
    // Keyed by repository, the job name the run reports and the step id: a merged matrix
    // statistic answers for each of its variants, and a step literally named "Upload #2"
    // does not borrow the p90 of the second "Upload".
    const p90Key = (repo, job, stepId) => JSON.stringify([repo, job, stepId]);
    const p90 = new Map();
    if (sameWorkflow) {
        for (const row of stats?.stepStats ?? []) {
            for (const job of row.variants?.length ? row.variants : [row.job]) {
                p90.set(p90Key(row.repo, job, row.stepId ?? stepIdOf(row.stepName, row.stepKey)), row.duration.p90);
            }
        }
    }
    const ms = (value) => Number(value) / 1e6 || 0;
    const max = Math.max(1000, ms(timeline.Duration), ...jobs.map((job) => ms(job.QueuedOffset) + ms(job.Wait) + ms(job.Duration)));
    const rows = [
        el("div", { class: "gantt__header" }, [
            el("span", { class: "gantt__title", text: `${timeline.Workflow} #${timeline.RunID} attempt ${timeline.RunAttempt}` }),
            onClose ? el("button", { type: "button", class: "ghost gantt__close", title: "Close this Gantt", "aria-label": "Close this Gantt", text: "× Close", onclick: onClose }) : null,
        ]),
        sameWorkflow ? null : el("p", { class: "notice notice--warn", text: `This run belongs to ${timeline.WorkflowPath || timeline.Workflow}, not ${workflow}; slow-step highlighting against p90 is off.` }),
        ganttAxis(max),
    ].filter(Boolean);
    for (const job of jobs) {
        const wait = ms(job.Wait);
        const labels = formatLabelSet(job.Labels ?? []);
        const runnerText = [job.RunnerName, job.RunnerGroup && job.RunnerGroup !== job.RunnerName ? job.RunnerGroup : null].filter(Boolean).join(" · ");
        const runnerTooltip = [
            job.RunnerName ? `runner ${job.RunnerName}` : null,
            job.RunnerGroup ? `group ${job.RunnerGroup}` : null,
            job.Kind ? `kind ${kindLabel(job.Kind)}` : null,
            labels ? `runs-on ${labels}` : null,
        ].filter(Boolean).join("\n");
        rows.push(el("div", { class: "gantt__row gantt__row--job", title: `${job.Name}\nwaited ${formatDuration(wait)} · ran ${formatDuration(ms(job.Duration))}${runnerTooltip ? `\n${runnerTooltip}` : ""}` }, [
            el("span", { class: "gantt__name gantt__name--job" }, [
                el("span", { class: "gantt__jobname", text: job.Name }),
                runnerText || labels ? el("span", { class: "gantt__runner", text: runnerText || labels }) : null,
            ]),
            el("div", { class: "gantt__track" }, [
                wait > 0 ? el("span", { class: "gantt__wait", style: span(ms(job.QueuedOffset), wait, max) }) : null,
                el("span", { class: "gantt__jobspan", style: span(ms(job.StartedOffset), ms(job.Duration), max) }),
            ]),
            el("span", { class: "gantt__dur", text: formatDuration(ms(job.Duration)) }),
        ]));
        for (const step of job.Steps ?? []) {
            const offset = ms(step.Offset);
            const duration = ms(step.Duration);
            const typical = p90.get(p90Key(timeline.Repo ?? "", job.Name, stepIdOf(step.Name, step.Key, step.Occurrence)));
            const slow = duration > (typical ?? Infinity);
            const failed = ["failure", "timed_out", "cancelled"].includes(String(step.Conclusion ?? "").toLowerCase());
            rows.push(ganttStepRow({
                name: step.Name,
                tooltip: `${step.Name}\n${formatDuration(duration)}${typical !== undefined ? ` (p90 ${formatDuration(typical)})` : ""}${step.Conclusion ? ` · ${step.Conclusion}` : ""}`,
                duration,
                segments: [el("span", { class: `gantt__bar${failed ? " gantt__bar--failed" : slow ? " gantt__bar--slow" : ""}`, style: span(offset, duration, max) })],
            }));
        }
    }
    return el("div", { class: "gantt gantt--run", role: "group", "aria-label": "Single-run Gantt" }, rows);
}

async function closeRunTimeline(state) {
    runTimelineSeq += 1;
    loading = false;
    state.steps = { ...(state.steps ?? {}), timeline: null, timelineRequest: null };
    renderSoon();
    // The next SSE snapshot reconciles the panel if the request failed.
    closingRunTimeline = fetch("./api/run-timeline", { method: "DELETE" }).then(() => {}, () => {});
    await closingRunTimeline;
}

async function copyMermaid(timelineRequest) {
    if (!timelineRequest?.run) return;
    const params = new URLSearchParams({ run: timelineRequest.run, format: "mermaid" });
    if (timelineRequest.repo) params.set("repo", timelineRequest.repo);
    if (timelineRequest.attempt) params.set("attempt", String(timelineRequest.attempt));
    const response = await fetch(`./api/run-timeline?${params}`);
    // A superseded copy answers with JSON rather than a diagram; leave the clipboard alone.
    if (response.status === 409) return;
    const text = await response.text();
    await navigator.clipboard?.writeText(text);
}

export function renderSteps(state) {
    if (state?.identity && !prefsByIdentity.has(state.identity) && !prefsLoading.has(state.identity)) {
        prefsLoading.add(state.identity);
        void fetch("./api/step-prefs")
            .then((response) => response.json())
            .then((prefs) => {
                prefsByIdentity.set(state.identity, prefs ?? {});
                renderSoon();
            })
            .catch(() => {
                prefsByIdentity.set(state.identity, {});
            })
            .finally(() => prefsLoading.delete(state.identity));
    }
    const result = state?.steps?.result;
    const step = (result?.stepStats ?? []).find((row) => row.id === selectedStepId) ?? result?.stepStats?.[0] ?? null;
    return [
        controlPanel(state),
        footnote(result),
        runnersCard(state),
        el("section", { class: "card" }, [el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Typical timeline" })]), el("div", { class: "card__body" }, [typicalTimeline(result)])]),
        el("section", { class: "card" }, [el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Step statistics" })]), el("div", { class: "card__body" }, [stepsTable(result)])]),
        el("section", { class: "card" }, [el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: step ? `Trend · ${step.job} / ${displayStepName(step.stepKey)}` : "Trend" })]), el("div", { class: "card__body" }, [trendChart(step), byRunnerTable(step)])]),
        el("section", { class: "card" }, [el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Runs and single-run Gantt" })]), el("div", { class: "card__body" }, [
            el("div", { class: "controls" }, [
                el("label", { class: "inline-field" }, [el("span", { text: "Run" }), el("input", { type: "search", value: runInput, placeholder: "run ID or URL", oninput: (event) => { runInput = event.target.value; } })]),
                el("label", { class: "inline-field" }, [el("span", { text: "Attempt" }), el("input", { type: "number", min: "1", value: attemptInput, oninput: (event) => { attemptInput = event.target.value; } })]),
                el("button", { type: "button", class: "ghost", text: "Open run", onclick: () => void openRunTimeline(state) }),
                state?.steps?.timelineRequest ? el("button", { type: "button", class: "ghost", text: "Copy mermaid", onclick: () => void copyMermaid(state.steps.timelineRequest) }) : null,
                state?.steps?.timeline ? el("button", { type: "button", class: "ghost", text: "Close run", onclick: () => void closeRunTimeline(state) }) : null,
            ]),
            runList(result, state),
            runTimeline(state?.steps?.timeline, result, state?.steps?.settings?.workflow ?? result?.meta?.workflow ?? "", () => void closeRunTimeline(state)),
        ])]),
    ].filter(Boolean);
}
