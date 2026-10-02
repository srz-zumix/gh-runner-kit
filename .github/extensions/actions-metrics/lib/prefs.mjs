// User-global preferences for the dashboard (last target, per-target filters).
// Project-scope extensions must not write user-global state into the
// repository, so this lives under $COPILOT_HOME/extensions/<name>/artifacts/.

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const EXTENSION_NAME = "actions-metrics";

function copilotHome() {
    return process.env.COPILOT_HOME && process.env.COPILOT_HOME.trim() !== ""
        ? process.env.COPILOT_HOME
        : join(homedir(), ".copilot");
}

const ARTIFACTS_DIR = join(copilotHome(), "extensions", EXTENSION_NAME, "artifacts");
const PREFS_FILE = join(ARTIFACTS_DIR, "prefs.json");

const EMPTY = { lastTarget: null, lastScope: "repo", filtersByTarget: {} };

let cache = null;
// The cold read in flight, shared so concurrent first reads cannot each initialize
// cache and drop an update another caller already merged into it.
let loading = null;

// Settings now persist on every change, not only after a collection, so two
// changes in quick succession issue two writes. Chained rather than issued in
// parallel: an older write finishing last would put the older value on disk.
let writes = Promise.resolve();

async function readPrefs() {
    try {
        const raw = await readFile(PREFS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        return {
            ...EMPTY,
            ...parsed,
            // Preferences written before organization targets existed.
            lastTarget: parsed.lastTarget ?? parsed.lastRepo ?? null,
            filtersByTarget: parsed.filtersByTarget ?? parsed.filtersByRepo ?? {},
        };
    } catch {
        return { ...EMPTY, filtersByTarget: {} };
    }
}

export async function loadPrefs() {
    if (cache) {
        return cache;
    }
    loading ??= readPrefs().then((prefs) => {
        cache ??= prefs;
        return cache;
    });
    return loading;
}

export async function savePrefs(update) {
    await loadPrefs();
    return commitPrefs(update);
}

// commitPrefs merges update into the loaded preferences synchronously, before its first
// await, so a caller that checked its request is still current right before calling it
// commits against the latest map. The per-target maps are merged entry by entry, so
// concurrent updates for different targets do not drop each other.
async function commitPrefs(update) {
    const current = cache;
    cache = {
        ...current,
        ...update,
        filtersByTarget: { ...current.filtersByTarget, ...(update.filtersByTarget ?? {}) },
        stepTimelineByTarget: { ...(current.stepTimelineByTarget ?? {}), ...(update.stepTimelineByTarget ?? {}) },
    };
    // Serialized at call time so the chain writes the values in the order they
    // were asked for, whatever order the writes are scheduled in.
    const payload = `${JSON.stringify(cache, null, 2)}\n`;
    const write = writes.then(async () => {
        await mkdir(ARTIFACTS_DIR, { recursive: true });
        await writeFile(PREFS_FILE, payload, "utf8");
    });
    // A failed write must not stop the next one from being attempted.
    writes = write.catch(() => {});
    await write;
    return cache;
}

/**
 * Remember a target's filters keyed by its scope-aware identity, while storing the
 * plain display selector as `lastTarget` so `materializeTarget` can still parse it back
 * into a target. Keying the filters by the identity keeps two targets that share one
 * display selector (a repository and a like-named organization on a matching host) from
 * overwriting each other's saved filters.
 */
export async function rememberFilters(identity, selector, scope, filters) {
    const current = await loadPrefs();
    return savePrefs({
        lastTarget: selector,
        lastScope: scope,
        filtersByTarget: { ...current.filtersByTarget, [identity]: filters },
    });
}

/**
 * Remember the Step timeline settings of one target. isCurrent is checked after the
 * preferences are loaded and right before they are merged, so a request a newer one
 * superseded never overwrites the newer settings.
 */
export async function rememberStepSettings(identity, settings, isCurrent = () => true) {
    await loadPrefs();
    if (!isCurrent()) {
        return cache;
    }
    return commitPrefs({ stepTimelineByTarget: { [identity]: settings } });
}

export const prefsPath = PREFS_FILE;
