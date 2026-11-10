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
  - plugins/truss/workflows/stage.js
  - plugins/truss/docs/state.schema.json
  - plugins/truss/docs/plan.schema.json
verified: 2e014597e3e0867f9e840984b0b4f17c817e746f
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

`stage.js` `admit()` maps those answers to `Stop BLOCKED` with `BLOCKED: budget: <why>` or `BLOCKED: awaiting client: <why>`, and retries once after 2 s on exit 2 `store busy` (stage.js:420-429). The pause runs inside a factory runner command: scripts have no timers. `qc()` returns `longTermCosts` (lines matching `^\s*(?:-\s*)?LONG-TERM-COST:`) only when non-empty (stage.js:1903, 1979).

`start` output has no top-level `entries`: started full crews are in `truss.crews`, direct crews in `direct`, foreman crews in `foremen`, held ones in `held` with `why` (factory.ts:1247, `stageOut`).

## Stub modules

`inbox`, `guard`, `worktypes`, `ledger` and `queue` export the final contract-025 signatures; a replacing crew keeps these exports exactly (`cost` is now implemented and is listed for its exports):

- `inbox.ts`: `escalate(repo, dir, {kind, title, detail?, crews?, ref?, blocking?})`, `blockingFor`, `budgetRaises`, `INBOX_COMMANDS`.
- `guard.ts`: `ltcLines`, `ltcTriggers`, `ltcPlan`, `ltcPlanGate`, `ltcCrewGate`.
- `cost.ts` (implemented): `sweep`, `budgetVerdict`, `crewCost`, `COST_COMMANDS`.
- `worktypes.ts`: `profilesOf`, `workTypeErrors`, `WORKTYPE_COMMANDS`.
- `ledger.ts`: `ledgerAppend`. `queue.ts`: `QUEUE_COMMANDS`.
