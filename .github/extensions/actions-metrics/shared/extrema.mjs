// Keep the argument count fixed even when a dataset contains hundreds of thousands of values.
export function maxOf(values, minimum = -Infinity) {
    let result = Math.max(minimum);
    for (const value of values) result = Math.max(result, value);
    return result;
}

export function minOf(values, maximum = Infinity) {
    let result = Math.min(maximum);
    for (const value of values) result = Math.min(result, value);
    return result;
}
