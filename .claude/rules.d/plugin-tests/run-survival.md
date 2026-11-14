---
sources:
  - plugins/truss/tests/factory-split-031.check.ts
  - plugins/truss/tests/run-survival-qc-032.check.ts
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/factory.ts
verified: f969c4c17345c52b0348cfc607a355f6cc8f3302
---

## Factory module list

`factory-split-031.check.ts` pins the files in `bin/factory/` with `MODULES`: a `.ts` file it does not list fails the test. Put a new `cmd*` function into a module already listed, such as `runs.ts` (`cmdFindRun`), unless the tester adds the new module to `MODULES` and to architecture.md.

## Pinning a doc's case numbers

To pin the case numbers a doc cites, parse the doc's `- Tests:` line and map each number to the Nth top-level `test(` title of the cited check file. Strip backtick spans first, or the `032` in the file name counts as a case number (`run-survival-qc-032.check.ts`, the test titled "run-survival doc: the case numbers it cites...").
