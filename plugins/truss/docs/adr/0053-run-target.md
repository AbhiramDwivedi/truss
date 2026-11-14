# ADR-0053: run target

Status: accepted, 2026-11-14
Decided by: program manager (auto): resting on the program manager's brief for this run (decisions.md 16:22 and 16:58, "target release-0.32.0, not main" and the long-term cost line for the optional `target` key), as the deferred-fixes goal and requirement R-138 ask

## Context

`.claude/truss.json` holds one `target` for the whole repo. A run that must land its crews on another branch, such as an integration branch `release-0.32.0` while the config says `main`, had no way to say so. The program manager of this run had to commit a config change on the release branch and undo it at release (decisions.md 16:22: "truss has no per-run target override"). `settingsOf` in `bin/factory/settings.ts` is the one place every merge path reads the target from, so the gap is small and the fix can be too.

## Decision

1. **An optional `target` in `plan.json`.** The plan may carry a top-level string `target`. `docs/plan.schema.json` lists it as an optional property. A plan without it behaves as before, so the plan version stays.
2. **It wins over the config.** `settingsOf(repo, dir)` returns the plan's `target` when `dir` holds a `plan.json` with a valid `target` (`planTargetOf`), else the `.claude/truss.json` target, else the current branch. `merge` still comes from the config. `source` reads `plan.json` when the plan target and a config merge mode are both set.
3. **Every caller with a truss dir passes it.** `settingsFor(f, repo)` reads `--dir` from the command's flags and serves `settings`, `land`, `finish`, `check`, `goal-check`, `knowledge-lint`, `knowledge-config-gate` and `gated-merge`. `cmdStart`, `crewCtx`, `cmdApprove` and `retirePlanRun` pass the `dir` they already hold, so `start` reports the plan target in its `truss.target` and every crew worktree is made from it. A command with no truss dir keeps the config target.
4. **`plan-check` refuses a bad target.** `cmdPlanCheck` refuses a `target` that is not a string or that `validBranchName` rejects (the rules of `git check-ref-format --branch`, checked without a git call: no space, control character, `~ ^ : ? * [ \`, no `..`, `@{` or `//`, no leading `-`, no trailing `/` or `.`, no path part that starts with `.` or ends with `.lock`). The error names `target`. A bad value that reaches `settingsOf` anyway is ignored, so the config target stands and no branch name can reach a git command as an option.

Code: `bin/factory/settings.ts` (`settingsOf`, `settingsFor`, `planTargetOf`, `validBranchName`), `bin/factory/plan.ts` (`cmdSettings`, `cmdPlanCheck`, `cmdApprove`), `bin/factory/start.ts` (`cmdStart`), `bin/factory/finish.ts` (`cmdLand`, `finishRun`), `bin/factory/crew.ts` (`crewCtx`), `bin/factory/check.ts`, `bin/factory/decide.ts`, `bin/factory/knowledge-cmds.ts`. Tests: `tests/deferred-032.check.ts`.

## Consequences

- The `target` field becomes part of the public plan contract. Every later reader of `settingsOf` and every new merge path must pass the truss dir, or it will land on the config target while the rest of the run lands on the plan's. This is the long-term cost the program manager accepted.
- A plan target that names a branch that does not exist fails in the first git command that uses it, as a config target does today. `plan-check` checks the name, not that the branch exists.
- The override lives in the plan, so it is frozen with the plan at approval and archived with it. Changing the target of a running run means rewriting an approved plan, which `plan-write` already refuses while crews run.
- The config `target` stays the default, so a repo that never sets the plan key sees no change.
