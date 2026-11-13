# Feature map

One entry per capability. Rules: [plugin-tests](../.claude/rules/plugin-tests.md). Product calls: [product-decisions](knowledge/product-decisions.md). Store, hold and stub details: [store](knowledge/store.md). Never nest backticks around a path here: the knowledge lint reads the inner path as a repo path and fails when it is untracked.

## Shared store

- What: the one lock, atomic-write and JSONL module for the plugin CLI, which also holds the transcript roots (`transcriptsOf`, and `proofTranscriptRoot` for the inbox proof), plus the helpers `factory.ts` once held (`CliError`, `usage`, `refuse`, `flat`). A lock whose owner is stale is taken over under a `.break` mutex, never renamed aside; an ownerless lock's age is re-checked under that mutex (ownerless after 3 s). The atomic writers sweep orphan tmp files of dead writers.
- Entry points: `plugins/truss/bin/store.ts`; tests `plugins/truss/tests/store.check.ts`; row shapes `plugins/truss/docs/state.schema.json`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md).

## Admission holds (awaiting client, budget)

- What: `factory.ts admit` and `start` hold a crew while the inbox blocks it or the budget is spent; `stage.js` turns the hold into `BLOCKED: awaiting client: ...` or `BLOCKED: budget: ...` and retries once on `store busy`. `start` reports held crews in `held`, with `why`.
- Entry points: `plugins/truss/bin/factory.ts` (`admission`, `holdOf`, `stageOut`), `plugins/truss/workflows/stage.js` (`admit`).
- Owner: `truss-plugin-node`, `truss-workflow-scripts`.
- Docs: [store](knowledge/store.md).

## Client inbox (escalate, resolve, notify)

- What: escalations land in the shared `inbox.jsonl`; `factory resolve --by client` needs a human-typed `/truss:inbox <decision> <E-id> <code>` line in the session transcript, and `verifiedItems` proves that line again at every read, so a `resolve` row without it counts as absent (the proof also refuses a row without `raiseUsd` when the typed line carries `raise <usd>`, and a typed row whose `cwd` is an existing directory of another repo) and the item stays open with `reopened` in the listing (a deleted or rotated transcript does the same). The proof root is the OS user's home `.claude/projects`, so a non-default `CLAUDE_CONFIG_DIR` fails closed. The `/truss:inbox` skill (model invocation disabled) lists open items with no arguments. `notify-run.ts` runs the client's `notify` command for each new item, with a 10 s limit. The inbox file holds only `codeHash`; the code goes to the PM's message and the notify stdin, and a mode 0600 sidecar in the session dir keeps it until the item resolves, for `inbox --recover-codes` (no `--dir`) after a crash. `inbox --unapplied --session <sid>` filters by the session that opened the item. `factory approve --by client --item <E-id>` passes only on `approvalProof()` (`inbox.ts`): a client-trigger item of this dir's session (ref `run` only; any other ref is refused) whose verified resolve is `approve` and was typed in this same session (a resolve typed in another session is refused), no later open row of the same kind, session and ref, and a resolve not older than the plan (`plan.md`, else `plan.json`, mtime): a resolve from before the plan was written is refused with "resolved before the current plan was written", so a proof cannot be replayed onto a re-planned plan. Once the plan is approved, `confirmApproval` passes `approved` and skips that staleness check. The typed approve of the run item approves the plan through an approver `factory.ts` registers with `onPlanApprove()`; a refusal rides in the resolve output as `approveRefused`. The first later `approve --by client --item` returns the existing `approvedAt` and marks the item applied; the next refuses as already approved (ADR-0045).
- Entry points: `plugins/truss/bin/inbox.ts`, `plugins/truss/bin/factory.ts` (`cmdApprove`, `onPlanApprove` registration), `plugins/truss/bin/notify-run.ts`, `plugins/truss/skills/inbox/SKILL.md`; tests `plugins/truss/tests/approve-029.check.ts`, `plugins/truss/tests/inbox.check.ts`, `plugins/truss/tests/trust-026.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Inbox transcript proof"), `plugins/truss/docs/adr/0037-shared-store-and-inbox.md`, `plugins/truss/docs/adr/0045-approve-proof.md`.
- Note: the skill passes the note via `--note-file`; `textOf` in `inbox.ts` reads it for `--note` and `--title`, and `resolve` refuses a passed note that differs from the typed text (an absent flag stores an empty note). Listings show an item's code token in a quote as `[code]` (`maskCode`, `inbox.ts:203`); `resolve`'s own output and the row keep the typed text. Gap: a slash line with no note leaves the code glued to `</command-args>`, so it is not masked (ADR-0037). Without a typed line the skill asks the human to type the decision line.

## Long-term cost guard

- What: `guard.ts` raises a blocking `long-term-cost` inbox item for each costly LONG-TERM-COST line (plan texts via `ltcPlan`, QC text via `ltcCrewGate`) and for deterministic triggers. Item ref `ltc:<sid>:<slug>:<sha12(what)>` (plan: `ltc:<sid>:plan:<rev>:<sha12(what)>`); an approved or open item with the ref is reused, a rejected one keeps blocking. `ltcTriggers` reads `--name-status -z`, so a quoted file name is seen, diffs `package.json` dependency names section by section (four lists, via `git show`, so a move out of `devDependencies` triggers) and counts only added (`A`) `migrations/`, `*.sql`, `*.schema.json`, `schema.*` files (matched case-insensitively). It fails closed: a failed `git diff` or one over the 1 MB buffer refuses, `ltcCrewGate` returns that as `refused`, and `ltcPlanGate` refuses a missing, corrupt or non-array `ltc-plan.json` and points at `plan-write`. Both gates read the verified inbox fold. A LONG-TERM-COST line may carry markdown at its start (bullet, number, quote, bold, code) and a none-word body (`none`, `n/a`, `-`) is no cost, while a bare marker with an empty body is kept and blocks; the diff runs with `--no-renames`, so a rename counts as a delete plus an add and does trigger; other ecosystems' manifests are not read. The two gates disagree on dismiss: `ltcPlanGate` treats dismiss/answer/done as cleared, `ltcCrewGate` needs `approve` and `raise` re-escalates a dismissed ref.
- Entry points: `plugins/truss/bin/guard.ts`; tests `plugins/truss/tests/ltc-guard.check.ts`, `plugins/truss/tests/trust-026.check.ts`, `ltc-paragraph.check.ts`, fixtures `tests/fixtures/ltc/`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/adr/0034-long-term-cost-guard.md`; [store](knowledge/store.md) ("E2E fixtures").

## Contract-025 modules (cost, worktypes, ledger)

- What: no stubs are left: `cost`, `worktypes` and `ledger` are filled and keep the contract-025 exports; `cost` and `worktypes` feed admission and `plan-check`. The header comment of `worktypes.ts` still says "A0 stub"; the body is the real one.
- Entry points: `plugins/truss/bin/cost.ts`, `worktypes.ts`, `ledger.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Stub modules"); the `bin/` module table in `plugins/truss/docs/architecture.md`.

## Run one queued item unattended (--next)

- What: `/truss:run --next` sets the unattended flag, takes in and claims one queue item, gates it (`ELIGIBLE: yes|no`), briefs it on defaults, always plans it, approves only `--by auto` and merges locally; every client call becomes an inbox item. Every early end and the normal end run `factory unattended --off`; a present client clears a leftover flag with `factory unattended --off --dir <truss dir>`.
- Entry points: `plugins/truss/skills/run/SKILL.md` ("Run one queued item unattended"), `plugins/truss/tests/autonomy-prose.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0039](../plugins/truss/docs/adr/0039-unattended-start.md).

## Cost meter and budgets

- What: `sweep` reads the session's transcripts into `usage.jsonl` (cursor in `usage-cursor.json`, under the `usage` lock); attribution to a crew is computed on every read. `budgetVerdict` holds a crew at run, crew, work-type or session limits; `crewCost` feeds the ledger `costUsd`. Unpriced or unrecorded spend is `null`, never 0 (a fast row with no `fast` prices is unpriced; a busy lock before the first sweep is unknown spend for `crewCost`; `budgetVerdict` reads an existing `usage.jsonl` as it stands on a busy lock, but with no `usage.jsonl` it sweeps once more with the store's default wait and then throws `StoreBusy`, exit 2 `store busy: usage`, never an admit: `admit` and `queue-next` exit 2, and `start` lists that crew in `held`); a hold's `why` starts `budget: `. Raise refs: `budget:<sid>:crew:<slug>`, `:workType:<slug>`, `:run:run`, `:session:session`. `sessionUsd` holds every crew's admit, attended runs included, with the one session ref. `factory cost` prints `sweep.busy` on a busy lock, and `session.usd`/`run.usd` are null with a `why` when no reading exists; a sweep closes a torn `usage.jsonl` tail with a newline first.
- Ruling by the program manager (PM), 0.26.0 item 6: attended sessions are capped by `sessionUsd` too, so a session at its cap holds at the next member start, and the session verdict carries the session ref, so one typed raise lifts the hold for all crews.
- Entry points: `plugins/truss/bin/cost.ts` (`sweep`, `budgetVerdict`, `crewCost`, `COST_COMMANDS`), `plugins/truss/bin/ledger.ts`; tests `plugins/truss/tests/cost.check.ts`, `plugins/truss/tests/cost-026.check.ts`, `plugins/truss/tests/ledger.check.ts`, `plugins/truss/tests/hygiene-029.check.ts` (prices the 5.5 ids from the repo's `.claude/truss.json` `pricing`).
- Owner: `truss-plugin-node`.
- Docs: [ADR-0038](../plugins/truss/docs/adr/0038-cost-budgets-and-ledger.md), [ADR-0041](../plugins/truss/docs/adr/0041-work-types.md).

## Intake queue

- What: `plugins/truss/bin/queue.ts` keeps one JSON item per queued job at `<shared>/queue/items/<Q-id>.json` (id `Q-` plus sha12 of the key); every write runs under the `queue` lock. `queue-next` checks the budget (a held result raises one blocking `budget` escalation with ref `budget:<sid>:<scope>:<scope>`, deduped across ticks, and adds the client-approval note to `held.why`), releases stale claims of other sessions (`by: "stale"`; a `running` item only when its owner's transcripts are also idle past `claimTtlHours`, since an owner mid-run makes no `queue-next` call), returns only this session's `claimed` item (a `running` item is held by its crews), else claims the oldest `new` item, and writes its id into `<dir>/unattended.json` only if that file exists. The session id is the basename of `--dir`. `intake` and `unattended` events carry crew `main`, since the events schema requires a crew. An md key is `md:` plus sha16 of the item text and truss never writes the md file it reads: editing a line adds a new item. `intake` drops (terminal `dropped`, `by: "intake"`) a stored `new` item of a source that its listing no longer holds, so a changed `queueFile` or `ghLabel`, or a mis-edited md file, drops that source's `new` items for good; a gh listing of 50 or more issues is capped and drops nothing, so a closed issue is dropped only once the count falls under 50. An unknown source in `.claude/truss.json` is refused as a usage error. `queue-next` leaves a claim `claimed`; only `running` may move to `done`, so run `queue-set --state running` right after it (ADR-0039 step 0). An untrusted issue title never goes in an escalation title; it goes in the detail inside `dataNotice`'s fence (`dataNotice`, `queue.ts:234`). A repeat `queue-next` by the same session returns its item and refreshes `claimedAt`. A non-collaborator `gh` issue without `--dir` is stored as `triage` and reported in `errors` (no escalation is raised; it is not retried later).
- Entry points: `plugins/truss/bin/queue.ts` (`QUEUE_COMMANDS`), `plugins/truss/tests/queue.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

## Unattended brief

- What: while `<truss dir>/unattended.json` exists, `truss:brief` records source `{kind: "intake", id}` and writes its own goal sentence. A large item goes to triage. A standard item runs `remaining` instead of `next`, marks branches the facts don't settle `by: "default"` and files a non-blocking `client-question` (`--ref brief:<sid>:<branch>`, `--title-file`); it skips the closing question and logs `Defaults filled: R-<n> (<branch>, E-<id>)`.
- Entry points: `plugins/truss/skills/brief/SKILL.md` ("Unattended brief"), `plugins/truss/tests/brief-unattended.check.ts`, `plugins/truss/tests/unattended.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0039](../plugins/truss/docs/adr/0039-unattended-start.md), [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

## Unattended switch

- What: `factory unattended --on|--off` writes or removes `<truss dir>/unattended.json` and logs the `unattended` event. While the file exists the run is unattended and `truss:brief` and `queue-next` read it.
- Entry points: `plugins/truss/bin/queue.ts` (the `unattended` command, `queue.ts:342-365`), `plugins/truss/tests/unattended.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0039](../plugins/truss/docs/adr/0039-unattended-start.md), [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

## Unattended question gate

- What: in an unattended run the main-thread `AskUserQuestion` is refused by a hook, with "[truss] unattended run: no one is here to answer…", so the run never waits on a person. The hook fails open on its own error.
- Entry points: `plugins/truss/hooks/register.ts` (the unattended check near lines 1286-1299 and 2500-2504), `plugins/truss/tests/unattended.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0039](../plugins/truss/docs/adr/0039-unattended-start.md), [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

## Plan work type

- What: version-4 plans may give a crew a `workType`; `plan-check` rejects it on older versions or with a bad value, and requires `unattended` where needed. The schema forbids it below version 4; the message text comes from code. A `bugfix` crew needs `red: true` only at lean process; a full (or absent) process counts as red (`plugins/truss/bin/worktypes.ts:63`).
- Entry points: `plugins/truss/docs/plan.schema.json`, `plugins/truss/bin/factory.ts` (`cmdPlanCheck`, `WORK_TYPES`), `plugins/truss/bin/worktypes.ts`, `plugins/truss/tests/plan-worktype.check.ts`, `plugins/truss/tests/worktypes.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Stored row shapes"), [ADR-0041](../plugins/truss/docs/adr/0041-work-types.md).

## Long-term cost lines in QC

- What: `stage.js` `qc()` returns `longTermCosts` from QC output lines starting `LONG-TERM-COST:` (markdown at the line start allowed; none-word bodies skipped), only when there are any; a line is never a FAIL.
- Entry points: `plugins/truss/workflows/stage.js` (`ltcLinesOf`, `qc`); tests `plugins/truss/tests/workflows.check.ts`.
- Owner: `truss-workflow-scripts`.

## Owns extension

- What: `factory owns-extend --slug S --glob G --reason R` adds the glob to the crew's `owns` in `plan.json` under the `plan` lock (once; a glob already there is not added twice), whatever other crews own, and appends a decision line; it replaces hand-editing owns. Crews may share files ([ADR-0043](../plugins/truss/docs/adr/0043-crews-share-files.md)): `plan-check` compares no crew's owns with another's and has no rule-file ownership rule; `owns-check` still refuses a crew diff outside the crew's own `owns`, except `.md` doc paths any non-merge crew commit changed (ADR-0046 item 0: the crew owns the docs of its change). Plan version 3 needs `goals` rows when a crew carries `goal`. Every `plan.json` writer (`patchPlan`, `owns-extend`, `plan-write`) takes the `plan` lock; `savePlan` writes atomically.
- Entry points: `plugins/truss/bin/factory.ts` (`cmdOwnsExtend`, `cmdOwnsCheck`, `cmdPlanCheck`), `plugins/truss/agents/design-engineer.md` (crews rule 4), `plugins/truss/tests/gates-026.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Owns and trailers").

## Merge gates and heavy slot bounds

- What: `integrate` refuses a non-merge member commit with no Truss trailers unless the target already holds it, and fails closed (a `why` saying trailers are unchecked) when `git log` cannot read the range; `stage.js` `integrateNow` stops BLOCKED on a refusal with a `why` and no `conflicts`, and sends an `inProgress` refusal to the resolver. A `truss-status: {}` line with no fields falls back to the stdout JSON for `met`. The merge gate refuses a non-local target branch with the fix. `check()` in `stage.js` re-waits a busy heavy slot 3 rounds (about 27 min), then stops BLOCKED; `releaseHeavySlot` retries on win32.
- Entry points: `plugins/truss/bin/factory.ts` (`untrailered`, `mergeCrew`), `plugins/truss/workflows/stage.js` (`check`, `HEAVY_WAIT_ROUNDS`), `plugins/truss/resources/index.ts`, `plugins/truss/tests/gates-026.check.ts`.
- Owner: `truss-plugin-node` (bin, resources), `truss-workflow-scripts` (stage.js).
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Owns and trailers", "Heavy slots").
- Resume: a resumed stage reuses the dead run's labels (`entry.runLabels`), so a restarted `x-builder` is `x-builder-2` in a stubbed-agent test; answers feed `stage.js` through `entry.prior` and `entry.answers` (`gates-026.check.ts` product-answer case).

## Finisher lease (resume guard)

- What: `finish` and `start --resume` hold a lease `finisher-<slug>` (`store.ts` `takeLease`/`refreshLease`/`releaseLease`) so two finishers never run one crew; a held live lease refuses the second (a live pid on the same host keeps its lease however long the acceptance test runs; only another host's lease goes stale, after 300 s). `finish` takes it per crew before writing, refreshes it before each merge and releases it in a `finally`. `start --resume` takes it before `ensureWorktree`, merges the target via `mergeIn`, and on a conflict runs `git merge --abort` and records `syncConflicts: [paths]` on the crew entry instead of refusing.
- Entry points: `plugins/truss/bin/store.ts` (`takeLease`), `plugins/truss/bin/factory.ts` (`cmdStartResume`, `cmdFinish`, `finishRun`, `mergeIn`), `plugins/truss/tests/resume-029.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0048](../plugins/truss/docs/adr/0048-resume-guard.md), [store notes](knowledge/store.md).

## Resume answers carry forward

- What: every crew resume (`start --slug S --resume answers|stale|merge-ready`) merges the crew's earlier rulings into `entry.answers`, so a PM's new `--answers` file never drops one. The store is `<truss dir>/crews/<slug>/answers.json`, rows `{at, text, after, ts}` (`after` is the id of the crew's newest Workflow run when the ruling was given). The new answers come first, then each stored one not repeated. A stored answer at a task name drops once a run after `after` finished that task (it is built; re-sending it would re-run the task); until then it rides along and keeps the task out of `done`. An answer at a step name (red, split, green, qc, stress, UX) always rides along. The refused-resume checks (red record) look only at the new answers.
- Entry points: `plugins/truss/bin/factory.ts` (`cmdStartResume`, `carriedAnswers`, `saveAnswers`, `storedAnswers`); tests `plugins/truss/tests/throughput-029.check.ts` (`i5 *`).
- Owner: `truss-plugin-node`.
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) item 5.

## Knowledge after stress and every fix round

- What: a workflow crew runs its stress test (and UX review) before the knowledge step, so the writer records the stress fixer's `learned` items. Before every QC round the knowledge lint runs; new failures send the writer back with them (at most twice, stopping when it commits nothing), then green and the lint re-run. After a QC fix round the writer runs again on the fix diff with the fixer's items, when the step ran before or the fixer learned something; so `unrecorded` holds only items a stop left behind.
- Entry points: `plugins/truss/workflows/stage.js` (`chain`, `qc`, `lintClean`, `LINT_FIX_ROUNDS`, `knowledgeAgain`, `knowledge`, `knowledgePrompt`); tests `plugins/truss/tests/throughput-029-stage.check.ts` (`i6 *`, `i7 *`).
- Owner: `truss-workflow-scripts`.
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) items 6 and 7, [ADR-0033](../plugins/truss/docs/adr/0033-crew-knowledge-and-product-calls.md).

## Crews own their docs; QC converges

- What: every builder prompt says to update the docs the change makes stale in the same change (feature map, knowledge docs with `verified`, architecture and ADR citations by symbol, skill and agent prose); only the pre-written acceptance test is read-only. `owns-check` exempts `.md` free docs (feature map, architecture doc, ADR dir, knowledge dir; no README, CHANGELOG or other `.md`) that any crew commit changed, and prompt files (skills, agents and personas, rules dir, agents index, product decisions file) only when the knowledge commit alone changed them and they are no judge's agent file; frontmatter never, a knowledge doc's `verified` and `sources` excepted. Each stress finding and each QC `bug` or `risk` finding (whole word) goes to a tester for a failing regression case before the fix builder runs; a stress-fix round that changed no test file, or left the head unmoved, gets one more fix builder with the findings, then stops BLOCKED at green. Test files are truss's built-in names plus the `testGlobs` key of `.claude/truss.json`, which `truss init` proposes from the project's test layout; when no tracked file is a test file by either, the crew gets a `warning: green check:` line, not a stop. QC never fails for a stale `verified` stamp or a moved line citation, only for a wrong statement; from round 2 it gets its previous report and the fix diff; a known defect on a trust or money path fails even when an ADR permits it; a logged PM ruling turns a guarded-file touch into a QUESTION; fix builders fix a nit only when the fix changes no behaviour.
- Entry points: `plugins/truss/workflows/stage.js` (`docsLines`, `NIT_LINE`, `fixFindings`, `regressionDetail`, `DEFECT_RE`, `green`, `noTestText`, `stressTest`, `lintLines`, `isStamp`, `DOC_DRIFT_LINE`, `knowledgePrompt`, `TRUST_PATH_LINE`, `reQcLines`, `qc`), `plugins/truss/bin/factory.ts` (`knowledgeDocs`, `testsSinceOf`), `plugins/truss/agents/qc-engineer.md` (steps 7, 8, 11, Knowledge scope); `plugins/truss/skills/init/SKILL.md` (`testGlobs`); tests `plugins/truss/tests/throughput-029-stage.check.ts` (`q*`), `plugins/truss/tests/knowledge-scope.check.ts` (`scope 1`-`scope 6`, `diff 3`-`diff 3c`).
- Owner: `truss-workflow-scripts` (stage.js), `truss-plugin-node` (factory.ts).
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) items 0, 2, 3, 8-13, [ADR-0033](../plugins/truss/docs/adr/0033-crew-knowledge-and-product-calls.md) (Scope, amended).

## Fewer runner spawns (reap fold, same-head skip)

- What: the reap after each member spawn rides on the crew's next factory call as `--reap-first <slug>`; `factory.ts` reaps `<slug>-check` before running the command and adds `reapedFirst: {error}` to its output only when that reap failed. Only the crew-end reap is a runner call of its own. Green, owns-check and the tests check skip a re-run while the crew head has not moved since they passed. A stubbed crew with a stress fix went from 32 runner spawns to 24 (26 since ADR-0046 item 8 adds the regression tester's admit and integrate).
- What (0.29.0, gates): the checks before QC (green, owns-check, tests check, knowledge lint, QC admit) go out as one runner call, `factory gates --slug S --steps ...`, which runs the due steps in order, stops at the first unmet one and prints each step's own output under `steps` with `gates`, `codes` and `stopped`. stage.js takes each step's result from that call and falls back to the single command when it has none. The same stubbed crew now costs 22 runner spawns; a real crew saves about 4 at the end of its member chain and about 3 per QC fix round.
- Entry points: `plugins/truss/workflows/stage.js` (`runFactory`, `ask`, `reap`, `moved`, `unmoved`, `passedAt`, `green`, `scope`, `testsGuard`, `testsBackstop`, `gates`, `takeGate`, `dropGates`), `plugins/truss/bin/factory.ts` (`takeReapFlag`, `reapFirst`, `gatesMain`, `gateMet`, `statusLine`); tests `plugins/truss/tests/throughput-029-stage.check.ts` (`i1 1`, `i1 2`, `i1 6`, `i1 7`), `plugins/truss/tests/throughput-029.check.ts` (`i1 3`, `i1 4`, `i1 5`), stub helper `plugins/truss/tests/fixtures/gates-stub.ts` (`gatesAware`).
- Owner: `truss-workflow-scripts` (stage.js), `truss-plugin-node` (factory.ts).
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) item 1, [ADR-0015](../plugins/truss/docs/adr/0015-resource-aware.md) Decision 6.

## Configurable heavy slot count

- What: up to `heavySlots` red and green checks (`factory heavy`) run at once across the session. The count is the `.claude/truss.json` key `heavySlots` (1-16), else `TRUSS_HEAVY_SLOTS`, else `max(1, min(4, floor(cpus/4), floor(totalGB/8)))` from the host. Slot 1 is `resources/heavy.lock/`, slot n is `resources/heavy-<n>.lock/`; `heavy` takes the first free slot and prints the count as `heavy.slots`.
- Entry points: `plugins/truss/bin/factory.ts` (`heavyMain`, `heavySlotsOf`), `plugins/truss/resources/index.ts` (`defaultHeavySlots`, `takeHeavySlot`, `releaseHeavySlot`), `plugins/truss/docs/truss-config.schema.json` (`heavySlots`); tests `plugins/truss/tests/throughput-029.check.ts` (`i4 *`).
- Owner: `truss-plugin-node`.
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) item 4, [ADR-0015](../plugins/truss/docs/adr/0015-resource-aware.md) Decision 3, [architecture](../plugins/truss/docs/architecture.md) ("Heavy slots").

## Long-context price tier (Claude 5.5 prices)

- What: a `pricing` entry may hold `longContext: {abovePromptTokens, <the five rates>}`. A standard-speed request whose prompt (input plus cache read plus both cache writes) is over `abovePromptTokens` is priced wholly at the `longContext` rates; each request is judged on its own. A fast row ignores `longContext`. This repo's own `.claude/truss.json` prices `claude-opus-5-5` (with `fast`), `claude-sonnet-5-5` and `claude-haiku-5-5` (with its long-context tier), from the claude-api skill's pricing page read 2026-11-12. The plugin still writes no price.
- Entry points: `plugins/truss/bin/cost.ts` (`ratesFor`, `sumOf`), `plugins/truss/docs/truss-config.schema.json` (`$defs.price.longContext`); tests `plugins/truss/tests/throughput-029.check.ts` (`pricing *`).
- Owner: `truss-plugin-node`.
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) "Pricing", [ADR-0038](../plugins/truss/docs/adr/0038-cost-budgets-and-ledger.md) section 3.

## Plan spawn labels

- What: a plan.js spawn label must parse (`parseLabel` in factory.ts) to the slug truss, or `sessionAudit` flags the run. The PO-revised designer is truss-designer-2 (fix run truss-designer-4), the re-check truss-checker-2 (fix run truss-checker-4); a -po or -2 suffix on a numbered label reads as another slug.
- Entry points: plugins/truss/workflows/plan.js (lines 203-204), plugins/truss/bin/factory.ts (sessionAudit).
- Owner: truss-workflow-scripts.

## Crew product calls reach the program manager

- What: a `PO: ESCALATE` opens a `pm-question` item the program manager resolves with `--by pm`; a `PO: SCOPE-CHANGE` opens a client-only `scope-change` item. Only the asking crew stops BLOCKED while it is open, and a resumed stage re-reads it through `factory inbox`, never a timer. `PO: DECIDE` never waits.
- Entry points: `plugins/truss/workflows/stage.js` (`productCall`, `restoreCalls`, `pendingCall`), `plugins/truss/bin/inbox.ts` (`KINDS`); test `plugins/truss/tests/pm-calls-029.check.ts`.
- Owner: `truss-workflow-scripts`.
- Docs: [inbox](knowledge/inbox.md), `plugins/truss/docs/adr/0047-crew-decisions-reach-pm.md` (amends ADR-0033 section B).

## Decision log line (decide)

- What: `factory decide` appends one decision line to the session log from exactly one of `--line`, `--checker` or `--run`. `--run` may create the session dir, only directly under `<common>/truss` and only after the goal text validates, so a refused `--run` writes nothing (`cmdDecide`, `factory.ts:3563`).
- Entry points: `plugins/truss/bin/factory.ts` (`cmdDecide`).
- Owner: `truss-plugin-node`.

## Role names (ADR-0042)

- What: the full-crew lead is the project manager (`truss:project-manager`) and the main session the program manager; no alias reads the old crew-lead name. Contract values: `promptOverrides` and role key `project-manager`, start key `projectManagers`, stall kind `idle-project-manager`, retro key `stalls.idleProjectManager`.
- Entry points: `plugins/truss/hooks/register.ts` (`isLeadType`, `leadStartName`, `stopperIsLead`); `plugins/truss/agents/project-manager.md` (moved there by the rename-plugin crew in 0.27.0).
- Docs: `plugins/truss/docs/adr/0042-project-manager-rename.md`; `plugins/truss/docs/architecture.md` ("Role names (ADR-0042)").
- Owner: `truss-plugin-node`.
