---
sources:
  - plugins/truss/tests/hub-split-032.check.ts
  - plugins/truss/bin/lock.ts
---

## Leaf modules (0.32.0, ADR-0049)

- Import from the leaf (`bin/core.ts`, `bin/lock.ts`, `bin/transcripts.ts`, and the `bin/factory/` leaves `cli`, `plan-file`, `settings`, `log`, `roles`, `slot`, `admit` and `reap`), never from the barrels `bin/store.ts`, `bin/factory/shared.ts` or `bin/factory/resources.ts`. `hub-split-032.check.ts` fails on a barrel import under `bin/` and `resources/`; for tests it is a convention no check enforces. This supersedes the `stubbedPlugin()` bullet that says modules import `../store.ts`. Stub the leaf in a private copy too: modules no longer load `bin/store.ts`, so a stubbed `store.ts` reaches nothing (`proof-plugin.ts` replaces `bin/transcripts.ts`). Text that pins the lock constants (`OWNERLESS_MS`, `STALE_AGE_MS`) reads `bin/lock.ts` (`release-026.check.ts`, `hygiene-029.check.ts` `storeLine`).
- Adding import lines to `bin/inbox.ts` shifts the lines retro `SKILL.md` cites for `typedText` and `OUTPUT_TAG`; `hygiene-029.check.ts` test "retro SKILL.md cites typedText and OUTPUT_TAG at the lines they have in bin/inbox.ts" fails until the skill is updated.
- `run-procedure.check.ts` cases "parses and carries merge sequential and target main" and "settings --repo prints target main" read the checkout's own `.claude/truss.json`, which a run sets to its release branch, so they fail in a checkout whose target is not main.
