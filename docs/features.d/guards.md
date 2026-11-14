## End-of-run worktree cleanup

At the end of a run, only `finish` (through `sweepMembers` in `bin/factory/retire.ts`) retires the Claude Code Agent worktrees `agent-<agentId>` and branches `worktree-agent-<agentId>` of merged or dropped crews. A crew is matched only by a `spawn` event in `events.jsonl` carrying that `agentId` and `crew`; the `wf_<run>-<n>` name match never sees these. A worktree whose tip the target lacks, that is locked, or that has changes is kept and listed in `leftWorktrees` with its why (`unmerged`, `locked`, `dirty`). A running crew's agent worktrees are never touched. `land` only merges the crew and retires its own `truss-<slug>` worktree (`cmdLand` calls `mergeCrew`), so a solo or lean crew's Agent worktrees stay until a later `finish` sweep.
- Tests: `plugins/truss/tests/guards-032.check.ts` cases 5 and 6.

## Decision log Bash guard

- What: a main-session `Bash` command that writes this session's `decisions.md` is refused with the decide-command text (`DECISION_LOG_REFUSAL`), so `factory.ts decide` stays the only writer whatever tool writes. It covers a redirect (`>`, `>>`, `1>`, `&>`, `>&file`, `<>`), `tee`, `sed -i`, a heredoc with a redirect, a nested shell (`bash -c`, `sh -c`), a command or process substitution, a write after a lone `&` (`echo x & tee log`), `uniq in log`, and any other command (`cp`, `mv`, `truncate`, `rm`, `eval`, `xargs`, an interpreter) that names the file. A command that names the file with a target it cannot resolve (a `$` variable, a glob, `~`, a substitution, a relative path after a `cd`) is refused. A read (`cat`, `grep`, `tail`, `head`, `wc`, `ls`, `test`) and the decide command are allowed. A member (an `agentId`) is not gated. Unlike the other hook handlers it fails closed: an error while judging a command that names the file refuses it.
- Entry points: `hooks/register.ts` `decisionLogBashVerdict`, `namesDecisionLog`, the main-session branch of the `Bash` `tool.call` handler.
- Limits: it is name-based. A command that never spells `decisions.md` (a name built from variables) is not seen.
- Tests: `plugins/truss/tests/guards-032.check.ts` cases 1 to 3.
