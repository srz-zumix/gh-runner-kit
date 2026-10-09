import { filterAttemptRows } from "../lib/stepattempts.mjs";

function key(repo, run) {
    return JSON.stringify([repo, String(run)]);
}

export function matchesWorkflow(run, workflow) {
    if (!workflow) return true;
    const value = String(workflow).trim();
    const path = String(run.workflowPath ?? "").split("@")[0];
    return String(run.workflowId) === value || path === value || path.split("/").at(-1) === value;
}

/** Select a view without changing or recollecting the shared execution dataset. */
export function selectDatasetJobs(dataset, { workflow = "", runBudget = 0, latestOnly = false, kind = "all", runner = "", excludeRunners = [], labels = [] } = {}) {
    const matching = dataset.runs.filter(run => matchesWorkflow(run, workflow))
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || String(b.id).localeCompare(String(a.id)));
    const counts = new Map();
    const selected = new Set();
    let sampled = false;
    for (const run of matching) {
        const count = counts.get(run.repository) ?? 0;
        if (runBudget > 0 && count >= runBudget) {
            sampled = true;
            continue;
        }
        counts.set(run.repository, count + 1);
        selected.add(key(run.repository, run.id));
    }
    const jobs = dataset.jobs.filter(row => selected.has(key(row.Repo, row.RunID)) && (!latestOnly || row.Latest === true));
    return { ...filterAttemptRows({ jobs, steps: [] }, { kind, runner, excludeRunners, labels }), sampled, selected };
}
