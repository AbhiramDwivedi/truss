---
sources:
  - plugins/truss/retro/problems.ts
  - plugins/truss/retro/problems-code.ts
  - plugins/truss/retro/counts.ts
  - plugins/truss/retro/cli.ts
  - plugins/truss/tests/retro-generic-032.check.ts
  - plugins/truss/tests/retro-generic-fixture.check.ts
  - plugins/truss/tests/fixtures/retro-generic/load.ts
  - plugins/truss/tests/fixtures/retro-generic/scrub-wave4.ts
  - plugins/truss/tests/fixtures/retro-generic/size-fixture.ts
  - plugins/truss/tests/fixtures/retro-generic/non-truss.ts
  - plugins/truss/tests/fixtures/retro-generic/rubric.ts
  - plugins/truss/docs/adr/0051-generic-retro.md
verified: 73be6836b7662713bc604e83a3201c4284796636
---

# Generic retro: where things live

The design is in `plugins/truss/docs/adr/0051-generic-retro.md`. This page holds what a later crew needs to change the code or its tests.

## Code

- `retro/counts.ts` re-exports `problems(directory)` and `CHECKLIST` from `retro/problems.ts`.
- `problems()` returns `{retro: 2, dir, measures, findings}`, ranked by `cost.wallMs`, then `cost.tokens`, then `id` (`rankCmp`).
- `problems.ts` also exports `assemble(directory, parts)`, `rankCmp`, `fmtMs`, `keyPart` and the `Part`, `Finding`, `Problems` and `Target` types, so another module can add a `Part`.
- `retro/problems-code.ts` `codePart(ctx)` returns two parts. Code structure: churn, size, merge conflict and owns-overlap findings from read-only git and `plan.json`. Tests: flaky run, full-versus-targeted and duration-trend findings from `checks/*.json`.
- The two modules import each other, so every import in `problems-code.ts` stays inside a function.
- A code finding's cost is measured. A file costs the commit-to-commit time of the commits that touched it, gaps over 2 hours dropped (`structurePart`). A flaky or repeated full run costs the crew's median heavy-slot run time times the repeat count (`testsPart`). Checks hold no per-run duration except the reporter's `duration_ms` line in the tail.
- Do not call `bin/cost.ts` `crewCost` or `attributor` from the counting step: they read transcript metadata. Attribute `usage.jsonl` rows through spawn events by `agentId`; a null `agentId` is `main`.
- Read `.claude/truss.json` with a tolerant `readJson` in `problems.ts` `readCtx`, never `bin/store.ts` `configOf`. `configOf` throws a `CliError` on text that is not JSON, and the wave-4 fixture's repo holds filler there. A failed read means no pricing.
- A `refusal` event in `events.jsonl` has `agent` set to the agent id for a subagent (crew is `main`) and `main` for the main session. `rulesPart` finds a refusal's retry cost from that agent's next usage row.

## Recur reads structured files

`retro/cli.ts` `runRecur` reads `catalogHits` from `retro/extract.json` only when that file exists, and also matches each fixed catalog entry against `retro/problems.json` titles and measure keys, `decisions.md` lines and `events*.jsonl` lines (`structuredHits`). It never reads a transcript. A missing extract gives no hits; a malformed one still exits 2.

## Test fixtures (`plugins/truss/tests/fixtures/retro-generic/`)

- `loadWave4()` in `load.ts` returns `{repo, dir, cleanup}`. It replays `wave4-git.json` (synthetic padded files) into a temp git repo and writes `wave4-run.json` to `<repo>/.git/truss/sid-wave4/`. Run `node load.ts <out dir>` to build it for CLI use. Regenerate the committed JSON with `scrub-wave4.ts <wave-4 run dir> <repo>`.
- Use `sid-NNNN` fake ids, never uuid-shaped ones, and run `retro/cli.ts scrub` on the output files before you commit (`retro-generic-fixture.check.ts`, first test).
- `size-fixture.ts` `makeSizeFixture()` builds a wave-4-sized truss dir with large transcripts under `HOME/.claude/projects`. The size case in `retro-generic-032.check.ts` spies on `node:fs` through a `--import` preload that calls `syncBuiltinESMExports`, in a child process.
- `non-truss.ts` `makeNonTruss()` builds a plain git repo with its own events and usage and no `plan.json`.
- `rubric.ts` `grade(judge, triage, problems)` grades judge and triage output in code. The recorded output is in `plugins/truss/retro/evals/`.
- `retro-generic-032.check.ts` pins what ADR-0051 leaves open: the `parseTriage` return shape `{decisions, fixGoal, proposedGoals, dropped}` and the rubric's known-id rule (`F-<n>` or a `problems` finding id). The recorded evals must follow both.
- `retro-skill.check.ts` no longer pins a transcript-is-data sentence for the judge, because the judge reads no transcripts. The ADR-0005 fetch rule keeps its own pin.
