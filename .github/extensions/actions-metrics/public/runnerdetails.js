import { workflowFileLink } from "./links.js";
import { renderLineTimeline } from "./charts.js";
import { formatTime } from "/shared/timezone.mjs";

const emptyRecentFilters = () => ({ result: "", failedStep: "", repository: "", workflow: "", job: "" });

const view = {
    root: null,
    runner: "",
    identity: null,
    includeAllAttempts: false,
    requestKey: "",
    requestSequence: 0,
    requestAbort: null,
    status: "idle",
    error: null,
    result: null,
    recentDraft: emptyRecentFilters(),
    recentApplied: emptyRecentFilters(),
    trendTableOpen: false,
    trendTable: null,
    executionTableOpen: false,
    executionTable: null,
    names: [],
    namesKey: "",
    namesStatus: "idle",
    namesError: null,
    namesSequence: 0,
    namesAbort: null,
    controls: null,
    body: null,
    onUpdate: () => {},
};

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
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unknown";
}

function timestamp(value) {
    return value ? formatTime(value, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
}

function card(title, content, note = "") {
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: title })]),
        el("div", { class: "card__body" }, content),
        note ? el("p", { class: "card__note", text: note }) : null,
    ]);
}

function table(columns, rows) {
    if (!rows.length) return el("p", { class: "empty", text: "No rows in this selection." });
    const head = el("thead", {}, [el("tr", {}, columns.map(column => el("th", { text: column.label })))]);
    const body = el("tbody", {}, rows.map(row => el("tr", {}, columns.map(column => el("td", {
        class: column.wrap ? "wrap" : null,
        text: column.render ? undefined : row[column.key],
    }, column.render ? column.render(row) : [])))));
    const wrapper = el("div", { class: "table-wrap" }, [el("table", {}, [head, body])]);
    return wrapper;
}

function requestDetails(state) {
    const datasetId = state?.metrics?.meta?.dataset?.id;
    const retainedReadable = state?.status === "ready" || (state?.status === "error" && state?.errorCode === "rate_limited");
    if (!view.runner || !datasetId || !retainedReadable) return;
    const key = JSON.stringify([state.identity, datasetId, view.runner, view.includeAllAttempts, view.recentApplied]);
    if (key === view.requestKey) return;
    view.requestKey = key;
    view.requestAbort?.abort();
    const controller = new AbortController();
    view.requestAbort = controller;
    const sequence = ++view.requestSequence;
    view.status = "loading";
    view.error = null;
    const runner = view.runner;
    const includeAllAttempts = view.includeAllAttempts;
    const recentJobFilters = { ...view.recentApplied };
    void fetch("./api/runner-details", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runner, includeAllAttempts, recentJobFilters }),
        signal: controller.signal,
    }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Runner details failed (${response.status}).`);
        return body;
    }).then(result => {
        if (sequence !== view.requestSequence) return;
        if (Object.values(recentJobFilters).some(Boolean) && !Number.isInteger(result?.meta?.matchingJobs)) {
            throw new Error("Recent job filters require an extension reload.");
        }
        view.status = "ready";
        view.result = result;
        view.error = null;
        view.onUpdate();
    }).catch(error => {
        if (error?.name === "AbortError" || sequence !== view.requestSequence) return;
        view.status = "error";
        view.error = error?.message ?? String(error);
        view.onUpdate();
    });
}

function retainedReadable(state) {
    return Boolean(state?.metrics?.meta?.dataset?.id)
        && (state.status === "ready" || (state.status === "error" && state.errorCode === "rate_limited"));
}

function requestRunnerNames(state) {
    if (!retainedReadable(state)) return;
    const key = JSON.stringify([state.identity, state.metrics.meta.dataset.id, view.includeAllAttempts]);
    if (key === view.namesKey) return;
    view.namesKey = key;
    view.namesAbort?.abort();
    const controller = new AbortController();
    view.namesAbort = controller;
    const sequence = ++view.namesSequence;
    view.namesStatus = "loading";
    view.namesError = null;
    view.names = [];
    updatePicker();
    const params = new URLSearchParams({ attempts: view.includeAllAttempts ? "all" : "latest" });
    void fetch(`./api/runner-names?${params}`, { signal: controller.signal }).then(async response => {
        const body = await response.json();
        if (!response.ok) throw new Error(body?.error ?? `Runner list failed (${response.status}).`);
        return body;
    }).then(body => {
        if (sequence !== view.namesSequence) return;
        view.names = Array.isArray(body.runners) ? body.runners : [];
        view.namesStatus = "ready";
        updatePicker();
    }).catch(error => {
        if (error?.name === "AbortError" || sequence !== view.namesSequence) return;
        view.names = [];
        view.namesStatus = "error";
        view.namesError = error?.message ?? String(error);
        // A failed listing must stay retryable on the next render.
        view.namesKey = "";
        updatePicker();
    });
}

function chooseRunner(value) {
    const name = String(value ?? "").trim();
    if (!name) return false;
    if (view.namesStatus === "ready" && !view.names.some(row => row.runner === name)) {
        view.controls.hint.textContent = `No runner named ${name} in this snapshot.`;
        return false;
    }
    if (name !== view.runner) {
        selectRunnerDetails(name);
        view.onUpdate();
    }
    return true;
}

function runnerOptionLabel(row) {
    return `${number(row.jobs)} jobs · ${percent(row.failureRate)} failed`;
}

function closeRunnerOptions() {
    const controls = view.controls;
    if (!controls) return;
    controls.open = false;
    controls.list.hidden = true;
    controls.input.setAttribute("aria-expanded", "false");
    controls.input.removeAttribute("aria-activedescendant");
    controls.active = -1;
}

function showRunnerOptions(filter = "") {
    const controls = view.controls;
    if (!controls) return;
    controls.open = true;
    controls.filter = filter;
    controls.renderedNames = view.names;
    const term = filter.trim().toLowerCase();
    controls.matches = view.names.filter(row => row.runner.toLowerCase().includes(term));
    controls.active = -1;
    controls.input.removeAttribute("aria-activedescendant");
    const options = controls.matches.map((row, index) => el("div", {
        id: `runner-details-option-${index}`,
        class: "runner-details__option",
        role: "option",
        "aria-selected": "false",
        onmousedown: event => event.preventDefault(),
        onclick: () => commitRunner(row.runner),
    }, [
        el("span", { class: "runner-details__option-name", text: row.runner }),
        el("span", { class: "runner-details__option-summary", text: runnerOptionLabel(row) }),
    ]));
    controls.list.replaceChildren(...options);
    controls.list.hidden = options.length === 0;
    controls.input.setAttribute("aria-expanded", options.length ? "true" : "false");
}

function commitRunner(name) {
    if (!chooseRunner(name)) return;
    view.controls.input.value = String(name).trim();
    closeRunnerOptions();
}

function moveRunnerOption(direction) {
    const controls = view.controls;
    if (!controls.open) showRunnerOptions();
    if (!controls.matches.length) return;
    const previous = controls.active;
    controls.active = previous < 0
        ? (direction > 0 ? 0 : controls.matches.length - 1)
        : (previous + direction + controls.matches.length) % controls.matches.length;
    if (previous >= 0) controls.list.children[previous].setAttribute("aria-selected", "false");
    const option = controls.list.children[controls.active];
    option.setAttribute("aria-selected", "true");
    controls.input.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
}

/**
 * The runner picker and attempt toggle are built once and only updated in place,
 * so a re-render while the reader is typing keeps the field's focus and caret.
 */
function buildControls() {
    const list = el("div", { id: "runner-details-names", class: "runner-details__options", role: "listbox", "aria-label": "Runner suggestions" });
    list.hidden = true;
    const input = el("input", {
        type: "search",
        id: "runner-details-picker",
        class: "runner-details__picker",
        role: "combobox",
        "aria-autocomplete": "list",
        "aria-controls": "runner-details-names",
        "aria-expanded": "false",
        placeholder: "Search runner name",
        "aria-label": "Runner name",
        autocomplete: "off",
        spellcheck: "false",
        onfocus: () => showRunnerOptions(),
        onclick: () => {
            if (!view.controls.open) showRunnerOptions();
        },
        onblur: () => closeRunnerOptions(),
        onkeydown: event => {
            if (event.isComposing) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                moveRunnerOption(event.key === "ArrowDown" ? 1 : -1);
            } else if (event.key === "Enter") {
                event.preventDefault();
                const controls = view.controls;
                commitRunner(controls.active >= 0 ? controls.matches[controls.active].runner : event.target.value);
            } else if (event.key === "Escape") {
                closeRunnerOptions();
            }
        },
        oninput: () => {
            hint.textContent = pickerStatus();
            showRunnerOptions(input.value);
        },
    });
    const open = el("button", { type: "button", class: "ghost", text: "Open", onclick: () => commitRunner(input.value) });
    const attempts = el("input", {
        type: "checkbox",
        onchange: event => {
            view.includeAllAttempts = event.target.checked;
            view.requestKey = "";
            view.onUpdate();
        },
    });
    const hint = el("span", { class: "control-note" });
    const node = el("div", { class: "controls runner-details__controls" }, [
        el("div", { class: "inline-field" }, [
            el("label", { for: "runner-details-picker", text: "Runner" }),
            el("span", { class: "runner-details__picker-wrap" }, [input, list]),
        ]),
        open,
        el("label", { class: "inline-field" }, [attempts, el("span", { text: "Include all attempts" })]),
        hint,
    ]);
    return { node, input, list, attempts, hint, matches: [], active: -1, open: false, filter: "", renderedNames: null };
}

function pickerStatus() {
    if (view.namesStatus === "loading") return "Loading runner names…";
    if (view.namesStatus === "error") return view.namesError;
    if (view.namesStatus === "ready") return `${number(view.names.length)} runner names in this snapshot`;
    return "";
}

function updatePicker() {
    const controls = view.controls;
    if (!controls) return;
    if (document.activeElement !== controls.input) controls.input.value = view.runner;
    if (controls.open && controls.renderedNames !== view.names) showRunnerOptions(controls.filter);
    controls.attempts.checked = view.includeAllAttempts;
    controls.hint.textContent = pickerStatus();
}

function summaryCard(result) {
    const summary = result.summary;
    return card("Job outcomes", [
        el("div", { class: "kpis" }, [
            kpi("Jobs", number(summary.jobs), `${result.attemptScope === "all" ? "all attempts" : "latest job listing"}`),
            kpi("Failed jobs", number(summary.failedJobs), `${number(summary.decidedJobs)} decided`),
            kpi("Failure rate", percent(summary.failureRate), "failure, timed out or startup failure / decided jobs"),
        ]),
        result.meta.truncated ? el("p", { class: "notice", text: "The retained collection is truncated; these counts cover only the available snapshot." }) : null,
        result.meta.malformedStepRows > 0
            ? el("p", { class: "notice", text: `${number(result.meta.malformedStepRows)} malformed step rows were skipped.` })
            : null,
        result.meta.warnings?.length
            ? el("details", {}, [
                el("summary", { text: `${number(result.meta.warnings.length)} collection warnings` }),
                el("ul", {}, result.meta.warnings.map(message => el("li", { text: message }))),
            ])
            : null,
    ], "Job outcomes are grouped by completion date in UTC. Cancelled, skipped and unfinished jobs are excluded from the failure-rate denominator.");
}

function dailyTrendBuckets(days) {
    const buckets = [];
    let previous = null;
    for (const day of days) {
        const time = Date.parse(`${day.day}T00:00:00Z`);
        if (previous !== null) {
            for (let missing = previous + 86400000; missing < time; missing += 86400000) {
                buckets.push({ day: new Date(missing).toISOString().slice(0, 10), failurePercent: null });
            }
        }
        buckets.push({ ...day, failurePercent: day.failureRate * 100 });
        previous = time;
    }
    return buckets;
}

function dailyExecutionBuckets(days) {
    const buckets = [];
    let previous = null;
    for (const day of days) {
        const time = Date.parse(`${day.day}T00:00:00Z`);
        if (previous !== null) {
            // Days between observed starts genuinely had no job executions.
            for (let missing = previous + 86400000; missing < time; missing += 86400000) {
                buckets.push({ day: new Date(missing).toISOString().slice(0, 10), jobs: 0, succeeded: 0, failed: 0, other: 0 });
            }
        }
        buckets.push(day);
        previous = time;
    }
    return buckets;
}

function chartWithPointTooltips(chart, tooltipId = "runner-details-chart-tooltip") {
    const tooltip = el("div", {
        id: tooltipId,
        class: "runner-details__chart-tooltip",
        role: "tooltip",
    });
    tooltip.hidden = true;
    const wrapper = el("div", { class: "runner-details__chart-wrap" }, [chart, tooltip]);
    const points = [...chart.querySelectorAll(".chart__series-point")];
    if (!points.length) return wrapper;
    chart.setAttribute("role", "group");
    let hovered = null;
    let focused = null;
    const hide = () => { tooltip.hidden = true; };
    const show = point => {
        if (!point) return hide();
        tooltip.textContent = point.getAttribute("aria-label");
        tooltip.hidden = false;
        const bounds = wrapper.getBoundingClientRect();
        const target = point.getBoundingClientRect();
        const left = target.left + target.width / 2 - bounds.left - tooltip.offsetWidth / 2;
        const above = target.top - bounds.top - tooltip.offsetHeight - 8;
        const top = above >= 0 ? above : target.bottom - bounds.top + 8;
        tooltip.style.left = `${Math.max(0, Math.min(left, bounds.width - tooltip.offsetWidth))}px`;
        tooltip.style.top = `${Math.max(0, Math.min(top, bounds.height - tooltip.offsetHeight))}px`;
    };
    for (const [index, point] of points.entries()) {
        const title = point.querySelector("title")?.textContent ?? "";
        point.setAttribute("aria-hidden", "true");
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        for (const name of ["cx", "cy"]) hit.setAttribute(name, point.getAttribute(name));
        const x = Number(point.getAttribute("cx"));
        const distances = [points[index - 1], points[index + 1]]
            .filter(Boolean)
            .map(neighbor => Math.abs(x - Number(neighbor.getAttribute("cx"))))
            .filter(distance => distance > 0);
        hit.setAttribute("r", String(Math.min(9, ...distances.map(distance => distance / 2))));
        hit.setAttribute("class", "runner-details__chart-hit");
        hit.setAttribute("tabindex", "0");
        hit.setAttribute("role", "img");
        hit.setAttribute("aria-label", title);
        hit.setAttribute("aria-describedby", tooltipId);
        hit.addEventListener("pointerenter", event => {
            if (event.pointerType === "touch") return;
            hovered = hit;
            show(hit);
        });
        hit.addEventListener("pointerleave", event => {
            if (event.pointerType === "touch") return;
            hovered = null;
            show(focused);
        });
        hit.addEventListener("focus", () => { focused = hit; show(hit); });
        hit.addEventListener("blur", () => { focused = null; show(hovered); });
        hit.addEventListener("keydown", event => {
            if (event.key === "Escape") {
                hovered = null;
                hide();
            }
        });
        hit.addEventListener("pointerdown", event => {
            if (event.pointerType !== "touch") return;
            hit.focus();
            show(hit);
            document.addEventListener("pointerdown", hide, { capture: true, once: true });
        });
        hit.addEventListener("pointercancel", hide);
        chart.append(hit);
    }
    return wrapper;
}

function trendCard(trend) {
    const details = el("details", { class: "runner-details__trend-table", open: view.trendTableOpen }, [
        el("summary", { text: "Daily table" }),
        table([
            { label: "Completed (UTC)", key: "day" },
            { label: "Failed / decided", render: row => `${number(row.failed)} / ${number(row.decided)}` },
            { label: "Failure rate", render: row => percent(row.failureRate) },
            {
                label: "",
                render: row => el("div", { class: "bar" }, [
                    el("div", { class: "bar__fill bar__fill--danger", style: `width:${Math.max(0, Math.min(100, (row.failureRate ?? 0) * 100)).toFixed(1)}%` }),
                ]),
            },
        ], trend.days),
    ]);
    view.trendTable = details;
    details.addEventListener("toggle", () => {
        if (view.trendTable === details) view.trendTableOpen = details.open;
    });
    return card("Daily job failure rate", [
        chartWithPointTooltips(renderLineTimeline({ buckets: dailyTrendBuckets(trend.days) }, {
            series: [{ key: "failurePercent", label: "Failure rate", color: "var(--true-color-red, #cf222e)" }],
            label: "Daily job failure rate by UTC completion date",
            emptyMessage: "No decided jobs with completion timestamps.",
            formatBucket: bucket => bucket.day,
            formatValue: value => `${value}%`,
            formatTooltip: bucket => `${bucket.day} (UTC)\nFailed jobs: ${number(bucket.failed)} / ${number(bucket.decided)} (${percent(bucket.failureRate)})`,
            max: 100,
            showZeroPoints: true,
        })),
        details,
        trend.unbucketedJobs > 0
            ? el("p", { class: "notice", text: `${number(trend.unbucketedJobs)} decided jobs have no completion timestamp and are excluded from daily buckets.` })
            : null,
    ], "Days without a completed, decided job are omitted rather than shown as zero. The timestamp is the job completion time, not workflow-run creation time.");
}

function executionCard(executions) {
    if (!executions) {
        return card("Daily job executions", [
            el("p", { class: "notice", text: "Reload the Actions metrics extension to show daily job executions." }),
        ]);
    }
    const details = el("details", { class: "runner-details__trend-table", open: view.executionTableOpen }, [
        el("summary", { text: "Daily table" }),
        table([
            { label: "Started (UTC)", key: "day" },
            { label: "Jobs", render: row => number(row.jobs) },
            { label: "Succeeded", render: row => number(row.succeeded) },
            { label: "Failed", render: row => number(row.failed) },
            { label: "Other", render: row => number(row.other) },
        ], executions.days),
    ]);
    view.executionTable = details;
    details.addEventListener("toggle", () => {
        if (view.executionTable === details) view.executionTableOpen = details.open;
    });
    return card("Daily job executions", [
        chartWithPointTooltips(renderLineTimeline({ buckets: dailyExecutionBuckets(executions.days) }, {
            series: [{ key: "jobs", label: "Jobs", color: "var(--true-color-blue, #0969da)" }],
            label: "Daily job executions by UTC start date",
            emptyMessage: "No jobs with start timestamps.",
            formatBucket: bucket => bucket.day,
            formatValue: value => number(value),
            formatTooltip: bucket => `${bucket.day} (UTC)\nJobs: ${number(bucket.jobs)}\nSucceeded: ${number(bucket.succeeded)} · Failed: ${number(bucket.failed)} · Other: ${number(bucket.other)}`,
            showZeroPoints: true,
        }), "runner-details-execution-tooltip"),
        details,
        executions.unstartedJobs > 0
            ? el("p", { class: "notice", text: `${number(executions.unstartedJobs)} jobs have no start timestamp and are excluded from daily buckets.` })
            : null,
    ], "Every job that started on this runner, grouped by start date in UTC. Days between the first and last start with no jobs are shown as zero. Other covers cancelled, skipped and unfinished jobs.");
}

function failedStepCard(result) {
    const rows = result.failedSteps;
    return card("Failed step names across workflows", [
        table([
            { label: "Step name", key: "name", wrap: true },
            { label: "Failed", render: row => number(row.failed) },
            { label: "Started", render: row => number(row.executed) },
            { label: "Failure rate", render: row => percent(row.failureRate) },
            { label: "Workflows", render: row => number(row.workflows) },
            { label: "Latest failure", render: row => timestamp(row.latestFailureAt) },
        ], rows),
        result.meta.totalFailedStepNames > rows.length
            ? el("p", { class: "notice", text: `Showing the ${number(rows.length)} most frequent failed step names of ${number(result.meta.totalFailedStepNames)}.` })
            : null,
    ], "Counts are distinct step executions on this runner name. Names are the exact step labels reported by GitHub; they do not prove an action's uses: identity or explain why it failed.");
}

function recentFiltersForm(result) {
    const options = [...(result.meta.resultOptions ?? new Set(result.recentJobs.map(row => row.conclusion || "__no_conclusion__")))].sort();
    if (view.recentDraft.result && !options.includes(view.recentDraft.result)) options.push(view.recentDraft.result);
    const resultSelect = el("select", {
        "aria-label": "Job result",
        onchange: event => { view.recentDraft.result = event.target.value; },
    }, [
        el("option", { value: "", selected: !view.recentDraft.result, text: "All results" }),
        ...options.map(value => el("option", {
            value,
            selected: view.recentDraft.result === value,
            text: value === "__no_conclusion__" ? "No conclusion" : value,
        })),
    ]);
    const input = (key, label) => el("label", { class: "inline-field" }, [
        el("span", { text: label }),
        el("input", {
            type: "search",
            value: view.recentDraft[key],
            placeholder: "Contains…",
            "aria-label": label,
            oninput: event => { view.recentDraft[key] = event.target.value; },
        }),
    ]);
    return el("form", {
        class: "controls runner-details__recent-filters",
        onsubmit: event => {
            event.preventDefault();
            view.recentApplied = Object.fromEntries(
                Object.entries(view.recentDraft).map(([key, value]) => [key, value.trim().toLowerCase()]),
            );
            if (view.status === "error") view.requestKey = "";
            view.onUpdate();
        },
    }, [
        el("label", { class: "inline-field" }, [el("span", { text: "Result" }), resultSelect]),
        input("failedStep", "Failed step"),
        input("repository", "Repository"),
        input("workflow", "Workflow"),
        input("job", "Job"),
        el("button", { type: "submit", class: "ghost", text: "Apply" }),
        el("button", {
            type: "button", class: "ghost", text: "Clear filters",
            onclick: () => {
                view.recentDraft = emptyRecentFilters();
                view.recentApplied = emptyRecentFilters();
                if (view.status === "error") view.requestKey = "";
                view.onUpdate();
            },
        }),
    ]);
}

function recentJobsCard(result, state) {
    const host = state?.target?.host || "github.com";
    const rows = result.recentJobs;
    const matching = result.meta.matchingJobs ?? result.meta.totalJobs;
    return card(`Recent jobs · ${number(matching)} / ${number(result.meta.totalJobs)} jobs`, [
        recentFiltersForm(result),
        table([
            { label: "Completed", render: row => timestamp(row.completedAt) },
            { label: "Repository", key: "repo", wrap: true },
            { label: "Workflow", wrap: true, render: row => workflowFileLink({
                repository: row.repo,
                workflow: row.workflow,
                workflowPath: row.workflowPath,
            }, host) },
            { label: "Job", key: "job", wrap: true },
            { label: "Result", key: "conclusion" },
            { label: "Failed step names", wrap: true, render: row => row.failedStepNames.length ? row.failedStepNames.join(", ") : "–" },
            {
                label: "Run",
                render: row => row.runUrl
                    ? el("a", {
                        href: row.runUrl,
                        target: "_blank",
                        rel: "noreferrer",
                        text: `${row.runId} · attempt ${row.runAttempt}`,
                    })
                    : "–",
            },
        ], rows),
        matching > rows.length
            ? el("p", { class: "notice", text: `Showing the ${number(rows.length)} most recent matching jobs of ${number(matching)}.` })
            : null,
    ], "A failed step is reported independently from the job conclusion; it may not be the cause of the job's failure. The runner is a normalized name aggregate, not guaranteed to identify one physical machine.");
}

function kpi(label, value, detail) {
    return el("div", { class: "kpi" }, [
        el("span", { class: "kpi__label", text: label }),
        el("strong", { class: "kpi__value", text: value }),
        el("span", { class: "kpi__hint", text: detail }),
    ]);
}

function content(state) {
    if (!state?.metrics?.meta?.dataset?.id) return [el("p", { class: "empty", text: "Collect dashboard metrics before loading runner details." })];
    if (!retainedReadable(state)) {
        return [el("p", { class: "empty", text: "Wait for the current collection to finish before loading runner details." })];
    }
    if (!view.runner) {
        return [el("p", { class: "empty", text: "Choose a runner name above, or open Details from Runner activity." })];
    }

    requestDetails(state);
    const status = view.status === "loading" ? [
        el("p", { class: "notice", text: view.result
            ? "Updating runner details; showing previous results until the update completes."
            : "Reading runner jobs and steps from the retained snapshot…" }),
    ] : view.status === "error" ? [
        el("p", { class: "notice", text: view.result ? `${view.error} Showing previous results.` : view.error }),
        el("button", {
            type: "button",
            class: "ghost",
            text: "Retry",
            onclick: () => {
                view.requestKey = "";
                requestDetails(state);
                view.onUpdate();
            },
        }),
    ] : [];
    const result = view.result;
    if (!result) return status;
    if (result.meta.totalJobs === 0) {
        return [
            ...status,
            summaryCard(result),
            el("p", { class: "empty", text: `No jobs were reported under the runner name ${view.runner} in this snapshot.` }),
        ];
    }
    return [
        ...status,
        summaryCard(result),
        executionCard(result.executions),
        trendCard(result.trend),
        failedStepCard(result),
        recentJobsCard(result, state),
    ];
}

export function initRunnerDetails({ onUpdate } = {}) {
    view.onUpdate = onUpdate ?? (() => {});
}

export function selectRunnerDetails(runner) {
    const name = String(runner ?? "").trim();
    if (view.runner !== name) {
        view.trendTableOpen = false;
        view.trendTable = null;
        view.executionTableOpen = false;
        view.executionTable = null;
        view.recentDraft = emptyRecentFilters();
        view.recentApplied = emptyRecentFilters();
        view.requestAbort?.abort();
        view.requestSequence++;
    }
    view.runner = name;
    if (view.controls) {
        view.controls.input.value = name;
        closeRunnerOptions();
    }
    view.requestKey = "";
    view.result = null;
    view.error = null;
    view.status = "idle";
}

export function renderRunnerDetails(state) {
    if (!view.root) {
        view.controls = buildControls();
        view.body = el("div", { class: "runner-details__body" });
        view.root = el("div", { class: "runner-details" }, [view.controls.node, view.body]);
    }
    if (view.identity !== null && view.identity !== state?.identity) {
        selectRunnerDetails("");
        view.includeAllAttempts = false;
        view.requestAbort?.abort();
        view.namesAbort?.abort();
        view.namesSequence++;
        view.names = [];
        view.namesKey = "";
        view.namesStatus = "idle";
    }
    view.identity = state?.identity ?? null;
    view.controls.node.hidden = !retainedReadable(state);
    requestRunnerNames(state);
    updatePicker();
    view.body.replaceChildren(...content(state).filter(Boolean));
    return [view.root];
}

export function resetRunnerDetails() {
    view.requestAbort?.abort();
    view.requestSequence++;
    view.requestKey = "";
    view.status = "idle";
    view.error = null;
    view.result = null;
    view.trendTable = null;
    view.executionTable = null;
}
