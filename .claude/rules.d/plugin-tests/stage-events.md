---
sources:
  - plugins/truss/tests/workflows.check.ts
  - plugins/truss/bin/factory/audit.ts
verified: ae333596e022670b3051b9497849f6a76787c71e
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
- `audit.ts` `recordRun` and `recordEscalations` stamp spawn, report, restart, tag, allowance-spent and knowledge events with transcript times via `stamp()`; a step with no readable transcript time keeps the finish-time `ts`.
