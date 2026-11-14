---
sources:
  - plugins/truss/tests/store.check.ts
  - plugins/truss/bin/lock.ts
  - plugins/truss/tests/workflows.check.ts
  - .claude/truss.json
  - plugins/truss/tests/inbox.check.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/workflows-src/stage/crew.js
  - plugins/truss/workflows-src/stage/runner.js
  - plugins/truss/docs/adr/0054-heavy-slot-run-limit.md
  - plugins/truss/tests/hub-split-032.check.ts
  - plugins/truss/docs/adr/0052-run-survival.md
  - plugins/truss/bin/factory/start.ts
  - plugins/truss/skills/run/SKILL.md
verified: 8c3b46bc
---

# Product decisions

## a0-foundation: store staleness test title

- Question: `store.check.ts` is titled "a lock older than 200 s is taken over" but the code threshold is 120 s (`STALE_AGE_MS`, `plugins/truss/bin/lock.ts`). Retitle it or amend the acceptance?
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

## resume-guard: finisher lease format and staleness

- Decision: the lease `<truss dir>/locks/finisher-<slug>.lease` holds `{pid, host, since, refreshed, token}`. On the same host a live pid keeps its lease however old (the finisher blocks in spawnSync during the acceptance test and cannot refresh); another host's lease goes stale after 5 minutes without a refresh.
- Reason: R-89 (one finisher per crew) must hold while a long acceptance test runs; a timer cannot refresh a blocked thread.
- Cost: other tools and older plugin versions must agree on the format, and cross-host judgement relies on agreeing clocks. Reversal is cheap.
- Decided by: builder, ADR-0048 (crew resume-guard).

## hygiene: 5.5 prices and the inbox flake

- Pricing: `pricing` in `.claude/truss.json` holds the three 5.5 ids. Cache write is 1.25x input (5m) and 2x input (1h), cache read 0.05x for Opus and Sonnet 5.5 (claude-api skill, `shared/prompt-caching.md`). Haiku 5.5 is priced from the claude-api skill pricing page read 2026-11-12, including its long-context tier (`longContext {abovePromptTokens: 100000, ...}`, priced in `bin/cost.ts` `ratesFor`; see features.md, Long-context price tier).
- Flake: with one busy-loop child per CPU, 20 consecutive whole-file runs of `inbox.check.ts` passed on the dev host (about 29 min, `load-red.mjs`), so the flake does not reproduce there and a red under load is not demonstrable on that host. The acceptance case runs only with `TRUSS_HYGIENE_LOAD_RUNS=20`.
- Decided by: crew hygiene (hygiene-tester, hygiene-builder items).

## crew-decisions: who answers a crew product call

- Question: when a product owner escalates, who answers and who waits?
- Answer: the program manager answers only an escalation inside approved scope (a `pm-question` item). A call that contradicts approved scope or a client ruling becomes a client-only `scope-change` item (or a `PROPOSAL:`) that the program manager never resolves. Only the asking crew waits, and a resumed stage re-reads the item through `factory inbox`, never a timer. A call touching no scope line is logged and never waits.
- Reason: scope changes are the client to rule on (plan decision 07:22, goal file `crew-decisions.md` approved scope); design in `plugins/truss/docs/adr/0047-crew-decisions-reach-pm.md`.
- Decided by: program manager as product owner (plan finding 3 ruling).

## deferred-fixes: the 0.31.0 requirement stamps carry the run start time

- Question: the `Added` lines of R-116 to R-124 in `plugins/truss/docs/requirements.md` carried the `T00:00:00Z` placeholder. What do they say?
- Answer: each of the nine lines is stamped `2026-11-13T17:33:53Z`, the 0.31.0 run start time, in place of the placeholder.
- Reason: the 0.31.0 report deferred the placeholder stamps.
- Decided by: product-owner persona (crew deferred-fixes). Source: the run's `decisions.md`, 00:51, product owner.

## heavy-slots: the run limit stops a hung suite (R-145)

- Question: may a heavy job that runs past a limit be stopped, which loses a healthy suite longer than the default?
- Answer: yes. `TRUSS_HEAVY_RUN_MS` (default the slot wait) stops it, the stop message names `TRUSS_HEAVY_RUN_MS` and how to raise it, and the next default limit doubles the longest stopped run, so a long healthy suite is lost once.
- Reason: a hung command under a live wrapper held the slot for ever. See ADR-0054.
- Decided by: the client, 2026-11-14 (`decisions.md` 09:33), on condition that the message names the variable.
- Sources: `plugins/truss/docs/adr/0054-heavy-slot-run-limit.md`.

## heavy-slots: the folded admission waits only through the standalone re-check

- Question: should the admission folded onto the red check (`--admit-first`) wait for memory?
- Answer: it has no wait. A memory or parallelism hold carrying admit's own figures (`minFreeMB`) triggers the standalone `admit --wait-ms 90000` re-check in `admit` (`crew.js`); a budget or awaiting hold stops the crew at once. Whether this split is intended is unconfirmed: confirm it or send the fold `--admit-wait-ms`.
- Reason: the acceptance test needs a held `admittedFirst` to stop the crew without a waiting standalone admit.
- Decided by: crew heavy-slots builder, not yet confirmed by the product owner.
- Sources: `plugins/truss/workflows-src/stage/runner.js` (`noWait: true`), `plugins/truss/workflows-src/stage/crew.js` (`admit`).

## hub-split: the 50-file selection target (R-139)

- Question: the moved code still selects 107 to 115 test files, so the "at most 50" cases cannot pass on real leaves. Rework `bin/**` or drop the bar?
- Answer: R-139 is not met and the hub split keeps no selection bar. No `bin/**` rework and no lazy imports. The three pinned count cases are retitled "every leaf of ... is measured and logged with its selection count" and only log counts and require at least 1 selected file.
- Reason: the suite grew from 164 to 173 test files and about 104 tests run the factory CLI, so leaves select 88 to 115 and no honest bar holds. The follow-up is per-command dispatch in `bin/factory.ts`.
- Decided by: program manager, ruling at 20:45 (`decisions.md`). It overrules the product-owner persona's earlier call d-hub-split-1 (rework `bin/**` so the worst leaf selects at most 50, with the cases measuring each real leaf).
- Sources: `plugins/truss/tests/hub-split-032.check.ts` (`countCase`), `plugins/truss/docs/adr/0049-hub-split.md` (Consequences).

## retro-generic: who updates the six old-shape retro tests

- Question: the `cli.ts` rewrite to the ADR-0051 finding shape leaves six cases on the old shape (`retro-contract.check.ts` at two cases, `retro/cli.check.ts` at four), and the builder may not edit tests. Who fixes them?
- Answer: the test-writer rewrites each case to the new shape, with `findings` reading `retro/problems.json`. The builder adds no fallback to the old shape.
- Reason: the cases are inside the crew's owns, and ADR-0051 Consequences already says the crew changes the retro-contract cases.
- Decided by: product-owner persona (crew retro-generic).

## retro-generic: refusal retry timing in the wave-4 run

- Domain truth: in `events.jsonl` a `refusal` event's `agent` is the agent id for a subagent (crew `main`) and `main` for the main session, so a retry's cost is the agent's next usage row. In the wave-4 fixture the worktree-guard refusals retried within about 1 to 2 seconds (`plugins/truss/tests/fixtures/retro-generic/wave4-run.json`, `plugins/truss/retro/problems.ts` `rulesPart`).

## run-survival: one PM session drives a run

- Question: should two PM sessions be able to resume the same run at once, with an owner token or process-liveness check on the start claim?
- Answer: no. One PM session drives a run, and concurrent resume of one run is not supported. The claim in `claimedWorktree` records no owner, `reclaimOrphans` checks no process liveness, and plan.json gains no field for the project-manager-path mark (a `pm-crew` event in events.jsonl instead).
- Reason: the cost of an owner and heartbeat protocol outweighs the case. Two concurrent starts can pass `maxParallelCrews`, and `find-run` cannot tell whether an old PM is alive, so the run skill has the new PM ask the client before it takes a run over.
- Decided by: client trim, 2026-11-14 (ADR-0052, Decision 2 and Consequences).

## run-survival: the trussFile gate spans the repo's truss dirs

- Question: may a PM session pass another session's `start` output to the Workflow gate?
- Answer: yes, for any `<git common dir>/truss/<name>/` dir of the same repo. The gate does not check that `<name>` is a session id, and a later hook that reads `args.trussFile` must treat the file as possibly another session's.
- Reason: R-135 and R-141: a resumed run keeps its goal files, reports and crew state in the old dir, so copying them would split one run across two dirs.
- Decided by: program manager (auto), recorded in ADR-0052; the long-term cost was logged in the goal's approved scope at 16:58.
