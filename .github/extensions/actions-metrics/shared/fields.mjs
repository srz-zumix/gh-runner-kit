// The query fields as the reader sees them.
//
// `lib/query.mjs` owns what a field *means* - its normalizer, its schema
// fragment, which identity it belongs to. This module owns what a field
// *looks like*: its label, the control that edits it, the values it accepts
// and the sentence that explains it.
//
// The accepted values have to be stated once, though, and the two sides can
// only share a module that both can load: `lib/` is server-only, while the
// browser reaches `shared/` over the canvas HTTP server. So the enum keys and
// the numeric bounds live here and `lib/runnerkit.mjs`, `lib/jobs.mjs` and
// `lib/jobrows.mjs` re-export them. Without that, a select in the toolbar
// could offer a value the normalizer silently rewrites to the default - the
// field would look settable and do nothing.

/** Keys `gh runner-kit metrics runner --group-by` accepts. */
export const GROUP_BY_KEYS = ["name", "label", "group"];

/**
 * Bucket widths offered for `gh runner-kit metrics concurrency --bucket`.
 * Go's time.ParseDuration has no day unit, hence 24h rather than 1d.
 */
export const BUCKET_KEYS = ["auto", "15m", "30m", "1h", "3h", "6h", "12h", "24h"];

/** Target queue times offered for `gh runner-kit metrics capacity --target-wait`. */
export const TARGET_WAIT_KEYS = ["15s", "30s", "1m", "2m", "5m", "10m", "30m"];

/**
 * Which runner inventory `--type` reads. `auto` leaves the flag off and keeps
 * the CLI default: the organization runners, or the repository runners when a
 * repository is selected. Setting it to `org` on a repository target is the
 * useful case - a repository that runs on shared organization runners reports
 * no runners at all under the default, which zeroes utilization and saturation.
 */
export const RUNNER_TYPE_KEYS = ["auto", "org", "repo"];

/** Which jobs a projection reads. */
export const JOB_KIND_KEYS = ["all", "self-hosted", "github-hosted"];

export const DEFAULT_TARGET_WAIT = "1m";
export const DEFAULT_TARGET_UTILIZATION = 0.7;
export const DEFAULT_JOB_KIND = "self-hosted";

/** Row ceilings a projection and the explorer respect. */
export const MAX_ROWS = 400000;
export const MIN_ROWS = 1000;
export const DEFAULT_TOP_RUNNERS = 40;
export const MIN_TOP_RUNNERS = 5;
export const MAX_TOP_RUNNERS = 200;
export const DEFAULT_ROW_BUDGET = 20000;
export const MIN_ROW_BUDGET = 500;
export const MAX_ROW_BUDGET = 200000;

/** Highest `--max-runs` the setting accepts; 0 means no limit. */
export const MAX_RUNS_CEILING = 1000000;

/** Range `--concurrency` accepts. Above this GitHub starts rate limiting. */
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 20;

/** Longest window the toolbar offers, in days. */
export const MIN_DAYS = 1;
export const MAX_DAYS = 365;

/**
 * What applying a change to a field costs. The editor groups by this and says
 * so before the reader presses Apply, because the difference between them is
 * half a minute and half an hour over a busy organization.
 */
export const FIELD_GROUPS = [
    {
        id: "collection",
        title: "Collection",
        effect: "Collects again",
        note: "These decide what is fetched from GitHub, so changing one discards the collection in hand and reads the window afresh.",
    },
    {
        id: "projection",
        title: "Projection",
        effect: "Re-reads the collection",
        note: "These re-read the jobs already collected, so a change lands in seconds without asking GitHub for anything.",
    },
    {
        id: "rows",
        title: "Job explorer",
        effect: "Refreshes explorer rows",
        note: "This bounds the raw job rows the explorer holds in the browser.",
    },
    {
        id: "operational",
        title: "Execution",
        effect: "Waits for the next collection",
        note: "This changes how fast the requests go out rather than what they ask for, so it applies the next time something is collected.",
    },
];

/**
 * Every query field, in the order the editor lays them out. `name` matches the
 * key in `lib/query.mjs`'s FIELDS table; a field present there and missing
 * here is unreachable from the toolbar, which `queryFieldNames` lets a caller
 * check.
 */
export const QUERY_FIELDS = [
    {
        name: "days",
        group: "collection",
        label: "Window",
        control: "number",
        min: MIN_DAYS,
        max: MAX_DAYS,
        step: 1,
        required: true,
        hint: "How many days back to read, counted from now.",
    },
    {
        name: "event",
        group: "collection",
        label: "Event",
        control: "text",
        placeholder: "all",
        hint: "Keep only runs triggered by this event, e.g. push.",
    },
    {
        name: "branch",
        group: "collection",
        label: "Branch",
        control: "text",
        placeholder: "all",
        hint: "Keep only runs on this branch.",
    },
    {
        name: "workflow",
        group: "collection",
        label: "Workflow",
        control: "text",
        placeholder: "all",
        hint: "Workflow file name, e.g. ci.yml.",
    },
    {
        name: "labels",
        group: "collection",
        label: "Runs-on labels",
        control: "labels",
        placeholder: "all",
        hint: "Comma-separated. Keeps jobs requesting every one of these labels.",
    },
    {
        name: "includeRepos",
        group: "collection",
        label: "Include repos",
        control: "labels",
        placeholder: "all",
        hint: "Comma-separated patterns, e.g. octo/*. Organization targets only.",
    },
    {
        name: "excludeRepos",
        group: "collection",
        label: "Exclude repos",
        control: "labels",
        placeholder: "none",
        hint: "Comma-separated patterns, applied after Include repos.",
    },
    {
        name: "maxRuns",
        group: "collection",
        label: "Max runs",
        control: "number",
        min: 0,
        max: MAX_RUNS_CEILING,
        step: 1,
        hint: "Per repository. 0 reads every run in the window; above 0 each repository reports only its most recent runs.",
    },
    {
        name: "bucket",
        group: "collection",
        label: "Bucket",
        control: "select",
        options: BUCKET_KEYS,
        hint: "Width of one column in the concurrency report. auto follows the window.",
    },
    {
        name: "groupBy",
        group: "collection",
        label: "Group runners by",
        control: "select",
        options: GROUP_BY_KEYS,
        hint: "How the runner report aggregates: per runner name, per label, or per runner group.",
    },
    {
        name: "runnerType",
        group: "collection",
        label: "Runner inventory",
        control: "select",
        options: RUNNER_TYPE_KEYS,
        hint: "Which inventory to read. Set org on a repository that runs on shared organization runners, which otherwise reports none.",
    },
    {
        name: "selfHostedOnly",
        group: "collection",
        label: "Self-hosted runs only",
        control: "checkbox",
        hint: "Drop runs that never touched a self-hosted runner.",
    },
    {
        name: "targetWait",
        group: "collection",
        label: "Target queue wait",
        control: "select",
        options: TARGET_WAIT_KEYS,
        hint: "The queue time capacity planning sizes the fleet against.",
    },
    {
        name: "targetUtilization",
        group: "collection",
        label: "Target utilization",
        control: "number",
        min: 0.1,
        max: 1,
        // "any" rather than a fixed increment: the model accepts any ratio in
        // range, and a step would make a value it accepts fail HTML validation.
        step: "any",
        hint: "How busy capacity planning aims to keep a runner, 0.1 to 1.",
    },
    {
        name: "billable",
        group: "collection",
        label: "Read billable time",
        control: "checkbox",
        hint: "Also fetch billable minutes, which costs an extra request per run.",
    },
    {
        name: "jobKind",
        group: "projection",
        label: "Jobs",
        control: "select",
        options: JOB_KIND_KEYS,
        hint: "Which jobs the activity charts read. A repository on GitHub-hosted runners only projects nothing under self-hosted.",
    },
    {
        name: "topRunners",
        group: "projection",
        label: "Charted runners",
        control: "number",
        min: MIN_TOP_RUNNERS,
        max: MAX_TOP_RUNNERS,
        step: 1,
        hint: "How many of the busiest runners the charts and heatmap carry.",
    },
    {
        name: "maxRows",
        group: "projection",
        label: "Row cap",
        control: "number",
        min: MIN_ROWS,
        max: MAX_ROWS,
        step: 1,
        hint: "Stop a projection after this many job rows.",
    },
    {
        name: "rowBudget",
        group: "rows",
        label: "Explorer row budget",
        control: "number",
        min: MIN_ROW_BUDGET,
        max: MAX_ROW_BUDGET,
        step: 1,
        hint: "How many raw job rows the explorer loads into the browser.",
    },
    {
        name: "jobConcurrency",
        group: "operational",
        label: "Request concurrency",
        control: "number",
        min: MIN_CONCURRENCY,
        max: MAX_CONCURRENCY,
        step: 1,
        hint: "Parallel requests while collecting. Higher is faster until GitHub rate limits.",
    },
];

/** Field names the editor can edit, for asserting nothing in the model is unreachable. */
export function queryFieldNames() {
    return QUERY_FIELDS.map((field) => field.name);
}

/** The fields of one group, in layout order. */
export function fieldsOfGroup(groupId) {
    return QUERY_FIELDS.filter((field) => field.group === groupId);
}

/** Look one field up by the name it carries in the query. */
export function fieldByName(name) {
    return QUERY_FIELDS.find((field) => field.name === name);
}

/**
 * Read a field out of a form control as the value the query expects. Numbers
 * stay numbers and labels stay a list, so the patch the editor sends compares
 * equal to the state it came from rather than differing by type alone.
 */
export function readFieldValue(field, raw) {
    if (field.control === "checkbox") {
        return Boolean(raw);
    }
    if (field.control === "number") {
        const value = Number(String(raw ?? "").trim());
        return Number.isFinite(value) ? value : null;
    }
    if (field.control === "labels") {
        return String(raw ?? "")
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean)
            .sort();
    }
    return String(raw ?? "").trim();
}

/** Render a query value into what the control should display. */
export function writeFieldValue(field, value) {
    if (field.control === "checkbox") {
        return Boolean(value);
    }
    if (field.control === "labels") {
        return (Array.isArray(value) ? value : []).join(", ");
    }
    if (value === null || value === undefined) {
        return "";
    }
    return String(value);
}

/** Whether two query values for one field are the same. */
export function sameFieldValue(field, a, b) {
    if (field.control === "labels") {
        const left = Array.isArray(a) ? a : [];
        const right = Array.isArray(b) ? b : [];
        return left.length === right.length && left.every((entry, index) => entry === right[index]);
    }
    return a === b;
}
