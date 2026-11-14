---
sources:
  - plugins/truss/bin/testmap.ts
  - plugins/truss/bin/fragments.ts
  - plugins/truss/tests/hub-split-032.check.ts
verified: 6b9157063194b1f2d394570a270454b159dadec9
---

## Why a leaf still selects about 110 test files

`selectTests` (`bin/testmap.ts`) picks a test when the files it reaches include the changed file. It follows symbols, and a test that spawns `factory.ts` without naming a command is assumed to run every command. So a leaf that holds a widely used primitive (`withLock`, `readJson`, `CliError`) is reached by about 110 of 173 test files however the hubs are split; only a leaf few commands use stays small (`roles.ts` 56, `admit.ts` 84). To measure, call `selectTests` on `git ls-files` with a one-file diff and assert `mode === 'targeted'`: a full selection returns zero files. The hub-split count cases log counts and do not enforce a bar (ADR-0049).

## Writing doc fragments

- A fragment replaces only sections at its own shallowest heading depth (`fragmentSections` and `applySection` in `bin/fragments.ts`). To change a `####` subsection, such as "Resource-aware sizing" under "### The Workflow path (ADR-0009)" in `architecture.md`, the fragment carries the whole `###` parent section.
- A rule file with no headings takes only an appended section, so a fragment cannot replace one of its stale bullets. Say in the appended section which bullet it supersedes.
