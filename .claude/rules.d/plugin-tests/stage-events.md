---
sources:
  - plugins/truss/tests/workflows.check.ts
  - plugins/truss/bin/factory/audit.ts
verified: c9229de66be2215da2f00c05bd5138e87ce0c97c
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
- `audit.ts` `recordRun` and `recordEscalations` stamp spawn, report, restart, tag, allowance-spent and knowledge events with transcript times via `stamp()`; a step with no readable transcript time keeps the finish-time `ts`.
