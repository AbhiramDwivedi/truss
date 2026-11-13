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
verified: 25e4e4d087e6348ba1a0b70a8d8ed0979606aa5a
---

# Plugin test notes

Area rules for writing plugin tests: [plugin-tests](../../.claude/rules/plugin-tests.md).

## lifecycle-029.check.ts

Pins `goal-check` (`cmdGoalCheck`), `plan-write` archiving a second run (`keepExisting` in `cmdPlanWrite`) and the session-scripts-dir default `scriptPath` for `plan-args` and `start` (`sessionScriptsDir`). Fixtures:

- `checkWorld()`: `marker.txt` exists only on `main` while the main checkout sits on `topic`, so a `goalCheck` that passes proves it ran at the target head in a temporary worktree.
- `sessionWorld(sub)`: builds `<common>/truss/<sid>[/wave4]` with a fixture transcript under `TRUSS_TRANSCRIPTS_ROOT`.

## Plan-lock race test hook

`cmdPlanWrite` has a test-only sync point: with `TRUSS_TEST_PLAN_WRITE_GATE=<dir>` set it writes `<dir>/checked` after the unlocked first check, then waits for `<dir>/go` (30 s, fails closed). Unset in production. `gates-026-regress.check.ts` uses it, so no fixed sleep decides the outcome. Source: `plugins/truss/bin/factory/plan.ts` (`cmdPlanWrite`, `TRUSS_TEST_PLAN_WRITE_GATE`).

## Running the suite

`npm test` takes over 600 s, so one foreground Bash call can hit its 600 s timeout. A bare `exit -1` with an empty tail is then a timeout or kill, not a failing test. Run it with output redirected to a file and read the tail. `lifecycle-029.check.ts` alone runs 8 cases in about 20 s.

## Root contract checks

`checks/*.check.ts` needs only node and git. It reads truss's own files and never reads claude-ops, the home directory, the network or the `claude` CLI. `checks/compose-manifests.check.ts` checks the `dependencies` list in `plugin.json`, the catalog's `allowCrossMarketplaceDependenciesOn` and the READMEs against each other. `checks/repo-home.check.ts` "repo-home install" computes what an install holds (`computedInstall`) from the catalog entry's git-subdir path on main and from `marketplace/`. Its last case is a control: a whole-repo entry would install `ui/` and `checks/`, so the cases can fail.

`checks/real-cli-install.e2e.ts` is opt-in, and the `checks/*.check.ts` glob does not pick it up. Run it with `npm run test:real-cli` or `node --test checks/real-cli-install.e2e.ts`. It runs the real `claude plugin marketplace add AbhiramDwivedi/truss` and `claude plugin install truss@truss` against a local smart-HTTP copy of the repo, in its own `CLAUDE_CONFIG_DIR`. Without `claude` on PATH it exits 1 with a message that names the missing CLI.

Every git call in that file uses its own `GIT_CONFIG_GLOBAL` with `maintenance.auto=false` and `gc.auto=0`, and sets `GIT_CONFIG_NOSYSTEM`. Git 2.54 starts a detached auto-maintenance after a commit in a fresh repo of about 900 objects. It repacks and deletes the loose objects while the next `git clone --bare` hardlinks them, or while `git http-backend` serves them. The clone then fails with "failed to copy file" or "hardlink different from source", and the served fetch fails with "bad tree object".

## Targeted tests

Since 0.31.0 a green check runs only the tests the crew's diff reaches, and the full suite runs once after QC passes. The selection, its reasons and the check record are in the green result's `tests` field and in `D/checks/`. In this repo, `.claude/truss.json` `targetedTests.map` adds `release-026.check.ts` and `hygiene-029.check.ts` (the citation checks) for any change under `plugins/truss/` or `.claude/rules/`, and `npm --prefix ui test` for a change under `ui/`. Sources: `plugins/truss/bin/testmap.ts` (`selectTests`), `plugins/truss/bin/factory/check.ts` (`checkTests`), `plugins/truss/workflows-src/stage/green.js` (`fullSuite`).
