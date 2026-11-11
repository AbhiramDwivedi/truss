# Feature map

One entry per capability. Rules: [plugin-tests](../.claude/rules/plugin-tests.md). Product calls: [product-decisions](knowledge/product-decisions.md). Store, hold and stub details: [store](knowledge/store.md). Never nest backticks around a path here: the knowledge lint reads the inner path as a repo path and fails when it is untracked.

## Shared store

- What: the one lock, atomic-write and JSONL module for the plugin CLI, which also holds the transcript roots (`transcriptsOf`, and `proofTranscriptRoot` for the inbox proof), plus the helpers `factory.ts` once held (`CliError`, `usage`, `refuse`, `flat`). A lock whose owner is stale is taken over under a `.break` mutex, never renamed aside; an ownerless lock's age is re-checked under that mutex.
- Entry points: `plugins/truss/bin/store.ts`; tests `plugins/truss/tests/store.check.ts`; row shapes `plugins/truss/docs/state.schema.json`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md).

## Admission holds (awaiting client, budget)

- What: `factory.ts admit` and `start` hold a crew while the inbox blocks it or the budget is spent; `stage.js` turns the hold into `BLOCKED: awaiting client: ...` or `BLOCKED: budget: ...` and retries once on `store busy`. `start` reports held crews in `held`, with `why`.
- Entry points: `plugins/truss/bin/factory.ts` (`admission`, `holdOf`, `stageOut`), `plugins/truss/workflows/stage.js` (`admit`).
- Owner: `truss-plugin-node`, `truss-workflow-scripts`.
- Docs: [store](knowledge/store.md).

## Client inbox (escalate, resolve, notify)

- What: escalations land in the shared `inbox.jsonl`; `factory resolve --by client` needs a human-typed `/truss:inbox <decision> <E-id> <code>` line in the session transcript, and `verifiedItems` proves that line again at every read, so a `resolve` row without it counts as absent (the proof also refuses a row without `raiseUsd` when the typed line carries `raise <usd>`, and a typed row whose `cwd` is an existing directory of another repo) and the item stays open with `reopened` in the listing (a deleted or rotated transcript does the same). The proof root is the OS user's home `.claude/projects`, so a non-default `CLAUDE_CONFIG_DIR` fails closed. The `/truss:inbox` skill (model invocation disabled) lists open items with no arguments. `notify-run.ts` runs the client's `notify` command for each new item, with a 10 s limit. The inbox file holds only `codeHash`; the code goes to the PM's message and the notify stdin, and a mode 0600 sidecar in the session dir keeps it until the item resolves, for `inbox --recover-codes` (no `--dir`) after a crash. `inbox --unapplied --session <sid>` filters by the session that opened the item.
- Entry points: `plugins/truss/bin/inbox.ts`, `plugins/truss/bin/notify-run.ts`, `plugins/truss/skills/inbox/SKILL.md`; tests `plugins/truss/tests/inbox.check.ts`, `plugins/truss/tests/trust-026.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Inbox transcript proof"), `plugins/truss/docs/adr/0037-shared-store-and-inbox.md`.
- Note: the skill passes the note via `--note-file`; `textOf` in `inbox.ts` reads it for `--note` and `--title`, and `resolve` refuses a passed note that differs from the typed text (an absent flag stores an empty note). Listings show an item's code token in a quote as `[code]` (`maskCode`, `inbox.ts:178`); `resolve`'s own output and the row keep the typed text. Gap: a slash line with no note leaves the code glued to `</command-args>`, so it is not masked (ADR-0037). Without a typed line the skill asks the human to type the decision line.

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

- What: `sweep` reads the session's transcripts into `usage.jsonl` (cursor in `usage-cursor.json`, under the `usage` lock); attribution to a crew is computed on every read. `budgetVerdict` holds a crew at run, crew, work-type or session limits; `crewCost` feeds the ledger `costUsd`. Unpriced or unrecorded spend is `null`, never 0 (a fast row with no `fast` prices is unpriced; a busy lock before the first sweep is unknown spend for `crewCost` but does not hold `budgetVerdict`, which reads `usage.jsonl` as it stands); a hold's `why` starts `budget: `. Raise refs: `budget:<sid>:crew:<slug>`, `:workType:<slug>`, `:run:run`, `:session:session`. `sessionUsd` holds every crew's admit, attended runs included, with the one session ref. `factory cost` prints `sweep.busy` on a busy lock, and `session.usd`/`run.usd` are null with a `why` when no reading exists; a sweep closes a torn `usage.jsonl` tail with a newline first.
- Entry points: `plugins/truss/bin/cost.ts` (`sweep`, `budgetVerdict`, `crewCost`, `COST_COMMANDS`), `plugins/truss/bin/ledger.ts`; tests `plugins/truss/tests/cost.check.ts`, `plugins/truss/tests/cost-026.check.ts`, `plugins/truss/tests/ledger.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0038](../plugins/truss/docs/adr/0038-cost-budgets-and-ledger.md), [ADR-0041](../plugins/truss/docs/adr/0041-work-types.md).

## Intake queue

- What: `plugins/truss/bin/queue.ts` keeps one JSON item per queued job at `<shared>/queue/items/<Q-id>.json` (id `Q-` plus sha12 of the key); every write runs under the `queue` lock. `queue-next` checks the budget (a held result raises one blocking `budget` escalation with ref `budget:<sid>:<scope>:<scope>`, deduped across ticks, and adds the client-approval note to `held.why`), releases stale claims of other sessions (`by: "stale"`; a `running` item only when its owner's transcripts are also idle past `claimTtlHours`, since an owner mid-run makes no `queue-next` call), returns this session's claimed or running item, else claims the oldest `new` item, and writes its id into `<dir>/unattended.json` only if that file exists. The session id is the basename of `--dir`. `intake` and `unattended` events carry crew `main`, since the events schema requires a crew. An md key is `md:` plus sha16 of the item text and truss never writes the md file it reads: editing a line adds a new item, so drop the old one with `queue-set --state dropped`. `queue-next` leaves a claim `claimed`; only `running` may move to `done`, so run `queue-set --state running` right after it (ADR-0039 step 0). An untrusted issue title never goes in an escalation title; it goes in the detail inside `dataNotice`'s fence (`queue.ts:182`). A repeat `queue-next` by the same session returns its item and refreshes `claimedAt`. A non-collaborator `gh` issue without `--dir` is stored as `triage` and reported in `errors` (no escalation is raised; it is not retried later).
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
- Entry points: `plugins/truss/bin/queue.ts` (the `unattended` command, `queue.ts:298-316`), `plugins/truss/tests/unattended.check.ts`.
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

## Owns extension and knowledge-owns rule

- What: `factory owns-extend --slug S --glob G --reason R` edits `plan.json` under the `plan` lock, refuses a glob overlapping another live crew, and appends a decision line; it replaces hand-editing owns. `plan-check` refuses a stage whose crews' owns overlap a rule file's `paths` when no crew of that stage owns the rule file (skipped silently without git). One exact rule-file glob may be owned by crews of different goals and stages only when one crew's `after` names the other (`orderedByAfter`); both commands apply this, and any other shared glob is an overlap. The knowledge-owns rule matches owns to rule `paths` with `ruleGlobsOverlap` (brace expansion, exact match for a wildcard-free path, last-segment compare for a leading `**`); the crew-vs-crew check keeps the literal-prefix `globsOverlap`. Plan version 3 needs `goals` rows when a crew carries `goal`. Every `plan.json` writer (`patchPlan`, `owns-extend`, `plan-write`) takes the `plan` lock; `savePlan` writes atomically. TODO: `plugins/truss/docs/plan.schema.json` has no crew `after` property, so a plan using it fails the schema (`additionalProperties: false`).
- Entry points: `plugins/truss/bin/factory.ts` (`cmdOwnsExtend`, `cmdPlanCheck`), `plugins/truss/agents/design-engineer.md` (crews rule 4), `plugins/truss/tests/gates-026.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Owns and trailers").

## Merge gates and heavy slot bounds

- What: `integrate` refuses a non-merge member commit with no Truss trailers unless the target already holds it, and fails closed (a `why` saying trailers are unchecked) when `git log` cannot read the range; `stage.js` `integrateNow` stops BLOCKED on a refusal with a `why` and no `conflicts`, and sends an `inProgress` refusal to the resolver. A `truss-status: {}` line with no fields falls back to the stdout JSON for `met`. The merge gate refuses a non-local target branch with the fix. `check()` in `stage.js` re-waits a busy heavy slot 3 rounds (about 27 min), then stops BLOCKED; `releaseHeavySlot` retries on win32.
- Entry points: `plugins/truss/bin/factory.ts` (`untrailered`, `mergeCrew`), `plugins/truss/workflows/stage.js` (`check`, `HEAVY_WAIT_ROUNDS`), `plugins/truss/resources/index.ts`, `plugins/truss/tests/gates-026.check.ts`.
- Owner: `truss-plugin-node` (bin, resources), `truss-workflow-scripts` (stage.js).
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Owns and trailers", "One heavy slot").
- Resume: a resumed stage reuses the dead run's labels (`entry.runLabels`), so a restarted `x-builder` is `x-builder-2` in a stubbed-agent test; answers feed `stage.js` through `entry.prior` and `entry.answers` (`gates-026.check.ts` product-answer case).

## Plan spawn labels

- What: a plan.js spawn label must parse (`parseLabel` in factory.ts) to the slug truss, or `sessionAudit` flags the run. The PO-revised designer is truss-designer-2 (fix run truss-designer-4), the re-check truss-checker-2 (fix run truss-checker-4); a -po or -2 suffix on a numbered label reads as another slug.
- Entry points: plugins/truss/workflows/plan.js (lines 203-204), plugins/truss/bin/factory.ts (sessionAudit).
- Owner: truss-workflow-scripts.
