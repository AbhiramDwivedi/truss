---
sources:
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/factory/admit.ts
  - plugins/truss/workflows/stage.js
verified: 8c3b46bc
---

# Fewer runner spawns: gates and folded admission

Detail moved out of the feature map entry "Fewer runner spawns (reap fold, same-head skip)" in `docs/features.md`. The entry keeps the reap fold and the same-head skip.

## Gates (0.29.0)

The checks before QC (green, owns-check, tests check, knowledge lint, QC admit) go out as one runner call, `factory gates --slug S --steps ...`, which runs the due steps in order, stops at the first unmet one and prints each step's own output under `steps` with `gates`, `codes` and `stopped`. stage.js takes each step's result from that call and falls back to the single command when it has none. The same stubbed crew now costs 22 runner spawns; a real crew saves about 4 at the end of its member chain and about 3 per QC fix round.

## Folded first admission (0.32.0, R-142)

The red check, the factory call just before the crew's first member start (the UX direction, else the planner), carries that member's admission as `--admit-first <slug> --admit-label <label> --admit-title <title>` (plus `--admit-persona` and `--admit-high` when the member has them), placed before `--dir` and before heavy's `--`. `admit()` takes its answer from the call's `admittedFirst` and makes no runner call; a held `admittedFirst` stops the crew as a held admit does (`held by admission:`, `BLOCKED: budget:`, `BLOCKED: awaiting client:`). A crew that resumes with saved tasks, or a member start that no factory call precedes, keeps the standalone admit. The admission inside `--admit-first` (`admitFirst`) runs with no memory wait; when it comes back held with admit's own figures (`minFreeMB`), `admit` in `crew.js` runs the standalone `admit --wait-ms 90000` re-check, and a budget or awaiting hold stops the crew at once. Every `admit` (`cmdAdmit`), standalone or folded, first reaps the crew's `<slug>-check` groups whose heavy job has exited and adds `reaped` (or `reapError`, which never changes the verdict) to its body, so a direct crew's member start is one `admit` call with no separate `reap`. The crew-end reap of `runCrew` rides on the late-reply read and runs alone only when `crew.reapDue` is still set after it.
