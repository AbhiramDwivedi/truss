---
paths:
  - "plugins/truss/tests/**/*.ts"
sources:
  - plugins/truss/bin/factory/audit.ts
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/build-stage.ts
  - plugins/truss/bin/testmap.ts
  - plugins/truss/tests/run-survival-qc-032.check.ts
  - plugins/truss/tests/stage-steps-032.check.ts
  - plugins/truss/tests/stage-step-ruling.check.ts
verified: 328e72ca
---

Closeout, deferred-fix and stage-step test rules (0.32.0; see also plugin-tests, plugin-tests-fixtures, plugin-tests-leaf, plugin-tests-heavy).

## Closeout test rules

- A new inbox kind goes into `KINDS` in `bin/inbox.ts`, the `escalate` kind enum in `docs/events.schema.json` and `$defs.inboxKind` in `docs/state.schema.json`; `validateEvent` in `tests/fixtures/workflow-run/harness.ts` validates a real escalate event (`closeout-review-node-032.check.ts`).
- Prove a `stage.js` case red against an older bundle: write `git show <rev>:plugins/truss/workflows/stage.js` to a file and point `TRUSS_STAGE_UNDER_TEST` at it (`closeout-review-stage-032.check.ts`, `STAGE`). `1d95d43` has the `pendingCall` only `runTask` read; `be2128b` has the question-or-answer heuristic.
- `doc-citations-031.check.ts` also scans `docs/goals`. Cite code by symbol or section heading there, never `file:<N>`.
- A skipped `node:test` case prints `ok N - <title> # SKIP`, and `passes()` in `closeout-032.check.ts` accepts it, so a doc row can cite a case that never ran. Cite only titles that run by default.
- A test that reads an out-of-repo dir through an env var skips with a message when the var is unset, via `test(name, {skip}, fn)`, so the title stays pinned and the full suite stays green (`closeout-032.check.ts`, `WAVE4_SKIP`).
- A timing limit in a test that runs under parallel heavy slots measures `process.cpuUsage`, not wall time (`trust-026.check.ts`, the "20 resolved items" case).

## Deferred fixes test rules

- Prove a tree kill with a pipe the test holds, not a pid poll and not a margin: `inbox.check.ts` runs `bin/notify-run.ts` with `TRUSS_TEST_NOTIFY_STDERR=inherit` and waits for the child's `close`, which fires only when notify-run, the command and its detached grandchild (`fixtures/inbox/spawn-sleeper-pipe.ts`) have all exited.
- Prove a test failing-first against old code once, from a scratch dir and outside the suite: build the old tree in a mkdtemp dir with a private `GIT_INDEX_FILE`, `git read-tree <rev>:plugins/truss` and `git checkout-index -a -f --prefix=<dir>/`, then write the new test files over its tests. Give the old code's hang a short limit through its own env (`TRUSS_GOALCHECK_TIMEOUT_MS`) so no process outlives the run, and run the same titles on the current checkout as a control. Paste the output as evidence with its date, head and command (`tests/fixtures/deferred-031/goalcheck-proof-evidence.txt`), and give the ledger entry a reason line pointing at it. Never keep the proof as a suite test: it rebuilds the old commit on every run and fails in any clone without that commit, so no permanent test may depend on git history.
- Before deleting a fixture under `tests/fixtures/`, grep every test for it: a second test may share it. Removing `fixtures/inbox/spawn-sleeper.ts` broke `trust-026.check.ts`, so it stays and the new tree-kill test uses `spawn-sleeper-pipe.ts`.
- A test that makes the session scripts dir unwritable makes `<transcripts root>/<project>/<sid>/workflows` a regular file, which fails the same way on macOS, Linux and Windows (`deferred-032.check.ts`, `blockedWorld`).

## Stage result shape and single-step tests

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
- `audit.ts` `recordRun` and `recordEscalations` stamp spawn, report, restart, tag, allowance-spent and knowledge events with transcript times via `stamp()`; a step with no readable transcript time keeps the finish-time `ts`.
- A new stage test drives one step (ADR-0050): `loadStageStep(<module path>, stubs)` from `bin/build-stage.ts`, as `stage-step-ruling.check.ts` does. Name the module by a relative literal (`'../workflows-src/stage/ruling.js'`): `bin/testmap.ts` resolves it to that one file, so only a change to that module selects the test. A bare `'ruling.js'` links to every file of that name.
- Never name `stage.js` in the test, not even in a test title or a quoted word in a comment: any literal whose file name is `stage.js` links the test to the bundle and so to every module. A test that calls `loadStageBundle` is linked to every module by that name (`testmap.ts` `stageBundles`); keep it for a check that needs the whole bundle, such as `stage-steps-032.check.ts` test "a single step driven alone returns the same result as the same step inside the stage.js bundle".
- Stub every free name the step reaches (`agent`, `args`, `log`, runner calls such as `integrate`). A missing one throws a ReferenceError when reached, which shows what the step needs. Read the step's functions from the returned `scope`; only names declared at column 0 are in it (`declaredNames`).
