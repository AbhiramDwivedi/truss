---
sources:
  - plugins/truss/tests/fixtures/citations/line-citations.ts
  - plugins/truss/tests/retro-generic-fixture.check.ts
  - plugins/truss/tests/retro-cause.check.ts
  - plugins/truss/tests/retro-skill.check.ts
verified: d2c90c7d5a0799f03767435d594251521038fe2e
---

## Importing `release-026.check.ts` from another test runs all its cases too

- Importing `release-026.check.ts` from another test runs all its cases too (`hygiene-029.check.ts` `ROOT` does); a shared citation helper belongs in its own module. The line-citation lint also covers the retro skill and the planning engineer: `fixtures/citations/line-citations.ts` `CITATION_DOC_FILES` lists them, `citationDocs` appends each one that exists, and they are not in `CITATION_DOC_ROOTS`, because every root must select the citation checks through `.claude/truss.json` targetedTests.map. A skill or agent doc cites code by symbol (`bin/inbox.ts` `typedText`, `OUTPUT_TAG`), never by line; the `hygiene-029.check.ts` case "retro SKILL.md cites typedText and OUTPUT_TAG by symbol, and the lint finds no line citation in CITATION_DOC_FILES" lints both files in a targeted run.

## The two P24 pins differ on purpose

- `retro-cause.check.ts` `P24` pins the retro `SKILL.md` section 3 sentence. `retro-skill.check.ts` `P24_NEW` pins the intro sentence. The wordings differ, so edit one sentence and rerun both files.

## A scrubbed fixture uses `sid-NNNN` fake ids

- A fake id shaped like a uuid fails the no-uuid check in `retro-generic-fixture.check.ts`. Use `sid-NNNN` ids and run `retro/cli.ts scrub` on the fixture files before you commit. The fixtures are in `fixtures/retro-generic/` (see `docs/knowledge/retro.md`).
