---
sources:
  - plugins/truss/tests/store.check.ts
  - plugins/truss/bin/store.ts
  - plugins/truss/tests/workflows.check.ts
verified: 31e38234699a58641abcf670ecebf9e9899e977e
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

## d2-product-prose: usage files, budget terms and prose pins (21:23)

- Question: where do `usage.jsonl` and `usage-cursor.json` live; are agent count and cost budget one term; are the retro and init test pins phrase-scoped?
- Answer: `usage.jsonl` and `usage-cursor.json` stay in the session dir `D`, not in `shared/` (`plugins/truss/bin/cost.ts`); the crew notes' wording lost to the contract and the doc describes the code. The agent count and the cost budget are distinct terms and stay in separate sentences. The retro and init pins stay phrase-scoped: they pin a phrase, not a whole sentence.
- Reason: contract-025 lines 73-74 place the two files in `D` (a sweep reads only its own session's transcripts) and its line 611 calls the two terms distinct.
- Decided by: product-owner persona (crew d2-product-prose, 21:23).

## b-cost: busy usage lock before the first sweep

- Question: with a busy usage lock and no `usage-cursor.json`, should `budgetVerdict` hold until the first sweep lands?
- Answer: no. `budgetVerdict` reads `usage.jsonl` as it stands and holds only on: not priced, found 0 with a budget set, limit reached. `crewCost` returns `usd: null` ('usage sweep busy') while the usage lock stays busy, so the ledger never records a cost too low. The test at `cost.check.ts` asserts `held: false` for that case.
- Reason: contract-025 section 4 lists only those holds; the first-sweep hold BLOCKED 3 of 4 crews started together (ADR-0038, `plugins/truss/bin/cost.ts` `budgetVerdict`). Known limit: no budget is enforced until the first sweep lands.
- Decided by: product-owner persona (crew b-cost).

## crew-decisions: who answers a crew product call

- Question: when a product owner escalates, who answers and who waits?
- Answer: the program manager answers only an escalation inside approved scope (a `pm-question` item). A call that contradicts approved scope or a client ruling becomes a client-only `scope-change` item (or a `PROPOSAL:`) that the program manager never resolves. Only the asking crew waits, and a resumed stage re-reads the item through `factory inbox`, never a timer. A call touching no scope line is logged and never waits.
- Reason: scope changes are the client to rule on (plan decision 07:22, goal file `crew-decisions.md` approved scope); design in `plugins/truss/docs/adr/0047-crew-decisions-reach-pm.md`.
- Decided by: program manager as product owner (plan finding 3 ruling).
