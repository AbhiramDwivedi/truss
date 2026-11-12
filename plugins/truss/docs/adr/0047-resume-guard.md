# ADR-0047: resume guard

Status: accepted, 2026-11-12
Decided by: program manager (auto): the approved plan (decisions.md 07:28, "plan approved (auto) ... scope frozen"), resting on goal-029.md items 5 and 6 and requirements R-89 and R-90

## Context

Wave 3 found two resume defects (goal-029.md items 5 and 6):

- **Two finishers for one crew.** A `finish` or a `start --resume` could run while another finisher of the same crew was still live, so a duplicate finisher started. Nothing in the truss dir said a crew was being finished.
- **A resume built on a stale base.** `start --resume` restarted a crew on its branch as it stood, without the target's newer commits (wave-3 decisions 07:56). Only a `merge-ready` resume synced, and only inside `stage.js`.

The goal asked for "one finisher per crew, enforced by a lock or state check". The requirements are R-89 "Only one finisher runs per crew" and R-90 "A resume merges the target into the crew branch before the crew restarts".

## Decision

1. **A finisher lease per crew.** The finisher holds the file `<truss dir>/locks/finisher-<slug>.lease`, taken by `takeLease(dir, 'finisher-<slug>')` in `bin/store.ts`. The file is created with `createExclusive` and holds `{pid, host, since, refreshed, token}`; `token` is a fresh `randomUUID()` per attempt. It is a file, not a lock directory, and uses no symlink and no POSIX-only process call.
2. **When a lease is stale.** A lease is stale when its `host` is this host and its `pid` is dead (`pidDead`), or when `refreshed` (else `since`) is missing or older than `LEASE_STALE_MS` = 300 000 ms (5 minutes). A lease written by another host is judged by age only, since its pid means nothing here. A lease that cannot be parsed is judged by the file's mtime against the same window. `LEASE_REFRESH_MS` = 30 000 ms is the refresh interval the store names, shorter than the staleness window.
3. **One breaker.** A stale lease is removed only under the mutex directory `<lease>.break`, and only if the lease still carries the token that was judged stale; the lease is never renamed aside. An abandoned mutex older than `OWNERLESS_MS` (3 s) is cleared. When the breaker loses the mutex, or the removal fails (on win32 `rmSync` retries 5 times, 20 ms apart), `takeLease` returns `null` and a later call recovers the lease. `takeLease` tries at most 5 times and never throws on contention. `refreshLease` and `releaseLease` act only while the token is the caller's, under the same mutex, waiting up to 5 s for it.
4. **`start --resume` takes the lease.** `cmdStartResume` takes `finisher-<slug>` before it touches the worktree. A live lease refuses the resume with exit 1 and `{slug, why: "finisher live"}`. The lease is released when the command returns or throws.
5. **`finish` takes the lease.** `finish` takes `finisher-<slug>` for each running factory crew of the run before it writes anything for that crew. A crew whose lease is live is listed under `refused` with `why: "finisher live"` and is not recorded or merged; the other crews proceed. `finish` refreshes every lease it holds before each passed crew's merge, and releases them all on every return and throw.
6. **`start --resume` merges the target first.** Every resume kind merges the target into the crew branch in the crew worktree, with the same `mergeIn` that `factory sync` uses. On a conflict it runs `git merge --abort`, so the worktree stays clean, records the conflicting paths as `syncConflicts` on the crew entry, and still returns the entry. Any other merge failure is thrown.
7. **`stage.js` syncs first on every resume.** `chain` runs `syncStep` as the first step of every resumed run: a `merge-ready` resume as before, and every other resume before the red check and before any member starts. `syncStep` runs `factory sync --slug <slug>`; on a conflict it hands the paths to the resolver (`resolveConflicts`) and syncs again, and a sync still unmerged after the resolver stops the crew `BLOCKED` at step `R1`. A conflict that `start --resume` aborted therefore reaches the resolver here.

Code: `bin/store.ts:391-516` (`LEASE_STALE_MS`, `LEASE_REFRESH_MS`, `takeLease`, `refreshLease`, `releaseLease`), `bin/factory.ts:2026-2079` (`cmdStartResume`), `bin/factory.ts:3220-3261` and `:3334` (`cmdFinish`, `finishRun`), `workflows/stage.js:2187-2219` (`syncStep`, `chain`). Tests: `tests/resume-029.check.ts`.

## Consequences

- A second `finish` or `start --resume` for a crew whose finisher is live is refused, never queued. The program manager waits and retries.
- A finisher that crashes leaves its lease. On the same host the dead pid frees it at once; a lease from another host, or one whose pid was reused, waits out the 5-minute window.
- `start --resume` holds the lease only while the command runs. The `stage.js` run it starts holds none, so the lease does not stop a `finish` that starts while a resumed crew's Workflow is running.
- No timer refreshes the lease. `LEASE_REFRESH_MS` has no caller in `bin/factory.ts`; `finish` refreshes only before each crew's merge. A single crew's merge step that runs past 5 minutes lets its lease go stale, and a second finisher could then take it.
- `syncConflicts` on the crew entry is informational: `stage.js` does not read it and finds the conflict again through its own `syncStep`.
- Every resume now pays for one merge of the target, and a resumed crew may meet target conflicts it did not meet before. The resolver settles them before any member works on a stale base.
- Age-only judgement across hosts depends on the hosts' clocks agreeing to well within 5 minutes.
