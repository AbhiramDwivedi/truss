# ADR-0043: crews may share files; they merge in turn

Status: accepted, 2026-11-11
Decided by: client
Amends: ADR-0001 (the "no two crews edit the same file" rule of Decision 4), ADR-0009 (plan-check's owns-overlap rule and the "Disjoint file ownership" row), ADR-0010 (the amendment's cross-goal owns check), ADR-0019 (item 8, the cross-goal overlap error)

## Context

Until now a plan could not give two crews of one stage, or two unmerged crews of different goals, `owns` globs that match a common path. `factory.ts plan-check` refused such a plan, `owns-extend` refused such a glob, and plan-check also required one crew of each stage to own any rule file (`.claude/rules/<area>.md`) whose `paths` matched a crew's `owns`. The design engineer had to split work around shared files (one crew, or two stages), and a crew that needed a file another goal's crew owned waited for that crew to merge.

The client ruled on 2026-11-11, word for word: "No two crews can edit same file is a bad rule. I asked it to be scratched. Remove it immediately. Agents should work in parallel on their worktrees. The program manager just gives them a go ahead to merge sequentially. When given a go ahead the later crews update to latest main, merge changes from main as needed and then merge back to main." Requirement R-84 records it.

## Decision

1. **No cross-crew file exclusivity.** `plan-check` reports no error when two crews' `owns` overlap, in one stage or across goals, and no longer requires a crew of each stage to own a matched rule file. `owns-extend` adds a glob whatever other crews own. `owns` stays each crew's own edit scope: `owns-check` still refuses a crew diff outside its own `owns`, with the knowledge-commit exemption of ADR-0033 unchanged.
2. **Crews build in parallel.** Every crew of a stage starts at once, each in its own worktree, even when their `owns` share files.
3. **They merge in turn.** The program manager gives each crew a go-ahead to merge, one at a time, in plan order within a stage. On its go-ahead a crew merges the latest target into its branch with `git merge <target>` (never a rebase or cherry-pick), resolves the conflicts, re-runs its checks, and gets a fresh QC ruling only when its patch id changed or the checks fail on the merged head (ADR-0004's patch-bound PASS). Then the target fast-forwards to the crew branch (`gated-merge --ff-only`, or `finish` for a Workflow crew). A Workflow crew whose merge conflicts comes back from `finish` as `rework: conflict` and its resolver settles the conflict in the same way before the checks and QC.
4. **The checking engineer's pre-merge review** still checks drift from the plan and duplicate work (two crews building the same thing). Two crews editing one file is not a finding.

## Consequences

- Plans no longer contort around shared files, and a goal no longer waits for another goal's crew to merge before it can touch the same path.
- A later crew pays for a conflict resolution and possibly a fresh QC ruling at merge time. Crews that all edit one hot file (an index, registry or route table) can still be given an extension point by a stage-0 crew, as a cost choice, not a rule.
- Merges stay serial, so the target only ever moves by fast-forward to a branch that already holds it.
- The code that compared owns across crews is gone: the overlap loop and the knowledge-owns rule of `cmdPlanCheck`, the overlap refusal of `cmdOwnsExtend`, and their helpers (`globsOverlap`, `ruleGlobsOverlap`, `braceExpand`, `globRe`, `orderedByAfter`) in `bin/factory.ts`.
