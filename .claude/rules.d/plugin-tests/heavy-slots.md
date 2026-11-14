---
sources:
  - plugins/truss/bin/factory/heavy.ts
  - plugins/truss/bin/factory/slot.ts
  - plugins/truss/resources/index.ts
  - plugins/truss/tests/heavy-slots-032.check.ts
  - plugins/truss/tests/heavy-slots-stage-032.cases.ts
  - plugins/truss/tests/heavy-slots-stress-032.check.ts
  - plugins/truss/tests/heavy-slots-stress-stage-032.check.ts
  - plugins/truss/tests/heavy-031.check.ts
  - plugins/truss/bin/fragments.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/factory/check.ts
  - plugins/truss/bin/factory/decide.ts
  - plugins/truss/workflows-src/stage/check.js
  - plugins/truss/tests/heavy-slots-fullcheck-032.check.ts
verified: 23480087acd6f75c1d6d42e583a4657ded1800b9
---

## Heavy job seams (0.32.0)

- Drive the win32 heavy job on any host in process: call `heavyJobMain(['--dir', D, '--job', key], sys)` with `sys = { platform: 'win32', spawn }`, where `spawn` records each call and delegates to the real `child_process.spawn`, after writing `D/resources/jobs/<key>/job.json` as `startJob` does. Assert `windowsHide: true` on every recorded spawn, then read `result.json` and `out.txt` (`heavy-slots-032.check.ts` "a heavy background job on win32 runs, reports its result and releases its slot"). `heavyMain` takes the same `HeavySys` but uses only its `spawn`. A stubbed run is never proof of a real Windows run; say so in the doc or report.
- `resources/index.ts` takes the platform and a `spawnSync` stand-in as trailing parameters (`takeHeavySlot`, `killGroup`, `treeKill`), and `cmdReap` takes the platform as its second argument.
- Test the run limit with real processes by setting `TRUSS_HEAVY_RUN_MS` low (1500) through `runCli`'s extra env, with `TRUSS_HEAVY_ATTACH_MS` low on the first call so it returns `pending` and high on the second so it collects `heavy.timedOut` (`runMsOf` reads the variable; "a heavy job that is a real sleeping child process past its limit is stopped and its slot released").
- Test the `until` takeover without waiting for a run limit: plant `D/resources/heavy.lock/owner.json` whose `pid` is a live detached sleeper and whose `until` is `Date.now() + 1500`, then run `heavy` and wait on the sleeper's `exit` event ("a second real check process takes the slot a hung real job held once the limit passes"). Wait on a real signal, never a fixed sleep.
- A `node:test` `{ timeout }` cannot interrupt a case blocked in `runCli` (`spawnSync`). Bound such a case with the command's own wait and attach env (`TRUSS_HEAVY_WAIT_MS`, `TRUSS_HEAVY_ATTACH_MS`) so a red run fails fast, and kill any real sleeper the case spawned in a `finally` block (`heavy-slots-032.check.ts` cases 4 and 5).
- A real-CLI heavy test uses `mkEnv({useRealPlugin:true})`, scrubs `GIT_*` and `NODE_TEST_CONTEXT` from the env, and sets `TRUSS_HEAVY_ATTACH_MS`, `TRUSS_HEAVY_WAIT_MS` and `TRUSS_HEAVY_RUN_MS` (`heavy-slots-stress-032.check.ts` `world`, `cleanEnv`). The `heavy-031.check.ts` case "a heavy run longer than the attach budget..." asserts the slot lock exists 300 ms after the caller returns, so a loaded host can fail it; re-run it alone before suspecting a code change.
- A test that drives `factory check` through `factory heavy` passes `--expect green` (or `red`) with `--full`, or the check exits 2 with `missing --expect` before it runs the suite (`heavy-slots-fullcheck-032.check.ts` `world`).
- `bashRun` in `bin/factory/check.ts` takes an optional `group` (`{dir, label, slug}`) that only a direct full-suite check passes (`suiteRun`): the suite then runs detached as its own process group, recorded under `resources/groups` with `heavyPid` set to the check's pid, so the `until` takeover stops it with its owner. Under `factory heavy` (env `TRUSS_HEAVY_JOB`) no record is made, because the wrapper's group already holds the suite. A test of that path needs a real second process; see "a second real check process takes the slot a hung real job held once the limit passes".
- A goal-check the run limit stops must still clean up: `cmdGoalCheckJob` (`bin/factory/decide.ts`) runs the check async with a SIGTERM handler, so the worktree removal and the decision line happen and the body carries `timedOut` (`heavy-slots-stress2-032.check.ts` "heavy stress 3"). A run limit of 2^31 ms or more is clamped to the longest `setTimeout` delay (2147483647 ms) in `heavyJobMain` ("heavy stress 4"). Node fires a longer delay after 1 ms, so clamp any user-set duration before it reaches `setTimeout`.
- A stage-bundle behavior can be a standalone `.check.ts` that drives `loadStageBundle` with a `gatesAware` stub agent and parses runner prompts for `factory.ts <cmd>` (`heavy-slots-stress-stage-032.check.ts` `drive`, `parseRunner`).
- A doc fragment starts with its shallowest heading: `fragmentSections` (`bin/fragments.ts`) drops text before the first shallowest heading, so a `###` section placed first is lost. Put a `###` under a `##` that comes first.
- A file named `*.cases.ts` holds tests that one `*.check.ts` imports for its side effect (`import './heavy-slots-stage-032.cases.ts'`), so the case titles run under that check and the acceptance test can match them. The default suite globs only `*.check.ts`, so the cases run once.
