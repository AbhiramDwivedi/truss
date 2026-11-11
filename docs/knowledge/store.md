---
sources:
  - plugins/truss/bin/store.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/inbox.ts
  - plugins/truss/bin/guard.ts
  - plugins/truss/bin/cost.ts
  - plugins/truss/bin/worktypes.ts
  - plugins/truss/bin/ledger.ts
  - plugins/truss/bin/queue.ts
  - plugins/truss/tests/fixtures/inbox/slash-command.jsonl
  - plugins/truss/workflows/stage.js
  - plugins/truss/tests/fixtures/ltc/e2e.ts
  - plugins/truss/docs/state.schema.json
  - plugins/truss/docs/plan.schema.json
verified: 7c93f173a49abfc47e5f16ad805a3405ac9b66d3
---

# Store, holds and contract-025 stubs

Crew a0-foundation. `plugins/truss/docs/architecture.md` was left at its base text (commit 86771c9, owned by crew d2-product-prose), so these facts live here until that doc takes them.

## The store (`bin/store.ts`)

- It is the only lock, atomic-write and transcript-finding code. New modules import `CliError`, `usage`, `refuse`, `flat` and the other moved helpers from `./store.ts`, never from `factory.ts` (store.ts:119-131).
- `withLock(dir, name, fn, {waitMs, platform, fs, host, now})` holds `<dir>/locks/<name>.lock/owner.json` with `{pid, host, token, since}` (store.ts:229-234). Only the owner's token releases it.
- A lock is stale when: the owner is a dead pid on the same host, or `since` is over `STALE_AGE_MS` (120 s) old, or there is no `owner.json` and the dir is over `OWNERLESS_MS` (10 s) old (store.ts:155-156, 245-251).
- Busy past `waitMs` (default 5000) throws `StoreBusy`: `CliError` code 2, body `{error: 'store busy: <name>'}` (store.ts:149-153, 254).
- Takeover never renames a lock aside: that would open a window where the path is free while a live owner is still running. One breaker at a time holds the mutex `<lock>.break`, re-reads `owner.json`, and removes the lock only if the token is still the one judged stale. An ownerless lock's age is re-checked under the mutex. A mutex over 10 s old is cleared after an ino+mtime re-check (store.ts:179-225). This deviates from contract-025 section 2 line 83.
- `opts.fs` is `Partial<typeof node:fs>`; an omitted function falls back to the real one (store.ts:135-137). `appendJsonl` takes the lock named by its second argument under the dir it is given; its file argument is relative to that dir.
- The test title "a lock older than 200 s is taken over" stays as pinned by contract-025; the code threshold is 120 s. See `product-decisions.md`.

## Stored row shapes

`state.schema.json` holds `inboxOp`, `ledgerRow`, `usageRow`, `usageCursor`, `queueItem`, `unattended` and `ltcPlan` as `$defs`. The contract left ledger field types open: `process`, `qc`, `red`, `goal` and `workType` are nullable, `target`, `base` and `head` are strings. Treat them as append-only once rows exist.

`plan.schema.json` forbids a crew `workType` below version 4 through the existing crew `not`/`anyOf` list (line 126). The text `workType is version 4 only` comes from `cmdPlanCheck` in `factory.ts`, not the schema. `cmdPlanCheck` also owns the enum and the unattended-required rules and de-duplicates against `workTypeErrors()`. The enum `WORK_TYPES` lives in `factory.ts:539`, not in `worktypes.ts`.

## Admission holds

`admission(dir, repo, plan, crew, command, running)` runs `holdOf()` before the memory checks (factory.ts:2182, 2200). `holdOf` calls `blockingFor` (answer `awaiting: true`), then, only when `cfg.budget` is an object, `budgetVerdict` (answer `budget: true` with scope, spentUsd, limitUsd, why; plus a `budget-hold` event and a budget escalate). An escalate error never lifts the hold; it goes into the hold's `escalateError` field.

`stage.js` `admit()` maps those answers to `Stop BLOCKED` with `BLOCKED: budget: <why>` or `BLOCKED: awaiting client: <why>`, and retries once, straight away, on exit 2 `store busy` (stage.js:416-424). There is no pause: scripts have no timers, and factory's own 5 s lock wait already ran. A budget or awaiting hold is never retried: `admit --wait-ms 90000` refuses it at once. Only a memory hold is re-checked inside factory, every 2 s first (`cmdAdmit`, bin/factory.ts:2309). `qc()` returns `longTermCosts` (lines starting, after optional bullet, number, quote or bold/code markup, with `LONG-TERM-COST:`; a none-word body is skipped; same regex as `LINE_RE` in `bin/guard.ts`) only when non-empty (stage.js:1928, 2004).

`start` output has no top-level `entries`: started full crews are in `truss.crews`, direct crews in `direct`, foreman crews in `foremen`, held ones in `held` with `why` (factory.ts:1247, `stageOut`).

## Cost meter (`bin/cost.ts`)

- `sweep(dir, repo?, {platform?, waitMs?})` returns `{rows, files, bad, found}` and runs under the `usage` lock (cost.ts:57). `platform` is a parameter so tests cover win32.
- `D/usage-cursor.json` is `{files: {<path key>: {offset}}, project, ccEstimate: {usd, ts} | null}`; win32 keys are lowercased paths (cost.ts:60, 156). Dedupe uses the msgId set loaded from `D/usage.jsonl`, not the cursor, so a deleted cursor re-adds nothing (cost.ts:67-69, 154).
- Attribution (workflow label, spawn event, `worktreePath`, Agent label, `main`, unattributed) is computed on every read and never stored in rows.
- Raise refs: `budget:<sid>:crew:<slug>`, `:workType:<slug>`, `:run:run`, `:session:session` (cost.ts:284-291); `queue-next` must use the session ref. Every `why` starts `budget: `.
- A busy usage lock before the first sweep (no cursor) is unknown spend: `crewCost` gives `usd: null`, but `budgetVerdict` does not hold and reads `usage.jsonl` as it stands, so no budget is enforced until the first sweep lands (cost.ts:171, 329).
- The meter counts think and web-search tokens but prices only in, out, cache read and cache write 5m/1h (cost.ts:249-256). Pricing web search needs a new rate field.
- Not every Claude Code transcript has a `cost-state` line, so `claudeCodeEstimateUsd` can be null; pick a session that has one before a cross-check (ADR-0038 uses 7026b2da).

## Inbox transcript proof

`typedText` and `typedProof` in `bin/inbox.ts:171-196` accept a transcript line only when it is a main-thread user line (not `isSidechain`, `isMeta`, `isCompactSummary` or `isVisibleInTranscriptOnly`) with no `origin` or `origin.kind` `human`, string content or text blocks, and no `tool_result`. It also refuses scheduled lines (`wakeupSource`, `scheduledTaskId` or `scheduledFireId` present, `turnOrigin` not `human`, `promptSource` not `typed`), so a `/loop` wakeup, a queued prompt and a `claude -p` prompt never count; the slash line is unaffected. Task-notification returns and compact summaries carry the id and code, so they would forge an approval. It also refuses command-output lines (a line holding `bash-input`, `bash-stdout`, `bash-stderr` or `local-command-*` tags, `inbox.ts:187`, `:208`), because `argsOf` takes the first `<command-args>` anywhere in the text. A line must be newer than the `open` op and hold the id and the code, and the decision must be the first word of the `<command-args>` text (or of the prompt) directly before the id (`inbox.ts:200-201`), so a note's word cannot flip the decision.

The proof guards only `factory resolve`: a same-user agent can append a `resolve` row to `S/inbox.jsonl` and the fold accepts it. Only a retro comparing each `quote` with the typed prompts catches it (ADR-0037, Consequences). Change proof-check behaviour here and in `docs/features.md` together.

A human `/truss:x args` is probed as two lines with the same timestamp: a user line whose string content is `<command-message>x</command-message>\n<command-name>/truss:x</command-name>\n<command-args>ARGS</command-args>`, then an `isMeta: true`, `turnCompanion: true` user line holding the skill body, which ends `ARGUMENTS: ARGS`. The `isMeta` rule is what stops that second copy of the args from counting. Probed from a real session transcript (lines 114-115); the scrubbed sample is `plugins/truss/tests/fixtures/inbox/slash-command.jsonl`, with `__ID__`, `__CODE__` and `__TS__` placeholders.

## E2E fixtures and the direct solo flow

- `tests/fixtures/ltc/e2e.ts` holds `mkE2eWorld` (the ltc world plus a bare origin and a test-only price table), `originRefs`, `layBudgetCrew` and `runUnattendedFlow`: the PM's end-of-run flow of `/truss:run --next` through real factory processes (intake, unattended `--on`, queue-next, plan-write, plan-check, approve `--by auto`, start, crew commit, land, escalate push-pr, queue-set running then done, unattended `--off`). Reuse it for any later e2e case.
- A solo crew with a version 4 plan and workType `docs` starts direct through `factory start --slug S --stage next` (creates worktree `truss-S`, sets running); `land --slug S` merges it locally and writes one row to `<common>/truss/shared/ledger.jsonl` (factory.ts:2068-2080, 3075). The session needs `goals/S.md` (test helper `writeGoal`).

## Stub modules

No module is a stub any more: all six are implemented (`worktypes.ts:1` still calls itself an "A0 stub"; the comment is stale). Each keeps the contract-025 exports exactly. `cost.ts` `crewCost` returns `{usd: null, why: 'usage sweep busy'}` on a busy usage lock; `sweepOrRead` marks its result `busy: true`, and there is no `unswept` field (cost.ts:163-174, 327-336). The exports:

- `inbox.ts`: `escalate(repo, dir, {kind, title, detail?, crews?, ref?, blocking?})`, `blockingFor`, `budgetRaises`, `INBOX_COMMANDS`.
- `guard.ts`: `ltcLines`, `ltcTriggers`, `ltcPlan`, `ltcPlanGate`, `ltcCrewGate`.
- `cost.ts` (implemented): `sweep`, `budgetVerdict`, `crewCost`, `COST_COMMANDS`.
- `worktypes.ts`: `profilesOf`, `workTypeErrors`, `WORKTYPE_COMMANDS`.
- `ledger.ts`: `ledgerAppend`. `queue.ts`: `QUEUE_COMMANDS`.
