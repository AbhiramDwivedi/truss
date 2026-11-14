### Stage step times (ADR-0009)

`stage.js` has no clock, so it cannot stamp the time a step ended. Instead, every crew result, passed or stopped, carries `stepEnds`: a list of `{ step, agent }` in the order the steps ended. Each time a member, runner or QC engineer returns, `endStep` in `workflows-src/stage/crew.js` records its label against the crew's current `crew.step` (called from `ask` and from `runQc` in `workflows-src/stage/qc.js`). `stepEndsOf` copies the list into the stopped result (`stopResult`) and the passed result (`qc`). A step that ran no agent has no entry. A step entered again, such as a QC fix round, moves its entry to the end, so each step has one entry.

At finish, `recordRun` and `recordEscalations` in `bin/factory/audit.ts` give each event line a `ts` from a transcript (`transcriptFacts` in `bin/factory/runs.ts`):

| Event | Time it takes |
|---|---|
| `spawn` | the agent's first transcript time (`firstTs`) |
| `report` | the agent's last transcript time (`lastTs`) |
| `restart` | the first transcript time of the restarted agent |
| `tag` | the latest `lastTs` of the agents whose label `stepEnds` names for the step the crew stopped at (`at`), or for the last entry when that step has none (`tagAgent`, `stepAgent`, `endOf`) |
| `allowance-spent` | the latest `lastTs` of the QC engineer whose FAIL spent the allowance |
| `knowledge` | the latest `lastTs` of the agent `stepEnds` names for the `knowledge` step, or for the last entry |

When no time can be read, `stamp` adds no `ts`, and `appendEvent` in `bin/factory/log.ts` writes the finish time, as before. So a batch write at finish no longer gives every event the same time.

This supersedes one sentence of "Timing baseline (0.31.0, speed goal step 0)" under "Roles and who talks to whom": a stage's spawn and tag events no longer all carry the stage's end time when a transcript time can be read. The `stampLagMs` and `batchOf` logic in `retro/timing.ts` still handles the finish-time fallback. TODO: decide whether `batchOf` and that paragraph need revising.

`tests/stage-events-032.check.ts` pins this. It also drives `concludeFrontmatterMerge` through `finish`: a crew branch whose only conflict with the target is doc frontmatter merges with no conflict marker and no merge left in progress.
