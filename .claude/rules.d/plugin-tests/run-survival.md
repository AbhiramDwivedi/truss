---
sources:
  - plugins/truss/tests/factory-split-031.check.ts
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/factory.ts
verified: f8d19f899e3d5f1cd2414996452adf4871ec6a27
---

## Factory module list

`factory-split-031.check.ts` pins the files in `bin/factory/` with `MODULES`: a `.ts` file it does not list fails the test. Put a new `cmd*` function into a module already listed, such as `runs.ts` (`cmdFindRun`), unless the tester adds the new module to `MODULES` and to architecture.md.
