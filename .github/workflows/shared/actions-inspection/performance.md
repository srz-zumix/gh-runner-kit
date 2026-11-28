---
# Shared check instructions.
---

## Performance (only when selected)

Use the supplied wait and duration distributions and slow job/step evidence.
Job creation-to-start wait includes needs dependencies and concurrency gates;
it is not a pure runner queue measurement. Do not infer runner shortages from
wait alone or compare incomplete populations without noting their coverage.
