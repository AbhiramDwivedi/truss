## Shared store

- What: the one lock, atomic-write and JSONL code for the plugin CLI (`bin/lock.ts`), the transcript roots (`bin/transcripts.ts`: `transcriptsOf`, and `proofTranscriptRoot` for the inbox proof), and the helpers `factory.ts` once held (`bin/core.ts`: `CliError`, `usage`, `refuse`, `flat`). A lock whose owner is stale is taken over under a `.break` mutex, never renamed aside; an ownerless lock's age is re-checked under that mutex (ownerless after 3 s). The atomic writers sweep orphan tmp files of dead writers. Since 0.32.0 `bin/store.ts` is only a barrel over the three leaves; new code imports the leaf.
- Entry points: `plugins/truss/bin/lock.ts`, `plugins/truss/bin/core.ts`, `plugins/truss/bin/transcripts.ts`; tests `plugins/truss/tests/store.check.ts`, `plugins/truss/tests/hub-split-032.check.ts`; row shapes `plugins/truss/docs/state.schema.json`.
- Owner: `truss-plugin-node`.
- Docs: [store](knowledge/store.md), [ADR-0049](../plugins/truss/docs/adr/0049-hub-split.md).

## Admission holds (awaiting client, budget)

- What: `factory.ts admit` and `start` hold a crew while the inbox blocks it or the budget is spent; `stage.js` turns the hold into `BLOCKED: awaiting client: ...` or `BLOCKED: budget: ...` and retries once on `store busy`. `start` reports held crews in `held`, with `why`.
- Entry points: `plugins/truss/bin/factory/admit.ts` (`admission`, `holdOf`), `plugins/truss/bin/factory/start.ts` (`stageOut`), `plugins/truss/workflows/stage.js` (`admit`).
- Owner: `truss-plugin-node`, `truss-workflow-scripts`.
- Docs: [store](knowledge/store.md).

## Finisher lease (resume guard)

- What: `finish` and `start --resume` hold a lease `finisher-<slug>` (`bin/lock.ts` `takeLease`/`refreshLease`/`releaseLease`) so two finishers never run one crew; a held live lease refuses the second (a live pid on the same host keeps its lease however long the acceptance test runs; only another host's lease goes stale, after 300 s). `finish` takes it per crew before writing, refreshes it before each merge and releases it in a `finally`. `start --resume` takes it before `ensureWorktree`, merges the target via `mergeIn`, and on a conflict runs `git merge --abort` and records `syncConflicts: [paths]` on the crew entry instead of refusing.
- Entry points: `plugins/truss/bin/lock.ts` (`takeLease`), `plugins/truss/bin/factory/start.ts` (`cmdStartResume`), `plugins/truss/bin/factory/finish.ts` (`cmdFinish`, `finishRun`), `plugins/truss/bin/factory/crew.ts` (`mergeIn`), `plugins/truss/tests/resume-029.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0048](../plugins/truss/docs/adr/0048-resume-guard.md), [store notes](knowledge/store.md).

## Configurable heavy slot count

- What: up to `heavySlots` red and green checks (`factory heavy`) run at once across the session. The count is the `.claude/truss.json` key `heavySlots` (1-16), else `TRUSS_HEAVY_SLOTS`, else `max(1, min(4, floor(cpus/4), floor(totalGB/8)))` from the host. Slot 1 is `resources/heavy.lock/`, slot n is `resources/heavy-<n>.lock/`; `heavy` takes the first free slot and prints the count as `heavy.slots`. Since 0.31.0 this repo's `.claude/truss.json` sets no `heavySlots`, so it runs at the host default, and the slot wait scales with the measured suite time (`slotWaitMs`: twice the longest of the last 10 slot runs, 540 s to 2 hours).
- Entry points: `plugins/truss/bin/factory/heavy.ts` (`heavyMain`), `plugins/truss/bin/factory/slot.ts` (`heavySlotsOf`, `slotWaitMs`), `plugins/truss/resources/index.ts` (`defaultHeavySlots`, `takeHeavySlot`, `releaseHeavySlot`), `plugins/truss/docs/truss-config.schema.json` (`heavySlots`); tests `plugins/truss/tests/throughput-029.check.ts` (`i4 *`).
- Owner: `truss-plugin-node`.
- Docs: [ADR-0046](../plugins/truss/docs/adr/0046-factory-throughput.md) item 4, [ADR-0015](../plugins/truss/docs/adr/0015-resource-aware.md) Decision 3, [architecture](../plugins/truss/docs/architecture.md) ("Heavy slots").

## Session scripts dir default

- What: `plan-args` and `start` copy `plan.js` or `stage.js` to `<dir of the session transcript>/<session id>/workflows/scripts/truss-<script>` and print that as `scriptPath`, so the Workflow tool accepts it; the session id is the path segment under `<git common dir>/truss/` of the truss dir. `--scripts-dir` overrides; with no session found, `scriptPath` stays the plugin's own file.
- Entry points: `plugins/truss/bin/factory/roles.ts` (`sessionScriptsDir`, `scriptPathFor`), `plugins/truss/bin/factory/plan.ts` (`cmdPlanArgs`), `plugins/truss/bin/factory/start.ts` (`cmdStart`), `plugins/truss/tests/lifecycle-029.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/skills/run/SKILL.md` sections 4 and 6; [architecture](../plugins/truss/docs/architecture.md) ("Workflow calls (ADR-0009)").
