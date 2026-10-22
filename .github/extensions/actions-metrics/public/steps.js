import { svg } from "./charts.js";
import { sortByCriteria, toggleSort } from "/shared/sort.mjs";
import { maxOf } from "/shared/extrema.mjs";
import { RECOVERED_JOB_STATUS, STEP_CONCLUSIONS, displayStepName, effectiveStepSettings, filterTimelineJobs, formatDuration, formatLabelSet, isRecoveredJobStatus, isRunnerFilterActive, labelSetKey, normalizeFailedStep, normalizeJobStatus, normalizeRunnerFilter, normalizeStepFilters, runnerFilterSelections, splitLabelSet, stepIdOf, timelineMatchesWorkflow, toggleRunnerFilterValue } from "/shared/steps.mjs";
import { renderFacetPicker } from "/shared/facet.mjs";

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
// The settings of the step request in flight, with the target and sequence it belongs
// to. Renders before its response would otherwise rebuild the controls from the
// previous settings and later requests would read those back.
let pendingStepRequest = null;
let runTimelineSeq = 0;
// The pending close request, which a following open waits for so that a late close
// cannot clear or abort the run opened after it.
let closingRunTimeline = Promise.resolve();
const prefsByIdentity = new Map();
const prefsLoading = new Set();
const draftsByIdentity = new Map();
const expandedRunnerPools = new Set();
const runnerFacetViews = new Map();
const conditionComposers = new Map();
const RUNNER_FACETS = [
    { key: "kinds", label: "Kind", format: kindLabel },
    { key: "labelSets", label: "Runs-on" },
    { key: "groups", label: "Group" },
    { key: "names", label: "Name" },
];

function draftStepSettings(state, patch) {
    draftsByIdentity.set(state?.identity, { ...draftsByIdentity.get(state?.identity), ...patch });
}

function canFilterSteps(state) {
    const collecting = pendingStepRequest && pendingStepRequest.identity === state?.identity && !pendingStepRequest.reuseRows;
    return Boolean(state?.steps?.result) && state.steps.result.available !== false && !collecting;
}

function workflowOptions(state, repository = "") {
    const rows = state?.metrics?.fleet?.workflows?.length ? state.metrics.fleet.workflows : state?.metrics?.overview?.byWorkflow ?? [];
    const seen = new Map();
    for (const row of rows) {
        if (repository && row.repository !== repository) continue;
        const value = workflowFile(row.workflowPath || row.workflow || row.name);
        if (!value) continue;
        const name = row.workflow || row.name || value;
        const label = row.workflowPath && name !== value ? `${name} · ${value}` : name;
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

function currentRunnerFilter(state, settings = state?.steps?.settings ?? prefsByIdentity.get(state?.identity)) {
    const pending = pendingStepRequest && pendingStepRequest.identity === state?.identity ? pendingStepRequest.settings.runnerFilter : undefined;
    return normalizeRunnerFilter(pending ?? state?.steps?.result?.runnerFilter ?? settings?.runnerFilter);
}

function runnerFilterFromControls(patch = {}, state) {
    return normalizeRunnerFilter({ ...currentRunnerFilter(state), ...patch });
}

// Filter changes always use the loaded collection, not edits waiting for Load steps.
function applyRunnerFilter(state, patch = {}) {
    void loadSteps(state, { reuseRows: true, runnerFilter: runnerFilterFromControls(patch, state) });
}

function toggleRunnerFacet(state, key, value) {
    void loadSteps(state, {
        reuseRows: true,
        runnerFilter: toggleRunnerFilterValue(currentRunnerFilter(state), key, value),
    });
}

function currentStepSettings(state) {
    return {
        ...effectiveStepSettings(state?.steps?.settings ?? prefsByIdentity.get(state?.identity), pendingStepRequest, state?.identity),
        ...draftsByIdentity.get(state?.identity),
    };
}

async function loadSteps(state, { reuseRows = false, runnerFilter = runnerFilterFromControls({}, state), failedStep, stepConditions } = {}) {
    if (reuseRows && !canFilterSteps(state)) return;
    const jobStatus = normalizeJobStatus(document.getElementById("steps-job-status")?.value);
    const budgetInput = document.getElementById("steps-budget")?.value?.trim() ?? "";
    const budget = budgetInput === "" ? 500 : Number(budgetInput);
    const collection = reuseRows ? state.steps.settings : {
        workflow: document.getElementById("steps-workflow")?.value?.trim() ?? "",
        includeAllAttempts: isRecoveredJobStatus(jobStatus)
            ? currentStepSettings(state).includeAllAttempts === true
            : document.getElementById("steps-all-attempts")?.checked === true,
        mergeMatrix: document.getElementById("steps-merge")?.checked !== false,
        showInfra: document.getElementById("steps-infra")?.checked !== false,
        runBudget: Number.isFinite(budget) ? budget : 500,
        kind: "all",
    };
    const workflow = collection?.workflow ?? "";
    if (!workflow) {
        error = "Choose a workflow file first.";
        renderSoon();
        return;
    }
    const previousSettings = state.steps?.settings ?? prefsByIdentity.get(state?.identity);
    const workflowChanged = !reuseRows && workflow !== previousSettings?.workflow;
    const stepFilters = normalizeStepFilters(workflowChanged ? { stepConditions: [] }
        : stepConditions !== undefined || failedStep !== undefined ? { stepConditions, failedStep } : currentStepSettings(state));
    const body = {
        ...collection,
        workflow,
        repository: state?.scope === "org" ? document.getElementById("steps-repository")?.value?.trim() ?? "" : "",
        job: document.getElementById("steps-job")?.value?.trim() ?? "",
        jobStatus,
        ...stepFilters,
        runnerFilter,
        reuseRows,
    };
    if (workflowChanged) conditionComposers.delete(JSON.stringify([state.identity, workflow, body.repository]));
    const seq = ++stepRequestSeq;
    const { reuseRows: _reuse, ...settings } = body;
    pendingStepRequest = { seq, identity: state?.identity, settings, reuseRows };
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
        state.steps = { ...(state.steps ?? {}), ...(stale ? { timeline: null, timelineRequest: null } : {}), status: "ready", settings, result };
        if (!reuseRows) {
            const drafts = draftsByIdentity.get(state?.identity);
            for (const key of Object.keys(drafts ?? {})) {
                if (String(drafts[key]) === String(settings[key])) delete drafts[key];
            }
        }
        if (!reuseRows || !(result.stepStats ?? []).some((row) => row.id === selectedStepId)) {
            selectedStepId = result.stepStats?.[0]?.id ?? "";
        }
    } catch (caught) {
        if (seq === stepRequestSeq) error = caught.message;
    } finally {
        if (seq === stepRequestSeq) {
            if (pendingStepRequest?.seq === seq) pendingStepRequest = null;
            loading = false;
            renderSoon();
        }
    }
}

async function openRunTimeline(state, run, repo = "", attemptValue = attemptInput) {
    const value = String(run ?? runInput ?? "").trim();
    if (!value) return;
    if (state?.scope === "org" && !repo && !/^https?:\/\//i.test(value)) repo = state.steps?.settings?.repository ?? "";
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

function stepLabel(step) {
    return `${displayStepName(step.name)}${step.occurrence > 1 ? ` · occurrence ${step.occurrence}` : ""}`;
}

function stepConditionsSummary(conditions) {
    return conditions.map(step => `${stepLabel(step)} = ${step.conclusion}`).join(" AND ");
}

function stepConditionControls(state, settings) {
    if (!state?.steps?.result?.meta?.stepConditionsSupported) return null;
    const conditions = normalizeStepFilters(settings).stepConditions;
    const disabled = !canFilterSteps(state);
    const context = JSON.stringify([state.identity, state.steps?.settings?.workflow, settings.repository ?? ""]);
    if (!conditionComposers.has(context)) conditionComposers.set(context, { step: null, conclusion: "failure" });
    const composer = conditionComposers.get(context);
    const options = [...(state.steps.result.stepConditionFacets ?? [])];
    for (const step of [...conditions, composer.step].filter(Boolean)) {
        if (!options.some(option => stepIdOf(option.name, "", option.occurrence) === stepIdOf(step.name, "", step.occurrence))) {
            options.push({ name: step.name, occurrence: step.occurrence, count: 0, conclusions: [] });
        }
    }
    const selected = composer.step ? stepIdOf(composer.step.name, "", composer.step.occurrence) : "";
    const conclusions = [...new Set([...STEP_CONCLUSIONS, ...options.flatMap(step => (step.conclusions ?? []).map(outcome => outcome.value)), composer.conclusion])];
    const apply = stepConditions => void loadSteps(state, { reuseRows: true, stepConditions });
    return el("section", { "aria-label": "Step conditions" }, [
        el("div", { class: "controls" }, [
            el("span", { class: "controls__label", text: "Step conditions (AND)" }),
            el("label", { class: "inline-field" }, [
                el("span", { text: "Step" }),
                el("select", { id: "steps-condition-step", disabled, onchange: event => {
                    const step = options.find(option => stepIdOf(option.name, "", option.occurrence) === event.target.value);
                    composer.step = step ? { name: step.name, occurrence: step.occurrence } : null;
                    renderSoon();
                } }, [
                    el("option", { value: "", text: "Select a step" }),
                    ...options.map(step => el("option", {
                        value: stepIdOf(step.name, "", step.occurrence), text: `${stepLabel(step)} (${number(step.count)})`,
                        title: `${step.name} · occurrence ${step.occurrence}`, selected: selected === stepIdOf(step.name, "", step.occurrence),
                    })),
                ]),
            ]),
            el("label", { class: "inline-field" }, [
                el("span", { text: "Conclusion" }),
                el("select", { id: "steps-condition-conclusion", disabled, onchange: event => {
                    composer.conclusion = event.target.value;
                } }, conclusions.map(value => el("option", { value, text: value, selected: composer.conclusion === value }))),
            ]),
            el("button", {
                id: "steps-condition-add", type: "button", class: "ghost", text: "Add condition", disabled: disabled || !composer.step,
                onclick: () => {
                    if (disabled || !composer.step) return;
                    apply([...normalizeStepFilters(currentStepSettings(state)).stepConditions, { ...composer.step, conclusion: composer.conclusion }]);
                },
            }),
        ]),
        conditions.length ? el("div", { class: "chips" }, [
            ...conditions.map(condition => el("button", {
                type: "button", class: "chip", disabled, text: `${stepLabel(condition)} = ${condition.conclusion} ×`,
                title: `Remove condition: ${condition.name} · occurrence ${condition.occurrence} = ${condition.conclusion}`,
                onclick: () => apply(normalizeStepFilters(currentStepSettings(state)).stepConditions.filter(step =>
                    step.name !== condition.name || step.occurrence !== condition.occurrence || step.conclusion !== condition.conclusion)),
            })),
            el("button", { id: "steps-conditions-clear", type: "button", class: "chip chip--clear", disabled, text: "Clear step conditions", onclick: () => apply([]) }),
        ]) : null,
        el("p", { class: "card__note", text: "Every condition must match in the same job attempt. Add a step and conclusion, then add more conditions; remove a chip to drop one. All steps of matching jobs remain. Missing steps do not match. Choices cover the loaded sample, not just matching jobs." }),
    ]);
}

function controlPanel(state) {
    const settings = currentStepSettings(state);
    const filtersDisabled = !canFilterSteps(state);
    const repository = state?.scope === "org" ? settings.repository ?? "" : "";
    const repositories = (state?.steps?.result?.repositoryFacets ?? []).map((item) => ({ value: item.value, text: `${item.value} (${number(item.count)} jobs)` }));
    if (repository && !repositories.some((item) => item.value === repository)) repositories.unshift({ value: repository, text: `${repository} (0 jobs)` });
    const options = workflowOptions(state, repository);
    const currentWorkflow = settings.workflow || state?.filters?.workflow || options[0]?.value || "";
    if (currentWorkflow && !options.some((item) => item.value === currentWorkflow)) options.unshift({ value: currentWorkflow, label: currentWorkflow });
    const jobs = state?.steps?.result?.jobStats ?? [];
    const jobOptions = jobs.map((job) => ({ value: job.job, text: job.variants?.length > 1 ? `${job.job} (${job.variants.length} variants)` : job.job }));
    if (settings.job && !jobOptions.some((option) => option.value === settings.job)) jobOptions.unshift({ value: settings.job, text: `${settings.job} (0 jobs)` });
    const jobStatus = normalizeJobStatus(settings.jobStatus);
    const failedStep = normalizeFailedStep(settings.failedStep);
    const conditions = normalizeStepFilters(settings).stepConditions;
    const failedStepId = failedStep ? stepIdOf(failedStep.name, "", failedStep.occurrence) : "";
    const failedStepOptions = [...(state?.steps?.result?.failedStepFacets ?? [])];
    if (failedStep && !failedStepOptions.some(step => stepIdOf(step.name, "", step.occurrence) === failedStepId)) {
        failedStepOptions.unshift({ ...failedStep, count: 0 });
    }
    const recovered = isRecoveredJobStatus(jobStatus);
    const statusFacets = state?.steps?.result?.jobStatusFacets;
    const statusOptions = statusFacets
        ? statusFacets.map((item) => ({ value: item.value, text: `${item.value} (${number(item.count)})` }))
        : ["success", "failure", "cancelled", "skipped", "timed_out", "completed", "in_progress", "queued", "waiting"].map((value) => ({ value, text: value }));
    if (state?.steps?.result?.meta?.jobRecoverySupported) statusOptions.unshift({ value: RECOVERED_JOB_STATUS, text: "Succeeded on re-run (all attempts)" });
    if (jobStatus && !statusOptions.some((option) => option.value === jobStatus)) statusOptions.unshift({ value: jobStatus, text: `${jobStatus} (0)` });
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Step timeline" })]),
        el("div", { class: "card__body" }, [
            el("div", { class: "controls" }, [
                state?.scope === "org" ? el("label", { class: "inline-field" }, [
                    el("span", { text: "Repository" }),
                    el("select", { id: "steps-repository", disabled: filtersDisabled, title: "Filter the loaded sample without collecting again", onchange: () => void loadSteps(state, { reuseRows: true }) }, [
                        el("option", { value: "", text: "All repositories" }),
                        ...repositories.map((item) => el("option", { value: item.value, text: item.text, selected: repository === item.value })),
                    ]),
                ]) : null,
                el("label", { class: "inline-field" }, [
                    el("span", { text: "Workflow" }),
                    el("select", { id: "steps-workflow", onchange: (event) => draftStepSettings(state, { workflow: event.target.value }) }, options.length ? options.map((option) => el("option", { value: option.value, text: option.label, selected: option.value === currentWorkflow })) : [el("option", { value: currentWorkflow, text: currentWorkflow || "No workflow rows yet" })]),
                ]),
                el("label", { class: "inline-field" }, [
                    el("span", { text: "Job" }),
                    el("select", { id: "steps-job", disabled: filtersDisabled, onchange: () => void loadSteps(state, { reuseRows: true }) }, [el("option", { value: "", text: "All jobs" }), ...jobOptions.map((option) => el("option", { value: option.value, text: option.text, selected: settings.job === option.value }))]),
                ]),
                el("label", { class: "inline-field" }, [
                    el("span", { text: "Job status" }),
                    el("select", { id: "steps-job-status", disabled: filtersDisabled, title: "Filter by status or conclusion, or select jobs that succeeded after a failed attempt and retain their attempt history", onchange: () => void loadSteps(state, { reuseRows: true }) }, [
                        el("option", { value: "", text: "All statuses" }),
                        ...statusOptions.map((option) => el("option", { value: option.value, text: option.text, selected: jobStatus === option.value })),
                    ]),
                ]),
                !state?.steps?.result?.meta?.stepConditionsSupported && state?.steps?.result?.meta?.failedStepSupported ? el("label", { class: "inline-field" }, [
                    el("span", { text: "Failed step" }),
                    el("select", {
                        id: "steps-failed-step", disabled: filtersDisabled,
                        title: "Keep job attempts where this exact step concluded failure; show all steps of matching jobs",
                        onchange: event => {
                            const choice = failedStepOptions.find(step => stepIdOf(step.name, "", step.occurrence) === event.target.value);
                            void loadSteps(state, { reuseRows: true, failedStep: choice ? { name: choice.name, occurrence: choice.occurrence } : null });
                        },
                    }, [
                        el("option", { value: "", text: "Any step outcome" }),
                        ...failedStepOptions.map(step => el("option", {
                            value: stepIdOf(step.name, "", step.occurrence), text: `${stepLabel(step)} (${number(step.count)})`,
                            title: `${step.name} · occurrence ${step.occurrence}`, selected: failedStepId === stepIdOf(step.name, "", step.occurrence),
                        })),
                    ]),
                ]) : null,
                el("label", { class: "inline-field", title: "0 reads every run in the selected window when you press Load steps" }, [el("span", { text: "Runs" }), el("input", { id: "steps-budget", type: "number", min: "0", max: "5000", value: String(settings.runBudget ?? 500), oninput: (event) => draftStepSettings(state, { runBudget: event.target.value }) })]),
                el("label", { class: "inline-field inline-field--check", title: recovered ? "The re-run success filter always includes failed and successful attempts; your normal attempt preference is preserved" : "Include every retained attempt when you press Load steps; no API collection" }, [el("input", { id: "steps-all-attempts", type: "checkbox", checked: recovered || settings.includeAllAttempts === true, disabled: recovered, onchange: (event) => draftStepSettings(state, { includeAllAttempts: event.target.checked }) }), el("span", { text: "Include all attempts" })]),
                el("label", { class: "inline-field inline-field--check" }, [el("input", { id: "steps-merge", type: "checkbox", checked: settings.mergeMatrix !== false, onchange: (event) => draftStepSettings(state, { mergeMatrix: event.target.checked }) }), el("span", { text: "Merge matrix" })]),
                el("label", { class: "inline-field inline-field--check" }, [el("input", { id: "steps-infra", type: "checkbox", checked: settings.showInfra !== false, onchange: (event) => draftStepSettings(state, { showInfra: event.target.checked }) }), el("span", { text: "Show infra" })]),
                el("button", { type: "button", class: "button button--primary", disabled: loading, text: loading ? "Loading…" : "Load steps", onclick: () => void loadSteps(state) }),
            ]),
            stepConditionControls(state, settings),
            runnerControls(state, settings),
            recovered ? el("p", { class: "notice", text: "Keeps jobs whose latest execution succeeded after an earlier failure, timeout or startup failure in the same run. Failed and successful attempts remain unless narrowed by other filters; matrix variants are classified separately, before runner filters. Only observed history in the retained sample can qualify." }) : null,
            conditions.length ? el("p", { class: "notice", text: `Step conditions: ${stepConditionsSummary(conditions)}. All conditions must match in the same job attempt; all steps of matching jobs remain. Other attempts are not added. ${recovered ? "Re-run success is evaluated from the full history before these attempt conditions." : "The current attempt scope still applies; enable Include all attempts and press Load steps to search earlier attempts."}` }) : null,
            error ? el("p", { class: "notice notice--warn", text: error }) : null,
        ]),
        el("p", { class: "card__note", text: "Runs defaults to 500 newest runs per repository; 0 removes the run-count limit within the selected window. Changes apply when you press Load steps. Loading another workflow clears step conditions. Workflow display names are not accepted by the CLI; use the file name such as ci.yml." }),
    ]);
}

function runnerControls(state, settings) {
    const facets = state?.steps?.result?.runnerFacets;
    if (!facets) return null;
    const disabled = !canFilterSteps(state);
    const filter = currentRunnerFilter(state, settings);
    const selected = runnerFilterSelections(filter);
    const context = JSON.stringify([state.identity, state.steps?.settings?.workflow, state.steps?.settings?.repository ?? ""]);
    if (!runnerFacetViews.has(context)) runnerFacetViews.set(context, { open: new Set(), queries: new Map() });
    const view = runnerFacetViews.get(context);
    const chips = [];
    const pickers = RUNNER_FACETS.map(({ key, label, format = value => value }) => {
        const options = facets[key] ?? [];
        const values = key === "labelSets" ? selected[key].map(value =>
            options.find(option => labelSetKey(splitLabelSet(option.value)) === labelSetKey(splitLabelSet(value)))?.value ?? value) : selected[key];
        for (const value of values) {
            chips.push(el("button", {
                type: "button", class: "chip", disabled, title: `Remove ${label}: ${value}`,
                text: `${label}: ${format(value)} ×`, onclick: () => toggleRunnerFacet(state, key, value),
            }));
        }
        return renderFacetPicker({
            create: el, id: `steps-runner-${key}`, key, label, options, selected: values, format,
            disabled, open: view.open.has(key), query: view.queries.get(key) ?? "",
            onPick: value => toggleRunnerFacet(state, key, value),
            onQuery: value => { view.queries.set(key, value); renderSoon(); },
            onToggle: open => { if (open) view.open.add(key); else view.open.delete(key); },
        });
    });
    if (filter.name && !filter.nameExact && filter.name.includes("*")) {
        chips.push(el("button", {
            type: "button", class: "chip", disabled, text: `Name pattern: ${filter.name} ×`,
            title: "Remove the saved wildcard name filter",
            onclick: () => applyRunnerFilter(state, { name: "", nameExact: false }),
        }));
    }
    if (isRunnerFilterActive(filter)) {
        chips.push(el("button", {
            type: "button", class: "chip chip--clear", disabled, text: "Clear runner filter",
            onclick: () => void loadSteps(state, { reuseRows: true, runnerFilter: normalizeRunnerFilter() }),
        }));
    }
    return el("div", {}, [
        el("div", { class: "controls controls--runner" }, [
            el("span", { class: "controls__label", text: "Runner" }),
            el("div", { class: "facets" }, pickers),
        ]),
        chips.length ? el("div", { class: "chips" }, chips) : null,
        el("p", { class: "card__note", text: "Select multiple values: OR within a runner facet, AND between facets. Sample statistics, including Runners, use the selection. Choices remain available so more runners can be added." }),
    ]);
}

function runnerMetricCells(pool) {
    return [
        el("td", { class: "num", text: number(pool.jobs) }),
        el("td", { class: "num", text: pool.wait.samples ? formatDuration(pool.wait.p50) : "–" }),
        el("td", { class: "num", text: pool.wait.samples ? formatDuration(pool.wait.p90) : "–" }),
        el("td", { class: "num", text: pool.duration.samples ? formatDuration(pool.duration.p50) : "–" }),
        el("td", { class: "num", text: pool.duration.samples ? formatDuration(pool.duration.p90) : "–" }),
        el("td", {
            class: "num",
            text: pool.duration.samples ? formatDuration(pool.duration.total) : "–",
            title: pool.duration.samples && Number.isFinite(pool.duration.total)
                ? `${(pool.duration.total / 60000).toLocaleString(undefined, { maximumFractionDigits: 2 })} min`
                : null,
        }),
        el("td", { class: "num", text: percent(pool.failureRate) }),
    ];
}

function individualRunnerRow(state, runner, selected) {
    const active = selected.names.includes(runner.name);
    const selectable = runner.name !== "" && canFilterSteps(state);
    const select = () => toggleRunnerFacet(state, "names", runner.name);
    const title = !runner.name ? "This job has no assigned runner to select."
        : active ? "Click to clear the individual runner selection" : "Click to filter the statistics by this individual runner";
    return el("tr", {
        class: `runners-table__row--individual${active ? " row--selected" : ""}${selectable ? " runners-table__row--selectable" : ""}`,
        title,
        onclick: selectable ? select : null,
    }, [
        el("td", { class: "runners-table__individual-label", text: "Runner" }),
        summaryCell(runner.kinds.map((item) => kindLabel(item.value))),
        summaryCell(runner.groups),
        el("td", {}, [el("button", {
            type: "button", class: "ghost runners-table__runner", disabled: !selectable,
            text: runner.name || "(unassigned)", "aria-pressed": String(active), title,
            onclick: (event) => { event.stopPropagation(); if (selectable) select(); },
        })]),
        ...runnerMetricCells(runner),
    ]);
}

function runnersCard(state) {
    const result = state?.steps?.result;
    const pools = result?.runners ?? [];
    if (!result?.runnerFacets) return null;
    const selected = runnerFilterSelections(result.runnerFilter);
    const filterKeys = new Set(selected.labelSets.map(value => labelSetKey(splitLabelSet(value))));
    const body = pools.length === 0
        ? el("p", { class: "empty", text: "No jobs to group by runner." })
        : el("table", { class: "runners-table" }, [
            el("thead", {}, [el("tr", {}, [el("th", { text: "Runs-on" }), el("th", { text: "Kind" }), el("th", { text: "Group" }), el("th", { text: "Runners" }), el("th", { class: "num", text: "Jobs" }), el("th", { class: "num", text: "Wait p50" }), el("th", { class: "num", text: "Wait p90" }), el("th", { class: "num", text: "Run p50" }), el("th", { class: "num", text: "Run p90" }), el("th", { class: "num", text: "Total run" }), el("th", { class: "num", text: "Fail" })])]),
            el("tbody", {}, pools.flatMap((pool) => {
                const active = filterKeys.has(pool.key);
                const expansionKey = JSON.stringify([state.identity, state.steps?.settings?.workflow, state.steps?.settings?.repository ?? "", pool.key]);
                const individuals = pool.individuals ?? [];
                const expanded = individuals.length > 0 && expandedRunnerPools.has(expansionKey);
                const labels = el("td", { class: "runners-table__labels" }, [
                    individuals.length > 0 ? el("button", {
                        type: "button", class: "ghost runners-table__toggle",
                        text: expanded ? "-" : "+", "aria-expanded": String(expanded),
                        "aria-label": `${expanded ? "Hide" : "Show"} individual runners for ${pool.labels || "(no labels)"}`,
                        onclick: (event) => {
                            event.stopPropagation();
                            if (expanded) expandedRunnerPools.delete(expansionKey);
                            else expandedRunnerPools.add(expansionKey);
                            renderSoon();
                        },
                    }) : null,
                    el("span", { text: pool.labels || "(no labels)" }),
                ]);
                // A job without runs-on labels cannot be selected, because an empty
                // label filter means every label set.
                const selectable = pool.labels !== "" && canFilterSteps(state);
                const row = el("tr", {
                    class: `${active ? "row--selected" : ""}${selectable ? " runners-table__row--selectable" : ""}`.trim() || null,
                    title: !selectable ? null : active ? "Click to remove this runs-on set from the selection" : "Click to add this runs-on set to the selection",
                    onclick: selectable ? () => toggleRunnerFacet(state, "labelSets", pool.labels) : null,
                }, [
                    labels,
                    summaryCell(pool.kinds.map((item) => kindLabel(item.value))),
                    summaryCell(pool.groups),
                    summaryCell(pool.runners.map((item) => `${item.value} (${number(item.count)})`)),
                    ...runnerMetricCells(pool),
                ]);
                return [row, ...(expanded ? individuals.map((runner) => individualRunnerRow(state, runner, selected)) : [])];
            })),
        ]);
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Runners" })]),
        el("div", { class: "card__body" }, [body]),
        el("p", { class: "card__note", text: "Matching jobs grouped by their runs-on label set, after all job and runner filters. Expand a pool to see non-hosted runners grouped by name; click a runner or pool to toggle its selection. Add more values with the Runner checkboxes above. GitHub-hosted runners stay aggregated. Wait and run statistics only use jobs that started or finished. Total run sums completed job execution times, excluding wait; parallel jobs and included attempts are added separately, not measured as elapsed wall-clock time." }),
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
    const conditions = normalizeStepFilters(meta).stepConditions;
    const selections = [meta.repository ? `repository: ${meta.repository}` : "", meta.jobStatus ? `status: ${meta.jobStatus}` : "", conditions.length ? `steps: ${stepConditionsSummary(conditions)}` : ""].filter(Boolean);
    const filtered = isRunnerFilterActive(meta.runnerFilter) || selections.length ? ` The job filters${selections.length ? ` (${selections.join("; ")})` : ""} keep ${number(meta.totalJobs)} of ${number(meta.unfilteredJobs)} jobs.` : "";
    const basis = meta.latestAttemptBasis === false
        ? `Attempt scope: all; ${number(meta.analysedAttempts)} attempts have matching rows. Earlier attempts with jobs: ${number(meta.historicalAttemptsWithJobs)} of ${number(meta.historicalAttemptsRequested)} requested.`
        : "Job lists use GitHub's latest-attempt basis, including carried-over jobs.";
    const budgetNote = meta.runBudget === 0
        ? meta.truncated ? "The collection was truncated despite having no run-count limit; see collection warnings." : "No run-count limit was applied."
        : meta.truncated ? "The run budget was reached, so this is a sample of newest runs." : "The run budget was not reached.";
    return el("p", { class: `notice${meta.truncated ? " notice--warn" : ""}`, text: `${number(meta.analysedRuns)} runs analysed for ${meta.workflow}; ${range}. ${budgetNote} ${basis}${filtered}` });
}

// The CLI reports skipped repositories and job lists on stderr; without them a partial
// collection would look complete.
function collectionWarnings(result) {
    const warnings = [...(result?.meta?.warnings ?? [])];
    const ambiguous = result?.meta?.recovery?.ambiguousJobs ?? 0;
    if (ambiguous) warnings.push(`Cannot classify ${number(ambiguous)} job histories with multiple same-name jobs in one attempt. They are excluded from re-run recovery matching; distinct job names are required.`);
    if (!warnings.length) return null;
    return el("details", { class: "notice notice--warn collection-warnings" }, [
        el("summary", { text: `Collection warnings (${number(warnings.length)})` }),
        el("ul", {}, warnings.map((warning) => el("li", { text: warning }))),
    ]);
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
    const max = maxOf(jobs.flatMap((job) => job.steps.map((step) => Math.max(job.startOffsetMs + step.offsetMs + step.durationMs, job.startOffsetMs + step.offsetP90Ms + step.durationP90Ms))), 1000);
    const rows = [ganttAxis(max)];
    for (const job of jobs) {
        rows.push(el("div", { class: "gantt__group", text: job.job }));
        for (const step of job.steps) {
            const start = job.startOffsetMs + step.offsetMs;
            const rangeStart = job.startOffsetMs + step.offsetP25Ms;
            const rangeLength = step.offsetP90Ms - step.offsetP25Ms + step.durationP90Ms;
            const variant = step.failureRate > 0 ? " gantt__bar--failed gantt__bar--failure-rate" : step.infrastructure ? " gantt__bar--infra" : "";
            rows.push(ganttStepRow({
                name: step.name,
                tooltip: `${job.job} / ${step.name}\np50 ${formatDuration(step.durationMs)} · p90 ${formatDuration(step.durationP90Ms)} · failure ${percent(step.failureRate)}`,
                duration: step.durationMs,
                segments: [
                    el("span", { class: "gantt__range", style: span(rangeStart, rangeLength, max) }),
                    el("span", { class: `gantt__bar${variant}`, style: `${span(start, step.durationMs, max)};--failure-rate:${pct(step.failureRate, 1)}` }),
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
    const max = Math.max(maxOf(daily.flatMap((day) => [day.p50Ms, day.p90Ms]), 1000), maxOf(points.map((point) => point.durationMs)));
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
    const origin = `https://${state?.target?.host || "github.com"}`;
    return el("table", { class: "runs-table" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "Run" }), el("th", { class: "num", text: result?.includeAllAttempts ? "Attempt" : "Attempts" }), el("th", { text: "Result" }), el("th", { text: "Runner" }), el("th", { class: "num", text: "Total" }), el("th", { text: "Open" })])]),
        el("tbody", {}, rows.slice(0, 30).map((row) => {
            const show = () => void openRunTimeline(state, row.runId, row.repo ?? "", row.runAttempt);
            const active = open && String(open.RunID) === String(row.runId) && Number(open.RunAttempt) === Number(row.runAttempt);
            const url = `${origin}/${row.repo}/actions/runs/${row.runId}/attempts/${row.runAttempt}`;
            return el("tr", { class: active ? "row--selected" : "" }, [
                el("td", {}, [el("button", { type: "button", class: "link-button", title: "Show this run's Gantt", text: row.runId, onclick: show })]),
                el("td", { class: `num${row.runAttempt > 1 ? " runs-table__retried" : ""}`, title: result?.includeAllAttempts ? `Statistics for attempt ${row.runAttempt}; click Gantt to open this attempt` : row.runAttempt > 1 ? `Re-run ${row.runAttempt - 1} time(s); statistics use attempt ${row.runAttempt}` : null, text: number(row.runAttempt) }),
                el("td", { text: row.conclusion ?? "–" }),
                (() => {
                    const summary = listSummary(row.runners);
                    const labels = (row.labelSets ?? []).filter(Boolean);
                    const title = [summary.title ?? (row.runners?.length === 1 ? row.runners[0] : null), labels.length ? `runs-on: ${labels.join(" | ")}` : null].filter(Boolean).join("\n");
                    return el("td", { class: "runs-table__runner", title: title || null, text: summary.text });
                })(),
                el("td", { class: "num", text: formatDuration(row.durationMs) }),
                el("td", {}, [el("div", { class: "runs-table__actions" }, [
                    el("button", { type: "button", class: "ghost", text: "Gantt", onclick: show }),
                    el("a", { href: url, target: "_blank", rel: "noreferrer", title: `Open ${row.repo} run ${row.runId} attempt ${row.runAttempt} on GitHub`, text: "GitHub" }),
                ])]),
            ]);
        })),
    ]);
}

function runTimeline(timeline, stats, workflow, onClose, jobStatus = "", repository = "", failedStep = null, stepConditions) {
    if (!timeline) return el("p", { class: "empty", text: "Open a run to show a single-run Gantt." });
    const conditions = normalizeStepFilters({ stepConditions, failedStep }).stepConditions;
    const jobs = filterTimelineJobs(timeline, jobStatus, repository, stats?.runs, failedStep, conditions);
    const sameRepository = !repository || timeline.Repo === repository;
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
    const max = Math.max(1000, ms(timeline.Duration), maxOf(jobs.map((job) => ms(job.QueuedOffset) + ms(job.Wait) + ms(job.Duration))));
    const rows = [
        el("div", { class: "gantt__header" }, [
            el("span", { class: "gantt__title", text: `${timeline.Workflow} #${timeline.RunID} attempt ${timeline.RunAttempt}` }),
            onClose ? el("button", { type: "button", class: "ghost gantt__close", title: "Close this Gantt", "aria-label": "Close this Gantt", text: "× Close", onclick: onClose }) : null,
        ]),
        sameWorkflow ? null : el("p", { class: "notice notice--warn", text: `This run belongs to ${timeline.WorkflowPath || timeline.Workflow}, not ${workflow}; slow-step highlighting against p90 is off.` }),
        sameRepository ? null : el("p", { class: "notice notice--warn", text: `This run belongs to ${timeline.Repo || "an unknown repository"}, not ${repository}. Clear the repository filter to show its jobs. Copy mermaid exports the full run.` }),
        jobStatus ? el("p", { class: "notice", text: `Job status: ${jobStatus}; showing ${number(jobs.length)} of ${number(timeline.Jobs?.length ?? 0)} jobs. Copy mermaid exports the full run.` }) : null,
        conditions.length ? el("p", { class: "notice", text: `Step conditions: ${stepConditionsSummary(conditions)}; showing ${number(jobs.length)} of ${number(timeline.Jobs?.length ?? 0)} jobs matching every condition in their own attempt. Copy mermaid exports the full run.` }) : null,
        isRecoveredJobStatus(jobStatus) && !(stats?.runs ?? []).some(row => row.repo === timeline.Repo && row.runId === String(timeline.RunID))
            ? el("p", { class: "notice notice--warn", text: "Re-run recovery membership is unavailable for this run in the loaded run list. Choose a matching run from that list or clear the job status filter." }) : null,
        jobs.length === 0 ? el("p", { class: "empty", text: "No jobs match the selected filters." }) : null,
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
        collectionWarnings(result),
        runnersCard(state),
        el("section", { class: "card" }, [
            el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: "Typical timeline" })]),
            el("div", { class: "card__body" }, [typicalTimeline(result)]),
            el("p", { class: "card__note", text: "Blue: no observed failures. Gray: infrastructure. Red: failures; darker red means a higher failure rate. Hover over a step for the percentage." }),
        ]),
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
            runTimeline(state?.steps?.timeline, result, state?.steps?.settings?.workflow ?? result?.meta?.workflow ?? "", () => void closeRunTimeline(state), state?.steps?.settings?.jobStatus ?? "", state?.steps?.settings?.repository ?? "", state?.steps?.settings?.failedStep ?? null, state?.steps?.settings?.stepConditions),
        ])]),
    ].filter(Boolean);
}
