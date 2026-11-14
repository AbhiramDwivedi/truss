## End-of-run worktree cleanup

At the end of a run, `finish` (and `land`) retire the `agent-<agentId>` worktrees and `worktree-agent-<agentId>` branches of merged or dropped crews, attributed by the `spawn` event with that agentId (`bin/factory/retire.ts` `sweepMembers`). A worktree whose tip the target lacks, that is locked, or that has changes is kept and listed in `leftWorktrees` with its why (`unmerged`, `locked`, `dirty`). A running crew's agent worktrees are never touched.

## Decision log Bash guard

- What: a main-session `Bash` command that writes this session's `decisions.md` is refused with the decide-command text (`DECISION_LOG_REFUSAL`), so `factory.ts decide` stays the only writer whatever tool writes. It covers a redirect (`>`, `>>`, `1>`, `&>`, `>&file`, `<>`), `tee`, `sed -i`, a heredoc with a redirect, a nested shell (`bash -c`, `sh -c`), a command or process substitution, and any other command (`cp`, `mv`, `truncate`, `rm`, `eval`, `xargs`, an interpreter) that names the file. A command that names the file with a target it cannot resolve (a `$` variable, a glob, `~`, a substitution, a relative path after a `cd`) is refused. A read (`cat`, `grep`, `tail`, `head`, `wc`, `ls`, `test`) and the decide command are allowed. A member (an `agentId`) is not gated. Unlike the other hook handlers it fails closed: an error while judging a command that names the file refuses it.
- Entry points: `hooks/register.ts` `decisionLogBashVerdict`, `namesDecisionLog`, the main-session branch of the `Bash` `tool.call` handler.
- Limits: it is name-based. A command that never spells `decisions.md` (a name built from variables) is not seen.
- Tests: `plugins/truss/tests/guards-032.check.ts` cases 1 to 3.
