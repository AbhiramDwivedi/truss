---
sources:
  - plugins/truss/bin/build-stage.ts
  - plugins/truss/bin/testmap.ts
  - plugins/truss/tests/stage-steps-032.check.ts
  - plugins/truss/tests/stage-step-ruling.check.ts
---

## Single-step stage tests (0.32.0, ADR-0050)

- A new stage test drives one step: `loadStageStep(<module path>, stubs)` from `bin/build-stage.ts`, as `stage-step-ruling.check.ts` does. Name the module by a relative literal (`'../workflows-src/stage/ruling.js'`): `bin/testmap.ts` resolves it to that one file, so only a change to that module selects the test. A bare `'ruling.js'` links to every file of that name.
- Never name `stage.js` in the test, not even in a test title or a quoted word in a comment: any literal whose file name is `stage.js` links the test to the bundle and so to every module. A test that calls `loadStageBundle` is linked to every module by that name (`testmap.ts` `stageBundles`); keep it for a check that needs the whole bundle, such as `stage-steps-032.check.ts` test "a single step driven alone returns the same result as the same step inside the stage.js bundle".
- Stub every free name the step reaches (`agent`, `args`, `log`, runner calls such as `integrate`). A missing one throws a ReferenceError when reached, which shows what the step needs. Read the step's functions from the returned `scope`; only names declared at column 0 are in it (`declaredNames`).
