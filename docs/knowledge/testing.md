---
sources:
  - plugins/truss/tests/lifecycle-029.check.ts
  - plugins/truss/bin/factory/decide.ts
  - plugins/truss/bin/factory/plan.ts
  - plugins/truss/bin/factory/check.ts
  - plugins/truss/bin/factory/start.ts
  - plugins/truss/bin/testmap.ts
  - plugins/truss/workflows/stage.js
  - plugins/truss/workflows-src/stage/green.js
  - plugins/truss/bin/fragments.ts
  - plugins/truss/tests/hub-split-032.check.ts
verified: 8c3b46bc
---

# Plugin test notes

Area rules for writing plugin tests: [plugin-tests](../../.claude/rules/plugin-tests.md), [fixtures](../../.claude/rules/plugin-tests-fixtures.md), [leaf modules and check runs](../../.claude/rules/plugin-tests-leaf.md), [heavy jobs](../../.claude/rules/plugin-tests-heavy.md), [closeout and stage steps](../../.claude/rules/plugin-tests-closeout.md).

## lifecycle-029.check.ts

Pins `goal-check` (`goalCheckMain`, `cmdGoalCheckJob`; a slow check is collected by a second call with `TRUSS_HEAVY_ATTACH_MS` low), `plan-write` archiving a second run (`keepExisting` in `cmdPlanWrite`) and the session-scripts-dir default `scriptPath` for `plan-args` and `start` (`sessionScriptsDir`, then `scriptPathAuto` falls back to `<truss dir>/scripts` and a tmpdir copy when the session dir is refused). Fixtures:

- `checkWorld()`: `marker.txt` exists only on `main` while the main checkout sits on `topic`, so a `goalCheck` that passes proves it ran at the target head in a temporary worktree.
- `sessionWorld(sub)`: builds `<common>/truss/<sid>[/wave4]` with a fixture transcript under `TRUSS_TRANSCRIPTS_ROOT`.

## Plan-lock race test hook

`cmdPlanWrite` has a test-only sync point: with `TRUSS_TEST_PLAN_WRITE_GATE=<dir>` set it writes `<dir>/checked` after the unlocked first check, then waits for `<dir>/go` (30 s, fails closed). Unset in production. `gates-026-regress.check.ts` uses it, so no fixed sleep decides the outcome. Source: `plugins/truss/bin/factory/plan.ts` (`cmdPlanWrite`, `TRUSS_TEST_PLAN_WRITE_GATE`).

## Running the suite

`npm test` takes over 600 s, so one foreground Bash call can hit its 600 s timeout. A bare `exit -1` with an empty tail is then a timeout or kill, not a failing test. Run it with output redirected to a file and read the tail. `lifecycle-029.check.ts` alone runs 10 cases in about 12 s.

## Root contract checks

`checks/*.check.ts` needs only node and git. It reads truss's own files and never reads claude-ops, the home directory, the network or the `claude` CLI. `checks/compose-manifests.check.ts` checks the `dependencies` list in `plugin.json`, the catalog's `allowCrossMarketplaceDependenciesOn` and the READMEs against each other. `checks/repo-home.check.ts` "repo-home install" computes what an install holds (`computedInstall`) from the catalog entry's git-subdir path on main and from `marketplace/`. Its last case is a control: a whole-repo entry would install `ui/` and `checks/`, so the cases can fail.

`checks/real-cli-install.e2e.ts` is opt-in, and the `checks/*.check.ts` glob does not pick it up. Run it with `npm run test:real-cli` or `node --test checks/real-cli-install.e2e.ts`. It runs the real `claude plugin marketplace add AbhiramDwivedi/truss` and `claude plugin install truss@truss` against a local smart-HTTP copy of the repo, in its own `CLAUDE_CONFIG_DIR`. Without `claude` on PATH it exits 1 with a message that names the missing CLI.

Every git call in that file uses its own `GIT_CONFIG_GLOBAL` with `maintenance.auto=false` and `gc.auto=0`, and sets `GIT_CONFIG_NOSYSTEM`. Git 2.54 starts a detached auto-maintenance after a commit in a fresh repo of about 900 objects. It repacks and deletes the loose objects while the next `git clone --bare` hardlinks them, or while `git http-backend` serves them. The clone then fails with "failed to copy file" or "hardlink different from source", and the served fetch fails with "bad tree object".

## Targeted tests

Since 0.31.0 a green check runs only the tests the crew's diff reaches, and the full suite runs once after QC passes. The selection, its reasons and the check record are in the green result's `tests` field and in `D/checks/`. In this repo, `.claude/truss.json` `targetedTests.map` adds `release-026.check.ts` and `hygiene-029.check.ts` (the citation checks) for any change under `plugins/truss/` or `.claude/rules/`, and `npm --prefix ui test` for a change under `ui/`. The selector follows names, not whole files, and reaches a factory command's handler only when a test names that command (architecture.md, "Targeted tests"). A test that runs the CLI through a computed command reaches every handler, so name the command as a literal when you can. Only files package.json's test globs match are ever selected. Since 0.32.0 a stage test can load one `workflows-src/stage/` module with `loadStageStep` (`bin/build-stage.ts`) and is then selected by a change to that module only; a test that loads the bundle (`loadStageBundle`, or a literal naming `stage.js`) is still selected by every stage module, and the older stage tests still run the bundle. Sources: `plugins/truss/bin/testmap.ts` (`selectTests`, `symbolGraph`, `stageBundles`), `plugins/truss/bin/factory/check.ts` (`checkTests`), `plugins/truss/workflows-src/stage/green.js` (`fullSuite`), `plugins/truss/bin/build-stage.ts` (`loadStageStep`).

## Open: R-96 inbox lock wait under CPU load

The load case in `plugins/truss/tests/hygiene-029.check.ts` ("inbox.check.ts passes 20 of 20 consecutive whole-file runs under artificial CPU load") runs only with `TRUSS_HYGIENE_LOAD_RUNS` set. With `TRUSS_HYGIENE_LOAD_RUNS=20` the inbox case "inbox: 8 concurrent escalates with one kind and ref leave one open op and 7 links" fails with `store busy: inbox` (exit 2), so the inbox lock wait is too short under CPU load. R-96 is still open; it is not fixed by 0.32.0.

## Why a leaf still selects about 110 test files

`selectTests` (`bin/testmap.ts`) picks a test when the files it reaches include the changed file. It follows symbols, and a test that spawns `factory.ts` without naming a command is assumed to run every command. So a leaf that holds a widely used primitive (`withLock`, `readJson`, `CliError`) is reached by about 110 of 173 test files however the hubs are split; only a leaf few commands use stays small (`roles.ts` 56, `admit.ts` 84). To measure, call `selectTests` on `git ls-files` with a one-file diff and assert `mode === 'targeted'`: a full selection returns zero files. The hub-split count cases log counts and do not enforce a bar (ADR-0049).

## Writing doc fragments

- A fragment replaces only sections at its own shallowest heading depth (`fragmentSections` and `applySection` in `bin/fragments.ts`). To change a `####` subsection, such as "Resource-aware sizing" under "### The Workflow path (ADR-0009)" in `architecture.md`, the fragment carries the whole `###` parent section.
- A rule file with no headings takes only an appended section, so a fragment cannot replace one of its stale bullets. Say in the appended section which bullet it supersedes.

## Open: evals-run-model tmpdir scan flakes under concurrency

The case "run-model: a missing binary leaves no truss-evals-* dir in os.tmpdir()" in `plugins/truss/tests/evals-run-model.check.ts` scans the shared `os.tmpdir()`, so it flakes when the full suite runs files concurrently and another file's `truss-evals-*` dir is present. A fix gives the child a private `TMPDIR` and scans that. Not fixed by crew stage-events.
