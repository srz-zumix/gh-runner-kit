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

// Settings now persist on every change, not only after a collection, so two
// changes in quick succession issue two writes. Chained rather than issued in
// parallel: an older write finishing last would put the older value on disk.
let writes = Promise.resolve();

export async function loadPrefs() {
    if (cache) {
        return cache;
    }
    try {
        const raw = await readFile(PREFS_FILE, "utf8");
        const parsed = JSON.parse(raw);
        cache = {
            ...EMPTY,
            ...parsed,
            // Preferences written before organization targets existed.
            lastTarget: parsed.lastTarget ?? parsed.lastRepo ?? null,
            filtersByTarget: parsed.filtersByTarget ?? parsed.filtersByRepo ?? {},
        };
    } catch {
        cache = { ...EMPTY, filtersByTarget: {} };
    }
    return cache;
}

export async function savePrefs(update) {
    const current = await loadPrefs();
    cache = { ...current, ...update, filtersByTarget: { ...current.filtersByTarget, ...(update.filtersByTarget ?? {}) } };
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

export const prefsPath = PREFS_FILE;
