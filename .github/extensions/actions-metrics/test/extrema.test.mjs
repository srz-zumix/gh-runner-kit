import test from "node:test";
import assert from "node:assert/strict";
import { maxOf, minOf } from "../shared/extrema.mjs";

test("extrema preserve Math semantics, including empty inputs, bounds, NaN and signed zero", () => {
    const cases = [
        [], [0], [-0], [0, -0], [-0, 0], [-7, -2, -9], [Infinity, -Infinity],
        [NaN, 1], [1, NaN], ["7", null, false], [undefined, 1],
    ];
    for (const values of cases) {
        assert.equal(maxOf(values), Math.max(...values));
        assert.equal(minOf(values), Math.min(...values));
        for (const bound of [-Infinity, Infinity, -0, 0, 1, NaN]) {
            assert.equal(maxOf(values, bound), Math.max(bound, ...values));
            assert.equal(minOf(values, bound), Math.min(bound, ...values));
        }
    }
    for (const invalid of [1n, Symbol("invalid")]) {
        assert.throws(() => maxOf([invalid]), TypeError);
        assert.throws(() => minOf([invalid]), TypeError);
    }
});

test("extrema examine every value above the function-argument limit without mutating inputs", () => {
    const values = new Float64Array(400_003).fill(3);
    values[values.length - 2] = -19;
    values[values.length - 1] = 37;
    assert.equal(maxOf(values), 37);
    assert.equal(minOf(values), -19);
    assert.equal(maxOf(values, 50), 50);
    assert.equal(minOf(values, -50), -50);
    assert.equal(values[0], 3);
    assert.equal(values[values.length - 2], -19);
    assert.equal(values[values.length - 1], 37);
    assert.equal(maxOf(values.values()), 37);
    assert.equal(minOf(values.values()), -19);
});
