---
sources:
  - plugins/truss/bin/lock.ts
  - plugins/truss/tests/hub-split-032.check.ts
verified: 437983e2009ce0a692761a50299c9243956ff8d8
---

## a0-foundation: store staleness test title

- Question: `store.check.ts` is titled "a lock older than 200 s is taken over" but the code threshold is 120 s (`STALE_AGE_MS`, `plugins/truss/bin/lock.ts`). Retitle it or amend the acceptance?
- Answer: keep the pinned title and do not amend the acceptance.
- Reason: contract-025 section 8 uses that exact title, and it is true: the case plants a lock 201 s old with a live pid, which is over the 120 s threshold. The title does not pin the 120 s value itself. To pin it, add one untitled case: a live-pid lock about 121 s old is taken over, one about 100 s old is waited on.
- Decided by: product-owner persona (crew a0-foundation).

## hub-split: the 50-file selection target (R-139)

- Question: the moved code still selects 107 to 115 test files, so the "at most 50" cases cannot pass on real leaves. Rework `bin/**` or drop the bar?
- Answer: R-139 is not met and the hub split keeps no selection bar. No `bin/**` rework and no lazy imports. The three pinned count cases are retitled "every leaf of ... is measured and logged with its selection count" and only log counts and require at least 1 selected file.
- Reason: the suite grew from 164 to 173 test files and about 104 tests run the factory CLI, so leaves select 88 to 115 and no honest bar holds. The follow-up is per-command dispatch in `bin/factory.ts`.
- Decided by: program manager, ruling at 20:45 (`decisions.md`). It overrules the product-owner persona's earlier call d-hub-split-1 (rework `bin/**` so the worst leaf selects at most 50, with the cases measuring each real leaf).
- Sources: `plugins/truss/tests/hub-split-032.check.ts` (`countCase`), `plugins/truss/docs/adr/0049-hub-split.md` (Consequences).
