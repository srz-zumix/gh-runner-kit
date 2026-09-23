// The canonical query: one flat object that is the whole identity of what the
// dashboard is looking at. The target and the settings used to be two separate
// models - a parsed `target` from `gh.mjs` and a flat `filters` object from
// `store.mjs` - which meant the same question was spelled three different ways
// in three places and the canvas input schema had to be written out twice.
//
// Here there is one object, one set of defaults, one normalizer, one validator
// and one JSON Schema. The legacy shapes are still produced, but only at the
// boundary where the collection layer is called: `targetOf` and `filtersOf`
// derive them on the spot and nothing stores them.
//
// What this model deliberately does NOT do is collapse to a single identity
// hash. The dashboard runs many subcommands over one collection and then
// projects that collection several ways, so it has three:
//
//   collectionId  - what has to be fetched from the CLI
//   projectionId  - how the collection already in hand is read
//   rowQueryId    - the raw job rows the explorer holds in the browser
//
// Changing `topRunners` must re-project in seconds, never re-collect a busy
// organization over half an hour, so which identity a field belongs to is
// declared once in FIELDS below rather than inferred at each call site.

import { createHash } from "node:crypto";
import { parseOrg, parseRepo } from "./gh.mjs";
import { DEFAULTS } from "./collect.mjs";
import {
    GROUP_BY_KEYS,
    BUCKET_KEYS,
    RUNNER_TYPE_KEYS,
    TARGET_WAIT_KEYS,
    DEFAULT_TARGET_WAIT,
    DEFAULT_TARGET_UTILIZATION,
} from "./runnerkit.mjs";
import {
    DEFAULT_JOB_KIND,
    DEFAULT_TOP_RUNNERS,
    JOB_KIND_KEYS,
    MAX_ROWS,
    MAX_TOP_RUNNERS,
    MIN_ROWS,
    MIN_TOP_RUNNERS,
} from "./jobs.mjs";
import { DEFAULT_ROW_BUDGET, MAX_ROW_BUDGET, MIN_ROW_BUDGET } from "./jobrows.mjs";

/** Highest `--max-runs` the setting accepts; 0 means no limit, and the
 * concurrency range `--concurrency` accepts. Declared in shared/fields.mjs so
 * the toolbar bounds and the normalizer cannot disagree. */
import { MAX_RUNS_CEILING, MIN_CONCURRENCY, MAX_CONCURRENCY } from "../shared/fields.mjs";

export { MAX_RUNS_CEILING, MIN_CONCURRENCY, MAX_CONCURRENCY };

/**
 * Bumped when the shape of a collected job row changes, so that a snapshot
 * collected by an older build is never read with a newer normalizer. It is
 * folded into `rowQueryId` alone, because it describes the rows rather than
 * the question asked of the CLI.
 */
const ROW_SCHEMA_VERSION = 1;

const DEFAULT_HOST = "github.com";

function text(value) {
    return String(value ?? "").trim();
}

function clampInt(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= min && number <= max ? Math.floor(number) : fallback;
}

function oneOf(keys, fallback) {
    return (value) => {
        const key = text(value);
        return keys.includes(key) ? key : fallback;
    };
}

/**
 * Runs-on labels are accepted both as an array and as a comma separated string
 * so that the toolbar field and the agent action can share one key. They are
 * sorted and de-duplicated so that two spellings of the same set are one query.
 */
function normalizeLabels(value) {
    const parts = Array.isArray(value) ? value : text(value).split(",");
    const seen = [];
    for (const part of parts) {
        const label = text(part);
        if (label && !seen.includes(label)) {
            seen.push(label);
        }
    }
    return seen.sort().slice(0, 10);
}

/**
 * Every field of a query, declared once.
 *
 * `collection`, `projection` and `rows` say which identity the field takes
 * part in; a field may take part in several, and one that takes part in none
 * is operational (it changes how a collection runs, never what it returns).
 * `target` marks the fields that name what is being analysed, which are
 * derived rather than remembered per target. `schema` is the JSON Schema
 * fragment the canvas and the agent action both publish.
 */
export const FIELDS = {
    repo: {
        target: true,
        collection: true,
        rows: true,
        default: "",
        normalize: text,
        schema: {
            type: "string",
            description: "Repository to analyse in [HOST/]OWNER/REPO form. Defaults to the workspace repository.",
        },
    },
    owner: {
        target: true,
        collection: true,
        rows: true,
        default: "",
        normalize: text,
        schema: {
            type: "string",
            description:
                "Organization to analyse in [HOST/]OWNER form, covering every repository it owns. Mutually exclusive with repo, and it issues many API requests on a large organization.",
        },
    },
    host: {
        target: true,
        collection: true,
        rows: true,
        default: "",
        normalize: text,
        schema: {
            type: "string",
            description:
                "GitHub host to read from, for a GitHub Enterprise Server instance. Defaults to the host carried by repo or owner, or to github.com.",
        },
    },
    days: {
        collection: true,
        rows: true,
        persist: true,
        default: DEFAULTS.days,
        normalize: (value) => clampInt(value, 1, 365, DEFAULTS.days),
        schema: { type: "integer", minimum: 1, maximum: 365, description: `Size of the analysis window in days. Defaults to ${DEFAULTS.days}.` },
    },
    event: {
        collection: true,
        rows: true,
        persist: true,
        default: "",
        normalize: text,
        schema: { type: "string", description: "Only include runs triggered by this event, for example push or pull_request. Pass an empty string to clear it." },
    },
    branch: {
        collection: true,
        rows: true,
        persist: true,
        default: "",
        normalize: text,
        schema: { type: "string", description: "Only include runs for this branch. Pass an empty string to clear it." },
    },
    workflow: {
        collection: true,
        rows: true,
        persist: true,
        default: "",
        normalize: text,
        schema: {
            type: "string",
            description: "Only include runs of this workflow (file name such as ci.yml, or workflow ID). Pass an empty string to clear it.",
        },
    },
    labels: {
        collection: true,
        rows: true,
        persist: true,
        default: [],
        normalize: normalizeLabels,
        schema: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description:
                "Restrict the concurrency timeline to the jobs whose runs-on set carries every one of these labels, and to the runners that can serve that set. Only the timeline honours it, because the CLI accepts a label filter on no other report. Pass an empty array to clear it.",
        },
    },
    includeRepos: {
        collection: true,
        // Also a row field: `rowQueryId` hashes only the row fields, so without
        // this the Job explorer would serve the previous repository set from
        // cache after the filter changed.
        rows: true,
        persist: true,
        default: [],
        normalize: normalizeLabels,
        schema: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description:
                "Keep only the repositories matching these patterns, such as octo/* or owner/repo. Applied before collection, so it also cuts the API traffic. Organization targets only. Pass an empty array to clear it.",
        },
    },
    excludeRepos: {
        collection: true,
        rows: true,
        persist: true,
        default: [],
        normalize: normalizeLabels,
        schema: {
            type: "array",
            items: { type: "string" },
            maxItems: 10,
            description:
                "Drop the repositories matching these patterns, such as octo/* or owner/repo. Applied before collection, and applied after includeRepos. Organization targets only. Pass an empty array to clear it.",
        },
    },
    groupBy: {
        collection: true,
        persist: true,
        default: "name",
        normalize: oneOf(GROUP_BY_KEYS, "name"),
        schema: {
            type: "string",
            enum: [...GROUP_BY_KEYS],
            description:
                "How `gh runner-kit metrics runner` aggregates the fleet activity. Use label or group for ephemeral runners. Defaults to name.",
        },
    },
    bucket: {
        collection: true,
        persist: true,
        default: "auto",
        normalize: oneOf(BUCKET_KEYS, "auto"),
        schema: {
            type: "string",
            enum: [...BUCKET_KEYS],
            description: "Width of one bucket in the concurrency timeline. Defaults to auto, which widens the bucket with the window.",
        },
    },
    runnerType: {
        collection: true,
        persist: true,
        default: "auto",
        normalize: oneOf(RUNNER_TYPE_KEYS, "auto"),
        schema: {
            type: "string",
            enum: [...RUNNER_TYPE_KEYS],
            description:
                "Which runner inventory the fleet numbers are measured against. Defaults to auto: the organization runners, or the repository runners when a repository is selected. Set it to org for a repository that runs on shared organization runners, which otherwise reports no runners and a zero utilization.",
        },
    },
    selfHostedOnly: {
        collection: true,
        persist: true,
        default: false,
        normalize: Boolean,
        schema: { type: "boolean", description: "Restrict the per-workflow report to jobs that ran on self-hosted runners. Defaults to false." },
    },
    targetWait: {
        collection: true,
        persist: true,
        default: DEFAULT_TARGET_WAIT,
        normalize: oneOf(TARGET_WAIT_KEYS, DEFAULT_TARGET_WAIT),
        schema: {
            type: "string",
            enum: [...TARGET_WAIT_KEYS],
            description: `Mean queue time the recommended pool sizes aim for. Defaults to ${DEFAULT_TARGET_WAIT}.`,
        },
    },
    targetUtilization: {
        collection: true,
        persist: true,
        default: DEFAULT_TARGET_UTILIZATION,
        normalize: (value) => {
            const number = Number(value);
            return Number.isFinite(number) && number > 0 && number <= 1 ? number : DEFAULT_TARGET_UTILIZATION;
        },
        schema: {
            type: "number",
            exclusiveMinimum: 0,
            maximum: 1,
            description: `Highest share of the time a recommended runner may be busy. Defaults to ${DEFAULT_TARGET_UTILIZATION}.`,
        },
    },
    billable: {
        collection: true,
        persist: true,
        default: false,
        normalize: Boolean,
        schema: {
            type: "boolean",
            description:
                "Also read the billable time GitHub-hosted runners consumed. Opt-in because it spends one extra API request per run. Defaults to false.",
        },
    },
    maxRuns: {
        collection: true,
        rows: true,
        persist: true,
        default: DEFAULTS.maxRuns,
        normalize: (value) => clampInt(value, 0, MAX_RUNS_CEILING, DEFAULTS.maxRuns),
        schema: {
            type: "integer",
            minimum: 0,
            maximum: MAX_RUNS_CEILING,
            description:
                "Stop after retrieving this many workflow runs per repository, as `--max-runs`. 0, the default, reads every run in the window; a limit makes a busy organization answer faster but reports only the most recent runs of each repository, so the collected total is the limit times the number of repositories.",
        },
    },
    jobConcurrency: {
        // Operational: the rate the requests go out at, never the rows they
        // come back with, so it takes part in no identity and applies to the
        // next collection rather than starting one.
        persist: true,
        default: DEFAULTS.jobConcurrency,
        normalize: (value) => clampInt(value, MIN_CONCURRENCY, MAX_CONCURRENCY, DEFAULTS.jobConcurrency),
        schema: {
            type: "integer",
            minimum: MIN_CONCURRENCY,
            maximum: MAX_CONCURRENCY,
            description: `How many per-run API requests to issue in parallel, as \`--concurrency\` (default ${DEFAULTS.jobConcurrency}). It changes only how fast a collection runs, never what it returns, so it applies to the next collection rather than starting one.`,
        },
    },
    jobKind: {
        projection: true,
        persist: true,
        default: DEFAULT_JOB_KIND,
        normalize: oneOf(JOB_KIND_KEYS, DEFAULT_JOB_KIND),
        schema: {
            type: "string",
            enum: [...JOB_KIND_KEYS],
            description: `Which jobs the runner projection reads, as \`metrics jobs --kind\` (default ${DEFAULT_JOB_KIND}, which also keeps the jobs whose runner could not be identified). A repository that runs only on GitHub-hosted runners projects nothing until this is widened.`,
        },
    },
    topRunners: {
        projection: true,
        persist: true,
        default: DEFAULT_TOP_RUNNERS,
        normalize: (value) => clampInt(value, MIN_TOP_RUNNERS, MAX_TOP_RUNNERS, DEFAULT_TOP_RUNNERS),
        schema: {
            type: "integer",
            minimum: MIN_TOP_RUNNERS,
            maximum: MAX_TOP_RUNNERS,
            description: `How many of the busiest runners the projection charts and tabulates (default ${DEFAULT_TOP_RUNNERS}). The Runners table still searches all of them.`,
        },
    },
    maxRows: {
        projection: true,
        persist: true,
        default: MAX_ROWS,
        normalize: (value) => clampInt(value, MIN_ROWS, MAX_ROWS, MAX_ROWS),
        schema: {
            type: "integer",
            minimum: MIN_ROWS,
            maximum: MAX_ROWS,
            description: `Stop a projection after this many job rows (default ${MAX_ROWS}, which is also the ceiling). Lower it to cap what a projection over a busy organization costs; the panel reports when a projection was truncated.`,
        },
    },
    rowBudget: {
        rows: true,
        persist: true,
        default: DEFAULT_ROW_BUDGET,
        normalize: (value) => clampInt(value, MIN_ROW_BUDGET, MAX_ROW_BUDGET, DEFAULT_ROW_BUDGET),
        schema: {
            type: "integer",
            minimum: MIN_ROW_BUDGET,
            maximum: MAX_ROW_BUDGET,
            description: `How many raw job rows the Job explorer holds in the browser (default ${DEFAULT_ROW_BUDGET}). It sizes the explorer's own collection alone, so changing it never discards the fleet metrics already in hand.`,
        },
    },
};

const FIELD_NAMES = Object.keys(FIELDS);

function fieldsWhere(flag) {
    return FIELD_NAMES.filter((name) => FIELDS[name][flag] === true);
}

/** Fields naming what is analysed, rather than how. */
export const TARGET_FIELDS = fieldsWhere("target");
/** Fields that decide what has to be fetched from the CLI. */
export const COLLECTION_FIELDS = fieldsWhere("collection");
/** Fields that decide how the collection already in hand is read. */
export const PROJECTION_FIELDS = fieldsWhere("projection");
/** Fields that decide which raw job rows the explorer collects. */
export const ROW_FIELDS = fieldsWhere("rows");
/** Fields remembered per target between sessions. */
export const PERSISTED_FIELDS = fieldsWhere("persist");

/** A query with every field at its default and no target. */
export const DEFAULT_QUERY = Object.freeze(
    Object.fromEntries(FIELD_NAMES.map((name) => [name, Array.isArray(FIELDS[name].default) ? [] : FIELDS[name].default])),
);

/**
 * The scope a query names. Derived rather than stored so that it can never
 * contradict the fields it is read from; `--all-repos` follows from it the
 * same way, because the CLI rejects `--owner` without it.
 */
export function scopeOf(query) {
    if (text(query?.repo)) {
        return "repo";
    }
    return text(query?.owner) ? "org" : "repo";
}

/** Complete an arbitrary input into a canonical query. */
export function normalizeQuery(input = {}) {
    const query = {};
    for (const name of FIELD_NAMES) {
        const field = FIELDS[name];
        query[name] = input[name] === undefined ? (Array.isArray(field.default) ? [] : field.default) : field.normalize(input[name]);
    }
    return query;
}

/**
 * The host and owner a query points at, lowercased, as one comparable string.
 *
 * The repository filters are patterns matched against `owner/repo`, so they are
 * only ever meaningful within the one owner they were written for. This is what
 * `applyQueryPatch` compares to decide whether they survive a target switch.
 */
function ownerKeyOf(query) {
    const scope = scopeOf(query);
    const selector = scope === "org" ? text(query?.owner) : text(query?.repo);
    const { path } = splitHost(selector, scope === "org" ? 1 : 2);
    return `${queryHost(query)}/${path.split("/")[0]}`.toLowerCase();
}

/**
 * Apply a partial change to a query.
 *
 * Distinct from `normalizeQuery` because the agent action patches rather than
 * replaces: an omitted key has to keep its current value, not fall back to its
 * default. Switching the target is the one place a patch touches a field it
 * did not name, because a leftover owner beside a new repo is not a query the
 * validator would accept.
 */
export function applyQueryPatch(query, patch = {}) {
    const current = normalizeQuery(query);
    const merged = { ...current };
    const naming = {
        repo: patch.repo !== undefined && text(patch.repo) !== "",
        owner: patch.owner !== undefined && text(patch.owner) !== "",
    };
    for (const [name, value] of Object.entries(patch)) {
        if (value === undefined || !FIELDS[name]) {
            continue;
        }
        // An empty `repo` or `owner` reads as "not stated", never as "stop
        // pointing anywhere": a query with no target is not one that can be
        // collected, and the toolbar posts an empty field on every change.
        if ((name === "repo" || name === "owner") && !naming[name]) {
            continue;
        }
        merged[name] = FIELDS[name].normalize(value);
    }
    if (naming.repo && !naming.owner) {
        merged.owner = "";
    } else if (naming.owner && !naming.repo) {
        merged.repo = "";
    }
    if ((naming.repo || naming.owner) && patch.host === undefined) {
        // A new selector carries its own host, embedded or default. Keeping the
        // old one would move a panel on a GitHub Enterprise Server instance to
        // a repository of the same name there rather than the one asked for,
        // and would make a `github.com/...` selector read as a host conflict.
        merged.host = "";
    }
    // A repository filter is a pattern over `owner/repo` on one host, so it can
    // never match once the owner or the host changes: the CLI applies it before
    // collection and exits with "no repositories matched include filter",
    // leaving the panel empty for a reason no part of it points at. Moving
    // between a repository and its own owner keeps them, because there the
    // patterns still describe the repositories on offer.
    const switchingOwner = (naming.repo || naming.owner) && ownerKeyOf(merged) !== ownerKeyOf(current);
    for (const name of ["includeRepos", "excludeRepos"]) {
        if (switchingOwner && patch[name] === undefined) {
            merged[name] = [];
        }
    }
    return normalizeQuery(merged);
}

/** Split a `[HOST/]...` selector into its host and the rest. */
function splitHost(selector, expectedParts) {
    const parts = text(selector)
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\.git$/, "")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean);
    if (parts.length === expectedParts + 1) {
        return { host: parts[0], path: parts.slice(1).join("/") };
    }
    return { host: "", path: parts.join("/") };
}

/** A query that cannot be collected, carrying the code the canvas reports. */
export class QueryError extends Error {
    constructor({ code, message }) {
        super(message);
        this.name = "QueryError";
        this.code = code;
    }
}

/** Throw `QueryError` unless the query is usable. Returns the query. */
export function assertQuery(query) {
    const problem = validateQuery(query);
    if (problem) {
        throw new QueryError(problem);
    }
    return query;
}

/**
 * Reject a query that names nothing, names two things, or carries a host that
 * disagrees with the one embedded in its selector. Returns `null` when the
 * query is usable, so that a caller can raise its own error type.
 */
export function validateQuery(query) {
    const repo = text(query?.repo);
    const owner = text(query?.owner);
    const host = text(query?.host);
    if (repo && owner) {
        return {
            code: "target_ambiguous",
            message: "Pass either `owner` to analyse a whole organization or `repo` to analyse one repository, not both.",
        };
    }
    if (!repo && !owner) {
        return {
            code: "target_missing",
            message: 'Nothing to analyse. Pass {"repo": "OWNER/REPO"} or {"owner": "ORG"}.',
        };
    }
    const selector = repo || owner;
    const expected = repo ? 2 : 1;
    const split = splitHost(selector, expected);
    if (split.path.split("/").filter(Boolean).length !== expected) {
        return repo
            ? { code: "invalid_repo", message: `Invalid repository selector: "${repo}". Use [HOST/]OWNER/REPO` }
            : { code: "invalid_owner", message: `Invalid organization selector: "${owner}". Use [HOST/]OWNER` };
    }
    if (host && split.host && split.host !== host) {
        return {
            code: "host_conflict",
            message: `"${selector}" names host ${split.host}, but host is set to ${host}. Drop one of them.`,
        };
    }
    return null;
}

/**
 * Drop the values a query states twice, so that two spellings of one target
 * share a collection and hash alike. The host embedded in a selector is
 * hoisted into `host`, and the default host is then dropped entirely.
 *
 * Only meaningful once the target has been materialized and validated: a
 * query with no target has nothing to hoist, and one that fails validation
 * would have its contradiction silently resolved.
 */
export function canonicalizeQuery(query) {
    const canonical = normalizeQuery(query);
    const repo = canonical.repo;
    const owner = canonical.owner;
    if (repo || owner) {
        const split = splitHost(repo || owner, repo ? 2 : 1);
        if (split.host) {
            canonical.host = split.host;
        }
        if (repo) {
            canonical.repo = split.path;
        } else {
            canonical.owner = split.path;
        }
    }
    if (canonical.host === DEFAULT_HOST) {
        canonical.host = "";
    }
    return canonical;
}

function hash(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function pick(query, names) {
    return Object.fromEntries(names.map((name) => [name, query?.[name] ?? DEFAULT_QUERY[name]]));
}

/** Identity of the whole query, target and settings alike. */
export function queryId(query) {
    return hash(pick(query, FIELD_NAMES));
}

/**
 * Identity of the data a query asks the CLI for. Two queries with the same
 * collection id need one collection between them.
 */
export function collectionId(query) {
    return hash(pick(query, COLLECTION_FIELDS));
}

/**
 * Identity of the projection a query asks for. Not a cache key on its own -
 * `{topRunners: 40}` is the same in every window of every target - so it is
 * only ever compared within one collection.
 */
export function projectionId(query) {
    return hash(pick(query, PROJECTION_FIELDS));
}

/** Identity of the raw job rows a query asks for, row schema included. */
export function rowQueryId(query) {
    return hash({ ...pick(query, ROW_FIELDS), schema: ROW_SCHEMA_VERSION });
}

/** The fields worth remembering for a target between sessions. */
export function persistedFields(query) {
    return pick(query, PERSISTED_FIELDS);
}

/** The host a query reads from, spelled the way `gh` itself spells it. */
export function queryHost(query) {
    const host = text(query?.host);
    if (host) {
        return host;
    }
    const selector = text(query?.repo) || text(query?.owner);
    return splitHost(selector, text(query?.repo) ? 2 : 1).host || DEFAULT_HOST;
}

/**
 * The parsed target the collection layer reads. Derived on the spot and never
 * stored: the query is the one place a target is remembered.
 */
export function targetOf(query) {
    const scope = scopeOf(query);
    const host = queryHost(query);
    const selector = scope === "org" ? text(query?.owner) : text(query?.repo);
    const parsed = scope === "org" ? parseOrg(selector) : parseRepo(selector);
    return { ...parsed, host: host === DEFAULT_HOST ? null : host };
}

/** The flat settings object the collection layer reads. */
export function filtersOf(query) {
    const normalized = normalizeQuery(query);
    const filters = {};
    for (const name of FIELD_NAMES) {
        if (!FIELDS[name].target) {
            filters[name] = normalized[name];
        }
    }
    return filters;
}

/** The collection limits a query carries, in the shape `collectSnapshot` reads. */
export function limitsOf(query) {
    return { ...DEFAULTS, maxRuns: query?.maxRuns ?? DEFAULTS.maxRuns, jobConcurrency: query?.jobConcurrency ?? DEFAULTS.jobConcurrency };
}

/** The selector form the UI displays. */
export function formatQuery(query) {
    const scope = scopeOf(query);
    const host = queryHost(query);
    const selector = scope === "org" ? text(query?.owner) : text(query?.repo);
    const path = splitHost(selector, scope === "org" ? 1 : 2).path;
    return host === DEFAULT_HOST ? path : `${host}/${path}`;
}

/**
 * The identity the store keys an entry by, and the instance compares to detect a
 * target change. It carries the scope because `formatQuery` alone cannot: a
 * repository `owner/repo` on the default host and an organization `owner` on a
 * host named `owner` both render to the same two-segment selector, yet they are
 * two distinct targets that must not share or overwrite one collection. The
 * display selector is kept separate so nothing user-facing shows the scope
 * prefix.
 */
export function targetKey(query) {
    return `${scopeOf(query)}:${formatQuery(query)}`;
}

/**
 * A readable summary of a query, for logs, error messages and anything the
 * browser shows. The identities above are opaque on purpose; this is what is
 * carried alongside them so that a mismatch can still be diagnosed.
 */
export function describeScope(query) {
    const canonical = canonicalizeQuery(query);
    return {
        target: formatQuery(canonical),
        host: queryHost(canonical),
        scope: scopeOf(canonical),
        allRepos: scopeOf(canonical) === "org",
        days: canonical.days,
        event: canonical.event,
        branch: canonical.branch,
        workflow: canonical.workflow,
        labels: [...canonical.labels],
        maxRuns: canonical.maxRuns,
        rowBudget: canonical.rowBudget,
    };
}

/** The window a query covers, ending at the time its data was collected. */
export function windowFor(query, collectedAt) {
    const to = collectedAt ? new Date(collectedAt).getTime() : Date.now();
    const end = Number.isFinite(to) ? to : Date.now();
    const days = normalizeQuery(query).days;
    return { from: end - days * 86400000, to: end, days };
}

function schemaProperties(names) {
    return Object.fromEntries(names.map((name) => [name, { ...FIELDS[name].schema }]));
}

/**
 * The one schema. The canvas input and the agent action publish the same
 * properties, so a field can never be settable from one and not the other -
 * which is exactly how the two hand-written schemas this replaces had drifted.
 */
export const queryProperties = schemaProperties(FIELD_NAMES);

export const querySchema = {
    type: "object",
    properties: queryProperties,
    additionalProperties: false,
};
