## Run survival across PM sessions (ADR-0052)

This section updates the `trussFile` seam bullet under "Workflow calls (ADR-0009)" and adds how a new PM session finds a run. Since 0.32.0 (R-135, R-141) the gate no longer holds `args.trussFile` to the session's own truss dir, and the bullet's "leaves the truss dir" now means "leaves every `<git common dir>/truss/<name>/` dir".

### The widened trussFile seam

The Workflow handler takes the session's truss dir from `rootOf` and passes its parent, `<git common dir>/truss` in a git repo, to `expandTrussFile(args, trussDir, read, realPathOf, trussRoot)`. With a `trussRoot`, the gate accepts a path whose normalised form or real path is at least one segment inside a directory of the root. Without one it accepts only the session's dir, as before.

The refusals of ADR-0024 item 29 stand: both keys at once, a non-absolute path, no session truss dir, an unreadable file, a file that is not JSON, and no object `truss`. A path outside every `<trussRoot>/<name>/` dir is refused with `args.trussFile must be inside one of the repo's truss dirs <trussRoot>/<session>, not <path>`. The handler's `readReal` refuses a file whose real path leaves `<trussRoot>`. The gate does not check that `<name>` is a session id, so `truss/shared/` passes.

### Finding a run

```
new PM session
  └─ factory.ts find-run --repo R           (bin/factory/runs.ts cmdFindRun; reads only, no lock)
       scans <git common dir>/truss/*/plan.json
       keeps approvedAt set + some crew not merged/dropped
       └─ {runs: [{dir, session, approvedAt, transcript, crews: [{slug, status, stage, results}]}]}
  └─ factory.ts start --dir <found dir> --stage next     planned crews of the next stage
  └─ factory.ts start --dir <found dir> --slug S --resume stale --transcript T   a running crew whose workflow is dead
  └─ Workflow(args: {trussFile: <file under the found dir>})      the widened gate above
```

There is no pointer file: the plan files are the index. `results` lists the files directly under `<dir>/reports/<slug>/` and `<dir>/crews/<slug>/`.

### The start claim

`cmdStart` claims a crew through `claimedWorktree` (`bin/factory/start.ts`) after the refusals and admission checks that come before it. Under the plan lock (`patchPlan`) the crew goes from `planned` to `running` only if `plan.json` still says `planned`. Only the winner creates the worktree, writes the decision line and, on the workflow path, the `spawn` event. The loser skips the crew without an error. A worktree failure sets the crew back to `planned` before the error is rethrown. The claim does not re-check `maxParallelCrews` under the lock, so two concurrent `start` calls can together pass the cap.

| Failure | Recovery |
| --- | --- |
| The PM session ended with crews running | A new session runs `find-run` and resumes the listed `dir`. |
| Two sessions resume one run at once | Each crew is claimed once; the losing `start` skips it and exits 0. |
| `ensureWorktree` fails after a claim | The crew is back to `planned`; run `start` again. |
| A start dies after the claim, before the `spawn` event | The crew is `running` with no spawn event (a direct crew: no worktree) and a dead owner. The next `start` without `--resume` or `--slug` sets it back to `planned` (`reclaimOrphans`) and starts it. |
