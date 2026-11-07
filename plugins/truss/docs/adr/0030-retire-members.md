# ADR-0030: finish retires every member worktree of a terminal crew and stops the run's leftover processes

Status: accepted
Decided by: client request, 2026-11-07
Amends: ADR-0021 Decision 7

## Context

After many runs, 38 worktrees sat in `.claude/worktrees/` on `worktree-wf_<run>-<n>` branches. Each crew member (builder, tester, each fix round) gets its own worktree, and only the crew's final result lands on the target, often as a new commit. So the earlier members' branches hold stale file versions that never become ancestors of the target, and the 0.19.0 sweep kept them as `unmerged` forever. Dropped crews, crews whose rework allowance was spent, and crews redone by a later run, resume or fix goal left their members too. Worktrees also looked dirty only because the worktrees plugin links `ui/node_modules` into the main checkout as an untracked symlink.

Processes outlived their work as well: a UI dev server ran 9 hours with its cwd inside a member worktree, and finished subagents stayed open until the PM stopped them by hand.

## Decision Drivers

- Nothing a member committed is lost.
- No worktree with real uncommitted work, or someone else's live process, is removed.
- Never kill by pattern; only processes inside a worktree being retired.

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
6. A worktree stays, and is listed in `leftWorktrees`, when it is locked, has real changes, or holds a live process the run did not start. Real changes are anything `git status --porcelain --untracked-files=all` lists, except an untracked symlink that points into the main checkout outside the worktree; such links are unlinked before `git worktree remove`, which never runs with `--force`.
7. Processes inside a worktree being retired are found by their `/proc/<pid>/cwd` (Linux only). One the run started (its environment holds `CLAUDECODE=1`, which Claude Code sets for every command) or an orphan (parent is init or a systemd user manager) is stopped by pid: SIGTERM, then SIGKILL after 2 s. Each gets a `stop` event. This process and its ancestors are never touched.
8. Members of crews that are not terminal keep the 0.19.0 rule, run only when a crew merged: this run's own, or an older run's idle an hour, removed once merged into a merged crew's branch or the target and clean.
9. Archive refs whose commit is older than 30 days are pruned at each finish.

`skills/run/SKILL.md` adds the PM's side: stop a subagent with TaskStop once its work is merged or recorded, and at the end of a run stop every subagent still open and any dev server the run started, by pid.

## Consequences

- `.claude/worktrees/` holds only live work and work that needs a ruling. The archive refs hide from `git branch` but keep every commit for 30 days: `git for-each-ref refs/truss/archive/` lists them.
- The 30-day window counts from the tip's commit date, not the archive date, so a branch archived long after its last commit is pruned sooner.
- On macOS and Windows no process is found, so none is stopped and none keeps a worktree.
- A process a user started by hand inside a member worktree keeps that worktree until it exits.
