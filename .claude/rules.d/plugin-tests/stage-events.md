---
sources:
  - plugins/truss/tests/workflows.check.ts
verified: ef61b484cff7c23ac1973ed8211a14bd68cb7498
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
