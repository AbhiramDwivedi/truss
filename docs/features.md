# Feature map

One entry per capability. Rules: [plugin-tests](../.claude/rules/plugin-tests.md). Product calls: [product-decisions](knowledge/product-decisions.md). Store, hold and stub details: [store](knowledge/store.md). Never nest backticks around a path here: the knowledge lint reads the inner path as a repo path and fails when it is untracked.

## Shared store

- What: the one lock, atomic-write, JSONL and transcript-finding module for the plugin CLI, plus the helpers `factory.ts` once held (`CliError`, `usage`, `refuse`, `flat`). A lock whose owner is stale is taken over under a `.break` mutex, never renamed aside; an ownerless lock's age is re-checked under that mutex.
- Entry points: `plugins/truss/bin/store.ts`; tests `plugins/truss/tests/store.check.ts`; row shapes `plugins/truss/docs/state.schema.json`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md).

## Admission holds (awaiting client, budget)

- What: `factory.ts admit` and `start` hold a crew while the inbox blocks it or the budget is spent; `stage.js` turns the hold into `BLOCKED: awaiting client: ...` or `BLOCKED: budget: ...` and retries once on `store busy`. `start` reports held crews in `held`, with `why`.
- Entry points: `plugins/truss/bin/factory.ts` (`admission`, `holdOf`, `stageOut`), `plugins/truss/workflows/stage.js` (`admit`).
- Owner: `truss-plugin-node`, `truss-workflow-scripts`.
- Docs: [store](knowledge/store.md).

## Client inbox (escalate, resolve, notify)

- What: escalations land in the shared `inbox.jsonl`; `factory resolve --by client` needs a human-typed `/truss:inbox <decision> <E-id> <code>` line in the session transcript. The `/truss:inbox` skill (model invocation disabled) lists open items with no arguments. `notify-run.ts` runs the client's `notify` command for each new item, with a 10 s limit. Only `codeHash` is stored; the code goes to the PM's message and the notify stdin.
- Entry points: `plugins/truss/bin/inbox.ts`, `plugins/truss/bin/notify-run.ts`, `plugins/truss/skills/inbox/SKILL.md`; tests `plugins/truss/tests/inbox.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Inbox transcript proof"), `plugins/truss/docs/adr/0037-shared-store-and-inbox.md`.
- Note: the skill passes the note via `--note-file`; `textOf` (`bin/inbox.ts:288`) reads it for `--note` and `--title`. Without a typed line the skill asks the human to type the decision line.

## Contract-025 module stubs (guard, cost, worktypes, ledger, queue)

- What: stub modules with the final exported signatures; later crews fill in the bodies and keep the exports. `cost` and `worktypes` already feed admission and `plan-check`.
- Entry points: `plugins/truss/bin/guard.ts`, `cost.ts`, `worktypes.ts`, `ledger.ts`, `queue.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Stub modules").

## Plan work type

- What: version-4 plans may give a crew a `workType`; `plan-check` rejects it on older versions or with a bad value, and requires `unattended` where needed. The schema forbids it below version 4; the message text comes from code.
- Entry points: `plugins/truss/docs/plan.schema.json`, `plugins/truss/bin/factory.ts` (`cmdPlanCheck`, `WORK_TYPES`), `plugins/truss/tests/plan-worktype.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Stored row shapes").

## Long-term cost lines in QC

- What: `stage.js` `qc()` returns `longTermCosts` from QC output lines starting `LONG-TERM-COST:`, only when there are any; a line is never a FAIL.
- Entry points: `plugins/truss/workflows/stage.js` (`ltcLinesOf`, `qc`); tests `plugins/truss/tests/workflows.check.ts`.
- Owner: `truss-workflow-scripts`.

## Plan spawn labels

- What: a plan.js spawn label must parse (`parseLabel` in factory.ts) to the slug truss, or `sessionAudit` flags the run. The PO-revised designer is truss-designer-2 (fix run truss-designer-4), the re-check truss-checker-2 (fix run truss-checker-4); a -po or -2 suffix on a numbered label reads as another slug.
- Entry points: plugins/truss/workflows/plan.js (lines 203-204), plugins/truss/bin/factory.ts (sessionAudit).
- Owner: truss-workflow-scripts.
