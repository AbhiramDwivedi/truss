# ADR-0052: find an unfinished run from a new program manager (PM) session and let the trussFile gate read any of the repo's truss dirs

Status: decided, 2026-11-13
Decided by: program manager (auto): the approved 0.32.0 plan (`plan.md`, crew notes for run-survival, "I set the design default, which the crew records in ADR-0052 as decided by program manager (auto), resting on R-141 and this plan"), resting on requirements R-141 "A run survives its PM session ending" and R-135 "The trussFile gate lets a PM use another session's truss dir it legitimately runs", and the long-term cost line of the goal's approved scope (16:58)
Amends: ADR-0024 (item 29, seam 3)

## Context

A run lives in its PM session's truss dir, `<git common dir>/truss/<session id>/` (`hooks/register.ts` `trussDir`). When that session ends while crews are running, nothing told a new session where the run was. R-141 asks that a new PM session on the same repo "finds the run, its unfinished crews and their saved results, and resumes them without redoing merged work".

A new session that resumes the run must also launch stage workflows from the old session's `start` output. ADR-0024, item 29, seam 3, holds `args.trussFile` to "the session's truss dir": `expandTrussFile` refused any other path with `args.trussFile must be inside the session's truss dir`. R-135 asks that a trussFile under the first session's truss dir be let through, while "a trussFile outside the repo's truss dirs is still refused".

Two PM sessions can also resume one run at the same moment. Before this ADR, `cmdStart` created a crew's worktree with `ensureWorktree` and only then set the crew to `running` through `patchPlan`. Two processes that both read the crew as `planned` would both start it.

## Decision Drivers

- A new session finds the run with no help from the session that ended.
- Resume never starts a crew that merged or dropped.
- Two concurrent resumes start each crew once.
- The gate widens only as far as the repo's own truss dirs and refuses everything else it refused before.
- No new file must be kept in step with the plans.

## Considered Options

| Option | Kept or rejected |
| --- | --- |
| A pointer file naming the current run, written by `start` | Rejected: a second record that can drift from `plan.json`, and a session that dies before writing it leaves no pointer. |
| Scan `<git common dir>/truss/*/plan.json` for approved plans with unfinished crews | Kept: the plan files are already the record of each run, so the scan needs no new write. |
| Keep the gate to the session's own dir and copy the old start output into the new dir | Rejected: the goal files, reports and crew state stay in the old dir, so the copy would split one run across two dirs. |
| Widen the gate to every `<git common dir>/truss/<name>/` dir | Kept, with the long-term cost below. |

## Decision

### 1. The find-run scan

We add the `find-run` command (`bin/factory/runs.ts` `cmdFindRun`, wired in `bin/factory.ts` `CORE_COMMANDS`). `node <plugin>/bin/factory.ts find-run --repo R` reads every directory directly under `<git common dir of R>/truss/` and loads its `plan.json` with `loadPlan`. There is no pointer file. A dir is skipped, never an error, when it has no plan, a broken plan, or a file that is not a plan.

A run is listed when its `approvedAt` is not null, undefined or empty, and at least one crew's `status` is neither `merged` nor `dropped`. The output is `{runs}`, newest `approvedAt` first. Each run is `{dir, session, approvedAt, transcript, crews}`:

- `session` is the dir's name.
- `transcript` is `transcriptsOf(session).main`, or null.
- `crews` holds only the unfinished crews, each `{slug, status, stage, results}`.
- `results` is the sorted list of files directly under `<dir>/reports/<slug>/` and `<dir>/crews/<slug>/`. A slug that does not match `^[A-Za-z0-9._-]+$`, or is `.` or `..`, gets an empty list.

The command takes no lock and writes nothing.

`skills/run/SKILL.md`, section "Resume a run an earlier session left", tells the PM to run `find-run` before a new run. When it lists a run, the PM resumes it with that `dir` as `--dir` for `start --stage next`, and with `start --slug <slug> --resume stale` for a `running` crew whose workflow is dead. That form also needs `--transcript T` (`bin/factory/start.ts`, the `--resume ${kind} needs --transcript T` usage error). `cmdStartResume` refuses a solo or lean crew unless `merge` is `single`, since such a crew runs direct and merges with `land`.

### 2. The start claim

`cmdStart` claims each crew before it starts it (`bin/factory/start.ts` `claimedWorktree`). Under the plan lock, through `patchPlan`, it re-reads `plan.json` and sets the crew from `planned` to `running` only if the file still says `planned`. Only the process that made that change creates the worktree with `ensureWorktree`, writes the decision line and, on the workflow path, the `spawn` event, and lists the crew in its output. A process that lost the claim skips the crew without an error. So two concurrent resumes start each crew once, and both exit 0.

The claim replaces the old unconditional `patchPlan` that set `running` after `ensureWorktree`, on both the direct path (solo and lean crews) and the workflow path. It runs after the refusals and admission checks that come before it, so their order is unchanged. If `ensureWorktree` throws, the claim is handed back (`running` to `planned`) before the error is rethrown. A crew that is `merged` or `dropped` is never `planned`, so it is never claimed.

### 3. The widened gate

`expandTrussFile` takes a fifth argument, `trussRoot`. The Workflow handler in `hooks/register.ts` passes the parent of the session's truss dir, which is `<git common dir>/truss` in a git repo. With a `trussRoot`, a `trussFile` is accepted when its normalised path, or its real path, sits inside some `<trussRoot>/<name>/` dir: at least one path segment below a directory of the root. Without a `trussRoot`, the gate holds to the session's own dir, as before.

The gate still refuses:

- a call that gives both `args.truss` and `args.trussFile`;
- a `trussFile` that is not a string path, or not absolute;
- a session with no truss dir;
- a path outside every `<trussRoot>/<name>/` dir, including a file directly in `<trussRoot>`, a sibling of the git common dir, and a `..` path that climbs out (`normalPath` resolves `.` and `..` first);
- a file whose real path, after symlinks, is outside `<trussRoot>` (the handler's `readReal`);
- a file that cannot be read, is not JSON, or holds no object `truss`.

The wide refusal reads `args.trussFile must be inside one of the repo's truss dirs <trussRoot>/<session>, not <path>`. Every refusal still starts `[truss] Refused:`.

### 4. Long-term cost

The goal's approved scope records it, word for word: "16:58 | long-term cost (cheap to reverse): run-survival widens the `trussFile` gate from the session's truss dir to every truss dir in the repo's git common dir (ADR-0052) | later: any session's start output can drive another session's workflow, and every later gate or hook must reason about cross-session files | none | followed".

## Seams

| Seam | Who calls it | Contract |
| --- | --- | --- |
| `node <plugin>/bin/factory.ts find-run --repo R` | the PM, per `skills/run/SKILL.md` | Prints `{runs}`, newest first; reads only; skips a dir with no valid plan. |
| `bin/factory/runs.ts` `cmdFindRun` | `bin/factory.ts` `CORE_COMMANDS` | Decision 1. |
| `bin/factory/start.ts` `claimedWorktree` | `cmdStart`, direct and workflow paths | `planned` to `running` under the plan lock; undefined when another process won; hands the claim back if the worktree fails. |
| `hooks/register.ts` `expandTrussFile(args, trussDir, read, realPathOf?, trussRoot?)` | the Workflow `tool.call` handler | With `trussRoot`, any `<trussRoot>/<name>/` dir; without it, the session's dir only. |

## Consequences

Positive:

- A new PM session finds the run, its unfinished crews and their saved results from the plan files alone (R-141).
- Resume starts no merged or dropped crew, and two concurrent resumes start each crew once.
- The `--transcript T` of a resume is the Workflow run dir of the new session's own run, not the `transcript` that `find-run` lists, which is the old session's main `.jsonl`. With the old session's value `start` lists no stale crew.
- A start killed after `claimedWorktree` set a workflow crew `running` and before its spawn event leaves no spawn event, and no resume form can restart it (`--resume stale` answers "not stale" because `factorySpawned` is undefined). The next `start` (`reclaimOrphans` in `bin/factory/start.ts`) sets such a crew back to planned and starts it again. It runs only for a `start` with neither `--resume` nor `--slug` (`cmdStart`), because `start --slug` on a running crew must stay a no-op. A direct (solo or lean) crew writes no spawn event, so `reclaimOrphans` takes it back to planned when its owner is dead and its crew worktree does not exist; a direct crew whose worktree exists is a live crew and stays running. The finished member results of the old run are dropped on a stale resume unless the old run is finished first.
- A PM session can pass the old session's start output to the Workflow gate (R-135).
- The reclaim does not touch a crew whose claiming start is still alive. `claimedWorktree` records `owner: { pid, token }` on the crew under the same plan lock as the claim, and `reclaimOrphans` resets a crew only when `ownerDead` finds that pid gone (`process.kill(pid, 0)` throws ESRCH; EPERM counts as alive) or the crew has no owner, as in a plan written before 0.32.0. The spawn event is written by the same `start` process, right after the claim and before it exits, so the owner pid is the right liveness signal. A second concurrent `start` therefore skips a crew the first is still setting up. `plan.schema.json` has an `owner` property for it.
- A project-manager-path crew has no spawn event and no owner by design, because the project manager sets it `running` by hand. When `start` lists a crew under `projectManagers` it stamps `engine: "project-manager"` on the plan entry, and `reclaimOrphans` never resets a crew that carries the stamp, whatever engine the later `start` call would pick. A workflow claim in `claimedWorktree` clears the stamp. `plan.schema.json` has an `engine` property for it.

Negative:

- The gate accepts a file under any directory of `<trussRoot>`, not only a session's. It does not check that `<name>` is a session id, so `<git common dir>/truss/shared/` passes too.
- The handler's `readReal` checks only that the real path is inside `<trussRoot>`. A path written inside a session dir that is a symlink to a file directly in `<trussRoot>` passes.
- Outside a git repo the truss dir is `~/.claude/truss/<session id>` (`trussDir`), so the root is `~/.claude/truss` and spans every such session.
- The claim does not re-check the parallel cap under the lock. Each `start` counts the running crews it read when it began, so two concurrent resumes can together pass `maxParallelCrews`.
- Any later gate or hook that reads `args.trussFile` must assume the file may belong to another session (Decision 4).

Neutral:

- `find-run` lists runs only. The PM still decides whether to resume one or start a new run.
- The narrow refusal text, `args.trussFile must be inside the session's truss dir`, is kept for a caller that passes no `trussRoot`. The Workflow handler always passes one when the session has a truss dir.

Reversing this decision would touch `hooks/register.ts` (`expandTrussFile` and the Workflow handler's `trussRoot` and `readReal`), `bin/factory/runs.ts`, the `find-run` entry in `bin/factory.ts`, the `claimedWorktree` calls in `bin/factory/start.ts`, the "Resume a run an earlier session left" section of `skills/run/SKILL.md`, and `tests/run-survival-032.check.ts`. The approved scope names it cheap to reverse.
