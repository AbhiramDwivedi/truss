# ADR-0054: a heavy slot past its deadline is stale, even with a live owner

Status: accepted, 2026-11-14
Decided by: crew heavy-slots (goal 0.32.0, R-145 and the heavy-job requirements), the client accepted the run limit on 2026-11-14 (decisions.md 09:33), on condition that the stop message names TRUSS_HEAVY_RUN_MS and how to raise it
Amends: ADR-0015 Decision 3 (stale-lock takeover), ADR-0046 (heavy job from 0.31.0)

## Context

The number is 0054 because plan.md reserves ADR-0049 to ADR-0053 for other crews of the 0.32.0 run.

Before this change a heavy slot was stale only when its owner pid was dead. A hung command under a live wrapper held the slot for ever, and on win32 a group kill by negative pid does not exist.

## Decision

- Each slot's `owner.json` carries `until`: start time plus the run limit plus `HEAVY_GRACE_MS` (15 s). The run limit is `TRUSS_HEAVY_RUN_MS`, default `slotWaitMs(dir)` (`runMsOf` in `bin/factory/slot.ts`). A run the limit stopped is recorded in `heavy-times.jsonl` with `timedOut: true`; `slotWaitMs` skips such a row, while `runMsOf` raises the next default limit to twice the longest of them (never above `HEAVY_WAIT_MAX_MS`), so a healthy suite longer than the default limit is not stopped for ever.
- `takeSlot` in `resources/index.ts` treats a lock past `until` as stale even with a live pid. It re-reads the token and stops the holder (`stopHolder`): the recorded groups whose `heavyPid` or `pgid` is the owner pid, then the owner's own process group when it leads one, then the owner pid with SIGKILL (tree kill on win32). Only then does it take the lock through `takeOver`, so one waiter removes it. The group stop is what ends a check's suite under `factory heavy`, where the check leads the group the wrapper spawned and `bashRun` writes no group record of its own.
- The wrapper also stops its own command at the run limit (SIGTERM, SIGKILL 2 s later), releases the slot and writes `result.json` with `timedOut: true`.
- On win32 a group is its leader's pid: `groupAlive` is a pid check and `killGroup` is `treeKill` (`taskkill /T /F`). `heavyMain` and `heavyJobMain` take `sys = { platform, spawn }` so the branch runs under a stub on any host. It has not run on Windows.

## Consequences

- A hung suite frees its slot after at most the run limit plus the grace.
- A client whose suite runs longer than the default limit loses the first run, and the next default limit is twice as long. Setting `TRUSS_HEAVY_RUN_MS` avoids that first loss.
- A reused pid can be signalled by mistake while the lock waits past `until`; the token re-read just before the kill narrows the window but does not close it.
- A lock without `until` (an older plugin) behaves as before.
