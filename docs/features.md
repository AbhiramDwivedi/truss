# Feature map

One entry per capability. Rules: [plugin-tests](../.claude/rules/plugin-tests.md). Product calls: [product-decisions](knowledge/product-decisions.md). Never nest backticks around a path here: the knowledge lint reads the inner path as a repo path and fails when it is untracked.

## Shared store

- What: the one lock, atomic-write, JSONL and transcript-finding module for the plugin CLI, plus the helpers `factory.ts` once held (`CliError`, `usage`, `refuse`, `flat`).
- Entry points: `plugins/truss/bin/store.ts`; tests `plugins/truss/tests/store.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/architecture.md` ("The store" section), `plugins/truss/docs/state.schema.json`.

## Admission holds (awaiting client, budget)

- What: `factory.ts admit` and `start` hold a crew while the inbox blocks it or the budget is spent; `stage.js` turns the hold into `BLOCKED: awaiting client: ...` or `BLOCKED: budget: ...` and retries once on `store busy`.
- Entry points: `plugins/truss/bin/factory.ts` (`admission`, `holdOf`), `plugins/truss/workflows/stage.js` (`admit`).
- Owner: `truss-plugin-node`, `truss-workflow-scripts`.
- Docs: `plugins/truss/docs/architecture.md` ("Holds before memory").

## Contract-025 module stubs (inbox, guard, cost, worktypes, ledger, queue)

- What: stub modules with the final exported signatures; later crews fill in the bodies. `cost` and `worktypes` already feed admission and `plan-check`.
- Entry points: `plugins/truss/bin/inbox.ts`, `guard.ts`, `cost.ts`, `worktypes.ts`, `ledger.ts`, `queue.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/architecture.md` ("Stub modules", "Work type in the plan").

## Plan work type

- What: version-4 plans may give a crew a `workType`; `plan-check` rejects it on older versions or with a bad value, and requires `unattended` where needed.
- Entry points: `plugins/truss/docs/plan.schema.json`, `plugins/truss/bin/factory.ts` (`cmdPlanCheck`, `WORK_TYPES`), `plugins/truss/tests/plan-worktype.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/architecture.md` ("Work type in the plan").

## Plan spawn labels

- What: a plan.js spawn label must parse (`parseLabel` in factory.ts) to the slug truss, or `sessionAudit` flags the run. The PO-revised designer is truss-designer-2 (fix run truss-designer-4), the re-check truss-checker-2 (fix run truss-checker-4); a -po or -2 suffix on a numbered label reads as another slug.
- Entry points: plugins/truss/workflows/plan.js (lines 203-204), plugins/truss/bin/factory.ts (sessionAudit).
- Owner: truss-workflow-scripts.
