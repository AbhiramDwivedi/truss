---
sources:
  - plugins/truss/tests/factory-split-031.check.ts
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/factory.ts
verified: 23b9ab72731017b5c3d8ae06d8a07fc70f2529de
---

## Factory module list

`factory-split-031.check.ts` pins the files in `bin/factory/` with `MODULES`: a `.ts` file it does not list fails the test. Put a new `cmd*` function into a module already listed, such as `runs.ts` (`cmdFindRun`), unless the tester adds the new module to `MODULES` and to architecture.md.
