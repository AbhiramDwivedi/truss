## End-of-run worktree cleanup

At the end of a run, `finish` (and `land`) retire the `agent-<agentId>` worktrees and `worktree-agent-<agentId>` branches of merged or dropped crews, attributed by the `spawn` event with that agentId (`bin/factory/retire.ts` `sweepMembers`). A worktree whose tip the target lacks, that is locked, or that has changes is kept and listed in `leftWorktrees` with its why (`unmerged`, `locked`, `dirty`). A running crew's agent worktrees are never touched.
