// In-memory cache of the job lists the dashboard reads through the REST API.
//
// The job list of a completed run attempt never changes, so re-reading it on
// every Refresh only spends rate limit budget - and after a collection was cut
// short by the limit, it is exactly what makes the next Refresh run into the
// limit again. Entries live for the extension process and are keyed by the run
// attempt, so a re-run is read afresh rather than answered with the attempt
// before it.
//
// A hard refresh invalidates a target by bumping its epoch. A collection that
// started before the bump carries the old epoch and may not write its lists
// back, so a superseded collection cannot repopulate what was just discarded.

export const DEFAULT_JOB_CAPACITY = 50_000;

function targetPrefix(target) {
    return `${String(target?.host ?? "").toLowerCase()}\u0000${target?.nwo ?? ""}\u0000`;
}

export class JobCache {
    constructor({ capacity = DEFAULT_JOB_CAPACITY } = {}) {
        this.capacity = capacity;
        // Insertion order doubles as recency: a hit is re-inserted at the end.
        this.entries = new Map();
        this.size = 0;
        this.epochs = new Map();
    }

    key(target, run) {
        return `${targetPrefix(target)}${run?.id}\u0000${run?.run_attempt ?? 1}`;
    }

    /** The epoch a collection of `target` has to present to write back. */
    epoch(target) {
        return this.epochs.get(targetPrefix(target)) ?? 0;
    }

    /** Whether a run's job list can be cached at all. */
    cacheable(run) {
        return run?.status === "completed" && run?.id !== null && run?.id !== undefined;
    }

    get(target, run) {
        if (!this.cacheable(run)) {
            return null;
        }
        const key = this.key(target, run);
        const jobs = this.entries.get(key);
        if (!jobs) {
            return null;
        }
        this.entries.delete(key);
        this.entries.set(key, jobs);
        return jobs;
    }

    set(target, run, jobs, epoch) {
        if (!this.cacheable(run) || !Array.isArray(jobs) || epoch !== this.epoch(target)) {
            return false;
        }
        // A list larger than the whole cache would only evict everything else.
        if (jobs.length > this.capacity) {
            return false;
        }
        const key = this.key(target, run);
        const previous = this.entries.get(key);
        if (previous) {
            this.entries.delete(key);
            this.size -= previous.length;
        }
        // Step logs are the bulk of a job payload and nothing reads them.
        const slim = jobs.map(({ steps: _steps, ...job }) => job);
        this.entries.set(key, slim);
        this.size += slim.length;
        for (const [oldest, list] of this.entries) {
            if (this.size <= this.capacity) {
                break;
            }
            this.entries.delete(oldest);
            this.size -= list.length;
        }
        return true;
    }

    /** Drop every list of a target and refuse writes from collections already running. */
    invalidate(target) {
        const prefix = targetPrefix(target);
        this.epochs.set(prefix, this.epoch(target) + 1);
        for (const [key, list] of this.entries) {
            if (key.startsWith(prefix)) {
                this.entries.delete(key);
                this.size -= list.length;
            }
        }
    }
}

/** The cache the dashboard collections share. */
export const jobCache = new JobCache();
