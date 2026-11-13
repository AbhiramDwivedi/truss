---
sources:
  - plugins/truss/tests/lifecycle-029.check.ts
  - plugins/truss/bin/factory.ts
verified: a1f65558c0ba1e4f69ec8e1a8350ed5f13deb498
---

# Plugin test notes

Area rules for writing plugin tests: [plugin-tests](../../.claude/rules/plugin-tests.md).

## lifecycle-029.check.ts

Pins `goal-check` (`cmdGoalCheck`), `plan-write` archiving a second run (`keepExisting` in `cmdPlanWrite`) and the session-scripts-dir default `scriptPath` for `plan-args` and `start` (`sessionScriptsDir`). Fixtures:

- `checkWorld()`: `marker.txt` exists only on `main` while the main checkout sits on `topic`, so a `goalCheck` that passes proves it ran at the target head in a temporary worktree.
- `sessionWorld(sub)`: builds `<common>/truss/<sid>[/wave4]` with a fixture transcript under `TRUSS_TRANSCRIPTS_ROOT`.

## Running the suite

`npm test` takes over 600 s, so one foreground Bash call can hit its 600 s timeout. A bare `exit -1` with an empty tail is then a timeout or kill, not a failing test. Run it with output redirected to a file and read the tail. `lifecycle-029.check.ts` alone runs 8 cases in about 20 s.
