## Closeout test rules (0.32.0)

- A new inbox kind goes into `KINDS` in `bin/inbox.ts`, the `escalate` kind enum in `docs/events.schema.json` and `$defs.inboxKind` in `docs/state.schema.json`; `validateEvent` in `tests/fixtures/workflow-run/harness.ts` validates a real escalate event (`closeout-review-node-032.check.ts`).
- Prove a `stage.js` case red against an older bundle: write `git show <rev>:plugins/truss/workflows/stage.js` to a file and point `TRUSS_STAGE_UNDER_TEST` at it (`closeout-review-stage-032.check.ts`, `STAGE`). `1d95d43` has the `pendingCall` only `runTask` read; `be2128b` has the question-or-answer heuristic.
- `doc-citations-031.check.ts` also scans `docs/goals`. Cite code by symbol or section heading there, never `file:<N>`.
- A skipped `node:test` case prints `ok N - <title> # SKIP`, and `passes()` in `closeout-032.check.ts` accepts it, so a doc row can cite a case that never ran. Cite only titles that run by default.
- A test that reads an out-of-repo dir through an env var skips with a message when the var is unset, via `test(name, {skip}, fn)`, so the title stays pinned and the full suite stays green (`closeout-032.check.ts`, `WAVE4_SKIP`).
- A timing limit in a test that runs under parallel heavy slots measures `process.cpuUsage`, not wall time (`trust-026.check.ts`, the "20 resolved items" case).
