const ROWS_PER_CHUNK = 1000;

// Keep a valid JSON response, with bounded row batches on separate lines so neither
// serialization nor worker decoding needs a dataset-sized JavaScript string.
export function* rowPayloadChunks({ rows, ...metadata }) {
    const header = JSON.stringify({ ...metadata, rows: [] });
    yield `${header.slice(0, -2)}\n`;
    for (let start = 0; start < rows.length; start += ROWS_PER_CHUNK) {
        const batch = JSON.stringify(rows.slice(start, start + ROWS_PER_CHUNK));
        yield `${start === 0 ? "" : ","}${batch.slice(1, -1)}\n`;
    }
    yield "]}\n";
}

export function decodeRowPayload(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const decoder = new TextDecoder();
    const headerEnd = bytes.indexOf(10);
    // An already-open provider may still have the old compact JSON cached.
    if (headerEnd === -1) return JSON.parse(decoder.decode(bytes));
    const header = decoder.decode(bytes.subarray(0, headerEnd)).trim();
    if (!header.endsWith('"rows":[')) throw new Error("The explorer row payload has an invalid header");
    const payload = JSON.parse(`${header}]}`);
    let complete = false;
    for (let offset = headerEnd + 1; offset < bytes.length;) {
        const next = bytes.indexOf(10, offset);
        const end = next === -1 ? bytes.length : next;
        let line = decoder.decode(bytes.subarray(offset, end)).trim();
        offset = end + 1;
        if (!line) continue;
        if (complete) throw new Error("The explorer row payload has content after its end");
        if (line === "]}") {
            complete = true;
            continue;
        }
        if (payload.rows.length > 0) {
            if (!line.startsWith(",")) throw new Error("The explorer row payload is missing a batch separator");
            line = line.slice(1);
        }
        const batch = JSON.parse(`[${line}]`);
        if (batch.length === 0) throw new Error("The explorer row payload has an empty batch");
        for (const row of batch) payload.rows.push(row);
    }
    if (!complete) throw new Error("The explorer row payload is incomplete");
    return payload;
}
