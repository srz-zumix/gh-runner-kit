// Collecting the raw `gh runner-kit metrics jobs` rows the explorer works on.
//
// Unlike the projection in `jobs.mjs`, which aggregates the stream server-side
// and returns a few thousand numbers, this keeps the rows themselves: the
// explorer's whole point is that the rows reach the browser once and every
// filter after that is answered there.
//
// What is collected is therefore deliberately the widest set the explorer's
// filters could ask for. Narrowing here would be invisible in the panel: a
// reader who picks "GitHub-hosted" from a facet would be shown an empty chart
// with no way to tell that the rows had never been fetched.

import { jobRowsCommand, probeRunnerKit } from "./runnerkit.mjs";
import { runLines } from "./jobs.mjs";

// Declared in shared/fields.mjs so the toolbar bounds match the normalizer.
import { DEFAULT_ROW_BUDGET, MAX_ROW_BUDGET, MIN_ROW_BUDGET } from "../shared/fields.mjs";

/** Rows the browser is asked to hold unless the setting says otherwise. */
export { DEFAULT_ROW_BUDGET, MAX_ROW_BUDGET, MIN_ROW_BUDGET };

// The identity of a row collection is `rowQueryId` in `query.mjs`, over the
// fields declared there as `rows: true`. Deliberately narrower than
// `collectionId` in two directions at once: it ignores `groupBy`, `bucket`,
// `targetWait`, `targetUtilization` and `billable`, none of which change a job
// row, and it includes `rowBudget`, which changes how much of the window the
// rows cover. `jobKind` is absent for the same reason the CLI is called with
// `--kind all`: the kind is an explorer filter, answered in the browser.

/**
 * Collect the raw rows for one query.
 *
 * `budget + 1` rows are read so that truncation can be told apart from a window
 * that happens to hold exactly `budget` rows. The extra row is dropped.
 */
export async function collectJobRows({ target, filters, limits, cwd, signal, onProgress } = {}) {
    const budget = filters?.rowBudget ?? DEFAULT_ROW_BUDGET;
    const cap = Math.max(MIN_ROW_BUDGET, Math.min(MAX_ROW_BUDGET, budget));
    const { args, env } = jobRowsCommand({
        target,
        filters,
        limits,
        probe: await probeRunnerKit(cwd),
        // Everything, so that every explorer filter has something to narrow.
        kind: "all",
        // No `--runner` or `--exclude-runner`: runner selection is a filter the
        // browser answers, and a CLI-side exclusion would silently empty it.
        pattern: "",
        exclusions: [],
        limit: cap + 1,
    });

    const rows = [];
    let malformed = 0;
    let read = 0;
    const startedAt = Date.now();

    const { truncated: stopped } = await runLines(
        args,
        env,
        cwd,
        (line) => {
            read += 1;
            if (rows.length > cap) {
                // The extra row has already been seen; nothing after it is
                // needed and reading on would only cost time.
                return false;
            }
            try {
                rows.push(JSON.parse(line));
            } catch {
                malformed += 1;
            }
            if (read % 5000 === 0) {
                onProgress?.(`Read ${read} job rows`);
            }
            return true;
        },
        signal,
    );

    // Only a row beyond the budget proves there were more. A malformed line is
    // counted separately so that a broken trailing line cannot make a capped
    // result look complete, nor a complete one look capped.
    const truncated = rows.length > cap || stopped;
    if (rows.length > cap) {
        rows.length = cap;
    }

    return {
        rows,
        truncated,
        malformed,
        budget: cap,
        collectedAt: Date.now(),
        durationMs: Date.now() - startedAt,
    };
}
