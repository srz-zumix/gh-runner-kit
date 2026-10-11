import { randomUUID } from "node:crypto";

/** Tokenize strings as a unit so only unquoted, unsafe integer literals become BigInts. */
export function parseSnapshot(text) {
    let marker;
    do { marker = randomUUID(); } while (text.includes(marker));
    const encoded = text.replace(/"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token =>
        /^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))
            ? JSON.stringify({ [marker]: token }) : token);
    return JSON.parse(encoded, (key, value) =>
        value && typeof value === "object" && Object.hasOwn(value, marker) ? BigInt(value[marker]) : value);
}

/** Snapshots contain only JSON values and the exact integer literals preserved above. */
export function stringifySnapshot(value) {
    if (typeof value === "bigint") return value.toString();
    if (Array.isArray(value)) return `[${value.map(stringifySnapshot).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${stringifySnapshot(entry)}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

/** Keep all jobs and attempts of the selected runs, including carried-over jobs. */
export function filterSnapshot(snapshot, runs, window) {
    const selected = new Set(runs.map(run => String(run.id)));
    const data = snapshot.Data;
    const jobs = (data.Jobs ?? []).filter(job => selected.has(String(job.run_id)));
    const jobIDs = new Set(jobs.map(job => String(job.id)));
    const repositories = Object.fromEntries(Object.entries(data.RunRepositories ?? {}).filter(([run]) => selected.has(run)));
    const counts = new Map();
    for (const repository of Object.values(repositories)) counts.set(repository, (counts.get(repository) ?? 0) + 1);
    return {
        ...snapshot,
        Data: {
            ...data,
            Window: window,
            Runs: (data.Runs ?? []).filter(run => selected.has(String(run.id))),
            Attempts: (data.Attempts ?? []).filter(run => selected.has(String(run.id))),
            Jobs: jobs,
            LatestJobs: Object.fromEntries(Object.entries(data.LatestJobs ?? {}).filter(([job]) => jobIDs.has(job))),
            RunRepositories: repositories,
            Usage: Object.fromEntries(Object.entries(data.Usage ?? {}).filter(([run]) => selected.has(run))),
            Repos: (data.Repos ?? []).map(repo => ({
                ...repo,
                Runs: counts.get(`${repo.Repository.Owner}/${repo.Repository.Name}`) ?? 0,
            })),
        },
    };
}
