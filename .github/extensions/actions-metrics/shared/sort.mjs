export function toggleSort(criteria, key, first, append, { clearOnThird = false } = {}) {
    const index = criteria.findIndex((entry) => entry.key === key);
    if (index === -1) {
        const next = { key, direction: first };
        return append ? [...criteria, next] : [next];
    }
    const current = criteria[index];
    // A plain click on a heading that is not the current primary starts a new
    // primary sort at the column's first direction, rather than continuing the
    // primary's click cycle (which would otherwise reset to no sort at all).
    if (!append && index > 0) {
        return [{ key, direction: first }];
    }
    const next = current.direction === first ? (first === "asc" ? "desc" : "asc") : null;
    const kept = append ? criteria.slice() : [current];
    const position = append ? index : 0;
    if (next === null && (append || clearOnThird)) {
        kept.splice(position, 1);
    } else {
        kept[position] = { key, direction: next ?? first };
    }
    return kept;
}

export function validateSorts(criteria, accessors) {
    if (!Array.isArray(criteria) || criteria.length > Object.keys(accessors).length) {
        throw new Error("Invalid sort criteria");
    }
    const seen = new Set();
    for (const entry of criteria) {
        if (!entry || typeof entry.key !== "string" || !Object.hasOwn(accessors, entry.key) ||
            (entry.direction !== "asc" && entry.direction !== "desc") || seen.has(entry.key)) {
            throw new Error("Invalid sort criteria");
        }
        seen.add(entry.key);
    }
    return criteria;
}

export function compareSortValues(left, right, direction) {
    const missingLeft = left === null || left === undefined || (typeof left === "number" && !Number.isFinite(left));
    const missingRight = right === null || right === undefined || (typeof right === "number" && !Number.isFinite(right));
    if (missingLeft || missingRight) {
        return Number(missingLeft) - Number(missingRight);
    }
    const result = typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right));
    return direction === "asc" ? result : -result;
}

export function sortByCriteria(rows, criteria, accessors, tieBreaker) {
    validateSorts(criteria, accessors);
    return rows
        .map((row, index) => ({ row, index, values: criteria.map(({ key }) => accessors[key](row)) }))
        .sort((left, right) => {
            for (let index = 0; index < criteria.length; index += 1) {
                const result = compareSortValues(left.values[index], right.values[index], criteria[index].direction);
                if (result !== 0) {
                    return result;
                }
            }
            return (tieBreaker?.(left.row, right.row) ?? 0) || left.index - right.index;
        })
        .map(({ row }) => row);
}
