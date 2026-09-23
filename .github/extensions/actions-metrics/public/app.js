import { initExplorer, renderExplorer, resetExplorer, syncExplorer } from "./explorer.js";
import {
    FIELD_GROUPS,
    QUERY_FIELDS,
    fieldByName,
    fieldsOfGroup,
    readFieldValue,
    sameFieldValue,
    writeFieldValue,
} from "/shared/fields.mjs";

const dom = {
    targetToggle: document.getElementById("target-toggle"),
    targetCurrent: document.getElementById("target-current"),
    targetPopover: document.getElementById("target-popover"),
    targetForm: document.getElementById("target-form"),
    targetCancel: document.getElementById("target-cancel"),
    targetHint: document.getElementById("target-hint"),
    targetError: document.getElementById("target-error"),
    scope: document.getElementById("scope"),
    target: document.getElementById("target"),
    targetLabel: document.getElementById("target-label"),
    queryToggle: document.getElementById("query-toggle"),
    queryDirtyCount: document.getElementById("query-dirty-count"),
    queryEditor: document.getElementById("query-editor"),
    queryForm: document.getElementById("query-form"),
    queryGroups: document.getElementById("query-groups"),
    queryEffect: document.getElementById("query-effect"),
    queryReset: document.getElementById("query-reset"),
    queryApply: document.getElementById("query-apply"),
    refresh: document.getElementById("refresh"),
    export: document.getElementById("export"),
    status: document.getElementById("status"),
    banner: document.getElementById("banner"),
    content: document.getElementById("content"),
    tabs: [...document.querySelectorAll(".tab")],
};

let state = null;
let activeTab = "overview";

/**
 * The query editor edits a draft rather than the live state. Only the fields
 * the reader actually touched are held here, so an SSE push - a finished
 * collection, a setting changed from a tab card or by the agent - keeps
 * updating everything else underneath instead of being locked out while the
 * panel is open. `baseline` is what each edited field read when it was first
 * touched, which is how a change arriving underneath an edited field is told
 * apart from the reader's own edit.
 */
const queryDraft = {
    open: false,
    edited: new Map(),
    baseline: new Map(),
    conflicts: new Set(),
    key: null,
};

/** The target popover, which commits separately from the query editor. */
const targetDraft = { open: false, dirty: false };
// Purely client-side view state: neither needs a new collection, so they are
// kept out of the filters the extension persists.
let chartMetric = "peak";
// The activity tab charts a projection, which has no inventory, so it carries
// its own series choice rather than inheriting one that may be utilization.
let traceMetric = "peak";
let runnerQuery = "";
// What the runner trace field holds. Unlike the filters this is submitted
// explicitly, because it costs a pass over every job in the window.
let timelineQuery = "";
// Narrows the projection only, leaving the other cards on the dashboard filter.
let timelineWorkflow = "";
// Runner patterns dropped as the job stream is read, so a noisy family can be
// kept out of the ranking without re-running the collection.
let timelineExclude = "";
// Reading every job row is a deliberate two-click action, not a blank submit.
let traceAllArmed = false;
// The runner table of a projection is served a page at a time, because the
// projection observes far more runners than the panel is ever given.
const RUNNER_PAGE_SIZE = 40;
let runnerFilterQuery = "";
let runnerFilterSort = "jobMs";
let runnerFilterDirection = "desc";
let runnerFilterOffset = 0;
let runnerFilterPage = null;
let runnerFilterProjection = null;
let runnerFilterError = null;
let runnerFilterRegion = null;
let runnerFilterSeq = 0;
let runnerFilterAbort = null;
let runnerFilterTimer = null;
// How the per-runner heatmap is cut down for reading; both are client-side.
let heatRows = 20;
let heatSort = "busy";
// The small multiples are a second card over the same runners, so they carry
// their own cut: one chart is much taller than one heatmap row, and the two
// cards are read for different things.
let sparkRows = 12;
let sparkSort = "busy";
let sparkScale = "full";
// Per table sort, keyed by tab and column labels so it survives a re-render.
const tableSort = new Map();
// Which settings cards the reader has opened. Kept by id rather than by node:
// every render replaces the whole content region, so the element a set held
// would be the previous one.
const openSettings = new Set();
// Half-typed numbers in the settings cards. A field is only read from here
// while it has the caret: an SSE update, another panel or an agent action can
// change the authoritative value, and an unfocused field must show that value
// rather than whatever was left in a draft.
const settingDrafts = new Map();
// Which field held the caret when the current render started, captured before
// the content region is replaced and the old node is detached.
let renderFocusId = null;

/* ---------- helpers ---------- */

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
        } else if (key === "html") {
            node.innerHTML = value;
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

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * `el` for SVG. A separate helper because SVG elements need their namespace at
 * creation time, and because their `className` is a read-only
 * `SVGAnimatedString`, so every property here has to go through
 * `setAttribute`.
 */
function svgEl(tag, props = {}, children = []) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) {
            continue;
        }
        if (key === "text") {
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
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function percent(ratio) {
    return Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "–";
}

function money(value) {
    return Number.isFinite(value) ? `$${value.toFixed(2)}` : "–";
}

function number(value) {
    return Number.isFinite(value) ? value.toLocaleString() : "–";
}

/**
 * Name a repository in a column that only exists under an organization, where
 * every row shares the same owner. Repeating it would cost width and say
 * nothing, so it is dropped when it matches the target being reported on.
 */
function repoName(repository, owner) {
    if (!repository) {
        return "–";
    }
    const prefix = `${owner}/`;
    return owner && repository.startsWith(prefix) ? repository.slice(prefix.length) : repository;
}

function healthPill(ratio) {
    if (!Number.isFinite(ratio)) {
        return el("span", { class: "pill", text: "–" });
    }
    const level = ratio >= 0.9 ? "ok" : ratio >= 0.7 ? "warn" : "bad";
    return el("span", { class: `pill pill--${level}`, text: percent(ratio) });
}

function bar(value, max, { danger = false } = {}) {
    const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    return el("div", { class: "bar" }, [
        el("div", { class: `bar__fill${danger ? " bar__fill--danger" : ""}`, style: `width:${(ratio * 100).toFixed(1)}%` }),
    ]);
}

function card(title, body, note, control) {
    return el("section", { class: "card" }, [
        el("header", { class: "card__header" }, [el("h2", { class: "card__title", text: title }), control ?? null]),
        el("div", { class: "card__body" }, body),
        note ? el("p", { class: "card__note", text: note }) : null,
    ]);
}

/**
 * A card that starts closed. Settings are read rarely and would otherwise push
 * the numbers the tab exists for off the screen, so they are folded away with
 * their open state kept in a module-level set: the content region is replaced
 * on every state update, and a card that snapped shut under a progress line
 * would be unusable while a collection runs.
 */
function settingsCard(id, title, body, note) {
    return el(
        "details",
        {
            class: "card card--settings",
            id,
            open: openSettings.has(id),
            // Written from the element rather than flipped, so the set stays
            // correct however the state was reached.
            ontoggle: (event) => {
                if (event.target.open) {
                    openSettings.add(id);
                } else {
                    openSettings.delete(id);
                }
            },
        },
        [
            el("summary", { class: "card__header card__header--summary" }, [el("h2", { class: "card__title", text: title })]),
            el("div", { class: "card__body" }, body),
            note ? el("p", { class: "card__note", text: note }) : null,
        ],
    );
}

/**
 * A number a setting is spelled with. Committed on `change` - blur or Enter -
 * rather than on every keystroke, because each commit is a round trip that can
 * re-run a projection, and a half-typed number is a different setting.
 */
function numberControl(id, label, value, { min, max, step = 1, hint = "" } = {}, onChange) {
    const drafted = renderFocusId === id && settingDrafts.has(id);
    return el("label", { class: "inline-field", title: hint || null }, [
        el("span", { text: label }),
        el("input", {
            id,
            type: "number",
            min: min === undefined ? null : String(min),
            max: max === undefined ? null : String(max),
            step: String(step),
            value: drafted ? settingDrafts.get(id) : String(value),
            oninput: (event) => {
                settingDrafts.set(id, event.target.value);
            },
            onchange: (event) => {
                settingDrafts.delete(id);
                const raw = String(event.target.value ?? "").trim();
                const next = Number(raw);
                // An emptied field is not a zero: `maxRuns` reads 0 as "no
                // limit", so a cleared box would silently mean something.
                if (raw === "" || !Number.isFinite(next)) {
                    // Nothing usable was typed, so the authoritative value is
                    // put back rather than a guess sent for the server to clamp.
                    render();
                    return;
                }
                onChange(next);
            },
            onkeydown: (event) => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    event.target.blur();
                }
            },
        }),
    ]);
}

function saturationPill(value) {
    if (!Number.isFinite(value)) {
        return el("span", { class: "pill", text: "–" });
    }
    const level = value > 1 ? "bad" : value >= 0.8 ? "warn" : "ok";
    return el("span", { class: `pill pill--${level}`, text: value.toFixed(2) });
}

function timestamp(value) {
    return value ? new Date(value).toLocaleString() : "–";
}

/** Banner shown instead of the gh runner-kit tables when the CLI is missing. */
function fleetNotice(fleet) {
    if (fleet?.available) {
        return null;
    }
    return el("p", {
        class: "empty",
        text: `${fleet?.reason ?? "gh runner-kit metrics has not been collected"}. Install it with: gh extension install srz-zumix/gh-runner-kit`,
    });
}

/**
 * Per-job cards are computed one repository at a time, so an organization
 * target leaves them out rather than rendering zeros. Workflow runs themselves
 * are reported by `gh runner-kit metrics runs` for every target.
 */
function orgWideNotice(orgWide) {
    return orgWide
        ? el("p", {
              class: "notice",
              text: "Organization-wide view: the numbers below cover every repository the organization owns. The per-job cards the dashboard derives itself (queue time, runner usage, cost estimates) are repository-scoped and are hidden.",
          })
        : null;
}

function runnerTypeControl(fleet, orgWide) {
    // The CLI reads the organization runners for `--type org` on any target, and
    // the repository runners for `--type repo`, which needs a repository. So an
    // organization target offers only its own inventory, while a repository
    // target can also read the shared organization runners it runs on.
    const options = orgWide
        ? [{ value: "auto", label: "auto" }, "org"]
        : [{ value: "auto", label: "auto" }, "repo", "org"];
    return selectControl(
        "Runner inventory",
        options,
        fleet?.runnerType ?? "auto",
        (value) => applyFilters({ runnerType: value }),
    );
}

function groupByControl(fleet) {
    return selectControl("Group by", ["name", "label", "group"], fleet?.groupBy ?? "name", (value) => applyFilters({ groupBy: value }));
}

/**
 * Client-side filter over the rows `gh runner-kit metrics runner` returned. The
 * CLI carries no runner filter, so this narrows the fetched rows instead of the
 * collection, which also keeps it free of a round trip.
 */
function matchesRunnerQuery(row) {
    const query = runnerQuery.trim().toLowerCase();
    return query === "" || String(row.key ?? "").toLowerCase().includes(query);
}

function runnerQueryControl(placeholder) {
    return el("label", { class: "inline-field" }, [
        el("span", { text: "Filter" }),
        el("input", {
            id: "runner-query",
            type: "search",
            value: runnerQuery,
            placeholder,
            spellcheck: "false",
            oninput: (event) => {
                runnerQuery = event.target.value;
                const caret = event.target.selectionStart;
                render();
                // `render` replaces the whole tab, so the field has to be given
                // its focus and its caret back to stay usable while typing.
                const next = document.getElementById("runner-query");
                if (next) {
                    next.focus();
                    next.setSelectionRange(caret, caret);
                }
            },
        }),
    ]);
}

/**
 * Per-runner busy time over the whole window, one horizontal bar per row of
 * `gh runner-kit metrics runner`. Rows without a job are kept so the idle and
 * cordoned capacity stays visible next to the busiest runners.
 */
function runnerBusyChart(rows, groupBy) {
    if (rows.length === 0) {
        return el("p", { class: "empty", text: "No runner matches the current filter." });
    }
    const ordered = [...rows].sort((left, right) => (right.busyTimeMs ?? 0) - (left.busyTimeMs ?? 0));
    const shown = ordered.slice(0, 40);
    const max = Math.max(1, ...shown.map((row) => row.busyTimeMs ?? 0));

    return el("div", {}, [
        el(
            "div",
            { class: "hbars" },
            shown.map((row) =>
                el("div", { class: "hbar", title: `${row.key} · ${row.jobs} jobs · util ${percent(row.utilization)}` }, [
                    el("span", { class: "hbar__label mono", text: row.key || "(unknown)" }),
                    el("span", { class: "hbar__track" }, [bar(row.busyTimeMs ?? 0, max, { danger: row.cordoned })]),
                    el("span", { class: "hbar__value", text: duration(row.busyTimeMs) }),
                    el("span", { class: "hbar__hint", text: percent(row.utilization) }),
                ]),
            ),
        ),
        ordered.length > shown.length
            ? el("p", { class: "card__note", text: `Showing the 40 busiest of ${number(ordered.length)} ${groupBy} rows.` })
            : null,
    ]);
}

/** Card-level `<select>` bound to one filter key. */
function selectControl(label, options, current, onChange) {
    return el("label", { class: "inline-field" }, [
        el("span", { text: label }),
        el(
            "select",
            { onchange: (event) => onChange(event.target.value) },
            options.map((option) => {
                const value = typeof option === "string" ? option : option.value;
                const text = typeof option === "string" ? option : option.label;
                return el("option", { value, text, selected: value === current });
            }),
        ),
    ]);
}

function checkboxControl(label, checked, onChange) {
    return el("label", { class: "inline-field inline-field--check" }, [
        el("input", { type: "checkbox", checked, onchange: (event) => onChange(event.target.checked) }),
        el("span", { text: label }),
    ]);
}

/** orphan = demand without capacity, unused = capacity without demand. */
function labelStatusPill(status) {
    if (!status) {
        return el("span", { class: "pill", text: "–" });
    }
    const level = status === "orphan" ? "bad" : status === "unused" ? "warn" : "ok";
    return el("span", { class: `pill pill--${level}`, text: status });
}

/** How many runners to add (positive) or retire (negative) for the target. */
function deltaPill(delta) {
    if (!Number.isFinite(delta) || delta === 0) {
        return el("span", { class: "pill pill--ok", text: "0" });
    }
    return el("span", { class: `pill pill--${delta > 0 ? "bad" : "warn"}`, text: delta > 0 ? `+${delta}` : String(delta) });
}

/**
 * The three series the concurrency buckets carry. `peak` counts jobs, so it is
 * compared against the runner inventory; the other two already describe how
 * busy the fleet was and carry no capacity line.
 */
const CHART_METRICS = {
    peak: { label: "Peak jobs", value: (row) => row.peak, format: (value) => number(value), capacity: true },
    busy: { label: "Busy time", value: (row) => row.busyTimeMs, format: (value) => duration(value), capacity: false },
    utilization: {
        label: "Utilization",
        value: (row) => row.utilization,
        format: (value) => percent(value),
        capacity: false,
        ceiling: 1,
    },
};

/**
 * Width of one column, as the charts should name it. `auto` is resolved from
 * the window at collection time, so the setting alone never says how wide a
 * column actually is - which is the first thing to know when reading a
 * timeline. The marker is kept so an automatic 1h still reads differently from
 * one that was asked for.
 */
function bucketWidth(bucket) {
    return state?.filters?.bucket === "auto" ? `${bucket} (auto)` : bucket;
}

/**
 * Concurrency timeline: one column per bucket, height relative to the busiest
 * bucket, with the runner inventory drawn as a capacity line across the chart.
 */
function concurrencyChart(rows, bucket, metric = "peak") {
    if (rows.length === 0) {
        return el("p", { class: "empty", text: "No self-hosted job ran in this window." });
    }
    const series = CHART_METRICS[metric] ?? CHART_METRICS.peak;
    const values = rows.map((row) => series.value(row) ?? 0);
    const highest = Math.max(...values);
    const capacity = series.capacity ? Math.max(0, ...rows.map((row) => row.runners)) : 0;
    const ceiling = Math.max(series.ceiling ?? 0, capacity, highest) || 1;

    return el("div", {}, [
        el("div", { class: "chart-wrap" }, [
            el(
                "div",
                { class: "chart" },
                rows.map((row, index) => {
                    const value = values[index];
                    const hot = capacity > 0 ? value >= capacity : highest > 0 && value >= highest * 0.9;
                    return el("div", { class: "chart__col", title: bucketTitle(row) }, [
                        el("div", {
                            class: `chart__seg chart__seg--${hot ? "failure" : "other"}`,
                            style: `height:${((value / ceiling) * 100).toFixed(2)}%`,
                        }),
                    ]);
                }),
            ),
            capacity > 0
                ? el("div", { class: "chart__capacity", style: `bottom:${((capacity / ceiling) * 100).toFixed(2)}%` }, [
                      el("span", { class: "chart__capacity-label", text: `${capacity} runners` }),
                  ])
                : null,
        ]),
        el("div", { class: "chart__axis" }, [
            el("span", { text: timestamp(rows[0]?.start) }),
            el("span", { text: `${bucketWidth(bucket)} buckets · max ${series.format(highest)}` }),
            el("span", { text: timestamp(rows.at(-1)?.end) }),
        ]),
    ]);
}

function bucketTitle(row) {
    const parts = [timestamp(row.start), `peak ${row.peak}`, `${row.jobs} jobs`, `busy ${duration(row.busyTimeMs)}`];
    if (row.runners > 0) {
        parts.push(`${row.runners} runners`, `util ${percent(row.utilization)}`);
    }
    return parts.join(" · ");
}

/**
 * Trace fields for the timeline chart. Submitting one asks the extension to
 * project the jobs of the matching runners onto the same buckets, through
 * `gh runner-kit metrics jobs`, which is a pass over every job in the window
 * and therefore never runs on a keystroke.
 *
 * The workflow field narrows this chart only: the dashboard filter re-runs
 * every report, which for an organization takes minutes, while this reads the
 * job cache those reports already populated.
 */
function timelineControl(state_) {
    const busy = state_?.timelineStatus === "loading";
    const active = Boolean(state_?.timeline);
    const inherited = state_?.filters?.workflow ?? "";
    const submit = (body) => {
        void fetch("./api/timeline", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        })
            .then((response) => response.json())
            .then((next) => {
                state = next;
                render();
            })
            .catch(() => {});
    };
    const fields = () => ({
        query: (document.getElementById("timeline-query")?.value ?? "").trim(),
        workflow: (document.getElementById("timeline-workflow")?.value ?? "").trim(),
        exclude: (document.getElementById("timeline-exclude")?.value ?? "").trim(),
    });
    const trace = () => {
        const { query, workflow, exclude } = fields();
        if (query === "") {
            return;
        }
        timelineQuery = query;
        timelineWorkflow = workflow;
        timelineExclude = exclude;
        traceAllArmed = false;
        submit({ query, workflow, exclude });
    };

    return el("div", { class: "controls" }, [
        el("label", { class: "inline-field" }, [
            el("span", { text: "Runner" }),
            el("input", {
                id: "timeline-query",
                type: "search",
                value: timelineQuery,
                placeholder: "name or name*",
                spellcheck: "false",
                disabled: busy ? "disabled" : null,
                // Typing must not re-render, or the field loses its caret.
                oninput: (event) => {
                    timelineQuery = event.target.value;
                },
                onkeydown: (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        trace();
                    }
                },
            }),
        ]),
        el("label", { class: "inline-field" }, [
            el("span", { text: "Workflow" }),
            el("input", {
                id: "timeline-workflow",
                type: "search",
                value: timelineWorkflow,
                placeholder: inherited ? `inherits ${inherited}` : "all workflows",
                title: inherited
                    ? `Empty inherits the dashboard filter (${inherited}). A name narrows this chart only; * ignores the filter here.`
                    : "Narrows this chart only, without re-running the other reports.",
                spellcheck: "false",
                disabled: busy ? "disabled" : null,
                oninput: (event) => {
                    timelineWorkflow = event.target.value;
                },
                onkeydown: (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        trace();
                    }
                },
            }),
        ]),
        el("label", { class: "inline-field" }, [
            el("span", { text: "Exclude" }),
            el("input", {
                id: "timeline-exclude",
                type: "search",
                value: timelineExclude,
                placeholder: "none",
                title: "Comma-separated runner patterns to leave out, written like the Runner field: bare text matches anywhere in the name, * matches any run of characters, and matching is case-sensitive. Sent to gh runner-kit as --exclude-runner, so the rows are dropped before the job stream is written and never count against the row cap. Note that a bare * also drops the jobs whose runner GitHub did not name. On a gh runner-kit without that flag the patterns are applied here instead, after the rows have been read.",
                spellcheck: "false",
                disabled: busy ? "disabled" : null,
                oninput: (event) => {
                    timelineExclude = event.target.value;
                },
                onkeydown: (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        trace();
                    }
                },
            }),
        ]),
        el("button", {
            type: "button",
            class: "ghost",
            text: busy ? "Tracing…" : "Trace",
            // A blank pattern must not be what asks for the expensive path.
            disabled: busy || timelineQuery.trim() === "" ? "disabled" : null,
            onclick: trace,
        }),
        el("button", {
            type: "button",
            class: "ghost",
            text: traceAllArmed ? "Confirm: read every job" : "Every runner",
            title: "Reads every job row in the window, capped at 400000 rows, instead of the rows of one pattern.",
            disabled: busy ? "disabled" : null,
            onclick: () => {
                if (!traceAllArmed) {
                    traceAllArmed = true;
                    render();
                    return;
                }
                traceAllArmed = false;
                timelineQuery = "";
                timelineWorkflow = fields().workflow;
                timelineExclude = fields().exclude;
                submit({ all: true, workflow: timelineWorkflow, exclude: timelineExclude });
            },
        }),
        traceAllArmed
            ? el("span", {
                  class: "control-note",
                  text: "Every job row in the window, not one runner's.",
              })
            : null,
        active || state_?.timelineStatus === "error"
            ? el("button", {
                  type: "button",
                  class: "ghost",
                  text: "Clear",
                  disabled: busy ? "disabled" : null,
                  onclick: () => {
                      traceAllArmed = false;
                      submit({ clear: true });
                  },
              })
            : null,
    ]);
}

/** One line describing which jobs the projected timeline was built from. */
function timelineNotice(state_) {
    if (state_?.timelineStatus === "error") {
        return el("p", { class: "notice", text: state_.timelineError ?? "The runner timeline could not be built." });
    }
    const timeline = state_?.timeline;
    if (!timeline) {
        return null;
    }
    const scope = timeline.pattern ? `matching ${timeline.pattern}` : "in the window";
    const parts = [
        `${number(timeline.matched)} jobs on ${number(timeline.runnerCount)} runner names ${scope}`,
        `job time ${duration(timeline.busyTimeMs)}`,
    ];
    if (timeline.workflow?.source === "override") {
        parts.push(timeline.workflow.value ? `workflow ${timeline.workflow.value}` : "every workflow");
    }
    if (timeline.excludeMode === "cli") {
        // No count: gh runner-kit dropped these before writing the stream, so
        // the dashboard never saw them and cannot say how many there were.
        parts.push(`runners matching ${timeline.exclusions.join(", ")} left out by gh runner-kit`);
    } else if (timeline.excluded > 0) {
        parts.push(`${number(timeline.excluded)} jobs left out by ${timeline.exclusions.join(", ")}`);
    }
    if (timeline.unfinished > 0) {
        parts.push(`${number(timeline.unfinished)} jobs left out because they never started or had not finished`);
    }
    if (timeline.zeroDuration > 0) {
        parts.push(`${number(timeline.zeroDuration)} jobs shorter than the one-second timestamp resolution`);
    }
    if (timeline.negativeDuration > 0) {
        parts.push(`${number(timeline.negativeDuration)} jobs GitHub timestamped as finishing before they started`);
    }
    return el("div", {}, [
        el("p", { class: "notice", text: `${parts.join(" · ")}.` }),
        timeline.truncated
            ? el("p", {
                  class: "notice notice--warn",
                  text:
                      `The job stream was capped at ${number(timeline.rows)} rows, so this is a sample of the window rather than all of it: the runners below are the busiest of the rows that were read, not of the window, and the totals are lower bounds.` +
                      (timeline.excludeMode === "local"
                          ? " The excluded rows were read before being dropped, so they used up part of that cap: the installed gh runner-kit has no --exclude-runner, which would have dropped them before the cap applied."
                          : ""),
              })
            : null,
    ]);
}

/**
 * Geometry of the concurrency axis, parsed once per render instead of once per
 * runner. A bucket whose timestamps do not parse, or that ends before it
 * starts, is marked invalid rather than given a fallback span: charging its
 * busy time against a guessed duration would draw an idle runner as a
 * saturated one.
 */
function bucketGeometry(buckets) {
    const parsed = buckets.map((bucket) => {
        const start = Date.parse(bucket?.start);
        const end = Date.parse(bucket?.end);
        const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
        return { start, end, valid, span: valid ? end - start : 0 };
    });
    const live = parsed.filter((bucket) => bucket.valid);
    const origin = live.length > 0 ? Math.min(...live.map((bucket) => bucket.start)) : 0;
    const last = live.length > 0 ? Math.max(...live.map((bucket) => bucket.end)) : 0;
    const total = last - origin;
    // Position is elapsed time, not column index, so an axis whose buckets are
    // not all the same width still reads as a time axis. A bucket that cannot
    // be placed gets no extent and breaks the line instead of being drawn at
    // an arbitrary spot.
    const x = parsed.map((bucket) =>
        total > 0 && bucket.valid ? [((bucket.start - origin) / total) * 100, ((bucket.end - origin) / total) * 100] : null,
    );
    return { parsed, x, span: total, invalid: parsed.length - live.length };
}

/**
 * The sparse cells of one runner expanded onto the axis. Entries are summed
 * rather than assigned so a duplicated bucket reports its total, and anything
 * outside the axis or not a positive number is dropped before it can reach a
 * path coordinate.
 */
function denseCells(row, count) {
    const cells = new Array(count).fill(0);
    for (const entry of row?.cells ?? []) {
        if (!Array.isArray(entry)) {
            continue;
        }
        const [index, ms] = entry;
        if (Number.isInteger(index) && index >= 0 && index < count && Number.isFinite(ms) && ms > 0) {
            cells[index] += ms;
        }
    }
    return cells;
}

/**
 * Which runners a per-runner view draws, under its own sort and row count. The
 * projection already kept only the busiest names, so this orders and cuts that
 * set - it never reaches the rest of the fleet.
 */
function selectRunners(timeline, sort, rows) {
    const named = timeline.runners.filter((row) => !row.unidentified);
    const unnamed = timeline.runners.find((row) => row.unidentified) ?? null;
    // A runner that never ran must not sort ahead of every other one, and a
    // NaN comparator would leave the order up to the engine.
    const first = (row) => (Number.isFinite(row.firstActive) ? row.firstActive : Number.POSITIVE_INFINITY);
    const byName = (left, right) => left.runner.localeCompare(right.runner);
    const ordered = [...named].sort((left, right) => {
        if (sort === "name") {
            return byName(left, right);
        }
        if (sort === "first") {
            return first(left) - first(right) || right.busyMs - left.busyMs || byName(left, right);
        }
        return right.busyMs - left.busyMs || byName(left, right);
    });
    return { named, unnamed, ordered, shown: ordered.slice(0, rows) };
}

/** Why a per-runner view has nothing to draw, which is not always "no jobs". */
function noRunnerRows(unnamed) {
    return el("p", {
        class: "empty",
        text: unnamed
            ? `Every matching job ran on a runner the API did not name, so there is no per-runner row to draw: ${number(unnamed.jobs)} jobs, busy ${duration(unnamed.jobMs)}.`
            : "No job ran on a matching runner in this window.",
    });
}

/**
 * Busy state of each runner over time: one row per runner, one column per
 * bucket of the concurrency axis, shaded by how much of the bucket the runner
 * spent working.
 *
 * A cell merges the jobs that overlapped on the same runner, so it never
 * exceeds the bucket and can be read as a share of it. The runners the API did
 * not name are left out: that key aggregates an unknown number of machines, so
 * shading it as one runner would mean nothing.
 */
function runnerHeatmap(timeline, bucket) {
    const buckets = timeline.buckets;
    const { unnamed, shown } = selectRunners(timeline, heatSort, heatRows);
    if (shown.length === 0) {
        return noRunnerRows(unnamed);
    }
    const geometry = bucketGeometry(buckets);

    return el("div", { class: "heat" }, [
        ...shown.map((row) => {
            const cells = denseCells(row, buckets.length);
            return el("div", { class: "heat__row" }, [
                el("span", { class: "heat__label mono", text: row.runner, title: row.runner }),
                el(
                    "div",
                    { class: "heat__cells" },
                    cells.map((ms, index) => {
                        const bucket = geometry.parsed[index];
                        const ratio = bucket.valid ? Math.min(1, ms / bucket.span) : 0;
                        const level = ratio <= 0 ? 0 : Math.max(1, Math.ceil(ratio * 4));
                        return el("span", {
                            class: `heat__cell heat__cell--${level}`,
                            title:
                                ratio > 0
                                    ? `${row.runner} · ${timestamp(buckets[index].start)} · busy ${duration(ms)} (${percent(ratio)})`
                                    : null,
                        });
                    }),
                ),
                el("span", { class: "heat__value", text: duration(row.busyMs) }),
                el("span", { class: "heat__hint", text: `${number(row.jobs)} jobs` }),
            ]);
        }),
        el("div", { class: "heat__legend" }, [
            el("span", { text: "idle" }),
            ...[0, 1, 2, 3, 4].map((level) => el("span", { class: `heat__cell heat__cell--${level}` })),
            el("span", { text: "busy all bucket" }),
        ]),
        el("div", { class: "chart__axis" }, [
            el("span", { text: timestamp(buckets[0]?.start) }),
            el("span", { text: `${runnerRowsLabel(timeline, shown)} · ${bucketWidth(bucket)} buckets` }),
            el("span", { text: timestamp(buckets.at(-1)?.end) }),
        ]),
        heatmapNote(timeline, unnamed),
    ]);
}

/**
 * The rows are cut twice - once by the projection, which keeps the busiest
 * names, and once by the row control - so saying only "N of M" would suggest
 * the sort reaches the whole fleet.
 */
function runnerRowsLabel(timeline, shown) {
    const kept = timeline.runners.length;
    const observed = timeline.runnerCount;
    if (observed <= kept) {
        return `${number(shown.length)} of ${number(observed)} runner names`;
    }
    return `${number(shown.length)} of the ${number(kept)} busiest runner names, out of ${number(observed)} observed`;
}

/** What the heatmap rows leave out, so the missing busy time is accounted for. */
function heatmapNote(timeline, unnamed) {
    const parts = [];
    if (unnamed) {
        parts.push(
            `${number(unnamed.jobs)} jobs (job time ${duration(unnamed.jobMs)}) ran on runners the API did not name and are not drawn as a row`,
        );
    }
    if (timeline.remainder.runners > 0) {
        parts.push(
            `${duration(timeline.remainder.total)} of job time belongs to ${number(timeline.remainder.runners)} runner names outside the busiest ${number(timeline.runners.length)}`,
        );
    }
    if (parts.length === 0) {
        return null;
    }
    return el("p", { class: "card__note", text: `${parts.join(" · ")}.` });
}

/**
 * What the activity tab shows before a projection exists. The cards used to
 * appear only once a trace had run, which left no trace of themselves on a
 * fresh dashboard: the views were unreachable because nothing said they were
 * there. An error is not repeated here because timelineNotice, which sits
 * directly above this in the same card, already reports it.
 */
function runnerTracePrompt(state_) {
    if (state_?.timelineStatus === "loading") {
        return el("p", { class: "empty", text: `${state_.progress || "Reading the jobs of this window"}…` });
    }
    return el("p", {
        class: "empty",
        text: "Name a runner above and trace it to draw this chart, a heatmap of every runner it matched, and one chart per runner. Per-runner numbers are not part of the dashboard collection because they need a separate pass over every job in the window, so they are read on request.",
    });
}

const SPARK_HEIGHT = 40;

/**
 * One runner's busy ratio as a step path over the concurrency axis.
 *
 * The value holds for a whole bucket, so it is drawn as a plateau across that
 * bucket's own time extent rather than interpolated between bucket midpoints,
 * which would invent values the projection never measured. A bucket that could
 * not be placed, and a gap between two buckets, break the path instead of
 * being bridged by a segment that claims the runner was busy in between.
 */
function stepPath(geometry, ratios, ceiling) {
    const base = SPARK_HEIGHT.toFixed(2);
    const y = (ratio) => (SPARK_HEIGHT - Math.max(0, Math.min(1, ratio / ceiling)) * SPARK_HEIGHT).toFixed(2);
    const line = [];
    const area = [];
    let open = false;
    geometry.x.forEach((range, index) => {
        if (!range) {
            open = false;
            return;
        }
        const left = range[0].toFixed(2);
        const right = range[1].toFixed(2);
        const top = y(ratios[index] ?? 0);
        if (open) {
            line.push(`L${left},${top}`);
            area.push(`L${left},${top}`);
        } else {
            line.push(`M${left},${top}`);
            area.push(`M${left},${base} L${left},${top}`);
            open = true;
        }
        line.push(`L${right},${top}`);
        area.push(`L${right},${top}`);
        const next = geometry.x[index + 1];
        // Anything other than the next bucket starting where this one ends is
        // the end of a run, so the fill is closed down to the baseline.
        if (!next || next[0] - range[1] > 1e-6) {
            area.push(`L${right},${base} Z`);
            open = false;
        }
    });
    return { line: line.join(" "), area: area.join(" ") };
}

/**
 * One small chart. The readout under it is driven by the pointer rather than
 * by a `title` per bucket: at 168 buckets a title per bucket would cost more
 * nodes than the chart itself, and the heatmap already carries that idiom.
 */
function sparkline(entry, geometry, ceiling, buckets) {
    const { row, cells, ratios, peak } = entry;
    const path = stepPath(geometry, ratios, ceiling);
    const idle = `${number(row.jobs)} jobs · busy ${duration(row.busyMs)} · peak ${percent(peak)}`;
    const readout = el("div", { class: "spark__read", text: idle });
    const marker = svgEl("line", { class: "spark__marker", x1: 0, x2: 0, y1: 0, y2: SPARK_HEIGHT, opacity: 0 });

    const track = (event) => {
        const box = event.currentTarget?.getBoundingClientRect?.();
        if (!box || box.width <= 0) {
            return;
        }
        const at = ((event.clientX - box.left) / box.width) * 100;
        const index = geometry.x.findIndex((range) => range && at >= range[0] && at <= range[1]);
        if (index < 0) {
            marker.setAttribute("opacity", "0");
            readout.textContent = idle;
            return;
        }
        const middle = ((geometry.x[index][0] + geometry.x[index][1]) / 2).toFixed(2);
        marker.setAttribute("x1", middle);
        marker.setAttribute("x2", middle);
        marker.setAttribute("opacity", "1");
        readout.textContent = `${timestamp(buckets[index].start)} · busy ${duration(cells[index])} (${percent(ratios[index])})`;
    };
    const leave = () => {
        marker.setAttribute("opacity", "0");
        readout.textContent = idle;
    };

    return el("div", { class: "spark__cell" }, [
        el("div", { class: "spark__head" }, [
            el("span", { class: "spark__name mono", text: row.runner, title: row.runner }),
            el("span", { class: "spark__total", text: duration(row.busyMs) }),
        ]),
        svgEl(
            "svg",
            {
                class: "spark__svg",
                viewBox: `0 0 100 ${SPARK_HEIGHT}`,
                preserveAspectRatio: "none",
                role: "img",
                "aria-label": `${row.runner}: ${idle}`,
                onpointermove: track,
                onpointerleave: leave,
            },
            [
                svgEl("path", { class: "spark__area", d: path.area }),
                // The viewBox is stretched to the card, so the stroke has to be
                // kept out of that scaling or it would be drawn as a wedge.
                svgEl("path", { class: "spark__line", d: path.line, "vector-effect": "non-scaling-stroke" }),
                marker,
            ],
        ),
        readout,
    ]);
}

/**
 * Small multiples of the per-runner busy ratio: one chart per runner, all on
 * the same axis and the same scale, so the charts can be compared by eye
 * instead of only within themselves.
 *
 * The scale control raises the ceiling shared by every chart rather than
 * normalising each one to its own peak, which would draw a runner that idles
 * at 3% exactly like one that saturates.
 */
function runnerSparklines(timeline, bucket) {
    const buckets = timeline.buckets;
    const { unnamed, shown } = selectRunners(timeline, sparkSort, sparkRows);
    if (shown.length === 0) {
        return noRunnerRows(unnamed);
    }
    const geometry = bucketGeometry(buckets);
    const series = shown.map((row) => {
        const cells = denseCells(row, buckets.length);
        const ratios = cells.map((ms, index) => {
            const bucket = geometry.parsed[index];
            return bucket.valid ? Math.min(1, ms / bucket.span) : 0;
        });
        return { row, cells, ratios, peak: ratios.length > 0 ? Math.max(...ratios) : 0 };
    });
    const highest = Math.max(0, ...series.map((entry) => entry.peak));
    // A fitted ceiling stays shared across the charts; it only stops a fleet
    // that never passes a few percent from reading as a flat line.
    const ceiling = sparkScale === "fit" ? Math.max(0.01, highest) : 1;

    return el("div", {}, [
        el(
            "div",
            { class: "spark" },
            series.map((entry) => sparkline(entry, geometry, ceiling, buckets)),
        ),
        el("div", { class: "chart__axis" }, [
            el("span", { text: timestamp(buckets[0]?.start) }),
            el("span", {
                text: `${runnerRowsLabel(timeline, shown)} · 0-${percent(ceiling)} of each ${bucketWidth(bucket)} bucket`,
            }),
            el("span", { text: timestamp(buckets.at(-1)?.end) }),
        ]),
        geometry.invalid > 0
            ? el("p", {
                  class: "notice notice--warn",
                  text: `${number(geometry.invalid)} buckets carry timestamps that do not describe a period and are drawn as a break in every chart.`,
              })
            : null,
        heatmapNote(timeline, unnamed),
    ]);
}

function kpi(label, value, hint) {
    return el("div", { class: "kpi" }, [
        el("div", { class: "kpi__label", text: label }),
        el("div", { class: "kpi__value", text: value }),
        hint ? el("div", { class: "kpi__hint", text: hint }) : null,
    ]);
}

/**
 * Sort keys are read back from the rendered cell so every table gets a working
 * sort without repeating an accessor per column. A column whose rendered text
 * does not describe its value, such as a date, carries an explicit `sort`.
 */
function cellText(value) {
    return value instanceof Node ? value.textContent : String(value ?? "");
}

const DURATION_PATTERN = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+)s)?$/;

function coerceSortKey(text) {
    const raw = text.trim();
    if (raw === "" || raw === "–") {
        return null;
    }
    const numeric = Number(raw.replace(/^\+/, "").replace(/[,%$]/g, ""));
    if (Number.isFinite(numeric)) {
        return numeric;
    }
    const parts = DURATION_PATTERN.exec(raw);
    if (parts && parts.slice(1).some(Boolean)) {
        return Number(parts[1] ?? 0) * 3600 + Number(parts[2] ?? 0) * 60 + Number(parts[3] ?? 0);
    }
    return raw.toLowerCase();
}

function sortKey(column, row) {
    if (column.sort) {
        const value = column.sort(row);
        return value === null || value === undefined || value === "" ? null : value;
    }
    return coerceSortKey(cellText(column.render(row)));
}

/** Rows without a value sort last whichever way the column points. */
function compareKeys(left, right) {
    if (left === null) {
        return right === null ? 0 : 1;
    }
    if (right === null) {
        return -1;
    }
    if (typeof left === "number" && typeof right === "number") {
        return left - right;
    }
    return String(left).localeCompare(String(right));
}

function sortedRows(rows, column, direction) {
    return rows
        .map((row, index) => ({ row, index, key: sortKey(column, row) }))
        .sort((left, right) => {
            const missing = (left.key === null ? 1 : 0) - (right.key === null ? 1 : 0);
            // A missing value stays at the bottom rather than following the
            // direction, so toggling a column never buries the populated rows.
            return missing || compareKeys(left.key, right.key) * direction || left.index - right.index;
        })
        .map((entry) => entry.row);
}

/**
 * Identifies a table across renders without threading an ID through all of the
 * call sites. Column labels are what the user clicks, so they also describe the
 * table well enough to key its sort state.
 */
function tableKey(columns) {
    return `${activeTab}:${columns.map((column) => column.label).join("|")}`;
}

function toggleSort(key, index, descendingFirst) {
    const current = tableSort.get(key);
    const first = descendingFirst ? -1 : 1;
    if (!current || current.index !== index) {
        // A measure or a date is most useful largest first, a name alphabetically.
        tableSort.set(key, { index, direction: first });
    } else if (current.direction === first) {
        tableSort.set(key, { index, direction: -first });
    } else {
        // Third click restores the order the report came in.
        tableSort.delete(key);
    }
    render();
}

/**
 * A table. `remote` switches sorting from the rows in hand to the caller: a
 * table that shows one page of a larger result cannot sort client-side, since
 * that would order the page rather than the result, which is a different and
 * wrong answer.
 */
function table(columns, rows, remote = null) {
    if (rows.length === 0) {
        return el("p", { class: "empty", text: "No data in this window." });
    }
    const key = tableKey(columns);
    const sort = remote ? null : tableSort.get(key);
    const active = sort ? columns[sort.index] : null;
    const ordered = active ? sortedRows(rows, active, sort.direction) : rows;

    return el("table", {}, [
        el("thead", {}, [
            el(
                "tr",
                {},
                columns.map((column, index) => {
                    // The bar columns have no heading and repeat the value of
                    // the column before them, so they are not sortable.
                    if (!column.label) {
                        return el("th", { class: column.num ? "num" : "" });
                    }
                    if (remote) {
                        if (!column.sortKey) {
                            return el("th", { class: column.num ? "num" : "" }, [el("span", { text: column.label })]);
                        }
                        const current = remote.key === column.sortKey ? (remote.direction === "asc" ? 1 : -1) : 0;
                        return el(
                            "th",
                            {
                                class: [column.num ? "num" : "", "th--sortable", current ? "th--sorted" : ""].filter(Boolean).join(" "),
                                title: `Sort every match by ${column.label}`,
                                onclick: () => remote.onSort(column.sortKey, Boolean(column.num)),
                            },
                            [
                                el("span", { text: column.label }),
                                el("span", { class: "th__arrow", text: current === 0 ? "" : current > 0 ? "▲" : "▼" }),
                            ],
                        );
                    }
                    const current = sort?.index === index ? sort.direction : 0;
                    return el(
                        "th",
                        {
                            class: [column.num ? "num" : "", "th--sortable", current ? "th--sorted" : ""].filter(Boolean).join(" "),
                            title: `Sort by ${column.label}`,
                            onclick: () => toggleSort(key, index, Boolean(column.num || column.sort)),
                        },
                        [
                            el("span", { text: column.label }),
                            el("span", { class: "th__arrow", text: current === 0 ? "" : current > 0 ? "▲" : "▼" }),
                        ],
                    );
                }),
            ),
        ]),
        el(
            "tbody",
            {},
            ordered.map((row) =>
                el(
                    "tr",
                    {},
                    columns.map((column) => {
                        const value = column.render(row);
                        const cellClass = [column.num ? "num" : "", column.wrap ? "wrap" : ""].filter(Boolean).join(" ");
                        return el("td", { class: cellClass }, value instanceof Node ? [value] : [String(value)]);
                    }),
                ),
            ),
        ),
    ]);
}

/* ---------- tabs ---------- */

/**
 * Self-hosted activity broken down by repository, as reported by
 * `gh runner-kit metrics repository`.
 *
 * The report has no runner-type switch: it is always built from the self-hosted
 * jobs alone, so `Runs` counts the runs that put at least one job on a
 * self-hosted runner rather than every run of the repository. An organization
 * whose repositories all build on GitHub-hosted runners therefore gets a table
 * of zeros, which is reported as an empty state instead.
 */
function selfHostedRepositoryCard(fleet, orgWide, owner) {
    if (!orgWide || !fleet.available) {
        return null;
    }
    const rows = fleet.repositories;
    const caption =
        "Reported by gh runner-kit metrics repository, which is always built from self-hosted jobs alone. Runs counts the runs that placed at least one job on a self-hosted runner, not every run of the repository.";
    if (rows === null) {
        return card(
            "Self-hosted activity by repository",
            [el("p", { class: "notice", text: "The per-repository report did not run. See the collection warnings above." })],
            caption,
        );
    }
    const active = rows.filter((row) => row.jobs > 0);
    if (active.length === 0) {
        return card(
            "Self-hosted activity by repository",
            [
                el("p", {
                    class: "notice",
                    text:
                        rows.length === 0
                            ? "No repository reported any self-hosted job in this window."
                            : `None of the ${number(rows.length)} repositories in this window placed a job on a self-hosted runner.`,
                }),
            ],
            caption,
        );
    }
    return card(
        "Self-hosted activity by repository",
        [
            table(
                [
                    { label: "Repository", wrap: true, render: (row) => repoName(row.repository, owner) },
                    { label: "Runs", num: true, render: (row) => number(row.runs) },
                    { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                    { label: "", render: (row) => bar(row.jobs, Math.max(1, ...active.map((item) => item.jobs))) },
                    { label: "Success", num: true, render: (row) => (row.decided === 0 ? "—" : healthPill(1 - row.failureRate)) },
                    { label: "Failed", num: true, render: (row) => `${number(row.failed)} / ${number(row.decided)}` },
                    { label: "Retried", num: true, render: (row) => percent(row.retryRate) },
                    { label: "Busy", num: true, render: (row) => duration(row.busyTimeMs) },
                    { label: "Last job", sort: (row) => row.lastJobAt, render: (row) => timestamp(row.lastJobAt) },
                ],
                active,
            ),
        ],
        caption,
    );
}

function renderOverview(metrics) {
    const overview = metrics.overview;
    const fleet = metrics.fleet;
    const orgWide = metrics.meta.scope === "org";
    const workflowRows = fleet?.available ? fleet.workflows : [];
    const maxDaily = Math.max(1, ...overview.daily.map((day) => day.total));

    const chart = el("div", {}, [
        el(
            "div",
            { class: "chart" },
            overview.daily.map((day) =>
                el(
                    "div",
                    { class: "chart__col", title: `${day.date}: ${day.total} runs (${day.failure} failed)` },
                    ["success", "failure", "cancelled", "other"].map((key) =>
                        day[key] > 0
                            ? el("div", {
                                  class: `chart__seg chart__seg--${key}`,
                                  style: `height:${((day[key] / maxDaily) * 100).toFixed(2)}%`,
                              })
                            : null,
                    ),
                ),
            ),
        ),
        el("div", { class: "chart__axis" }, [
            el("span", { text: overview.daily[0]?.date ?? "" }),
            el("span", { text: overview.daily.at(-1)?.date ?? "" }),
        ]),
        el(
            "div",
            { class: "legend" },
            [
                ["success", "Success"],
                ["failure", "Failure"],
                ["cancelled", "Cancelled"],
                ["other", "Other / running"],
            ].map(([key, label]) =>
                el("span", {}, [el("span", { class: `legend__swatch chart__seg--${key}` }), label]),
            ),
        ),
    ]);

    const maxWorkflowRuns = Math.max(1, ...overview.byWorkflow.map((row) => row.runs));
    // A failed collection must not render as a confident zero.
    const runsUnavailable = metrics.meta.runs?.available === false;

    return [
        orgWideNotice(orgWide),
        runsUnavailable
            ? el("p", {
                  class: "notice",
                  text: `Workflow runs could not be collected: ${metrics.meta.runs.reason ?? "unknown error"}. The run-derived cards are left out rather than reported as zero.`,
              })
            : null,
        runsUnavailable
            ? null
            : el("div", { class: "kpis" }, [
            kpi("Runs", number(overview.totals.runs), orgWide ? "across every repository" : `${number(overview.totals.jobs)} jobs analysed`),
            kpi("Success rate", percent(overview.successRate), `${number(overview.totals.completedRuns)} completed`),
            // Run duration and job queue are measured from the jobs of each
            // run, which are collected one repository at a time.
            ...(orgWide
                ? []
                : [
                      kpi("Run duration p50", duration(overview.duration.p50), `p95 ${duration(overview.duration.p95)}`),
                      kpi("Job queue p50", duration(overview.jobQueue.p50), `p95 ${duration(overview.jobQueue.p95)}`),
                  ]),
            kpi("Retried runs", number(overview.totals.retriedRuns), "run_attempt > 1"),
            kpi("In progress", number(overview.totals.inProgressRuns), "at collection time"),
              ]),
        runsUnavailable ? null : card("Runs per day", [chart]),
        selfHostedRepositoryCard(fleet, orgWide, metrics.meta.target?.owner),
        workflowRows.length > 0
            ? card(
                  "Workflows",
                  [
                      table(
                          [
                              // Only under an organization: the rows are keyed
                              // per repository, so two repositories with a `ci`
                              // workflow are two lines with the same name.
                              ...(orgWide
                                  ? [
                                        {
                                            label: "Repository",
                                            wrap: true,
                                            render: (row) => repoName(row.repository, metrics.meta.target?.owner),
                                        },
                                    ]
                                  : []),
                              { label: "Workflow", render: (row) => row.workflow, wrap: true },
                              { label: "Runs", num: true, render: (row) => number(row.runs) },
                              { label: "", render: (row) => bar(row.runs, Math.max(1, ...workflowRows.map((item) => item.runs))) },
                              { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                              {
                                  label: "Success",
                                  num: true,
                                  // `decided` counts the jobs that reached a
                                  // verdict. At zero the rate is arithmetically
                                  // 0, which would render as a perfect 100%
                                  // success for a workflow nobody can judge.
                                  // A build that predates the field reports
                                  // null, and keeps the old rendering.
                                  render: (row) => (row.decided === 0 ? "—" : healthPill(1 - row.failureRate)),
                              },
                              {
                                  label: "Failed",
                                  num: true,
                                  render: (row) => (row.failed === null ? "—" : `${number(row.failed)} / ${number(row.decided)}`),
                              },
                              { label: "Retried", num: true, render: (row) => percent(row.retryRate) },
                              { label: "Wait p50", num: true, render: (row) => duration(row.waitP50Ms) },
                              { label: "p50", num: true, render: (row) => duration(row.durationP50Ms) },
                              { label: "p95", num: true, render: (row) => duration(row.durationP95Ms) },
                              { label: "Busy", num: true, render: (row) => duration(row.busyTimeMs) },
                          ],
                          workflowRows,
                      ),
                  ],
                  "Reported by gh runner-kit metrics workflow. Failed counts the jobs that failed out of the ones that reached a verdict, so cancelled and skipped jobs count as neither, and Retried is the share of runs restarted at least once. A workflow whose jobs never reached a verdict shows no success rate.",
                  checkboxControl("Self-hosted only", Boolean(fleet.selfHostedOnly), (checked) =>
                      applyFilters({ selfHostedOnly: checked }),
                  ),
              )
            : card(
                  "Workflows",
                  [
                      fleetNotice(fleet),
                      table(
                          [
                              ...(orgWide
                                  ? [
                                        {
                                            label: "Repository",
                                            wrap: true,
                                            render: (row) => repoName(row.repository, metrics.meta.target?.owner),
                                        },
                                    ]
                                  : []),
                              { label: "Workflow", render: (row) => row.name, wrap: true },
                              { label: "Runs", num: true, render: (row) => number(row.runs) },
                              { label: "", render: (row) => bar(row.runs, maxWorkflowRuns) },
                              { label: "Success", num: true, render: (row) => healthPill(row.successRate) },
                              { label: "Failures", num: true, render: (row) => number(row.failures) },
                              // Measured from the jobs of each run, which an
                              // organization target does not collect.
                              ...(orgWide
                                  ? []
                                  : [
                                        { label: "p50", num: true, render: (row) => duration(row.p50DurationMs) },
                                        { label: "p95", num: true, render: (row) => duration(row.p95DurationMs) },
                                    ]),
                          ],
                          overview.byWorkflow,
                      ),
                  ],
              ),
        orgWide ? null : card(
            "Most failing jobs",
            [
                table(
                    [
                        { label: "Job", render: (row) => row.name, wrap: true },
                        { label: "Runs", num: true, render: (row) => number(row.runs) },
                        { label: "Failures", num: true, render: (row) => number(row.failures) },
                        { label: "Failure rate", num: true, render: (row) => percent(row.failureRate) },
                        { label: "p50", num: true, render: (row) => duration(row.p50DurationMs) },
                        { label: "Queue p50", num: true, render: (row) => duration(row.p50QueueMs) },
                    ],
                    overview.byJob,
                ),
            ],
            metrics.meta.jobCoverageRuns < overview.totals.runs
                ? `Job-level metrics cover the ${number(metrics.meta.jobCoverageRuns)} runs that reported jobs, out of ${number(overview.totals.runs)} in the window.`
                : `Job-level metrics cover all ${number(overview.totals.runs)} runs in the window.`,
        ),
        // Slowest runs needs a run duration, which is measured from the jobs of
        // each run and so exists only for a repository target.
        orgWide ? null : card(
            "Slowest runs",
            [
                table(
                    [
                        {
                            label: "Run",
                            wrap: true,
                            render: (row) =>
                                row.url
                                    ? el("a", { href: row.url, target: "_blank", rel: "noreferrer", text: `${row.name} #${row.runNumber}` })
                                    : `${row.name} #${row.runNumber}`,
                        },
                        { label: "Branch", render: (row) => row.branch ?? "–" },
                        { label: "Result", render: (row) => row.conclusion ?? "–" },
                        { label: "Duration", num: true, render: (row) => duration(row.durationMs) },
                    ],
                    overview.slowest,
                ),
            ],
        ),
        runsUnavailable ? null : card(
            "Trigger events",
            [
                table(
                    [
                        { label: "Event", render: (row) => row.event },
                        { label: "Runs", num: true, render: (row) => number(row.runs) },
                        { label: "Success", num: true, render: (row) => healthPill(row.successRate) },
                    ],
                    overview.byEvent,
                ),
            ],
        ),
        collectionSettingsCard(),
    ];
}

/**
 * How much the dashboard collects, and how fast. Both were fixed in the code
 * until now, which made a window that took half an hour look like the only
 * way to read it.
 */
function collectionSettingsCard() {
    const filters = state?.filters ?? {};
    const maxRuns = filters.maxRuns ?? 0;
    return settingsCard(
        "settings-collection",
        "Collection settings",
        [
            el("div", { class: "controls" }, [
                numberControl(
                    "setting-max-runs",
                    "Max runs",
                    maxRuns,
                    { min: 0, max: 1000000, hint: "gh runner-kit metrics --max-runs. 0 reads every run in the window." },
                    (value) => applyFilters({ maxRuns: value }),
                ),
                numberControl(
                    "setting-concurrency",
                    "Concurrency",
                    filters.jobConcurrency ?? 6,
                    { min: 1, max: 20, hint: "gh runner-kit metrics --concurrency. Applies to the next collection." },
                    (value) => applyFilters({ jobConcurrency: value }),
                ),
            ]),
            el("p", {
                class: "notice",
                text:
                    maxRuns > 0
                        ? `Reading at most ${number(maxRuns)} workflow runs per repository, so every repository describes only its most recent ${number(maxRuns)} runs rather than the whole window.`
                        : "Reading every workflow run in the window, which is what the numbers on this tab describe.",
            }),
        ],
        "Max runs changes what is collected, so it collects again; over a busy organization that is minutes. Concurrency only changes how fast the requests go out, so it waits for the next collection rather than starting one - press Refresh to use it now.",
    );
}

function renderRunners(metrics) {
    const orgWide = metrics.meta.scope === "org";
    const runners = metrics.runners;
    const summary = runners.summary;
    const fleet = metrics.fleet;
    const fleetSummary = fleet?.summary;
    const maxRunnerMinutes = Math.max(1, ...runners.byRunner.map((row) => row.minutes));
    const fleetRunners = (fleet?.runners ?? []).filter(matchesRunnerQuery);
    const maxBusyMs = Math.max(1, ...fleetRunners.map((row) => row.busyTimeMs ?? 0));

    return [
        orgWideNotice(orgWide),
        fleetSummary
            ? el("div", { class: "kpis" }, [
                  kpi(
                      "Registered runners",
                      number(fleetSummary.runners),
                      `${number(fleetSummary.online)} online · ${number(fleetSummary.cordoned)} cordoned`,
                  ),
                  kpi("Self-hosted jobs", number(fleetSummary.jobs), `${number(fleetSummary.hostedJobs)} on GitHub-hosted`),
                  kpi("Utilization", percent(fleetSummary.utilization), `busy ${duration(fleetSummary.busyTimeMs)}`),
                  kpi("Failure rate", percent(fleetSummary.failureRate), `${number(fleetSummary.runs)} runs analysed`),
                  kpi("Wait p95", duration(fleetSummary.waitP95Ms), `p50 ${duration(fleetSummary.waitP50Ms)}`),
                  kpi("Peak concurrency", number(fleetSummary.peakConcurrency), `job p95 ${duration(fleetSummary.durationP95Ms)}`),
              ])
            : orgWide
              ? null
              : el("div", { class: "kpis" }, [
                  kpi("Registered runners", number(summary.total), `${summary.repository} repo / ${summary.organization} org`),
                  kpi("Online", number(summary.online), `${number(summary.offline)} offline`),
                  kpi("Busy", number(summary.busy), `${number(summary.idle)} idle`),
                  kpi("Cordoned", number(summary.cordoned), "gh runner-kit cordon"),
                  kpi("Self-hosted jobs", number(runners.split.selfHosted.jobs), `${number(runners.split.selfHosted.minutes)} min`),
                  kpi(
                      "Self-hosted queue p95",
                      duration(runners.split.selfHosted.p95QueueMs),
                      `p50 ${duration(runners.split.selfHosted.p50QueueMs)}`,
                  ),
              ]),
        fleetSummary?.truncated
            ? el("p", { class: "notice", text: "gh runner-kit reached --max-runs, so the fleet numbers cover only part of the window." })
            : null,
        fleet?.available
            ? card(
                  "Runner busy time",
                  [runnerBusyChart(fleetRunners, fleet.groupBy)],
                  `Reported by gh runner-kit metrics runner, grouped by ${fleet.groupBy}. The bar is how long the row was occupied over the whole window and the trailing figure is that time divided by the window, so a runner registered halfway through never reaches 100%. Cordoned rows are drawn in the warning colour.`,
                  el("div", { class: "controls" }, [runnerQueryControl(`filter by ${fleet.groupBy}`), groupByControl(fleet)]),
              )
            : null,
        card(
            "Runner registrations",
            [
                table(
                    [
                        { label: "Name", render: (row) => row.name, wrap: true },
                        { label: "Scope", render: (row) => row.scope },
                        { label: "OS", render: (row) => row.os ?? "–" },
                        {
                            label: "Status",
                            render: (row) =>
                                el("span", {
                                    class: `pill pill--${row.status === "online" ? "ok" : "bad"}`,
                                    text: row.status ?? "unknown",
                                }),
                        },
                        { label: "Busy", render: (row) => (row.busy ? "yes" : "no") },
                        {
                            label: "Cordoned",
                            render: (row) =>
                                row.cordoned
                                    ? el("span", {
                                          class: "pill pill--warn",
                                          text: row.cordonedFromGroup ? `yes (${row.cordonedFromGroup})` : "yes",
                                      })
                                    : "no",
                        },
                        { label: "Labels", wrap: true, render: (row) => el("span", { class: "mono", text: row.labels.join(", ") }) },
                    ],
                    runners.registered,
                ),
            ],
            summary.total === 0
                ? "No self-hosted runner is visible with the current token permissions."
                : "Read from the runner API, which reports the fleet as it is right now because it keeps no history.",
            fleet?.available ? runnerTypeControl(fleet, orgWide) : null,
        ),
        card(
            "Runner activity",
            [
                fleet?.available
                    ? table(
                          [
                              { label: "Key", wrap: true, render: (row) => el("span", { class: "mono", text: row.key }) },
                              {
                                  label: "Status",
                                  render: (row) =>
                                      row.status
                                          ? el("span", { class: `pill pill--${row.status === "online" ? "ok" : "bad"}`, text: row.status })
                                          : "–",
                              },
                              {
                                  label: "Cordoned",
                                  render: (row) => (row.cordoned ? el("span", { class: "pill pill--warn", text: "yes" }) : "no"),
                              },
                              { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                              { label: "Busy", num: true, render: (row) => duration(row.busyTimeMs) },
                              { label: "", render: (row) => bar(row.busyTimeMs ?? 0, maxBusyMs) },
                              { label: "Util", num: true, render: (row) => percent(row.utilization) },
                              { label: "Fail", num: true, render: (row) => percent(row.failureRate) },
                              { label: "Wait p50", num: true, render: (row) => duration(row.waitP50Ms) },
                              { label: "Job p50", num: true, render: (row) => duration(row.durationP50Ms) },
                              { label: "Last job", sort: (row) => row.lastJobAt, render: (row) => timestamp(row.lastJobAt) },
                          ],
                          fleetRunners,
                      )
                    : el("div", {}, [
                          fleetNotice(fleet),
                          table(
                              [
                                  { label: "Runner", wrap: true, render: (row) => row.runner },
                                  { label: "Registered", render: (row) => (row.registered ? "yes" : "no") },
                                  { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                                  { label: "Minutes", num: true, render: (row) => number(row.minutes) },
                                  { label: "", render: (row) => bar(row.minutes, maxRunnerMinutes) },
                                  { label: "Failures", num: true, render: (row) => number(row.failures) },
                                  { label: "Job p50", num: true, render: (row) => duration(row.p50DurationMs) },
                              ],
                              runners.byRunner,
                          ),
                      ]),
            ],
            fleet?.available
                ? "Reported by gh runner-kit metrics runner. Rows without jobs are idle or cordoned capacity, and GitHub-hosted jobs are excluded. The Filter box on the busy time card narrows these rows as well."
                : "Built-in aggregation. GitHub-hosted runners are excluded because their names are ephemeral per-job identifiers.",
            fleet?.available ? groupByControl(fleet) : null,
        ),
        fleet?.available && fleet.labels.length > 0
            ? card(
                  "Label supply and demand",
                  [
                      table(
                          [
                              { label: "Label", wrap: true, render: (row) => el("span", { class: "mono", text: row.label }) },
                              { label: "Status", render: (row) => labelStatusPill(row.status) },
                              { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                              { label: "Runners", num: true, render: (row) => number(row.runners) },
                              { label: "Wait p50", num: true, render: (row) => duration(row.waitP50Ms) },
                              { label: "Wait p95", num: true, render: (row) => duration(row.waitP95Ms) },
                              { label: "Last job", sort: (row) => row.lastJobAt, render: (row) => timestamp(row.lastJobAt) },
                          ],
                          fleet.labels,
                      ),
                  ],
                  "Reported by gh runner-kit metrics label. An orphan label is requested by jobs that no runner can serve; an unused label is carried by a runner nothing asked for, which usually means a typo or a label that outlived its workflow. Runners is the current inventory, because the API keeps no label history.",
              )
            : orgWide
              ? card("Runner labels", [fleetNotice(fleet)])
              : card("Runner labels", [
                  fleetNotice(fleet),
                  table(
                      [
                          { label: "Label", render: (row) => el("span", { class: "mono", text: row.label }) },
                          { label: "Runners", num: true, render: (row) => number(row.runners) },
                      ],
                      runners.byLabel,
                  ),
              ]),
    ];
}

function renderQueue(metrics) {
    const orgWide = metrics.meta.scope === "org";
    const fleet = metrics.fleet;
    const rows = fleet?.queue ?? [];
    const timeline = fleet?.concurrency ?? [];
    const worstWaitMs = rows.length > 0 ? Math.max(...rows.map((row) => row.waitP95Ms ?? 0)) : null;
    const worstSaturation = rows.length > 0 ? Math.max(...rows.map((row) => row.saturation ?? 0)) : null;
    const undersized = rows.filter((row) => (row.saturation ?? 0) > 1).length;
    const busiest = timeline.length > 0 ? timeline.reduce((best, row) => (row.peak > best.peak ? row : best)) : null;
    const capacity = fleet?.capacity ?? [];
    const missing = capacity.reduce((sum, row) => sum + Math.max(0, row.delta), 0);

    return [
        orgWideNotice(orgWide),
        el("div", { class: "kpis" }, [
            kpi("Label sets", number(rows.length), "self-hosted runs-on combinations"),
            kpi("Worst wait p95", duration(worstWaitMs), "across all label sets"),
            kpi("Max saturation", Number.isFinite(worstSaturation) ? worstSaturation.toFixed(2) : "–", "peak jobs / matching runners"),
            kpi("Undersized pools", number(undersized), "saturation above 1.00"),
            kpi("Busiest bucket", busiest ? `${number(busiest.peak)} jobs` : "–", busiest ? timestamp(busiest.start) : "no timeline"),
            kpi(
                "Runners to add",
                capacity.length > 0 ? `+${number(missing)}` : "–",
                capacity.length > 0 ? `for a ${fleet.targetWait} mean queue time` : "no sizing",
            ),
        ]),
        capacity.length > 0
            ? card(
                  "Recommended pool size",
                  [
                      table(
                          [
                              { label: "Labels", wrap: true, render: (row) => el("span", { class: "mono", text: row.labelSet }) },
                              { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                              { label: "Arrivals / h", num: true, render: (row) => row.arrivalPerHour.toFixed(2) },
                              { label: "Avg job", num: true, render: (row) => duration(row.avgDurationMs) },
                              { label: "Load", num: true, render: (row) => row.load.toFixed(2) },
                              { label: "Runners", num: true, render: (row) => number(row.runners) },
                              { label: "Recommended", num: true, render: (row) => number(row.recommended) },
                              { label: "Delta", num: true, render: (row) => deltaPill(row.delta) },
                              { label: "Est wait", num: true, render: (row) => duration(row.estimatedWaitMs) },
                              { label: "Wait p95", num: true, render: (row) => duration(row.observedWaitP95Ms) },
                          ],
                          capacity,
                      ),
                  ],
                  `Reported by gh runner-kit metrics capacity, sized for a ${fleet.targetWait} mean queue time at ${percent(fleet.targetUtilization)} utilization. Load is the offered load in Erlangs, the runners the label set kept busy on average. The M/M/c model assumes jobs arrive independently, so a scheduled burst or a fan-out inside one workflow breaks it: compare Est wait against the measured Wait p95 before acting on Delta.`,
                  el("div", { class: "controls" }, [
                      selectControl("Target wait", ["15s", "30s", "1m", "2m", "5m", "10m", "30m"], fleet.targetWait, (value) =>
                          applyFilters({ targetWait: value }),
                      ),
                      selectControl(
                          "Max utilization",
                          [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((value) => ({ value: String(value), label: percent(value) })),
                          String(fleet.targetUtilization),
                          (value) => applyFilters({ targetUtilization: Number(value) }),
                      ),
                  ]),
              )
            : null,
        card(
            "Runner busy time over time",
            [fleetNotice(fleet) ?? concurrencyChart(timeline, fleet.bucket, chartMetric)],
            "Reported by gh runner-kit metrics concurrency. Peak jobs is the highest number of jobs running at the same instant inside the bucket, and columns reaching the capacity line mean the fleet ran out of runners. Busy time sums how long the runners were occupied inside the bucket, and utilization divides that by the capacity the inventory offered, so both stay flat when the fleet idles through a peak. This chart always describes the whole fleet; the Runner activity tab rebuilds it from the jobs of one runner, or of a matched family of them.",
            fleet?.available
                ? el("div", { class: "controls" }, [
                      selectControl(
                          "Series",
                          Object.entries(CHART_METRICS).map(([value, entry]) => ({ value, label: entry.label })),
                          chartMetric,
                          (value) => {
                              chartMetric = value;
                              render();
                          },
                      ),
                      selectControl(
                          "Bucket",
                          [{ value: "auto", label: `auto (${fleet.bucket})` }, "15m", "30m", "1h", "3h", "6h", "12h", "24h"],
                          state?.filters?.bucket ?? "auto",
                          (value) => applyFilters({ bucket: value }),
                      ),
                  ])
                : null,
        ),
        card(
            "Queue time by runs-on label set",
            [
                fleetNotice(fleet) ??
                    table(
                        [
                            { label: "Labels", wrap: true, render: (row) => el("span", { class: "mono", text: row.labelSet }) },
                            { label: "Kind", render: (row) => row.kind || "–" },
                            { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                            { label: "Wait p50", num: true, render: (row) => duration(row.waitP50Ms) },
                            { label: "Wait p95", num: true, render: (row) => duration(row.waitP95Ms) },
                            { label: "Wait max", num: true, render: (row) => duration(row.waitMaxMs) },
                            { label: "Runners", num: true, render: (row) => number(row.runners) },
                            { label: "Peak", num: true, render: (row) => number(row.peakConcurrency) },
                            { label: "Saturation", num: true, render: (row) => saturationPill(row.saturation) },
                        ],
                        rows,
                    ),
            ],
            "Reported by gh runner-kit metrics queue. Saturation above 1.00 with a high wait p95 means the pool asked for more runners than it has; a low saturation with a high wait points at needs dependencies or concurrency groups instead.",
        ),
        orgWide ? null : card(
            "Label demand vs capacity (all jobs)",
            [
                table(
                    [
                        { label: "Requested labels", wrap: true, render: (row) => el("span", { class: "mono", text: row.labelSet }) },
                        { label: "Type", render: (row) => (row.selfHosted ? "self-hosted" : "GitHub-hosted") },
                        { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                        { label: "Minutes", num: true, render: (row) => number(row.minutes) },
                        { label: "Matching runners", num: true, render: (row) => number(row.matchingRunners) },
                        { label: "Queue p50", num: true, render: (row) => duration(row.p50QueueMs) },
                        { label: "Queue p95", num: true, render: (row) => duration(row.p95QueueMs) },
                    ],
                    metrics.runners.demand,
                ),
            ],
            "Built-in aggregation; unlike the table above it also covers the GitHub-hosted label sets.",
        ),
    ];
}

/**
 * The runner table of a projection, searched over every runner it observed.
 *
 * The chart and the two cards below it are built from the busiest 40 runners,
 * because a chart of 18000 rows is not a chart. The table is the one place the
 * rest of them are reachable, so its search runs in the extension against the
 * whole ranking and returns one page.
 */
function runnerFilterCard(traced) {
    const projection = traced.projectionId ?? null;
    if (projection && runnerFilterProjection !== projection) {
        // A new projection is a new set of runners; carrying the old page or
        // offset across would show rows from a window that is gone.
        runnerFilterProjection = projection;
        runnerFilterPage = null;
        runnerFilterOffset = 0;
        runnerFilterError = null;
        requestRunnerPage({ immediate: true });
    }

    const results = el("div", { class: "table-region" }, runnerFilterResults(traced));
    runnerFilterRegion = results;

    return card(
        `Runners · ${traced.pattern || "every runner"}`,
        [results],
        `Searches every one of the ${number(traced.observedRunners ?? 0)} runner names this projection observed, not just the ${number(traced.runners?.length ?? 0)} the charts draw. Sorting a column sorts every match and not only the page shown. Busy time merges jobs that overlapped on one runner; job time is their plain sum, and Share is a share of the window's job time, which is what the job times add up to.`,
        el("div", { class: "controls" }, [
            el("label", { class: "inline-field" }, [
                el("span", { text: "Search" }),
                el("input", {
                    id: "runner-filter",
                    type: "search",
                    value: runnerFilterQuery,
                    placeholder: "any part of a name",
                    spellcheck: "false",
                    oninput: (event) => {
                        runnerFilterQuery = event.target.value;
                        runnerFilterOffset = 0;
                        syncRunnerFilterClear();
                        requestRunnerPage();
                    },
                }),
            ]),
            // Always rendered rather than conditional on the query: only the
            // rows region is repainted as a search settles, so a button that
            // appeared with the first keystroke would not appear until some
            // unrelated render happened to rebuild these controls.
            el("button", {
                type: "button",
                class: "ghost",
                text: "Clear",
                id: "runner-filter-clear",
                disabled: runnerFilterQuery === "" ? "disabled" : null,
                onclick: () => {
                    runnerFilterQuery = "";
                    runnerFilterOffset = 0;
                    const field = document.getElementById("runner-filter");
                    if (field) {
                        field.value = "";
                    }
                    syncRunnerFilterClear();
                    requestRunnerPage({ immediate: true });
                },
            }),
        ]),
    );
}

/** The rows region of the runner table, repainted alone as a search settles. */
function runnerFilterResults(traced) {
    if (runnerFilterError) {
        return [el("p", { class: "notice", text: runnerFilterError })];
    }
    const page = runnerFilterPage;
    if (!page) {
        return [el("p", { class: "empty", text: "Searching…" })];
    }
    if (page.rows.length === 0) {
        return [el("p", { class: "empty", text: `No runner name contains ${page.query}.` })];
    }

    const showsJobTime = page.rows.some((row) => Math.round(row.jobMs) !== Math.round(row.busyMs));
    const columns = [
        {
            label: "Runner",
            wrap: true,
            sortKey: "runner",
            render: (row) =>
                el("span", {
                    class: "mono",
                    text: row.runner,
                    title: row.unidentified
                        ? "Every job whose runner the API did not name, aggregated: this row is not one machine."
                        : null,
                }),
        },
        { label: "Jobs", num: true, sortKey: "jobs", render: (row) => number(row.jobs) },
        { label: "Busy time", num: true, sortKey: "busyMs", render: (row) => duration(row.busyMs) },
        // Only worth a column when a runner ran jobs that overlapped, which is
        // the case the merged busy time hides.
        ...(showsJobTime ? [{ label: "Job time", num: true, sortKey: "jobMs", render: (row) => duration(row.jobMs) }] : []),
        {
            label: "Share",
            num: true,
            render: (row) => percent(traced.busyTimeMs > 0 ? row.jobMs / traced.busyTimeMs : 0),
        },
    ];

    const to = Math.min(page.offset + page.rows.length, page.matched);

    return [
        table(columns, page.rows, {
            key: page.sort,
            direction: page.direction,
            onSort: (sortKey, descendingFirst) => {
                if (runnerFilterSort === sortKey) {
                    runnerFilterDirection = runnerFilterDirection === "asc" ? "desc" : "asc";
                } else {
                    runnerFilterSort = sortKey;
                    runnerFilterDirection = descendingFirst ? "desc" : "asc";
                }
                runnerFilterOffset = 0;
                requestRunnerPage({ immediate: true });
            },
        }),
        el("div", { class: "controls" }, [
            el("span", {
                class: "control-note",
                text:
                    page.matched === page.observed
                        ? `${number(page.offset + 1)}–${number(to)} of ${number(page.matched)} runners.`
                        : `${number(page.offset + 1)}–${number(to)} of ${number(page.matched)} matching, out of ${number(page.observed)} observed.`,
            }),
            page.offset > 0
                ? el("button", {
                      type: "button",
                      class: "ghost",
                      text: "Previous",
                      onclick: () => {
                          runnerFilterOffset = Math.max(0, runnerFilterOffset - RUNNER_PAGE_SIZE);
                          requestRunnerPage({ immediate: true });
                      },
                  })
                : null,
            to < page.matched
                ? el("button", {
                      type: "button",
                      class: "ghost",
                      text: "Next",
                      onclick: () => {
                          runnerFilterOffset += RUNNER_PAGE_SIZE;
                          requestRunnerPage({ immediate: true });
                      },
                  })
                : null,
        ]),
    ];
}

/** Keep the Clear button in step with the field without a full render. */
function syncRunnerFilterClear() {
    const button = document.getElementById("runner-filter-clear");
    if (!button) {
        return;
    }
    if (runnerFilterQuery === "") {
        button.setAttribute("disabled", "");
    } else {
        button.removeAttribute("disabled");
    }
}

/**
 * Ask the extension for a page of runners.
 *
 * Debounced, because a keystroke must not be a request; aborted, because an
 * in-flight one is about a query the reader has already moved past; sequenced
 * and checked against the projection, because a slow answer must not paint
 * rows from a trace the panel is no longer showing.
 */
function requestRunnerPage({ immediate = false } = {}) {
    clearTimeout(runnerFilterTimer);
    // Invalidated here rather than when the timer fires. Between a keystroke
    // and the debounce settling, a response to the *previous* query would
    // otherwise still carry the current sequence number and paint itself under
    // the new text.
    runnerFilterAbort?.abort();
    runnerFilterAbort = null;
    const seq = (runnerFilterSeq += 1);
    const fire = () => {
        const projection = runnerFilterProjection;
        if (seq !== runnerFilterSeq || !projection) {
            return;
        }
        const controller = new AbortController();
        runnerFilterAbort = controller;
        const params = new URLSearchParams({
            projection,
            q: runnerFilterQuery.trim(),
            sort: runnerFilterSort,
            direction: runnerFilterDirection,
            limit: String(RUNNER_PAGE_SIZE),
            offset: String(runnerFilterOffset),
        });
        void fetch(`./api/runners?${params}`, { signal: controller.signal })
            .then(async (response) => {
                const body = await response.json();
                if (!response.ok) {
                    throw new Error(body?.error ?? `The runner list could not be read (${response.status}).`);
                }
                return body;
            })
            .then((page) => {
                // A newer request, or a newer projection, owns the table now.
                if (seq !== runnerFilterSeq || page.projectionId !== runnerFilterProjection) {
                    return;
                }
                runnerFilterPage = page;
                runnerFilterError = null;
                repaintRunnerFilter();
            })
            .catch((error) => {
                if (error?.name === "AbortError" || seq !== runnerFilterSeq) {
                    return;
                }
                runnerFilterPage = null;
                runnerFilterError = error?.message ?? String(error);
                repaintRunnerFilter();
            });
    };
    if (immediate) {
        fire();
    } else {
        runnerFilterTimer = setTimeout(fire, 200);
    }
}

/**
 * Repaint the rows alone. A full render would rebuild the charts above, which
 * a search over the table has not changed, and would cost the reader their
 * scroll position on every keystroke.
 */
function repaintRunnerFilter() {
    const traced = state?.timeline;
    if (!runnerFilterRegion || !traced || !runnerFilterRegion.isConnected) {
        render();
        return;
    }
    runnerFilterRegion.replaceChildren(...runnerFilterResults(traced).filter(Boolean));
}

/**
 * Everything that comes out of a projection, on its own tab.
 *
 * The aggregate reports are collected for the whole dashboard; these are read
 * on request, against one runner or one family of them, so they belong
 * together and behind one control rather than scattered through the fleet
 * cards they are not comparable with.
 */
function renderActivity(metrics) {
    const fleet = metrics.fleet;
    const traced = state?.timeline ?? null;
    const label = traced ? traced.pattern || "every runner" : "";
    const drawn = Boolean(traced) && traced.matched > 0;
    const busiest = drawn ? traced.runners.find((row) => !row.unidentified) ?? null : null;
    // A projection carries no runner inventory, so utilization - which divides
    // by it - is not offered here at all.
    const metric = traceMetric === "utilization" ? "peak" : traceMetric;

    if (!fleet?.available) {
        // Nothing to project onto, so the trace control is left out rather
        // than offered and rejected - but an error raised by the agent action
        // still has to reach the reader somewhere.
        return [
            orgWideNotice(metrics.meta.scope === "org"),
            card(
                "Runner activity",
                [timelineNotice(state), fleetNotice(fleet) ?? el("p", { class: "empty", text: "No self-hosted data in this window." })],
                "Per-runner detail is projected onto the buckets of the concurrency report, so it needs a self-hosted fleet to project onto.",
            ),
        ];
    }

    return [
        orgWideNotice(metrics.meta.scope === "org"),
        drawn
            ? el("div", { class: "kpis" }, [
                  kpi("Matched jobs", number(traced.matched), `on ${number(traced.runnerCount)} runner names`),
                  kpi("Job time", duration(traced.busyTimeMs), "every job added up, overlaps counted twice"),
                  kpi("Busy time", duration(traced.runnerBusyTimeMs), "overlaps on one runner merged first"),
                  kpi("Busiest runner", busiest ? duration(busiest.busyMs) : "–", busiest ? busiest.runner : "no named runner"),
                  kpi(
                      "Skipped jobs",
                      number(traced.unfinished + traced.zeroDuration + traced.negativeDuration),
                      "unfinished, sub-second or backwards",
                  ),
              ])
            : null,
        card(
            traced ? `Runner busy time over time · ${label}` : "Runner busy time over time",
            [
                el("div", {}, [
                    timelineNotice(state),
                    traced
                        ? drawn
                            ? concurrencyChart(traced.buckets, fleet.bucket, metric)
                            : el("p", { class: "empty", text: `No job ran on ${label} in this window.` })
                        : runnerTracePrompt(state),
                ]),
                drawn
                    ? el("p", {
                          class: "notice",
                          text: `The chart, and the two cards below it, are built from the ${number(traced.runners.length)} busiest runners of the ${number(traced.observedRunners ?? traced.runnerCount)} this projection observed. The Runners table searches all of them.`,
                      })
                    : null,
            ],
            traced
                ? "Projected from gh runner-kit metrics jobs: every job of the matching runners, split across the same buckets the concurrency report uses, so this chart can be laid against the fleet-wide one on the Queue & capacity tab. Utilization is not offered because the runner inventory of an arbitrary subset of the fleet is not knowable, and for the same reason the chart draws no capacity line. A job that had not finished when the window was collected is left out rather than charged against a guessed end, and so is a job GitHub timestamped as starting and finishing in the same second."
                : "A trace reads the jobs of the window through gh runner-kit metrics jobs and projects them onto the buckets of the concurrency report, which is the only way to get per-runner detail: every other report is either bucket-level or window-level. A pattern reads the rows of the matching runners; Every runner reads all of them, which is the expensive path and is capped at 400000 rows.",
            el("div", { class: "controls" }, [
                timelineControl(state),
                drawn
                    ? selectControl(
                          "Series",
                          Object.entries(CHART_METRICS)
                              .filter(([value]) => value !== "utilization")
                              .map(([value, entry]) => ({ value, label: entry.label })),
                          metric,
                          (value) => {
                              traceMetric = value;
                              render();
                          },
                      )
                    : null,
            ]),
        ),
        drawn ? runnerFilterCard(traced) : null,
        drawn
            ? card(
                  `Busy state per runner · ${label}`,
                  [runnerHeatmap(traced, fleet.bucket)],
                  "Built from the same gh runner-kit metrics jobs rows as the chart above: one row per runner, one column per bucket, shaded by how much of that bucket the runner spent working. Jobs that overlapped on one runner are merged, so a cell is a share of the bucket and never exceeds it, while the table above keeps their plain sum as job time. Rows are the busiest runners of the window, so a fleet of single-use ephemeral runners will show one lit cell per row: sort by first active to read it as a schedule instead.",
                  el("div", { class: "controls" }, [
                      selectControl(
                          "Sort",
                          [
                              { value: "busy", label: "Busy time" },
                              { value: "first", label: "First active" },
                              { value: "name", label: "Name" },
                          ],
                          heatSort,
                          (value) => {
                              heatSort = value;
                              render();
                          },
                      ),
                      selectControl(
                          "Rows",
                          [10, 20, 40].map((value) => ({ value: String(value), label: `${value} busiest` })),
                          String(heatRows),
                          (value) => {
                              heatRows = Number(value);
                              render();
                          },
                      ),
                  ]),
              )
            : null,
        drawn
            ? card(
                  `Busy state per runner over time · ${label}`,
                  [runnerSparklines(traced, fleet.bucket)],
                  "The same rows as the heatmap above, one chart each, so a single runner's day can be read on its own: the height is the share of that bucket the runner spent running a job, held flat across the bucket because that is the resolution the projection has. Every chart shares one axis and one ceiling, so they can be compared against each other; hover a chart to read the bucket under the pointer. A gap in the line is a bucket that could not be placed on the axis, not an idle one - an idle bucket sits on the baseline.",
                  el("div", { class: "controls" }, [
                      selectControl(
                          "Sort",
                          [
                              { value: "busy", label: "Busy time" },
                              { value: "first", label: "First active" },
                              { value: "name", label: "Name" },
                          ],
                          sparkSort,
                          (value) => {
                              sparkSort = value;
                              render();
                          },
                      ),
                      selectControl(
                          "Charts",
                          [6, 12, 24, 40].map((value) => ({ value: String(value), label: `${value} runners` })),
                          String(sparkRows),
                          (value) => {
                              sparkRows = Number(value);
                              render();
                          },
                      ),
                      selectControl(
                          "Scale",
                          [
                              { value: "full", label: "0-100% of a bucket" },
                              { value: "fit", label: "Fit the busiest chart" },
                          ],
                          sparkScale,
                          (value) => {
                              sparkScale = value;
                              render();
                          },
                      ),
                  ]),
              )
            : null,
        projectionSettingsCard(),
    ];
}

/**
 * What a projection reads, and how much of it. `--kind` in particular was
 * fixed at self-hosted, which left a repository that runs only on
 * GitHub-hosted runners projecting nothing and saying nothing about why.
 */
function projectionSettingsCard() {
    const filters = state?.filters ?? {};
    const kind = filters.jobKind ?? "self-hosted";
    const busy = state?.timelineStatus === "loading";
    return settingsCard(
        "settings-projection",
        "Projection settings",
        [
            el("div", { class: "controls" }, [
                selectControl(
                    "Jobs",
                    [
                        { value: "self-hosted", label: "Self-hosted" },
                        { value: "github-hosted", label: "GitHub-hosted" },
                        { value: "all", label: "Every job" },
                    ],
                    kind,
                    (value) => applyFilters({ jobKind: value }),
                ),
                numberControl(
                    "setting-top-runners",
                    "Charted runners",
                    filters.topRunners ?? 40,
                    { min: 5, max: 200, hint: "How many of the busiest runners the chart, heatmap and small multiples carry." },
                    (value) => applyFilters({ topRunners: value }),
                ),
                numberControl(
                    "setting-max-rows",
                    "Row cap",
                    filters.maxRows ?? 400000,
                    { min: 1000, max: 400000, step: 1000, hint: "Stop a projection after this many job rows. 400000 is also the ceiling." },
                    (value) => applyFilters({ maxRows: value }),
                ),
            ]),
            el("p", {
                class: "notice",
                text:
                    kind === "self-hosted"
                        ? "Projecting the self-hosted jobs, which is also what the fleet reports count, and the jobs whose runner GitHub did not name. A repository that runs only on GitHub-hosted runners projects nothing until this is widened."
                        : kind === "github-hosted"
                          ? "Projecting the GitHub-hosted jobs. The buckets underneath still come from the self-hosted concurrency report, so the two describe different fleets on one axis."
                          : "Projecting every job, self-hosted and GitHub-hosted alike, so the busiest names here need not be runners the fleet owns.",
            }),
            busy ? el("p", { class: "notice", text: "A projection is running; changing a setting here restarts it." }) : null,
        ],
        "These read the collection already in hand rather than fetching again, so a change re-runs the trace in seconds instead of collecting the window anew. Lower the row cap to bound what a trace over a busy organization costs.",
    );
}

function renderUsage(metrics) {
    const orgWide = metrics.meta.scope === "org";
    const usage = metrics.usage;
    const usageWindow = usage.window;
    const fleet = metrics.fleet;
    const costRows = fleet?.cost ?? [];
    const billableMs = costRows.reduce((sum, row) => sum + (row.billableMs ?? 0), 0);
    const maxWorkflowMinutes = Math.max(1, ...usageWindow.byWorkflow.map((row) => row.minutes));

    return [
        orgWideNotice(orgWide),
        orgWide
            ? null
            : el("div", { class: "kpis" }, [
                  kpi("Billable minutes", number(usageWindow.billableMinutes), "GitHub-hosted, in window"),
                  kpi("Estimated cost", money(usageWindow.estimatedCost), "list price, in window"),
                  kpi("Self-hosted minutes", number(usageWindow.selfHostedMinutes), "not billed by GitHub"),
                  kpi("Total job minutes", number(usageWindow.totalMinutes), "rounded up per job"),
              ]),
        fleet?.available
            ? card(
                  "Billable time reported by GitHub",
                  [
                      fleet.billable
                          ? table(
                                [
                                    { label: "OS", render: (row) => row.os },
                                    { label: "Runs", num: true, render: (row) => number(row.runs) },
                                    { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                                    { label: "Billable", num: true, render: (row) => duration(row.billableMs) },
                                    { label: "Rate / min", num: true, render: (row) => money(row.rate) },
                                    { label: "Est cost", num: true, render: (row) => money(row.cost) },
                                ],
                                costRows,
                            )
                          : el("p", {
                                class: "empty",
                                text: orgWide
                                    ? "Billable time is not collected yet. Across a whole organization it costs one extra API request per run of every repository, so switch it on only when you need the breakdown."
                                    : "Billable time is not collected yet. It costs one extra API request per run, so switch it on only when you need the breakdown.",
                            }),
                  ],
                  fleet.billable
                      ? `Reported by gh runner-kit metrics cost: ${duration(billableMs)} billable in this window. GitHub bills only the jobs it hosted and public repositories run for free, so a zero is also what moving this work to self-hosted runners would avoid.${
                            orgWide ? "" : " The numbers above are the dashboard's own estimate from job durations and will differ."
                        }`
                      : orgWide
                        ? "Reads the usage GitHub actually billed. It costs one extra API request per run of every repository in the organization, so switch it on deliberately."
                        : "Reads the usage GitHub actually billed, instead of estimating it from job durations like the tables below.",
                  checkboxControl("Read billable time", Boolean(fleet.billable), (checked) => applyFilters({ billable: checked })),
              )
            : null,
        orgWide ? null : card(
            "By runner class",
            [
                table(
                    [
                        { label: "Runner class", render: (row) => row.runnerClass },
                        { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                        { label: "Minutes", num: true, render: (row) => number(row.minutes) },
                        { label: "Rate / min", num: true, render: (row) => (usage.rates[row.runnerClass] ? money(usage.rates[row.runnerClass]) : "–") },
                        { label: "Estimated cost", num: true, render: (row) => money(row.cost) },
                    ],
                    usageWindow.byRunnerClass,
                ),
            ],
            `Estimate uses public list prices (Linux ${money(usage.rates.UBUNTU)}, Windows ${money(usage.rates.WINDOWS)}, macOS ${money(usage.rates.MACOS)} per minute) and ignores included free minutes and larger-runner surcharges.`,
        ),
        orgWide ? null : card(
            "Cost by workflow (window)",
            [
                table(
                    [
                        { label: "Workflow", wrap: true, render: (row) => row.name },
                        { label: "Jobs", num: true, render: (row) => number(row.jobs) },
                        { label: "Minutes", num: true, render: (row) => number(row.minutes) },
                        { label: "", render: (row) => bar(row.minutes, maxWorkflowMinutes) },
                        { label: "Self-hosted min", num: true, render: (row) => number(row.selfHostedMinutes) },
                        { label: "Estimated cost", num: true, render: (row) => money(row.cost) },
                    ],
                    usageWindow.byWorkflow,
                ),
            ],
        ),
        orgWide ? null : card(
            "Reported billable minutes (current billing cycle)",
            [
                usage.reported.available
                    ? table(
                          [
                              { label: "Workflow", wrap: true, render: (row) => row.name },
                              {
                                  label: "Breakdown",
                                  wrap: true,
                                  render: (row) => row.perOs.map((entry) => `${entry.os}: ${number(entry.minutes)}m`).join("  ·  "),
                              },
                              { label: "Minutes", num: true, render: (row) => number(row.totalMinutes) },
                              { label: "Estimated cost", num: true, render: (row) => money(row.cost) },
                          ],
                          usage.reported.byWorkflow,
                      )
                    : el("p", { class: "empty", text: "GitHub did not report billable timing (billing read access is required)." }),
            ],
            usage.reported.available
                ? `Reported by GitHub for the current billing cycle, which is a different period than the ${metrics.meta.filters.days}-day window above.`
                : undefined,
        ),
    ];
}

/* ---------- shell ---------- */

function renderBanner() {
    const messages = [];
    if (state?.error) {
        messages.push(state.error);
    }
    for (const warning of state?.metrics?.meta?.warnings ?? []) {
        messages.push(warning);
    }
    if (messages.length === 0) {
        dom.banner.hidden = true;
        return;
    }
    dom.banner.hidden = false;
    dom.banner.className = `banner${state?.error ? " banner--error" : ""}`;
    dom.banner.replaceChildren(
        el("strong", { text: state?.error ? "Collection failed" : "Partial data" }),
        el(
            "ul",
            {},
            messages.map((message) => el("li", { text: message })),
        ),
    );
}

function renderStatus() {
    if (!state) {
        dom.status.textContent = "Connecting…";
        return;
    }
    const label = state.scope === "org" ? `${state.key} (all repos)` : state.key;
    const loading = state.status === "loading";
    dom.refresh.disabled = loading;
    dom.refresh.textContent = loading ? "Refreshing…" : "Refresh";
    if (loading) {
        dom.status.textContent = `${label} · ${state.progress || "Collecting…"}`;
        return;
    }
    const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleString() : "never";
    const collection = state.metrics?.meta?.collectionMs;
    dom.status.textContent = `${label} · last ${state.filters.days} days · updated ${updated}${
        Number.isFinite(collection) ? ` (${(collection / 1000).toFixed(1)}s)` : ""
    }`;
}

/** The selector form differs per scope, so the field follows the select. */
function syncScopeField() {
    const org = dom.scope.value === "org";
    dom.targetLabel.textContent = org ? "Organization" : "Repository";
    dom.target.placeholder = org ? "[HOST/]OWNER" : "[HOST/]OWNER/REPO";
    dom.targetHint.textContent = org
        ? "Reads every repository in the organization. Prefix a host for GitHub Enterprise, e.g. ghe.example/octo."
        : "Prefix a host for GitHub Enterprise, e.g. ghe.example/octo/api.";
}

/** Build the query editor once; renders afterwards only assign values. */
function buildQueryEditor() {
    const groups = FIELD_GROUPS.map((group) => {
        const fields = fieldsOfGroup(group.id);
        if (fields.length === 0) {
            return null;
        }
        return el("section", { class: "query-group", "data-group": group.id }, [
            el("h3", {}, [
                document.createTextNode(group.title),
                el("span", { class: "query-group__effect", text: group.effect }),
            ]),
            el("p", { class: "query-group__note", text: group.note }),
            el(
                "div",
                { class: "field-grid" },
                fields.map((field) => queryField(field)),
            ),
        ]);
    });
    dom.queryGroups.replaceChildren(...groups.filter(Boolean));
}

/** One labelled control, wired to record an edit rather than to apply it. */
function queryField(field) {
    const id = `query-field-${field.name}`;
    let control;
    if (field.control === "select") {
        control = el(
            "select",
            { id, name: field.name },
            field.options.map((option) => el("option", { value: option, text: option })),
        );
    } else if (field.control === "checkbox") {
        control = el("input", { id, name: field.name, type: "checkbox" });
    } else if (field.control === "number") {
        control = el("input", {
            id,
            name: field.name,
            type: "number",
            min: String(field.min),
            max: String(field.max),
            step: String(field.step ?? 1),
        });
        // Every number is required: an emptied box reads as NaN, and sending
        // that would let the normalizer quietly substitute the default for
        // whatever the reader had actually set.
        control.required = true;
    } else {
        control = el("input", {
            id,
            name: field.name,
            type: "text",
            spellcheck: "false",
            autocomplete: "off",
            placeholder: field.placeholder ?? "",
        });
    }
    // Numbers and text both report on `input`, so a half-typed value counts as
    // an edit straight away. Without that, a control the reader is typing into
    // still reads as untouched, and the next render would either overwrite
    // what they typed or - worse - leave a stale value on screen and then take
    // that stale value as the baseline when they finally commit it.
    const event = field.control === "select" || field.control === "checkbox" ? "change" : "input";
    control.addEventListener(event, () => recordEdit(field, control));
    const label = el("label", { class: `field${field.control === "checkbox" ? " field--checkbox" : ""}`, "data-field": field.name });
    if (field.control === "checkbox") {
        label.append(control, el("span", { text: field.label }));
    } else {
        label.append(el("span", { text: field.label }), control);
    }
    return el("div", { class: "query-field" }, [
        label,
        el("small", { class: "field-hint", id: `query-hint-${field.name}`, text: field.hint ?? "" }),
    ]);
}

/** Remember an edit, or forget it once it matches the live value again. */
function recordEdit(field, control) {
    const raw = field.control === "checkbox" ? control.checked : control.value;
    const value = readFieldValue(field, raw);
    const live = state?.filters?.[field.name];
    if (!queryDraft.baseline.has(field.name)) {
        queryDraft.baseline.set(field.name, live);
    }
    if (sameFieldValue(field, value, live)) {
        queryDraft.edited.delete(field.name);
        queryDraft.baseline.delete(field.name);
        queryDraft.conflicts.delete(field.name);
    } else {
        queryDraft.edited.set(field.name, value);
    }
    renderQueryEditor();
}

/**
 * Push the live query into every control the reader has not edited. Because an
 * edit is recorded on the first keystroke, "not edited" means the control is
 * genuinely untouched, so it is safe to assign even while it holds the caret -
 * and necessary, since a control left showing a stale value would otherwise be
 * taken as the baseline the moment the reader did type into it.
 *
 * An edited field keeps its draft. If the authoritative value moved away from
 * what it was when the edit started, the field is flagged so applying it does
 * not silently undo a change made elsewhere; the flag clears again if the two
 * come back into agreement.
 */
function renderQueryEditor() {
    if (!state) {
        return;
    }
    let dirty = 0;
    for (const field of QUERY_FIELDS) {
        const wrapper = dom.queryGroups.querySelector(`[data-field="${field.name}"]`);
        const control = document.getElementById(`query-field-${field.name}`);
        if (!control) {
            continue;
        }
        const live = state.filters?.[field.name];
        if (queryDraft.edited.has(field.name)) {
            // Something else may have committed the very value being drafted,
            // which settles the edit rather than leaving it pending forever.
            if (sameFieldValue(field, queryDraft.edited.get(field.name), live)) {
                queryDraft.edited.delete(field.name);
                queryDraft.baseline.delete(field.name);
                queryDraft.conflicts.delete(field.name);
            } else if (sameFieldValue(field, queryDraft.baseline.get(field.name), live)) {
                queryDraft.conflicts.delete(field.name);
            } else {
                queryDraft.conflicts.add(field.name);
            }
        }
        const edited = queryDraft.edited.has(field.name);
        if (edited) {
            dirty += 1;
        } else {
            const next = writeFieldValue(field, live);
            if (field.control === "checkbox") {
                control.checked = next;
            } else if (control.value !== next) {
                control.value = next;
            }
        }
        wrapper?.classList.toggle("field--dirty", edited);
    }
    // auto is the one setting that does not state what it does: the width is
    // resolved from the window when the collection runs, so the width it
    // actually resolved to is reported beside it.
    const bucketHint = document.getElementById("query-hint-bucket");
    if (bucketHint) {
        const base = fieldByName("bucket")?.hint ?? "";
        const resolved = state.metrics?.fleet?.bucket;
        bucketHint.textContent =
            state.filters?.bucket === "auto" && resolved ? `${base} This window resolved to ${resolved}.` : base;
    }
    dom.queryDirtyCount.hidden = dirty === 0;
    dom.queryDirtyCount.textContent = String(dirty);
    dom.queryReset.disabled = dirty === 0;
    dom.queryApply.disabled = dirty === 0;
    dom.queryEffect.textContent = describePending();
}

/** Say what pressing Apply will cost before it is pressed. */
function describePending() {
    if (queryDraft.edited.size === 0) {
        return "No changes.";
    }
    const groups = new Set();
    for (const name of queryDraft.edited.keys()) {
        groups.add(QUERY_FIELDS.find((field) => field.name === name)?.group);
    }
    const effects = FIELD_GROUPS.filter((group) => groups.has(group.id)).map((group) => group.effect.toLowerCase());
    const conflicts = [...queryDraft.conflicts].filter((name) => queryDraft.edited.has(name));
    const warning = conflicts.length
        ? ` ${conflicts.join(", ")} changed elsewhere while you were editing; applying will overwrite that.`
        : "";
    return `${queryDraft.edited.size} change${queryDraft.edited.size === 1 ? "" : "s"}: ${effects.join(", ")}.${warning}`;
}

/** The header button carries the target, so it has to follow the state. */
function renderTarget() {
    if (!state) {
        return;
    }
    dom.targetCurrent.textContent = state.scope === "org" ? `${state.key} (all repos)` : state.key;
    // An open but untouched popover follows the state too. Left alone it would
    // still hold the target it was opened on, and pressing Switch would move
    // the dashboard back to it, undoing a change made from another panel.
    if (!targetDraft.open || !targetDraft.dirty) {
        dom.scope.value = state.scope ?? "repo";
        dom.target.value = state.key;
        syncScopeField();
    }
}

function renderFilters() {
    renderTarget();
    if (queryDraft.open) {
        renderQueryEditor();
    }
}

function render() {
    // Every render replaces the whole content region, which detaches and
    // re-inserts whatever the reader was typing in and so drops focus. An SSE
    // update arrives on its own schedule - a progress line, a finished
    // collection - so without this a search field loses the caret mid-word.
    const focused = document.activeElement;
    const focusId = focused?.id && dom.content.contains(focused) ? focused.id : null;
    const caret = focusId ? { start: focused.selectionStart, end: focused.selectionEnd } : null;
    renderFocusId = focusId;

    renderContent();

    if (focusId) {
        const restored = document.getElementById(focusId);
        if (restored && restored !== document.activeElement) {
            restored.focus({ preventScroll: true });
            if (caret && caret.start !== null && typeof restored.setSelectionRange === "function") {
                try {
                    restored.setSelectionRange(caret.start, caret.end);
                } catch {
                    // Not every input type carries a selection.
                }
            }
        }
    }
}

function renderContent() {
    renderFilters();
    renderStatus();
    renderBanner();

    for (const tab of dom.tabs) {
        tab.setAttribute("aria-selected", String(tab.dataset.tab === activeTab));
    }

    if (activeTab === "explore") {
        // Checked ahead of the metrics gate: the explorer reads its own row
        // collection, so it has something to show even when no fleet metrics
        // have been collected for this target.
        dom.content.replaceChildren(...renderExplorer(state).filter(Boolean));
        return;
    }

    const metrics = state?.metrics;
    if (!metrics) {
        dom.content.replaceChildren(
            el("p", { class: "empty", text: state?.status === "loading" ? "Collecting metrics…" : "No metrics yet. Press Refresh." }),
        );
        return;
    }
    const sections =
        activeTab === "runners"
            ? renderRunners(metrics)
            : activeTab === "queue"
              ? renderQueue(metrics)
              : activeTab === "activity"
                ? renderActivity(metrics)
                : activeTab === "usage"
                  ? renderUsage(metrics)
                  : renderOverview(metrics);
    dom.content.replaceChildren(...sections.filter(Boolean));
}

/**
 * Send one query patch. Only the fields named here change: the extension
 * treats an unstated key as "no change", so the browser no longer keeps its
 * own copy of every default - a second source of truth that had already
 * drifted from the model and would silently reset any field added to it.
 *
 * `/api/refresh` additionally discards the job cache `gh runner-kit` keeps, so
 * only the Refresh button uses it; changing a setting reuses the cache.
 */
async function postQuery(payload, { bypassCache = false } = {}) {
    const response = await fetch(bypassCache ? "./api/refresh" : "./api/filters", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        // A rejected target comes back as 400 with an error message. Adopting
        // it as the dashboard state would replace the whole view with a
        // malformed object, so it is raised for the form to show instead.
        throw new Error(body.error ?? `Request failed with HTTP ${response.status}`);
    }
    state = body;
    render();
    syncExplorer(state);
    return body;
}

/** Change settings without touching the target. Used by the tab cards too. */
async function applyFilters(patch = {}, { bypassCache = false } = {}) {
    return postQuery({ filters: patch }, { bypassCache });
}

/** Move the dashboard to another repository or organization. */
async function switchTarget({ scope, target }) {
    return postQuery({ scope, target, filters: {} });
}

/** Collect the committed query again, ignoring the CLI's job cache. */
async function refreshCurrentQuery() {
    return postQuery({ filters: {} }, { bypassCache: true });
}

/**
 * Download the current window through `gh runner-kit metrics export`. The
 * canvas runs in a sandboxed iframe, so the blob is clicked from here rather
 * than navigating the frame to the endpoint.
 */
async function exportMetrics(format) {
    if (!format) {
        return;
    }
    const previous = dom.status.textContent;
    dom.export.disabled = true;
    dom.status.textContent = `Exporting ${format}…`;
    try {
        const response = await fetch(`./api/export?format=${encodeURIComponent(format)}`);
        if (!response.ok) {
            const detail = await response.json().catch(() => ({}));
            throw new Error(detail.error ?? `Export failed with HTTP ${response.status}`);
        }
        const blob = await response.blob();
        const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? `metrics.${format}`;
        const href = URL.createObjectURL(blob);
        const link = el("a", { href, download: name });
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(href);
        dom.status.textContent = `Exported ${name}`;
    } catch (error) {
        dom.status.textContent = `Export failed: ${error?.message ?? error}`;
        setTimeout(() => {
            dom.status.textContent = previous;
        }, 5000);
    } finally {
        dom.export.disabled = false;
        dom.export.value = "";
    }
}

function connect() {
    const source = new EventSource("./api/events");
    source.onmessage = (message) => {
        const next = JSON.parse(message.data);
        // A different target is a different question, so the explorer drops the
        // rows it holds rather than redrawing them under a new heading, and a
        // draft written against the old target stops applying to this one.
        if (state && next.key !== state.key) {
            resetExplorer();
            if (queryDraft.edited.size > 0) {
                resetQueryDraft();
                dom.queryEffect.textContent = `Target changed to ${next.key}; the draft was discarded.`;
            }
        }
        state = next;
        render();
        syncExplorer(state);
    };
    source.onerror = () => {
        dom.status.textContent = "Reconnecting…";
    };
}

/** Open and close the two forms, returning focus where it came from. */
function openTargetPicker() {
    targetDraft.open = true;
    dom.targetPopover.hidden = false;
    dom.targetToggle.setAttribute("aria-expanded", "true");
    dom.targetError.hidden = true;
    dom.target.focus();
    dom.target.select();
}

function closeTargetPicker({ restoreFocus = true } = {}) {
    targetDraft.open = false;
    targetDraft.dirty = false;
    dom.targetPopover.hidden = true;
    dom.targetToggle.setAttribute("aria-expanded", "false");
    dom.targetError.hidden = true;
    renderTarget();
    if (restoreFocus) {
        dom.targetToggle.focus();
    }
}

function openQueryEditor() {
    queryDraft.open = true;
    queryDraft.key = state?.key ?? null;
    dom.queryEditor.hidden = false;
    dom.queryToggle.setAttribute("aria-expanded", "true");
    renderQueryEditor();
    document.getElementById("query-field-days")?.focus();
}

function closeQueryEditor({ restoreFocus = true } = {}) {
    queryDraft.open = false;
    dom.queryEditor.hidden = true;
    dom.queryToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) {
        dom.queryToggle.focus();
    }
}

/** Throw the draft away and show the live query again. */
function resetQueryDraft() {
    queryDraft.edited.clear();
    queryDraft.baseline.clear();
    queryDraft.conflicts.clear();
    renderQueryEditor();
}

dom.targetToggle.addEventListener("click", () => {
    if (targetDraft.open) {
        closeTargetPicker();
    } else {
        openTargetPicker();
    }
});
dom.targetCancel.addEventListener("click", () => closeTargetPicker());
dom.scope.addEventListener("change", () => {
    targetDraft.dirty = true;
    syncScopeField();
});
dom.target.addEventListener("input", () => {
    targetDraft.dirty = true;
    dom.targetError.hidden = true;
});
dom.targetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = dom.target.value.trim();
    if (!target) {
        dom.targetError.textContent = "Enter a repository or organization.";
        dom.targetError.hidden = false;
        return;
    }
    void switchTarget({ scope: dom.scope.value, target })
        .then(() => {
            // The settings follow the reader to the new target rather than
            // being restored from whatever was last used there.
            resetQueryDraft();
            closeTargetPicker();
        })
        .catch((error) => {
            dom.targetError.textContent = error?.message ?? String(error);
            dom.targetError.hidden = false;
        });
});

dom.queryToggle.addEventListener("click", () => {
    if (queryDraft.open) {
        closeQueryEditor();
    } else {
        openQueryEditor();
    }
});
dom.queryReset.addEventListener("click", () => resetQueryDraft());
dom.queryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!dom.queryForm.reportValidity()) {
        return;
    }
    const patch = Object.fromEntries(queryDraft.edited);
    if (Object.keys(patch).length === 0) {
        return;
    }
    dom.queryApply.disabled = true;
    void applyFilters(patch)
        .then(() => {
            resetQueryDraft();
            closeQueryEditor();
        })
        .catch((error) => {
            dom.queryEffect.textContent = `Could not apply: ${error?.message ?? error}`;
            dom.queryApply.disabled = false;
        });
});

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
        return;
    }
    if (targetDraft.open) {
        closeTargetPicker();
    } else if (queryDraft.open) {
        closeQueryEditor();
    }
});
document.addEventListener("pointerdown", (event) => {
    if (targetDraft.open && !dom.targetPopover.contains(event.target) && !dom.targetToggle.contains(event.target)) {
        closeTargetPicker({ restoreFocus: false });
    }
});

dom.refresh.addEventListener("click", () => void refreshCurrentQuery().catch(() => {}));
dom.export.addEventListener("change", (event) => void exportMetrics(event.target.value));
for (const tab of dom.tabs) {
    tab.addEventListener("click", () => {
        activeTab = tab.dataset.tab;
        render();
        if (activeTab === "explore") {
            // Opening the tab is what asks for the rows: collecting them for a
            // reader who never opens it would spend the API budget on a tab
            // that is not on screen.
            syncExplorer(state);
        }
    });
}

initExplorer({
    state: () => state,
    activeTab: () => activeTab,
    applyFilters: (overrides) => applyFilters(overrides),
    requestRows: (options = {}) =>
        fetch("./api/rows", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(options),
        }).catch(() => {}),
});

buildQueryEditor();

fetch("./api/state")
    .then((response) => response.json())
    .then((initial) => {
        state = initial;
        render();
        syncExplorer(state);
    })
    .catch(() => render())
    .finally(connect);
