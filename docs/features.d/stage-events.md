## Stage step event times

Each stage step's event in `events.jsonl` carries the time that step ended. `stage.js` returns `stepEnds` (`[{ step, agent }]`) on every crew result (`plugins/truss/workflows-src/stage/crew.js` `endStep`, `stepEndsOf`; `plugins/truss/workflows-src/stage/qc.js` `qc`), and `factory finish` stamps each event from that agent's transcript time (`plugins/truss/bin/factory/audit.ts`).
