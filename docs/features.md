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

## Contract-025 module stubs (inbox, guard, cost, worktypes, ledger)

- What: stub modules with the final exported signatures; later crews fill in the bodies and keep the exports. `cost` and `worktypes` already feed admission and `plan-check`. `queue` left this list: it is filled in (next entry).
- Entry points: `plugins/truss/bin/inbox.ts`, `guard.ts`, `cost.ts`, `worktypes.ts`, `ledger.ts`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md) ("Stub modules").

## Intake queue

- What: `plugins/truss/bin/queue.ts` keeps one JSON item per queued job at `<shared>/queue/items/<Q-id>.json` (id `Q-` plus sha12 of the key); every write runs under the `queue` lock. `queue-next` checks the budget, releases stale claims (`by: "stale"`), returns this session's claimed or running item, else claims the oldest `new` item, and writes its id into `<dir>/unattended.json` only if that file exists. The session id is the basename of `--dir`. `intake` and `unattended` events carry crew `main`, since the events schema requires a crew. An md key is `md:` plus sha16 of the item text and truss never writes `docs/queue.md`: editing a line adds a new item, so drop the old one with `queue-set --state dropped`.
- Entry points: `plugins/truss/bin/queue.ts` (`QUEUE_COMMANDS`), `plugins/truss/tests/queue.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

## Unattended brief

- What: while `<truss dir>/unattended.json` exists, `truss:brief` records source `{kind: "intake", id}` and writes its own goal sentence. A large item goes to triage. A standard item runs `remaining` instead of `next`, marks branches the facts don't settle `by: "default"` and files a non-blocking `client-question` (`--ref brief:<sid>:<branch>`, `--title-file`); it skips the closing question and logs `Defaults filled: R-<n> (<branch>, E-<id>)`.
- Entry points: `plugins/truss/skills/brief/SKILL.md` ("Unattended brief"), `plugins/truss/tests/brief-unattended.check.ts`, `plugins/truss/tests/unattended.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0039](../plugins/truss/docs/adr/0039-unattended-start.md), [ADR-0040](../plugins/truss/docs/adr/0040-intake-queue.md).

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
