---
sources:
  - plugins/truss/tests/workflows.check.ts
verified: bbb513c563bca35071524d4de8c6e6b097b55d14
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
