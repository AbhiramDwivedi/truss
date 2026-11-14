---
sources:
  - plugins/truss/tests/fixtures/citations/line-citations.ts
  - plugins/truss/tests/retro-generic-fixture.check.ts
verified: c794d8dc8ac9f6836e2cc3c541faff0a234338b0
---

## Importing `release-026.check.ts` from another test runs all its cases too

- Importing `release-026.check.ts` from another test runs all its cases too (`hygiene-029.check.ts` `ROOT` does); a shared citation helper belongs in its own module. The line-citation lint also covers the retro skill and the planning engineer: `fixtures/citations/line-citations.ts` `CITATION_DOC_FILES` lists them, `citationDocs` appends each one that exists, and they are not in `CITATION_DOC_ROOTS`, because every root must select the citation checks through `.claude/truss.json` targetedTests.map. A skill or agent doc cites code by symbol (`bin/inbox.ts` `typedText`, `OUTPUT_TAG`), never by line; the `hygiene-029.check.ts` case "retro SKILL.md cites typedText and OUTPUT_TAG by symbol, and the lint finds no line citation in CITATION_DOC_FILES" lints both files in a targeted run.

## A scrubbed fixture uses `sid-NNNN` fake ids

- A fake id shaped like a uuid fails the no-uuid check in `retro-generic-fixture.check.ts`. Use `sid-NNNN` ids and run `retro/cli.ts scrub` on the fixture files before you commit. The fixtures are in `fixtures/retro-generic/` (see `docs/knowledge/retro.md`).
