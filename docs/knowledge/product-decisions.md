---
sources:
  - plugins/truss/tests/store.check.ts
  - plugins/truss/bin/store.ts
  - plugins/truss/tests/workflows.check.ts
verified: 4705791bf65c28393cd89b0b2ad8184d2e92d2f2
---

# Product decisions

## a0-foundation: store staleness test title

- Question: `store.check.ts` is titled "a lock older than 200 s is taken over" but the code threshold is 120 s (`STALE_AGE_MS`, `plugins/truss/bin/store.ts:155`). Retitle it or amend the acceptance?
- Answer: keep the pinned title and do not amend the acceptance.
- Reason: contract-025 section 8 uses that exact title, and it is true: the case plants a lock 201 s old with a live pid, which is over the 120 s threshold. The title does not pin the 120 s value itself. To pin it, add one untitled case: a live-pid lock about 121 s old is taken over, one about 100 s old is waited on.
- Decided by: product-owner persona (crew a0-foundation).

## a0-foundation: long-term cost paragraph test

- Answer: assert the paragraph byte for byte on the prompts the stubbed agents received (a-qc through `runStage`, truss-checker through `runPlan`, in `plugins/truss/tests/workflows.check.ts`), not on script source text. The source-text test in `wiring-025.check.ts` was deleted.
- Decided by: product-owner persona, applied in commit f197412 (crew a0-foundation).

## b-cost: busy usage lock before the first sweep

- Question: with a busy usage lock and no `usage-cursor.json`, should `budgetVerdict` hold until the first sweep lands?
- Answer: no. `budgetVerdict` reads `usage.jsonl` as it stands and holds only on: not priced, found 0 with a budget set, limit reached. `crewCost` still returns `usd: null` ('usage sweep still running') while unswept, so the ledger never records a cost too low. The test at `cost.check.ts` asserts `held: false` for that case.
- Reason: contract-025 section 4 lists only those holds; the first-sweep hold BLOCKED 3 of 4 crews started together (ADR-0038, `plugins/truss/bin/cost.ts` `budgetVerdict`). Known limit: no budget is enforced until the first sweep lands.
- Decided by: product-owner persona (crew b-cost).
