// Hand-drawn SVG charts for the job explorer.
//
// Deliberately not a charting library: the panel has no build step and no
// network, and the four shapes here are the only ones the tab draws. Each one
// takes the aggregate it renders and returns a detached node, so the caller can
// place it without the chart knowing anything about the page.
//
// Every chart that can be clicked reports its selection in data terms - a time
// range, a facet value - never in pixels, so the explorer's filter state stays
// the single description of what is on screen.

const NS = "http://www.w3.org/2000/svg";

export function svg(tag, props = {}, children = []) {
    const node = document.createElementNS(NS, tag);
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

/** A chart with nothing to draw says so rather than rendering empty axes. */
function emptyChart(message) {
    const node = document.createElement("p");
    node.className = "chart-empty";
    node.textContent = message;
    return node;
}

function niceCeiling(max) {
    if (!(max > 0)) {
        return 1;
    }
    const magnitude = 10 ** Math.floor(Math.log10(max));
    for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
        if (max <= step * magnitude) {
            return step * magnitude;
        }
    }
    return 10 * magnitude;
}

/**
 * Time labels for a horizontal axis.
 *
 * The format follows the span rather than the bucket: over a month the hour is
 * noise, and within a day the date is.
 */
function timeFormatter(spanMs) {
    if (spanMs <= 6 * 3600000) {
        return (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    }
    if (spanMs <= 3 * 86400000) {
        return (ms) => new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit" });
    }
    return (ms) => new Date(ms).toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Roughly evenly spaced ticks that always include the first and last bucket. */
function axisTicks(count, wanted = 6) {
    if (count <= 1) {
        return [0];
    }
    const step = Math.max(1, Math.round(count / Math.min(wanted, count)));
    const ticks = [];
    for (let index = 0; index < count; index += step) {
        ticks.push(index);
    }
    if (ticks[ticks.length - 1] !== count - 1) {
        ticks.push(count - 1);
    }
    return ticks;
}

/**
 * A drag-to-select overlay in data coordinates.
 *
 * Added to any chart drawn over a bucket axis, so selecting a busy hour on the
 * timeline and reading it on the concurrency chart are the same gesture.
 */
function brush({ root, plot, buckets, bucketMs, onSelect, selection }) {
    if (!onSelect || buckets.length === 0) {
        return;
    }
    const { x, width, y, height } = plot;
    const span = buckets.length;
    const at = (event) => {
        const box = root.getBoundingClientRect();
        // The viewBox and the rendered box differ whenever the card is
        // narrower than the drawing, so the pointer is mapped through the
        // ratio rather than read as a pixel offset.
        const scale = root.viewBox.baseVal.width / (box.width || 1);
        const local = (event.clientX - box.left) * scale - x;
        return Math.max(0, Math.min(span - 1, Math.floor((local / width) * span)));
    };

    const highlight = svg("rect", { class: "brush__range", x, y, width: 0, height, visibility: "hidden" });
    if (selection) {
        const first = Math.max(0, Math.floor((selection.from - buckets[0].start) / bucketMs));
        const last = Math.min(span - 1, Math.ceil((selection.to - buckets[0].start) / bucketMs) - 1);
        if (last >= first) {
            highlight.setAttribute("x", String(x + (first / span) * width));
            highlight.setAttribute("width", String(((last - first + 1) / span) * width));
            highlight.setAttribute("visibility", "visible");
        }
    }
    root.append(highlight);

    let anchor = null;
    const surface = svg("rect", { class: "brush__surface", x, y, width, height });
    surface.addEventListener("pointerdown", (event) => {
        anchor = at(event);
        surface.setPointerCapture(event.pointerId);
    });
    surface.addEventListener("pointermove", (event) => {
        if (anchor === null) {
            return;
        }
        const current = at(event);
        const from = Math.min(anchor, current);
        const to = Math.max(anchor, current);
        highlight.setAttribute("x", String(x + (from / span) * width));
        highlight.setAttribute("width", String(((to - from + 1) / span) * width));
        highlight.setAttribute("visibility", "visible");
    });
    const finish = (event) => {
        if (anchor === null) {
            return;
        }
        const current = at(event);
        const from = Math.min(anchor, current);
        const to = Math.max(anchor, current);
        anchor = null;
        // A click rather than a drag clears the selection: the same gesture
        // that made it undoes it, so there is no way to be stuck inside a
        // range with no visible control to leave it.
        if (from === to && selection) {
            onSelect(null);
            return;
        }
        onSelect({ from: buckets[from].start, to: buckets[to].start + bucketMs });
    };
    surface.addEventListener("pointerup", finish);
    surface.addEventListener("pointercancel", () => {
        anchor = null;
    });
    root.append(surface);
}

/**
 * Jobs over time, stacked by whichever dimension the reader picked.
 *
 * Stacked rather than grouped because the question it answers is "when was
 * this busy, and what was it busy with" - the total has to stay readable as
 * one silhouette.
 */
export function renderStackedTimeline(timeline, { height = 180, onSelect, selection, series = [] } = {}) {
    const buckets = timeline?.buckets ?? [];
    if (buckets.length === 0) {
        return emptyChart("No jobs in this window.");
    }
    const width = 960;
    const plot = { x: 48, y: 8, width: width - 60, height: height - 34 };
    const max = niceCeiling(Math.max(1, ...buckets.map((bucket) => bucket.total)));
    const bandWidth = plot.width / buckets.length;
    const root = svg("svg", {
        class: "chart",
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "none",
        role: "img",
    });

    for (const ratio of [0, 0.5, 1]) {
        const y = plot.y + plot.height * (1 - ratio);
        root.append(svg("line", { class: "chart__grid", x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y }));
        root.append(
            svg("text", {
                class: "chart__label",
                x: plot.x - 6,
                y: y + 4,
                "text-anchor": "end",
                text: Math.round(max * ratio).toLocaleString(),
            }),
        );
    }

    buckets.forEach((bucket, index) => {
        if (bucket.total <= 0) {
            return;
        }
        let cursor = 0;
        const x = plot.x + index * bandWidth;
        const lines = series
            .filter((entry) => (bucket[entry.key] ?? 0) > 0)
            .map((entry) => `${entry.label}: ${(bucket[entry.key] ?? 0).toLocaleString()}`);
        const tip = `${new Date(bucket.t).toLocaleString()}\n${lines.join("\n")}\ntotal: ${bucket.total.toLocaleString()}`;
        for (const entry of series) {
            const value = bucket[entry.key] ?? 0;
            if (value <= 0) {
                continue;
            }
            const barHeight = (value / max) * plot.height;
            cursor += barHeight;
            root.append(
                svg(
                    "rect",
                    {
                        class: `chart__bar chart__bar--${entry.key}`,
                        x,
                        // Widened a hair so neighbouring bars meet: a
                        // half-pixel gap at this density reads as a pattern in
                        // the data rather than as an artifact of the drawing.
                        width: Math.max(1, bandWidth - 0.5) + 0.5,
                        y: plot.y + plot.height - cursor,
                        height: Math.max(0.5, barHeight),
                        fill: entry.color,
                    },
                    // Nested rather than appended alongside: an SVG tooltip is
                    // a child of the shape it describes.
                    [svg("title", { text: tip })],
                ),
            );
        }
    });

    const format = timeFormatter(buckets[buckets.length - 1].t - buckets[0].t);
    for (const index of axisTicks(buckets.length)) {
        root.append(
            svg("text", {
                class: "chart__label",
                x: plot.x + (index + 0.5) * bandWidth,
                y: height - 8,
                "text-anchor": "middle",
                text: format(buckets[index].t),
            }),
        );
    }

    brush({
        root,
        plot,
        buckets: buckets.map((bucket) => ({ start: bucket.t })),
        bucketMs: timeline.bucketMs,
        onSelect,
        selection,
    });
    return root;
}

/** A single series over the same axis, used for peak concurrency. */
export function renderAreaChart(points, { bucketMs, height = 150, onSelect, selection, label = "" } = {}) {
    if (!points || points.length === 0) {
        return emptyChart("No activity in this window.");
    }
    const width = 960;
    const plot = { x: 48, y: 8, width: width - 60, height: height - 34 };
    const max = niceCeiling(Math.max(1, ...points.map((point) => point.v)));
    const step = plot.width / points.length;
    const root = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img" });

    for (const ratio of [0, 0.5, 1]) {
        const y = plot.y + plot.height * (1 - ratio);
        root.append(svg("line", { class: "chart__grid", x1: plot.x, x2: plot.x + plot.width, y1: y, y2: y }));
        root.append(
            svg("text", {
                class: "chart__label",
                x: plot.x - 6,
                y: y + 4,
                "text-anchor": "end",
                text: Math.round(max * ratio).toLocaleString(),
            }),
        );
    }

    // Stepped rather than smoothed: each point is a peak held over a whole
    // bucket, and a curve between two of them would draw values that were
    // never measured.
    const commands = [];
    points.forEach((point, index) => {
        const x = plot.x + index * step;
        const y = plot.y + plot.height * (1 - point.v / max);
        commands.push(index === 0 ? `M ${x} ${y}` : `L ${x} ${y}`, `L ${x + step} ${y}`);
    });
    const line = commands.join(" ");
    root.append(
        svg("path", {
            class: "chart__area",
            d: `${line} L ${plot.x + plot.width} ${plot.y + plot.height} L ${plot.x} ${plot.y + plot.height} Z`,
        }),
        svg("path", { class: "chart__line", d: line }),
    );

    points.forEach((point, index) => {
        root.append(
            svg("rect", { class: "chart__hit", x: plot.x + index * step, y: plot.y, width: step, height: plot.height }, [
                svg("title", { text: `${new Date(point.t).toLocaleString()}\n${label}: ${point.v.toLocaleString()}` }),
            ]),
        );
    });

    const buckets = points.map((point) => ({ start: point.t }));
    const format = timeFormatter(points[points.length - 1].t - points[0].t);
    for (const index of axisTicks(points.length)) {
        root.append(
            svg("text", {
                class: "chart__label",
                x: plot.x + (index + 0.5) * step,
                y: height - 8,
                "text-anchor": "middle",
                text: format(points[index].t),
            }),
        );
    }
    brush({ root, plot, buckets, bucketMs, onSelect, selection });
    return root;
}

/** A fixed-bin distribution, drawn as columns because the bins are ordered. */
export function renderHistogram(bins, { height = 140, highlight = null } = {}) {
    const total = (bins ?? []).reduce((sum, bin) => sum + bin.count, 0);
    if (!total) {
        return emptyChart("Nothing measured yet.");
    }
    const width = 960;
    const plot = { x: 8, y: 8, width: width - 16, height: height - 40 };
    const max = Math.max(...bins.map((bin) => bin.count));
    const band = plot.width / bins.length;
    const root = svg("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: "none", role: "img" });

    bins.forEach((bin, index) => {
        const barHeight = max > 0 ? (bin.count / max) * plot.height : 0;
        root.append(
            svg(
                "rect",
                {
                    class: `chart__bar${highlight === index ? " chart__bar--on" : ""}`,
                    x: plot.x + index * band + 2,
                    width: Math.max(1, band - 4),
                    y: plot.y + plot.height - barHeight,
                    height: Math.max(0.5, barHeight),
                },
                [svg("title", { text: `${bin.label}: ${bin.count.toLocaleString()} (${((bin.count / total) * 100).toFixed(1)}%)` })],
            ),
            svg("text", {
                class: "chart__label",
                x: plot.x + index * band + band / 2,
                y: height - 8,
                "text-anchor": "middle",
                text: bin.label,
            }),
        );
    });
    return root;
}

/**
 * A ranked list with a proportional bar, used for every "top N" card.
 *
 * A list rather than a chart because the label is the point: a reader is
 * looking for which workflow, not for the shape of the distribution.
 */
export function renderRankedBars(entries, { valueOf, formatValue, onPick, active = [], secondaryOf = null, max: given } = {}) {
    if (!entries || entries.length === 0) {
        return emptyChart("Nothing to rank in this selection.");
    }
    const max = given ?? Math.max(...entries.map((entry) => valueOf(entry)));
    const list = document.createElement("ul");
    list.className = "ranked";
    for (const entry of entries) {
        const value = valueOf(entry);
        const selected = active.includes(entry.key);
        const item = document.createElement("li");
        item.className = `ranked__item${selected ? " ranked__item--on" : ""}`;

        const label = document.createElement(onPick ? "button" : "span");
        label.className = "ranked__label";
        label.textContent = entry.label ?? entry.key;
        label.title = entry.label ?? entry.key;
        if (onPick) {
            label.type = "button";
            label.setAttribute("aria-pressed", String(selected));
            label.addEventListener("click", () => onPick(entry));
        }

        const track = document.createElement("div");
        track.className = "ranked__track";
        const fill = document.createElement("div");
        fill.className = "ranked__fill";
        fill.style.width = `${max > 0 ? Math.max(1, (value / max) * 100) : 0}%`;
        track.append(fill);

        const amount = document.createElement("span");
        amount.className = "ranked__value";
        amount.textContent = formatValue ? formatValue(entry) : value.toLocaleString();

        item.append(label, track, amount);
        if (secondaryOf) {
            const secondary = secondaryOf(entry);
            if (secondary) {
                const note = document.createElement("span");
                note.className = "ranked__note";
                note.textContent = secondary;
                item.append(note);
            }
        }
        list.append(item);
    }
    return list;
}

/** One horizontal bar split by category, for a breakdown that is a whole. */
export function renderShareBar(entries, { colorOf, onPick, active = [] } = {}) {
    const total = (entries ?? []).reduce((sum, entry) => sum + entry.count, 0);
    if (!total) {
        return emptyChart("Nothing to break down.");
    }
    const wrap = document.createElement("div");
    wrap.className = "share";
    const bar = document.createElement("div");
    bar.className = "share__bar";
    const legend = document.createElement("ul");
    legend.className = "share__legend";

    for (const entry of entries) {
        const ratio = entry.count / total;
        const segment = document.createElement(onPick ? "button" : "div");
        segment.className = `share__segment${active.includes(entry.key) ? " share__segment--on" : ""}`;
        segment.style.width = `${ratio * 100}%`;
        if (colorOf) {
            segment.style.background = colorOf(entry.key);
        }
        segment.title = `${entry.key}: ${entry.count.toLocaleString()} (${(ratio * 100).toFixed(1)}%)`;
        if (onPick) {
            segment.type = "button";
            segment.addEventListener("click", () => onPick(entry));
        }
        bar.append(segment);

        const item = document.createElement("li");
        item.className = "share__legend-item";
        const swatch = document.createElement("span");
        swatch.className = "share__swatch";
        if (colorOf) {
            swatch.style.background = colorOf(entry.key);
        }
        const text = document.createElement("span");
        text.textContent = `${entry.key} · ${entry.count.toLocaleString()} (${(ratio * 100).toFixed(0)}%)`;
        item.append(swatch, text);
        legend.append(item);
    }
    wrap.append(bar, legend);
    return wrap;
}

/**
 * A stable colour per category.
 *
 * Hashed from the name rather than taken from a rotating palette so that one
 * workflow keeps its colour as the reader filters: a legend that reshuffles
 * on every click is worse than no colour at all.
 */
export function colorFor(key) {
    let hash = 0;
    const text = String(key ?? "");
    for (let index = 0; index < text.length; index += 1) {
        hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
    }
    return `hsl(${hash % 360} 62% 52%)`;
}

/**
 * The conventional colour of a run or job conclusion, matching the segments of
 * the overview chart, which reads green for success and red for failure.
 *
 * Only the three conclusions that convention actually speaks for are named.
 * Everything else keeps its hashed colour, because a shared grey would leave
 * the legend with several swatches the reader cannot tell apart, and because a
 * conclusion this does not know is better shown as distinct than as a guess.
 */
const CONCLUSION_COLORS = {
    success: "var(--success)",
    failure: "var(--danger)",
    cancelled: "var(--muted)",
};

export function conclusionColorFor(key) {
    return CONCLUSION_COLORS[String(key ?? "").toLowerCase()] ?? colorFor(key);
}
