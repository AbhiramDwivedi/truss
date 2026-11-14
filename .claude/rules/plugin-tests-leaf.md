---
paths:
  - "plugins/truss/tests/**/*.ts"
sources:
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/factory/check.ts
  - plugins/truss/bin/factory/consolidate.ts
  - plugins/truss/bin/fragments.ts
  - plugins/truss/tests/factory-split-031.check.ts
  - plugins/truss/tests/hub-split-032.check.ts
  - plugins/truss/tests/heavy-031.check.ts
  - plugins/truss/tests/hygiene-029.check.ts
  - plugins/truss/tests/release-026.check.ts
  - plugins/truss/tests/fixtures/citations/line-citations.ts
  - plugins/truss/tests/retro-cause.check.ts
  - plugins/truss/tests/retro-skill.check.ts
  - plugins/truss/tests/retro-generic-fixture.check.ts
verified: 8c3b46bc
---

Check runs, factory modules and doc seams (see also plugin-tests, plugin-tests-fixtures, plugin-tests-heavy, plugin-tests-closeout).

- `factory check` runs the targeted and full test commands through `bashRun`, which drops `NODE_TEST_CONTEXT` from the child's env: without that, a `node --test` started from inside a test skips every file and exits 0. Since 0.31.0 a green check is followed by one `check ... --full` call after a QC PASS (`workflows-src/stage/green.js` `fullSuite`); a stage test that counts green re-runs must leave out commands matching `/\s--full\b/` (`crew-knowledge.check.ts` `greens`, `retro-fixes2-stage.check.ts` `greenChecks`), and a spawn cap counts that call. Test the heavy background job without a 540 s wait by setting `TRUSS_HEAVY_ATTACH_MS` low (`heavy-031.check.ts`). Prove a `stage.js` change red by pointing `TRUSS_CONTRACT_ROOT` at a copy of the old plugin (`stage-tests-031.check.ts`). The `heavy run still going` stop text, like `heavy slot busy:`, is pinned by a test.
- Tests build their own fixtures in a mkdtemp dir and never depend on sibling checkouts (claude-ops), home-directory paths, the network or installed CLIs such as `claude`; the default suite needs only node and git. A run of the real CLI goes in an opt-in file outside the `*.check.ts` glob (`checks/real-cli-install.e2e.ts`), which fails with a clear message when a prerequisite is missing. A git fixture that is cloned or served right after a commit needs `maintenance.auto=false` and `gc.auto=0`, or a detached auto-maintenance repacks its objects mid-read.
- Since 0.31.0 `bin/factory.ts` is only the dispatcher; each command group lives in `bin/factory/<group>.ts` (architecture.md, "Factory modules"). The `stubbedPlugin()` seam still works: the modules import `../store.ts`, `../inbox.ts` and the other `bin/X.ts` files, so a stubbed `bin/X.ts` reaches them. A test that reads command source text reads the module, not `factory.ts` (`crew-decisions.check.ts` reads `bin/factory/decisions.ts`). No module imports `factory.ts`: its top-level await would make an import cycle (`factory-split-031.check.ts`); a module that needs `main` takes it as an argument (`gatesRun`).
- Leaf modules (0.32.0, ADR-0049): import from the leaf (`bin/core.ts`, `bin/lock.ts`, `bin/transcripts.ts`, and the `bin/factory/` leaves `cli`, `plan-file`, `settings`, `log`, `roles`, `slot`, `admit` and `reap`), never from the barrels `bin/store.ts`, `bin/factory/shared.ts` or `bin/factory/resources.ts`. `hub-split-032.check.ts` fails on a barrel import under `bin/` and `resources/`; for tests it is a convention no check enforces. This supersedes the `stubbedPlugin()` bullet above that says modules import `../store.ts`. Stub the leaf in a private copy too: modules no longer load `bin/store.ts`, so a stubbed `store.ts` reaches nothing (`proof-plugin.ts` replaces `bin/transcripts.ts`). Text that pins the lock constants (`OWNERLESS_MS`, `STALE_AGE_MS`) reads `bin/lock.ts` (`release-026.check.ts`, `hygiene-029.check.ts` `storeLine`).
- The `store.ts` test seam bullet and the `proofPlugin()` bullet (plugin-tests, plugin-tests-fixtures) name `bin/store.ts`: since 0.32.0 the lock code (`withLock`, `takeOver`, `OWNERLESS_MS`) is in `bin/lock.ts` and the stubbed proof seams (`proofTranscriptRoot`, `readProofFile`) are in `bin/transcripts.ts`; `bin/store.ts` is a barrel.
- Adding import lines to `bin/inbox.ts` shifts the lines retro `SKILL.md` cites for `typedText` and `OUTPUT_TAG`; `hygiene-029.check.ts` test "retro SKILL.md cites typedText and OUTPUT_TAG at the lines they have in bin/inbox.ts" fails until the skill is updated.
- `run-procedure.check.ts` cases "parses and carries merge sequential and target main" and "settings --repo prints target main" read the checkout's own `.claude/truss.json`, which a run sets to its release branch, so they fail in a checkout whose target is not main.
- The line-citation lint also covers the retro skill and the planning engineer: `fixtures/citations/line-citations.ts` `CITATION_DOC_FILES` lists them, `citationDocs` appends each one that exists, and they are not in `CITATION_DOC_ROOTS`, because every root must select the citation checks through `.claude/truss.json` targetedTests.map. A skill or agent doc cites code by symbol (`bin/inbox.ts` `typedText`, `OUTPUT_TAG`), never by line; the `hygiene-029.check.ts` case "retro SKILL.md cites typedText and OUTPUT_TAG by symbol, and the lint finds no line citation in CITATION_DOC_FILES" lints both files in a targeted run.
- The two P24 pins differ on purpose: `retro-cause.check.ts` `P24` pins the retro `SKILL.md` section 3 sentence. `retro-skill.check.ts` `P24_NEW` pins the intro sentence. The wordings differ, so edit one sentence and rerun both files.
- A scrubbed fixture uses `sid-NNNN` fake ids: a fake id shaped like a uuid fails the no-uuid check in `retro-generic-fixture.check.ts`. Use `sid-NNNN` ids and run `retro/cli.ts scrub` on the fixture files before you commit. The fixtures are in `fixtures/retro-generic/` (see `docs/knowledge/retro.md`).
- A doc fragment cannot add to a doc preamble: `stitchDoc` in `bin/fragments.ts` returns a fragment's text before its first heading as a `preamble` (`fragmentSections`) and `applySection` replaces sections only by matching depth and title, so text before the H1-level list of `architecture.md` (the ADR summary list) cannot come from a fragment. Put a crew's ADR summary in a `###` section it replaces, or leave it for the PM at stitch time.
- Factory module list: `factory-split-031.check.ts` pins the files in `bin/factory/` with `MODULES`: a `.ts` file it does not list fails the test. Put a new `cmd*` function into a module already listed, such as `runs.ts` (`cmdFindRun`), unless the tester adds the new module to `MODULES` and to architecture.md.
- To pin the case numbers a doc cites, parse the doc's `- Tests:` line and map each number to the Nth top-level `test(` title of the cited check file. Strip backtick spans first, or the `032` in the file name counts as a case number (`run-survival-qc-032.check.ts`, the test titled "run-survival doc: the case numbers it cites...").
