---
sources:
  - plugins/truss/docs/adr/0052-run-survival.md
  - plugins/truss/bin/factory/start.ts
  - plugins/truss/skills/run/SKILL.md
verified: f969c4c17345c52b0348cfc607a355f6cc8f3302
---

## run-survival: one PM session drives a run

- Question: should two PM sessions be able to resume the same run at once, with an owner token or process-liveness check on the start claim?
- Answer: no. One PM session drives a run, and concurrent resume of one run is not supported. The claim in `claimedWorktree` records no owner, `reclaimOrphans` checks no process liveness, and plan.json gains no field for the project-manager-path mark (a `pm-crew` event in events.jsonl instead).
- Reason: the cost of an owner and heartbeat protocol outweighs the case. Two concurrent starts can pass `maxParallelCrews`, and `find-run` cannot tell whether an old PM is alive, so the run skill has the new PM ask the client before it takes a run over.
- Decided by: client trim, 2026-11-14 (ADR-0052, Decision 2 and Consequences).

## run-survival: the trussFile gate spans the repo's truss dirs

- Question: may a PM session pass another session's `start` output to the Workflow gate?
- Answer: yes, for any `<git common dir>/truss/<name>/` dir of the same repo. The gate does not check that `<name>` is a session id, and a later hook that reads `args.trussFile` must treat the file as possibly another session's.
- Reason: R-135 and R-141: a resumed run keeps its goal files, reports and crew state in the old dir, so copying them would split one run across two dirs.
- Decided by: program manager (auto), recorded in ADR-0052; the long-term cost was logged in the goal's approved scope at 16:58.
