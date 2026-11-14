## Find and resume a run another session left

- What: `factory.ts find-run --repo R` lists the approved runs under the repo's `<git common dir>/truss/*/plan.json` that still have a crew neither `merged` nor `dropped`, newest first, each with its `dir`, `session`, main `transcript`, and unfinished `crews` with their saved `results`. It only reads, and there is no pointer file. A new PM session resumes a listed run with that `dir` as `--dir`; `start` claims each `planned` crew under the plan lock, so two sessions resuming one run start each crew once.
- Entry points: `plugins/truss/bin/factory/find-run.ts` `cmdFindRun`; `plugins/truss/bin/factory/start.ts` `claimedWorktree`; `plugins/truss/skills/run/SKILL.md`, section "Resume a run an earlier session left"; ADR-0052.
- Limits: the PM decides whether to resume; `find-run` starts nothing. The claim does not re-check `maxParallelCrews` under the lock, so two concurrent resumes can together pass the cap.
- Tests: `plugins/truss/tests/run-survival-032.check.ts` cases 1 to 3 and 6.

## Cross-session trussFile gate

- What: the Workflow gate's `args.trussFile` may name a file under any `<git common dir>/truss/<name>/` dir of the repo, not only the session's own, so a PM session can pass another session's `start` output. It still refuses both `truss` and `trussFile` at once, a path that is not absolute, one outside every such dir (a `..` climb, a sibling of the git common dir, a file directly in the truss root), a real path outside the truss root, and a file that is not JSON or holds no object `truss`.
- Entry points: `plugins/truss/hooks/register.ts` `expandTrussFile` (its `trussRoot` argument) and the Workflow `tool.call` handler; ADR-0052, which amends ADR-0024 seam 3.
- Limits: the gate does not check that `<name>` is a session, so `truss/shared/` passes. Outside a git repo the root is `~/.claude/truss`, which spans every such session.
- Tests: `plugins/truss/tests/run-survival-032.check.ts` cases 4 and 5.
