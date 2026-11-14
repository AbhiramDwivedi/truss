---
sources:
  - plugins/truss/tests/workflows.check.ts
verified: 96a749a851e5bac754c78e76bc632331cbce4210
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
