---
sources:
  - plugins/truss/bin/lock.ts
---

## a0-foundation: store staleness test title

- Question: `store.check.ts` is titled "a lock older than 200 s is taken over" but the code threshold is 120 s (`STALE_AGE_MS`, `plugins/truss/bin/lock.ts`). Retitle it or amend the acceptance?
- Answer: keep the pinned title and do not amend the acceptance.
- Reason: contract-025 section 8 uses that exact title, and it is true: the case plants a lock 201 s old with a live pid, which is over the 120 s threshold. The title does not pin the 120 s value itself. To pin it, add one untitled case: a live-pid lock about 121 s old is taken over, one about 100 s old is waited on.
- Decided by: product-owner persona (crew a0-foundation).
