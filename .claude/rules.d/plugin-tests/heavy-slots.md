---
sources:
  - plugins/truss/bin/factory/heavy.ts
  - plugins/truss/bin/factory/slot.ts
  - plugins/truss/resources/index.ts
  - plugins/truss/tests/heavy-slots-032.check.ts
  - plugins/truss/tests/heavy-slots-stage-032.cases.ts
---

## Heavy job seams (0.32.0)

- Drive the win32 heavy job on any host in process: call `heavyJobMain(['--dir', D, '--job', key], sys)` with `sys = { platform: 'win32', spawn }`, where `spawn` records each call and delegates to the real `child_process.spawn`, after writing `D/resources/jobs/<key>/job.json` as `startJob` does. Assert `windowsHide: true` on every recorded spawn, then read `result.json` and `out.txt` (`heavy-slots-032.check.ts` "a heavy background job on win32 runs, reports its result and releases its slot"). `heavyMain` takes the same `HeavySys` but uses only its `spawn`. A stubbed run is never proof of a real Windows run; say so in the doc or report.
- `resources/index.ts` takes the platform and a `spawnSync` stand-in as trailing parameters (`takeHeavySlot`, `killGroup`, `treeKill`), and `cmdReap` takes the platform as its second argument.
- Test the run limit with real processes by setting `TRUSS_HEAVY_RUN_MS` low (1500) through `runCli`'s extra env, with `TRUSS_HEAVY_ATTACH_MS` low on the first call so it returns `pending` and high on the second so it collects `heavy.timedOut` (`runMsOf` reads the variable; "a heavy job that is a real sleeping child process past its limit is stopped and its slot released").
- Test the `until` takeover without waiting for a run limit: plant `D/resources/heavy.lock/owner.json` whose `pid` is a live detached sleeper and whose `until` is `Date.now() + 1500`, then run `heavy` and wait on the sleeper's `exit` event ("a second real check process takes the slot a hung real job held once the limit passes"). Wait on a real signal, never a fixed sleep.
- A file named `*.cases.ts` holds tests that one `*.check.ts` imports for its side effect (`import './heavy-slots-stage-032.cases.ts'`), so the case titles run under that check and the acceptance test can match them. The default suite globs only `*.check.ts`, so the cases run once.
