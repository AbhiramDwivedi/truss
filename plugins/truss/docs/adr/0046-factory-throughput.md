# ADR-0046: factory throughput and QC quality (0.29.0, builder A items)

Status: accepted, 2026-11-12
Decided by: program manager (auto), resting on the 0.29.0 throughput goal (wave5 `goal-throughput.md`, items 1, 4, 5, 6, 7 and the pricing item)
Amends: ADR-0009 Decision 4 (step order), ADR-0015 Decision 3 (the slot count is configurable) and Decision 6 (the reap after each member rides on the next factory call), ADR-0033 (knowledge step order and re-runs), ADR-0022 (UX review now precedes the knowledge step)

## Context

- A resumed crew got only the answers in the PM's newest `--answers` file. A ruling given on an earlier resume was lost unless the PM restated it, and the crew re-asked or rebuilt without it.
- Every factory command a stage runs costs one runner agent spawn; admit and reap wrap every member, and the same check re-ran on an unchanged head.
- The heavy slot is one lock for the whole host, and the load case ran on every QC round.
- The knowledge step and its lint ran once, before QC; a fix round after it left the knowledge docs stale. The stress test ran after the knowledge step, so knowledge never saw stress fixes.

## Decision

Each item below records what changed. Items not yet listed here were not done in this change; the builder's handoff says why.

### Item 5: a resume carries every unbuilt ruling

- `start --resume answers|stale|merge-ready` merges the crew's stored rulings into `entry.answers`: the new answers first, then each stored one not repeated (`carriedAnswers`, `bin/factory.ts`).
- The store is `<truss dir>/crews/<slug>/answers.json`, rows `{at, text, after, ts}`, rewritten on every resume (`saveAnswers`). `after` is the id of the crew's newest Workflow run when the ruling was first given.
- A stored ruling at a task name drops once a run after `after` finished that task: it is built, and re-sending it would make the resume re-run the task. Until then it rides along and keeps the task out of `done`. A ruling at a step name (red, split, green, qc, stress, UX) always rides along: a step has no "built" record.
- The red-record refusal looks only at the new answers, as before.

### Item 7: the stress test runs before the knowledge step

- `chain()` in `workflows/stage.js` now runs: reply checkpoint, UX review (when on), stress test (when on), knowledge step, green (when the step committed), scope check, QC. Before, the knowledge step ran before UX review and the stress test, so a stress fix staled the docs it had just written and the stress fixer's `learned` items were never recorded.
- The reply checkpoint stays first, so no reply is applied during stress rework (ADR-0033 section B holds).

### Item 6: knowledge and its lint re-run after every fix round

- Before each QC round, `lintClean` runs `factory knowledge-lint`. When it reports failures marked `new: true` and the crew has code tasks, the knowledge writer runs again with those failures in its brief ("Why this run: the knowledge lint failed ..."), green re-runs and the lint runs again. The loop is bounded by `LINT_FIX_ROUNDS` = 2 writer runs per QC round, and stops early when a writer run commits nothing (the head did not move). QC then gets whatever failures remain, as before.
- After each QC fix round, `knowledgeAgain` re-runs the knowledge writer on the fix diff (from the head before the fix) with the fixer's `learned` items, then green. It runs only when the step ran before in this crew or the fixer reported items; otherwise it costs no spawn. The lint loop above then runs before the next QC round.
- A stress fix needs no re-run: with item 7 the knowledge step already comes after it.
- Items the re-run records leave `unrecorded`; only items learned after the last writer run (a stop mid-round) stay listed there for the run-end reconcile pass.

### Item 1: fewer runner spawns

- The reap after each member (ADR-0015 Decision 6) no longer has a runner spawn of its own. The member's spawn leaves `crew.reapDue` set, and `runFactory` in `workflows/stage.js` adds `--reap-first <slug>` (before `--dir`) to the crew's next factory call, which is almost always the next member's admit. `bin/factory.ts` takes the flag off (`takeReapFlag`, before heavy's `--` only), runs `reap --slug <slug> --label <slug>-check` in the same process (`reapFirst`) and then the command. A clean reap leaves the command's output unchanged; a failed one adds `reapedFirst: {error}`, which stage.js logs in the crew's proofs as before (`reap failed: ...`). The crew's end still runs a standalone `reap`.
- A full batch protocol (several commands in one runner call) was not done: every stubbed stage test parses one command per runner prompt, and the reap fold removes the most frequent spawn without it.
- Same-head skip: `crew.moves` counts merges that changed the crew head (`moved`, from the head `integrate` and `sync` print; a merge that prints none counts as a move). `green`, `scope` (owns-check) and the tests check (`testsGuard`, `testsBackstop`) remember the count they last passed at and skip a re-run while it is unchanged, so a fixer that commits nothing costs no green, no tests check.
- Measured on the stubbed stage tests (`i1 1`: planner, tester, builder, stress test with one fix, knowledge writer, QC): 32 runner spawns before, 24 after (31 on the code before items 6 and 7).

### Item 4: a configurable heavy slot count

- The slot count is `heavySlots` in `.claude/truss.json` (an integer 1-16, declared in `truss-config.schema.json`), else `TRUSS_HEAVY_SLOTS` (a test seam), else the host default `max(1, min(4, floor(cpus/4), floor(totalGB/8)))` (`defaultHeavySlots` in `resources/index.ts`, from `os.availableParallelism()` and `os.totalmem()`). `heavyMain` in `bin/factory.ts` reads the key from the repo `--cwd` is in (`heavySlotsOf`) and prints it as `heavy.slots`.
- Slot 1 keeps the lock name `D/resources/heavy.lock/`; slot n > 1 is `D/resources/heavy-<n>.lock/`. `takeHeavySlot(dir, owner, platform, slots)` tries them in order and takes the first free one, with the same stale-lock takeover per slot (ADR-0015 Decision 3). `releaseHeavySlot` removes the one lock whose `owner.json` holds the token, whichever slot it is. The default `slots` is 1, so a caller that passes none keeps the one slot.
- Not done: running the load case once per stage. Truss cannot tell a project's load case from its other checks; the same-head skip (item 1) is the only saving here.

### Pricing: the Claude 5.5 family

- The plugin still writes no price (ADR-0038 section 3). This repo's own `.claude/truss.json` gains `pricing` for `claude-opus-5-5` (with `fast`), `claude-sonnet-5-5` and `claude-haiku-5-5`, from the claude-api skill's pricing page read 2026-11-12. Every rate there is published; none is derived.
- Haiku 5.5 bills a request whose prompt is over 100,000 tokens at higher rates for the whole request. A `pricing` entry may now hold `longContext: {abovePromptTokens, <the five rates>}` (`$defs.price` in `truss-config.schema.json`). `ratesFor` in `bin/cost.ts` takes the request's prompt size (input, cache read and both cache writes) and uses `longContext` when it is over the bound. Each usage row is one request, priced on its own. A fast row ignores `longContext`: no model has both.

## Consequences

- The program manager (PM)'s answers file holds only new rulings (`skills/run/SKILL.md` section 7). A ruling the PM wants withdrawn must be overridden by a newer ruling at the same `at`; there is no delete command. Long-term cost: step rulings accumulate for the life of the crew and lengthen every resumed brief.
- The repo's prices go stale when Anthropic changes them; the client re-reads the pricing page and edits `.claude/truss.json`. A future model with both a fast mode and a long-context tier would need `fast.longContext`, which the schema does not allow yet.
- Items 6 and 7 cost spawns: one more writer (Sonnet, `medium`) and one more green per QC fix round on a crew whose step ran, and up to two writers and two greens per QC round whose lint fails. The bound keeps a writer that cannot satisfy the lint from looping; QC still fails the crew on what is left. UX review now also comes before the knowledge step, so the writer documents the reviewed screens.
- Item 1 delays the reap after a member until the crew's next factory call, so a member's orphaned `<slug>-check` processes can live a little longer (through a PO or judge spawn, which make no factory call). The same-head skip trusts the head `integrate` and `sync` print; a merge that prints none counts as a move, so the skip fails safe.
- Item 4 lets up to `heavySlots` red and green checks run at once; on a host whose memory or CPU the default over-reads (a shared box), the client sets `heavySlots: 1`. The free-memory gate still applies to every slot. Slots are not FIFO, as before.
- Tests: `plugins/truss/tests/throughput-029.check.ts` (`i5 *`, `i1 3`, `i4 *`, `pricing *`), `plugins/truss/tests/throughput-029-stage.check.ts` (`i1 1`, `i1 2`, `i6 *`, `i7 *`); `crew-knowledge.check.ts` knowledge 6, knowledge 22 and replies 9 now pin the new order and re-run; `stage-resources.check.ts` (crew-end reap, failed reap logged, admit title) and `stage-resources-contract.check.ts` (reap after each member) pin the folded reap.
