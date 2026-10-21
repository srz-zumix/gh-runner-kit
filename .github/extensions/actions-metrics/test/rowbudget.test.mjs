import test from "node:test";
import assert from "node:assert/strict";
import { collectJobRows } from "../lib/jobrows.mjs";
import { RowStore } from "../lib/rowstore.mjs";
import { applyQueryPatch, collectionId, datasetQueryId, FIELDS, normalizeQuery, rowQueryId } from "../lib/query.mjs";
import { fieldByName, MAX_ROW_BUDGET } from "../shared/fields.mjs";
import { decodeRowPayload } from "../shared/rowpayload.mjs";

test("row budget accepts a million rows consistently without changing collection scope or defaults", () => {
    assert.equal(MAX_ROW_BUDGET, 1000000);
    const field = fieldByName("rowBudget");
    assert.equal(field.min, 500);
    assert.equal(field.max, 1000000);
    assert.equal(FIELDS.rowBudget.schema.maximum, 1000000);
    const original = normalizeQuery({ repo: "example/project" });
    assert.equal(original.rowBudget, 20000);
    assert.equal(original.maxRows, 400000);
    for (const value of [500, 200000, 200001, 500000, 1000000]) {
        assert.equal(normalizeQuery({ rowBudget: value }).rowBudget, value);
    }
    const increased = applyQueryPatch(original, { rowBudget: 1000000 });
    assert.equal(increased.rowBudget, 1000000);
    assert.equal(datasetQueryId(increased), datasetQueryId(original));
    assert.equal(collectionId(increased), collectionId(original));
    assert.notEqual(rowQueryId(increased), rowQueryId(original));
    for (const value of [499, 1000001, NaN, Infinity]) {
        assert.equal(normalizeQuery({ rowBudget: value }).rowBudget, 20000);
    }
});

test("collection and serialized row cache retain exactly a million selected jobs", async () => {
    const jobs = Array.from({ length: 1000001 }, (_, index) => ({ JobID: String(2000000 + index) }));
    const dataset = {
        meta: {
            id: "synthetic-dataset", collectedAt: "2026-01-01T00:02:00Z", truncated: false,
            window: { Start: "2026-01-01T00:00:00Z", End: "2026-01-01T00:02:00Z" },
        },
        select: () => ({ jobs }),
    };
    const filters = { rowBudget: 1000000 };
    const overflow = await collectJobRows({ filters, dataset });
    assert.equal(overflow.rows.length, 1000000);
    assert.equal(overflow.budget, 1000000);
    assert.equal(overflow.truncated, true);
    assert.equal(overflow.rows[0].JobID, "2000000");
    assert.equal(overflow.rows.at(-1).JobID, "2999999");
    jobs.pop();
    const exact = await collectJobRows({ filters, dataset });
    assert.equal(exact.rows.length, 1000000);
    assert.equal(exact.truncated, false);
    const store = new RowStore({ withDataset: async (_query, read) => read(dataset) });
    const query = normalizeQuery({ repo: "example/project", rowBudget: 1000000 });
    store.request({ query });
    await store.entry(store.signature(query)).inflight;
    const ready = store.describe(store.signature(query));
    assert.equal(ready.status, "ready", ready.error);
    assert.equal(ready.count, 1000000);
    assert.equal(ready.budget, 1000000);
    assert.equal(ready.truncated, false);
    const payload = decodeRowPayload(store.payload(ready.id, ready.revision).bytes);
    assert.equal(payload.id, ready.id);
    assert.equal(payload.revision, ready.revision);
    assert.equal(payload.rows.length, 1000000);
    assert.equal(payload.rows.at(-1).JobID, "2999999");
    assert.equal(payload.budget, 1000000);
    assert.equal(payload.datasetId, "synthetic-dataset");
});
