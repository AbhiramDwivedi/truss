## Stage step event times

- What: each stage step's line in `events.jsonl` carries the time that step ended, not the time `factory finish` ran. `stage.js` has no clock, so every crew result, passed or stopped, carries `stepEnds`: a list of `{ step, agent }` naming the last agent that returned in each step. `finish` reads that agent's transcript and writes the time as the event's own `ts`. When no transcript time can be read, the event keeps the finish time.
- Entry points: `plugins/truss/workflows-src/stage/crew.js` (`endStep`, `stepEndsOf`, `stopResult`, `ask`), `plugins/truss/workflows-src/stage/qc.js` (`runQc`, `qc`), `plugins/truss/bin/factory/audit.ts` (`recordRun`, `recordEscalations`, `stamp`, `endOf`, `stepAgent`, `tagAgent`), `plugins/truss/bin/factory/runs.ts` (`transcriptFacts`); tests `plugins/truss/tests/stage-events-032.check.ts`, which also drives `concludeFrontmatterMerge` through `finish`.
- Owner: `truss-workflow-scripts` (crew.js, qc.js), `truss-plugin-node` (audit.ts).
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Stage step times (ADR-0009)").
