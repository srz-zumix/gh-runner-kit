// Interval arithmetic shared by the server-side projection and the browser-side
// explorer, so the two cannot drift into reporting different busy time for the
// same jobs.
//
// This module is imported by the extension process (Node) and by the canvas
// renderer and its worker (browser), so it must stay free of any Node-only
// import.
//
// Two measures are deliberately kept apart throughout:
//
//   job time  - the sum of every job interval, which double counts a runner
//               that was running two jobs at once.
//   busy time - the union of those intervals, which is the time the runner was
//               occupied and can never exceed the window.
//
// Conflating them is the easiest way to draw a heatmap cell darker than "busy
// for the whole bucket", so every function here says which one it returns.

/** Every bucket is half-open, `[start, end)`, so an instant belongs to exactly one. */
export function bucketAxis({ fromMs, toMs, bucketMs }) {
    const buckets = [];
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !Number.isFinite(bucketMs) || bucketMs <= 0) {
        return buckets;
    }
    // Aligned to the epoch rather than to the window, so the same bucket width
    // always cuts the axis in the same places and two windows can be compared.
    const start = Math.floor(fromMs / bucketMs) * bucketMs;
    for (let at = start; at < toMs; at += bucketMs) {
        buckets.push({ start: at, end: at + bucketMs });
    }
    return buckets;
}

const BUCKET_STEPS = [
    60000,
    5 * 60000,
    10 * 60000,
    15 * 60000,
    30 * 60000,
    3600000,
    2 * 3600000,
    3 * 3600000,
    6 * 3600000,
    12 * 3600000,
    86400000,
    7 * 86400000,
];

/** The coarsest step that keeps the axis under `targetBuckets` columns. */
export function chooseBucketMs(spanMs, targetBuckets = 80) {
    if (!Number.isFinite(spanMs) || spanMs <= 0) {
        return BUCKET_STEPS[0];
    }
    for (const step of BUCKET_STEPS) {
        if (spanMs / step <= targetBuckets) {
            return step;
        }
    }
    return BUCKET_STEPS.at(-1);
}

/**
 * Highest number of intervals open at once within each bucket.
 *
 * Carried across buckets rather than recomputed: a job that started in an
 * earlier bucket and has not finished still occupies its runner, so each
 * bucket's peak is seeded with the count already open at its start. Recording a
 * peak only where an interval begins - which is the obvious implementation -
 * reads a long job as zero concurrency for every bucket it spans but the first.
 *
 * Intervals are half-open: an end at the same instant as a start frees the
 * runner first, so the two do not read as two concurrent jobs.
 */
export function peakPerBucket(buckets, intervalStarts, intervalEnds) {
    const peaks = new Array(buckets.length).fill(0);
    if (intervalStarts.length === 0) {
        return peaks;
    }
    const starts = Float64Array.from(intervalStarts).sort();
    const ends = Float64Array.from(intervalEnds).sort();

    let open = 0;
    let nextStart = 0;
    let nextEnd = 0;
    for (let index = 0; index < buckets.length; index += 1) {
        const { start, end } = buckets[index];
        // Catch up to the bucket: everything that already closed is released,
        // everything that opened earlier and still runs counts from the start.
        while (nextEnd < ends.length && ends[nextEnd] <= start) {
            nextEnd += 1;
            open -= 1;
        }
        while (nextStart < starts.length && starts[nextStart] <= start) {
            nextStart += 1;
            open += 1;
        }
        let peak = open;
        while (nextStart < starts.length && starts[nextStart] < end) {
            while (nextEnd < ends.length && ends[nextEnd] <= starts[nextStart]) {
                nextEnd += 1;
                open -= 1;
            }
            nextStart += 1;
            open += 1;
            if (open > peak) {
                peak = open;
            }
        }
        peaks[index] = Math.max(0, peak);
    }
    return peaks;
}

/**
 * Union of a set of `[start, end]` intervals, as a flat
 * `[start, end, start, end, ...]` array. Touching intervals are merged, so
 * `[0, 5]` and `[5, 9]` become one `[0, 9]`.
 */
export function mergeIntervals(intervals) {
    if (intervals.length === 0) {
        return [];
    }
    const sorted = intervals.slice().sort((left, right) => left[0] - right[0] || left[1] - right[1]);
    const merged = [];
    let [start, end] = sorted[0];
    for (let index = 1; index < sorted.length; index += 1) {
        const [nextStart, nextEnd] = sorted[index];
        if (nextStart > end) {
            merged.push(start, end);
            start = nextStart;
            end = nextEnd;
            continue;
        }
        if (nextEnd > end) {
            end = nextEnd;
        }
    }
    merged.push(start, end);
    return merged;
}

/**
 * Spread already-merged intervals across the axis, adding the busy time each
 * bucket holds into `into`. The axis is uniform, so the first bucket an
 * interval touches is found by arithmetic rather than by scanning: a window of
 * 2000 buckets and 200000 jobs is otherwise 400 million comparisons.
 */
export function occupancyByBucket(buckets, merged, into) {
    const cells = into ?? new Float64Array(buckets.length);
    if (buckets.length === 0 || merged.length === 0) {
        return cells;
    }
    const axisStart = buckets[0].start;
    const width = buckets[0].end - buckets[0].start;
    for (let cursor = 0; cursor < merged.length; cursor += 2) {
        const start = merged[cursor];
        const end = merged[cursor + 1];
        if (end <= start) {
            continue;
        }
        let index = Math.floor((start - axisStart) / width);
        if (index < 0) {
            index = 0;
        }
        for (; index < buckets.length; index += 1) {
            const bucket = buckets[index];
            if (bucket.start >= end) {
                break;
            }
            const overlap = Math.min(end, bucket.end) - Math.max(start, bucket.start);
            if (overlap > 0) {
                cells[index] += overlap;
            }
        }
    }
    return cells;
}

/** Total of a merged interval list, which is busy time rather than job time. */
export function mergedTotal(merged) {
    let total = 0;
    for (let cursor = 0; cursor < merged.length; cursor += 2) {
        total += merged[cursor + 1] - merged[cursor];
    }
    return total;
}

/** Clip an interval to a half-open window, or null when nothing is left of it. */
export function clipInterval(start, end, windowStart, windowEnd) {
    const from = Math.max(start, windowStart);
    const to = Math.min(end, windowEnd);
    return to > from ? [from, to] : null;
}
