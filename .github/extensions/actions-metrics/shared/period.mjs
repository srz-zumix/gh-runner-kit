/** API dates are UTC dates or RFC3339 timestamps with an explicit timezone. */
export function periodTime(value) {
    const text = String(value ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(text)) return NaN;
    if (text.length > 10 && (Number(text.slice(11, 13)) > 23 || Number(text.slice(14, 16)) > 59 || Number(text.slice(17, 19)) > 59)) return NaN;
    const date = text.slice(0, 10);
    const calendar = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date) return NaN;
    return Date.parse(text.length === 10 ? `${text}T00:00:00Z` : text);
}

export function normalizePeriodTime(value) {
    const text = String(value ?? "").trim();
    const time = periodTime(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : text;
}

export function localPeriodValue(value) {
    const time = periodTime(value);
    if (!Number.isFinite(time)) return "";
    const date = new Date(time);
    return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}

/** A filter may narrow a retained window, never claim uncollected coverage. */
export function filteredWindow(window, { filterFrom = "", filterTo = "" } = {}) {
    const start = periodTime(window?.Start);
    const end = periodTime(window?.End);
    const from = filterFrom ? periodTime(filterFrom) : start;
    const to = filterTo ? periodTime(filterTo) : end;
    let message;
    if (![start, end, from, to].every(Number.isFinite) || start >= end || from >= to) {
        message = "The period must have valid timestamps with its start before its exclusive end";
    } else if (from < start || to > end) {
        message = `The dataset filter must stay within the collected period [${window.Start}, ${window.End}); change Collection to fetch a wider period`;
    }
    if (message) {
        const error = new Error(message);
        error.code = "period_invalid";
        throw error;
    }
    return { Start: new Date(from).toISOString(), End: new Date(to).toISOString() };
}

export const PERIOD_PRESETS = [
    { id: "today", label: "Today" },
    { id: "yesterday", label: "Yesterday" },
    { id: "this-week", label: "This week" },
    { id: "last-week", label: "Last week" },
    { id: "this-month", label: "This month" },
    { id: "last-month", label: "Last month" },
    { id: "last-7-days", label: "Last 7 days" },
    { id: "last-30-days", label: "Last 30 days" },
];

/** Calendar presets use local boundaries; rolling days are exact 24-hour periods. */
export function periodPreset(id, { now = Date.now(), coverage } = {}) {
    const date = new Date(now);
    if (!Number.isFinite(date.getTime()) || !PERIOD_PRESETS.some(preset => preset.id === id)) {
        throw new Error("Unknown period preset or invalid current time");
    }
    const year = date.getFullYear();
    const month = date.getMonth();
    const day = date.getDate();
    const monday = day - (date.getDay() + 6) % 7;
    let start;
    let end = date;
    switch (id) {
        case "today": start = new Date(year, month, day); break;
        case "yesterday":
            start = new Date(year, month, day - 1);
            end = new Date(year, month, day);
            break;
        case "this-week": start = new Date(year, month, monday); break;
        case "last-week":
            start = new Date(year, month, monday - 7);
            end = new Date(year, month, monday);
            break;
        case "this-month": start = new Date(year, month, 1); break;
        case "last-month":
            start = new Date(year, month - 1, 1);
            end = new Date(year, month, 1);
            break;
        case "last-7-days": start = new Date(date.getTime() - 7 * 86400000); break;
        case "last-30-days": start = new Date(date.getTime() - 30 * 86400000); break;
    }
    const requested = { Start: start.toISOString(), End: end.toISOString() };
    const bounds = coverage ? filteredWindow(coverage) : requested;
    const from = Math.max(start.getTime(), periodTime(bounds.Start));
    const to = Math.min(end.getTime(), periodTime(bounds.End));
    const available = from < to;
    return {
        requested,
        available,
        window: available ? { Start: new Date(from).toISOString(), End: new Date(to).toISOString() } : null,
        partial: Boolean(coverage) && (from !== start.getTime() || to !== end.getTime()),
        reason: available ? "" : coverage ? "No collected data overlaps this preset." : "This period has no elapsed time yet.",
    };
}
