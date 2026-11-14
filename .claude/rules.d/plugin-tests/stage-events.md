---
sources:
  - plugins/truss/tests/workflows.check.ts
  - plugins/truss/bin/factory/audit.ts
verified: 8224647b84256517629779755b57a8a1e71b707a
---

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
