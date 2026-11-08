# ADR-0030: finish retires every member worktree of a terminal crew; the PM's TaskStop stops the run's leftover processes

Status: accepted
Decided by: client request, 2026-11-07; item 7 by client ruling, 2026-11-08 (truss 0.20.1)
Amends: ADR-0021 Decision 7

## Context

After many runs, 38 worktrees sat in `.claude/worktrees/` on `worktree-wf_<run>-<n>` branches. Each crew member (builder, tester, each fix round) gets its own worktree, and only the crew's final result lands on the target, often as a new commit. So the earlier members' branches hold stale file versions that never become ancestors of the target, and the 0.19.0 sweep kept them as `unmerged` forever. Dropped crews, crews whose rework allowance was spent, and crews redone by a later run, resume or fix goal left their members too. Worktrees also looked dirty only because the worktrees plugin links `ui/node_modules` into the main checkout as an untracked symlink.

Processes outlived their work as well: a UI dev server ran 9 hours with its cwd inside a member worktree, and finished subagents stayed open until the PM stopped them by hand.

## Decision Drivers

- Nothing a member committed is lost.
- No worktree with real uncommitted work is removed.
- Leftover processes are stopped on Linux, macOS and Windows alike, never only on Linux.
- Never stop another session's process: truss runs beside other Claude Code sessions on the same machine.

## Considered Options

1. Keep the 0.19.0 rule (merged and clean only). Leaves every superseded member forever.
2. Delete unmerged member branches outright. Loses work that a later ruling might want.
3. Archive the tip as a ref, then delete the branch and worktree. Chosen.

## Decision

`factory.ts finish`, after every crew of the run has had its merge turn, sweeps member worktrees (`sweepMembers`):

1. A crew is terminal when it merged in this finish (`merged`), its plan status is `dropped` (`dropped`), or this finish refused it because its rework allowance is spent (`failed`).
2. A member worktree `wf_<run>-<n>` on branch `worktree-wf_<run>-<n>` belongs to the crew whose agent transcript in that run has it as cwd, else to the run's only crew in the spawn events. Only runs this truss dir recorded count (spawn events `by: workflow:<run>`), so another goal's crew of the same slug is never touched.
3. Every member of a terminal crew is retired, from this run and from earlier runs alike, with no idle wait. Member branches whose worktree is already gone are retired too, and a dropped crew's own `truss-<slug>` worktree and branch.
4. Before a branch whose tip the target lacks is deleted, the tip is kept as `refs/truss/archive/<run id>/<branch>`. A merged crew's member whose tip the target lacks is logged as `superseded`.
5. Each retirement appends one `retire` event (crew, run, branch, worktree, reason, archive).
6. A worktree stays, and is listed in `leftWorktrees`, when it is locked or has real changes. A process inside it never keeps it (item 7). Real changes are anything `git status --porcelain --untracked-files=all` lists, except an untracked symlink that points into the main checkout outside the worktree; such links are unlinked before `git worktree remove`, which never runs with `--force`.
7. truss stops no process. Claude Code's TaskStop does: stopping a finished subagent, Workflow run or background shell stops every background process it started, grandchildren included, on every OS, scoped to this session (the client's ruling of 2026-11-08). The PM is the reaper (`skills/run/SKILL.md`): it stops each finished one whose work is merged, recorded or dropped, through a session-scoped CronCreate job every 30 minutes and once more in the end-of-run sweep, which then deletes the job. A process stays the session's only when it was started through Bash `run_in_background`, so the members' shell rules (`SHELL_RULES` in `hooks/register.ts`) say to start a long-running process that way and never with `&`, `nohup`, `setsid` or `disown`, and the detach gate refuses a member's Bash command that does. 0.20.0 found processes by `/proc/<pid>/cwd` (Linux only) and signalled them. That is gone: a system scan can't tell this session's processes from another session's, and on macOS and Windows it found nothing. `stop` events are no longer written; the schema keeps the type for old logs. The two remaining `/proc` reads concern pids truss knows, and each has a safe path off Linux: pid liveness is `process.kill(pid, 0)` everywhere (the zombie check is Linux-only), and the session start time is unknown off Linux, so `start` warns that it can't tell whether the stress agent file changed rather than pass silently.
8. Members of crews that are not terminal keep the 0.19.0 rule, run only when a crew merged: this run's own, or an older run's idle an hour, removed once merged into a merged crew's branch or the target and clean.
9. Archive refs whose commit is older than 30 days are pruned at each finish.

`skills/run/SKILL.md` adds the PM's side, item 7's stop job and end-of-run sweep.

## Consequences

- `.claude/worktrees/` holds only live work and work that needs a ruling. The archive refs hide from `git branch` but keep every commit for 30 days: `git for-each-ref refs/truss/archive/` lists them.
- The 30-day window counts from the tip's commit date, not the archive date, so a branch archived long after its last commit is pruned sooner.
- Stopping works the same on Linux, macOS and Windows, because Claude Code does it per session.
- A process started with `&`, `nohup`, `setsid` or `disown` that slips past the gate (from a script, say) escapes the session; nothing in truss stops it. The worktree it ran in is still retired.
- A process a user started by hand inside a member worktree no longer keeps that worktree: on Linux and macOS it runs on in a deleted directory. On Windows an open handle can make `git worktree remove` fail, and the worktree then stays.
- A finished agent stays open up to 30 minutes before the stop job stops it.
