---
sources:
  - plugins/truss/tests/lifecycle-029.check.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/testmap.ts
  - plugins/truss/workflows/stage.js
verified: 25e4e4d087e6348ba1a0b70a8d8ed0979606aa5a
---

# Plugin test notes

Area rules for writing plugin tests: [plugin-tests](../../.claude/rules/plugin-tests.md).

## lifecycle-029.check.ts

Pins `goal-check` (`cmdGoalCheck`), `plan-write` archiving a second run (`keepExisting` in `cmdPlanWrite`) and the session-scripts-dir default `scriptPath` for `plan-args` and `start` (`sessionScriptsDir`). Fixtures:

- `checkWorld()`: `marker.txt` exists only on `main` while the main checkout sits on `topic`, so a `goalCheck` that passes proves it ran at the target head in a temporary worktree.
- `sessionWorld(sub)`: builds `<common>/truss/<sid>[/wave4]` with a fixture transcript under `TRUSS_TRANSCRIPTS_ROOT`.

## Plan-lock race test hook

`cmdPlanWrite` has a test-only sync point: with `TRUSS_TEST_PLAN_WRITE_GATE=<dir>` set it writes `<dir>/checked` after the unlocked first check, then waits for `<dir>/go` (30 s, fails closed). Unset in production. `gates-026-regress.check.ts` uses it, so no fixed sleep decides the outcome. Source: `plugins/truss/bin/factory.ts` (`TRUSS_TEST_PLAN_WRITE_GATE`).

## Running the suite

`npm test` takes over 600 s, so one foreground Bash call can hit its 600 s timeout. A bare `exit -1` with an empty tail is then a timeout or kill, not a failing test. Run it with output redirected to a file and read the tail. `lifecycle-029.check.ts` alone runs 8 cases in about 20 s.

## Targeted tests

Since 0.31.0 a green check runs only the tests the crew's diff reaches, and the full suite runs once after QC passes. The selection, its reasons and the check record are in the green result's `tests` field and in `D/checks/`. In this repo, `.claude/truss.json` `targetedTests.map` adds `release-026.check.ts` and `hygiene-029.check.ts` (the citation checks) for any change under `plugins/truss/` or `.claude/rules/`, and `npm --prefix ui test` for a change under `ui/`. Sources: `plugins/truss/bin/testmap.ts` (`selectTests`), `plugins/truss/bin/factory.ts` (`checkTests`), `plugins/truss/workflows/stage.js` (`fullSuite`).
