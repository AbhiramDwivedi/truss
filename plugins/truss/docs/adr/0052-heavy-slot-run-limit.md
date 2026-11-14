# ADR-0052: a heavy slot past its deadline is stale, even with a live owner

Status: accepted, 2026-11-14
Decided by: crew heavy-slots (goal 0.32.0, R-142 and the heavy-job requirements)
Amends: ADR-0015 Decision 3 (stale-lock takeover), ADR-0046 (heavy job from 0.31.0)

## Context

Before this change a heavy slot was stale only when its owner pid was dead. A hung command under a live wrapper held the slot for ever, and on win32 a group kill by negative pid does not exist.

## Decision

- Each slot's `owner.json` carries `until`: start time plus the run limit plus `HEAVY_GRACE_MS` (15 s). The run limit is `TRUSS_HEAVY_RUN_MS`, default `slotWaitMs(dir)` (`runMsOf` in `bin/factory/slot.ts`).
- `takeSlot` in `resources/index.ts` treats a lock past `until` as stale even with a live pid. It re-reads the token, stops the recorded groups whose `heavyPid` is the owner pid (`stopHolder`), then SIGKILLs the owner pid (tree kill on win32), then takes the lock through `takeOver`, so one waiter removes it.
- The wrapper also stops its own command at the run limit (SIGTERM, SIGKILL 2 s later), releases the slot and writes `result.json` with `timedOut: true`. A run stopped that way is not recorded in `heavy-times.jsonl`, so a hang never stretches `slotWaitMs`.
- On win32 a group is its leader's pid: `groupAlive` is a pid check and `killGroup` is `treeKill` (`taskkill /T /F`). `heavyMain` and `heavyJobMain` take `sys = { platform, spawn }` so the branch runs under a stub on any host. It has not run on Windows.

## Consequences

- A hung suite frees its slot after at most the run limit plus the grace.
- A reused pid can be signalled by mistake while the lock waits past `until`; the token re-read just before the kill narrows the window but does not close it.
- A lock without `until` (an older plugin) behaves as before.
