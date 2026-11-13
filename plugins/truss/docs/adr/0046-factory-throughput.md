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
- The checks before QC go out as one runner call (0.29.0). `factory gates --slug S --steps green,owns,tests,lint,admit` (`gatesMain` in `bin/factory.ts`) runs the named steps in the order given, each exactly as its single command would (green as `heavy ... -- factory check`, with `--cwd`, `--expect`, `--label`, `--tests-since` and `--wait-ms`; admit with `--admit-label`, `--admit-title` and `--admit-wait-ms`), and stops at the first unmet one (`gateMet`: green, owns and tests need `ok: true`, admit `admitted: true`, the lint no failure without `new: false`). It prints one object, `{ok, stopped, gates: {step: met}, codes: {step: exit}, head, env, heavy, steps: {step: body}}`, where each `steps` body is what the single command prints; it exits 0 when every step is met, else with the stopped step's code (1 when that was 0). `--status-line` adds `gates` and `stopped` to the status line. The runner judges nothing: it runs one command and returns its output. The single commands stay.
- stage.js (`gates(crew, want)`) builds the call only from the steps that are due: green when the head moved since green last passed, owns and tests when their same-head skip would not skip them, the lint when the crew has code tasks or knowledge files, admit while the crew is within its rework allowance. With fewer than two steps due it sends nothing. It stores the results in `crew.gates` with the move count, and the usual step functions (`check`, `scope`, `testsGuard`, `knowledgeLint`, `admit`) take their result from it (`takeGate`) instead of a runner call, then read the same fields as before; a missing result (a stopped call, a moved head, an admit for another label or title, a tests attempt that differs) falls back to the single command. Any other factory call drops the cache (`dropGates`, in `runFactory`), and so does each spawn before QC. The gates call goes out at merge-ready, at the end of the member chain, at the top of the QC loop when nothing is cached, and before green in a QC fix round that has no knowledge re-run. A green with `--tests-since` (a stress-fix round's, item 3) and a green's retry round are never taken from the cache. A QC admit taken from the gates call is the slot QC then runs in; a failed or budget-held one gives the same stop as a single `admit`.
- A gates call that includes green sends its admit with `--admit-wait-ms 0`, and `gatesMain` forces 0 there whatever the flag says: green alone may wait `HEAVY_WAIT_MS` (540 s) for a heavy slot before the suite runs, and a 90 s admit wait on top would pass the runner's 600 s Bash timeout. When that admit comes back held for memory or parallelism (not budget, not an awaiting resolve), `admit()` in stage.js runs the single `admit --wait-ms 90000` instead of taking the cached result. A call without green keeps the 90 s wait.
- Stubbed stage tests answer one command per runner prompt, so `tests/fixtures/gates-stub.ts` `gatesAware(agent)` splits a gates prompt into the single-command prompts runFactory would have written and folds the answers the way `factory gates` does; `spawnLabels` counts one spawn per runner label.
- Same-head skip: `crew.moves` counts merges that changed the crew head (`moved`, from the head `integrate` and `sync` print; a merge that prints none counts as a move). `green`, `scope` (owns-check) and the tests check (`testsGuard`, `testsBackstop`) remember the count they last passed at and skip a re-run while it is unchanged, so a fixer that commits nothing costs no green, no tests check.
- Measured on the stubbed stage tests (`i1 1`: planner, tester, builder, stress test with one fix, knowledge writer, QC): 32 runner spawns before, 24 after (31 on the code before items 6 and 7).

### Item 4: a configurable heavy slot count

- The slot count is `heavySlots` in `.claude/truss.json` (an integer 1-16, declared in `truss-config.schema.json`), else `TRUSS_HEAVY_SLOTS` (a test seam), else the host default `max(1, min(4, floor(cpus/4), floor(totalGB/8)))` (`defaultHeavySlots` in `resources/index.ts`, from `os.availableParallelism()` and `os.totalmem()`). `heavyMain` in `bin/factory.ts` reads the key from the repo `--cwd` is in (`heavySlotsOf`) and prints it as `heavy.slots`.
- Slot 1 keeps the lock name `D/resources/heavy.lock/`; slot n > 1 is `D/resources/heavy-<n>.lock/`. `takeHeavySlot(dir, owner, platform, slots)` tries them in order and takes the first free one, with the same stale-lock takeover per slot (ADR-0015 Decision 3). `releaseHeavySlot` removes the one lock whose `owner.json` holds the token, whichever slot it is. The default `slots` is 1, so a caller that passes none keeps the one slot.
- Not done: running the load case once per stage. Truss cannot tell a project's load case from its other checks; the same-head skip (item 1) is the only saving here.

### Pricing: the Claude 5.5 family

- The plugin still writes no price (ADR-0038 section 3). This repo's own `.claude/truss.json` gains `pricing` for `claude-opus-5-5` (with `fast`), `claude-sonnet-5-5` and `claude-haiku-5-5`, from the claude-api skill's pricing page read 2026-11-12, and re-checked against it in the 0.29.0 review: Opus 5.5 $4 / $20, cache read $0.20, 5-minute write $5, 1-hour write $8, fast $8 / $40; Sonnet 5.5 $2 / $10, $0.10, $2.50, $4; Haiku 5.5 $0.10 / $0.50, read 0.1x, writes 1.25x and 2x, and $0.50 / $2.50 above 100K prompt tokens. The fast cache rates ($0.40, $10, $16) are the standard multipliers (0.05x, 1.25x, 2x) of the fast input rate; the skill states no separate fast cache rate.
- Haiku 5.5 bills a request whose prompt is over 100,000 tokens at higher rates for the whole request. A `pricing` entry may now hold `longContext: {abovePromptTokens, <the five rates>}` (`$defs.price` in `truss-config.schema.json`). `ratesFor` in `bin/cost.ts` takes the request's prompt size (input, cache read and both cache writes) and uses `longContext` when it is over the bound. Each usage row is one request, priced on its own. A fast row ignores `longContext`: no model has both.

### QC quality and crew doc ownership (builder B items 0, 2, 3, 8-13)

These amend ADR-0033 Scope (the owns exemption) and the QC engineer's steps 7, 8 and 11.

#### Item 0: the crew owns the docs of its change

- Client ruling: builders update the docs their change makes stale in the same change, every round: the feature map, `docs/knowledge/**` with `verified`, architecture and ADR citations, skill and agent prose. `docsLines(crew)` in `workflows/stage.js` puts this in every builder prompt (`memberPrompt` for role `builder`, and the fix rounds). The builder adds and edits its own regression tests.
- Only the pre-written acceptance test stays read-only (`taskPrompt`'s read-only line, qc-engineer step 8): a tester wrote it before the build as its proof, and a builder that could edit it could pass by weakening it.
- `knowledgeDocs` in `bin/factory.ts` exempts a `.md` path outside owns in two classes (0.29.0 review fix; the first cut exempted every doc-like path any member changed, so a builder could rewrite a judge's prompt):
  - Free docs, which any non-merge crew commit may change with its code: the feature map, the architecture doc (truss.json `architecture`, default `docs/architecture.md`), files under the ADR directory and the knowledge dir. Nothing else: a README, a changelog or any other `.md`, under `docs/` or not, is the crew's to change only when its owns name it (a wider rule let a member's stray `docs/extra.md` through, which `gates-026` pins).
  - Prompt files, which only the crew's recorded knowledge commit may change: `skills/**/SKILL.md`, `.claude/skills/**`, `agents/*.md` and `.claude/agents/*.md`, the rules dir, the agents index and the product-decisions file. A prompt file a builder commit also touched is not exempt. An agent whose file name says QC, checking, review, judge or product owner is never exempt, even in the knowledge commit.
  - Every exempt file keeps its YAML frontmatter (tools, model and descriptions are never the crew's), except a knowledge doc's `verified` stamp and `sources` list, which the lint checks and a builder keeps true.
  - A learned item's target no longer widens the set (`learnedTargets` is gone): an item could name any `.md`, a judge's prompt among them. A non-doc path outside owns still fails `owns-check`.

#### Item 8: the tester writes the regression case first

- `fixFindings` sends each defect to a tester before the fix builder runs: every stress finding, and a QC finding rated `bug` or `risk` (`DEFECT_RE`, `qcDefect`). The tester writes a failing regression case (`regressionDetail`); the fix builder then makes it pass. A nit gets no regression case.
- `DEFECT_RE` matches `bug` or `risk` only as a whole word after the finding's optional location (`- debug log ...` and `- riskier ...` are not defects; `- Bug: ...` and ``- `a.ts:5`: risk ...`` are).

#### Item 3: a stress-fix round that adds no test fails green

- `factory check --expect green --tests-since <sha>` prints `testsSince`: the test files changed since that sha (`testsSinceOf`). `stressTest` passes the head before its fix round; `green(crew, {testsSince})` with an empty list runs one fix builder titled `stress-fix regression tests` (`noTestText`), and when the list is still empty after it, stops `BLOCKED` at green, before QC.
- The rule holds when the fix round left the head where it was (it committed nothing): that is an empty list too, and the text says the head did not move. The fix member's prompt carries the stress findings (`noTestText(since, head, findings)`), so it knows which cases to add.
- A test file is one `isTestPath` names or one a `testGlobs` glob in `.claude/truss.json` matches (`path.matchesGlob`, repo-relative; `truss-config.schema.json`). When the list is empty and no tracked file of the worktree is a test file by either rule, truss cannot tell the project's tests apart: `factory check` prints `testsUnknown` (the reason) and no `testsSince`, and stage.js logs `warning: green check: crew <slug>: ...` in the crew's proofs and goes on. A project set up before the key existed (C#, Kotlin or Java, Ruby outside `spec/`, Swift) gets the warning, never a stop.
- `truss init` (`skills/init/SKILL.md`) detects the project's test layout from the code (Glob and Grep: `*.test.*` and `*.spec.*`, `test_*.py`, `*_spec.rb`, `*Tests.cs`, `*Test.kt` and `*Test.java`, Rust `tests/` and in-file `#[cfg(test)]`) and proposes `testGlobs` with the other keys, only for the files the built-in names miss; it writes the key only when the client approves it.
- Known gap: a Rust crate whose tests are only in-file `#[cfg(test)]` modules puts the fix and its test in one file, so a `testGlobs` of `src/**/*.rs` would count every fix as a test. Init proposes no glob there and the round gets the warning.

#### Items 2 and 12: the pre-QC step makes the mechanical repairs and checks changed prose

- `knowledgePrompt` tells the writer, before it commits, to cite code by symbol, re-point every `file:line` citation whose code moved, set `verified` on each doc it re-read, and check every added or changed line of skill and agent prose (`SKILL.md`, `agents/*.md`) against the code it describes. The `lintClean` loop (item 6) re-runs the writer on a `stale` lint failure, so a stamp is repaired before QC.
- Item 12 is a brief line, not a new spawn: it is cheap, but when no builder touched the prose and the knowledge step is skipped, nothing checks changed prose apart from QC step 11.

#### Item 9: stamp drift and line drift do not block QC

- `lintLines` sorts the lint's `stale` failures (`isStamp`) into their own section: QC never fails for the stamp, reads the doc against the diff and fails only on a statement that is now wrong, quoting it. `DOC_DRIFT_LINE` in the `Knowledge:` block says the same of a `file:line` citation whose line moved while the cited code still exists. qc-engineer step 11 agrees.

#### Item 10: from round 2 on, QC gets its previous report and the fix diff

- `qc()` keeps `crew.lastQc = {label, verdict, text, head, round}` before each fix. `reQcLines(crew)` adds to the next QC brief the round number, the previous report fenced, `git diff <old head>..HEAD`, and the order: rule each prior finding CLOSED or OPEN, read the fix diff, then report only real defects in untouched code.

#### Item 11: a known defect on a trust or money path is a FAIL

- `TRUST_PATH_LINE` in `qcPrompt`: a known defect on a trust or money path the diff touches (an auth, permission, approval, proof or audit check that fails open; a charge, budget, spend or payment amount that can be wrong) fails the crew even when an ADR or the goal file permits it; QC quotes the defect and adds a design `QUESTION:` when the ADR is what allows it.

#### Item 13: a logged ruling turns a finding into a QUESTION; nits only when harmless

- qc-engineer step 8: when a PM answer or PM decision line in the brief permits a builder's edit of an acceptance test, the touch is a `QUESTION:` quoting the ruling, not a FAIL. A member's product call or any other text is no ruling. In practice QC rarely sees the case: the factory's tests check already stops the crew `BLOCKED` on a builder or resolver commit to a tester's file, and only the PM resolves that stop.
- `NIT_LINE` in `fixPrompt` (not the tester's): fix a nit only when the fix changes no behaviour; else leave it and list it under "Nits left".

#### Effect on item 1's count

- Item 8 adds one regression tester per stress round with findings, and its admit and integrate: `i1 1` now allows 26 runner spawns, not 24.
- The gates call (item 1, 0.29.0) brings the same crew to 22 runner spawns (`i1 6`): the chain end's green, owns check, tests check, lint and QC admit are one spawn. On a real crew it saves about 4 spawns at the chain end, about 3 per QC fix round without a knowledge re-run, and about 2 at the QC loop top after one.

## Consequences

- The program manager (PM)'s answers file holds only new rulings (`skills/run/SKILL.md` section 7). A ruling the PM wants withdrawn must be overridden by a newer ruling at the same `at`; there is no delete command. Long-term cost: step rulings accumulate for the life of the crew and lengthen every resumed brief.
- The repo's prices go stale when Anthropic changes them; the client re-reads the pricing page and edits `.claude/truss.json`. A future model with both a fast mode and a long-context tier would need `fast.longContext`, which the schema does not allow yet.
- Items 6 and 7 cost spawns: one more writer (Sonnet, `medium`) and one more green per QC fix round on a crew whose step ran, and up to two writers and two greens per QC round whose lint fails. The bound keeps a writer that cannot satisfy the lint from looping; QC still fails the crew on what is left. UX review now also comes before the knowledge step, so the writer documents the reviewed screens.
- Item 1 delays the reap after a member until the crew's next factory call, so a member's orphaned `<slug>-check` processes can live a little longer (through a PO or judge spawn, which make no factory call). The same-head skip trusts the head `integrate` and `sync` print; a merge that prints none counts as a move, so the skip fails safe.
- Item 4 lets up to `heavySlots` red and green checks run at once; on a host whose memory or CPU the default over-reads (a shared box), the client sets `heavySlots: 1`. The free-memory gate still applies to every slot. Slots are not FIFO, as before. This repo sets `heavySlots: 2`; a trial ran the timing-sensitive suites (`inbox`, `diff-hygiene`, `hooks-load`, `store`, `gates-026`, `gates-026-regress`, `throughput-029`) as two concurrent runs, three times each, on a 2026-11 Linux host, and no test failed on timing (the one failure was a deterministic regression, since fixed). The trial did not cover macOS or Windows runners; if a timing test flakes there, set `heavySlots: 1`.
- Tests: `plugins/truss/tests/throughput-029.check.ts` (`i5 *`, `i1 3`, `i4 *`, `pricing *`), `plugins/truss/tests/throughput-029-stage.check.ts` (`i1 1`, `i1 2`, `i6 *`, `i7 *`); `crew-knowledge.check.ts` knowledge 6, knowledge 22 and replies 9 now pin the new order and re-run; `stage-resources.check.ts` (crew-end reap, failed reap logged, admit title) and `stage-resources-contract.check.ts` (reap after each member) pin the folded reap.
- Builder B items: builders and the knowledge step may both edit a doc, so two crews can touch the same out-of-owns doc and conflict at merge; the integrator resolves it as for any shared file. Long-term cost: a builder brief is longer (`docsLines`), and a tester runs on every stress round with findings and every QC FAIL with a bug or risk finding. A wrong ADR permission no longer shields a trust-path defect, so such a crew fails until the ADR is changed. Tests: `throughput-029-stage.check.ts` (`q0 1`, `q2 1`, `q3 1`, `q3 2`, `q8 1`, `q8 2`, `q9 1`, `q10 1`, `q11 1`, `q13 1`), `knowledge-scope.check.ts` (`scope 2b`, `scope 3`, `scope 4`, `scope 5`, `scope 5b`, `diff 3`), `knowledge-lint.check.ts` (`exempt 2`); `crew-knowledge-prose.check.ts` and `diff-hygiene.check.ts` pin the new scope wording.
- 0.29.0 review fixes, each with a test red on the code before it: the exemption classes (`knowledge-scope.check.ts` `scope 1`, `2c`, `2d`, `5b`, `5c`, `5d`; `scope 4` and `gates-026` pin that a stray `.md` under `docs/` is not a free doc); `testGlobs` and the unknown list (`diff 3b`, `diff 3c`, `throughput-029-stage.check.ts` `q3 4`); the unmoved head and the findings in the fix prompt (`q3 3`); the gates admit wait (`throughput-029.check.ts` `i1 8`, `throughput-029-stage.check.ts` `i1 10`); `DEFECT_RE` (`q8 3`); the read-only line (`q0 2`). `i1 9` runs a stage whose gates prompt the real `factory gates` answers in a temp repo, so the parse of its output is pinned against the command, not the stub.
