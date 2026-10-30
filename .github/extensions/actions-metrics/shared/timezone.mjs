export function localTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const formats = new Map();

export function localDateKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatTime(value, options = {}) {
    const zone = localTimeZone();
    const key = JSON.stringify([zone, options]);
    let formatter = formats.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(undefined, { ...options, timeZone: zone });
        formats.set(key, formatter);
    }
    return formatter.format(new Date(value));
}

export function formatTimestamp(value) {
    return formatTime(value, {
        year: "numeric", month: "numeric", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "shortOffset",
    });
}
