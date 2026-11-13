## Single-step stage tests

- To test one stage step, call `loadStageStep(<workflows-src/stage/X.js>, stubs)` from `bin/build-stage.ts` (`stage-step-ruling.check.ts`). Stub every free name the step reaches (`agent`, `args`, `log`, runner calls); an unstubbed one throws a ReferenceError, which is the check that the step needs no more. Name the module by a relative literal so `bin/testmap.ts` selects the test for that module only. `loadStageBundle(stubs)` loads the whole bundle and makes the test depend on every module.
