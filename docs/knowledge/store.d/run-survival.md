---
sources:
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/factory/start.ts
verified: ec7039be658dac848206fb3185ad3a37215a7d3c
---

## Finding a run another session left

`factory.ts find-run --repo R` lists the runs an earlier PM session left unfinished (`cmdFindRun` in `bin/factory/runs.ts`). It reads `<git common dir>/truss/<name>/plan.json` one level deep, so it sees the dirs of every session of the repo, not only the caller's. There is no pointer file: the plan files are the index. A run is listed when its plan parses as a plan, its `approvedAt` is not null, and at least one crew is neither `merged` nor `dropped`. A dir with no plan, a broken plan or a file that is not a plan is skipped, never an error.

Each run is `{dir, session, approvedAt, transcript, crews}`, newest `approvedAt` first. `session` is the last segment of `dir`. `transcript` is the main transcript from `transcriptsOf(session)`, or null. `crews` holds only the unfinished crews, each as `{slug, status, stage, results}`, where `results` is the sorted list of files directly under `<dir>/reports/<slug>/` and `<dir>/crews/<slug>/`. The command only reads: it takes no lock and writes nothing, so it is safe next to a live run.

A new session resumes a found run with `factory.ts start --repo R --dir <found dir> --stage next`. The goal files, reports and crew state it needs sit in that dir.

## The start claim

Two `start` processes can run on one plan, for example two PM sessions that resume the same run. `cmdStart` therefore claims each planned crew before it does anything else for it (`claimedWorktree` in `bin/factory/start.ts`). The claim runs under the plan lock through `patchPlan` and flips the crew from `planned` to `running` only if `plan.json` still says `planned`. Only the winner creates the worktree, appends the `spawn` event and the decision line, and adds the crew to its output. The loser skips that crew without an error, so both processes exit 0 and each crew is started once across them.

The claim sits after every refusal, hold and admission check, so those keep their order. It applies to the direct path (solo and lean crews) and the workflow path alike. A crew that is `merged` or `dropped` is never `planned`, so it is never claimed. If creating the worktree fails, the claim is handed back (`running` to `planned`) before the error is thrown, so a failed start leaves the crew startable.

The claim does not re-check the parallel cap under the lock. Each process counts the running crews it read at the start of the call, so two processes can together exceed `maxParallelCrews` by up to one stage's worth. A later `admit` still sees the real running count.

A start killed after the claim leaves a `running` crew nobody runs. `reclaimOrphans` in `start.ts` sets it back to `planned` at the top of a `start` that has neither `--resume` nor `--slug` (`start --slug` on a running crew stays a no-op). It takes a workflow crew with no `spawn` event, and a direct crew (no spawn event ever) with no crew worktree, when the claim's owner pid is dead or absent. ADR-0052 holds the detail.
