---
sources:
  - plugins/truss/bin/inbox.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/workflows/stage.js
  - plugins/truss/tests/pm-calls-029.check.ts
verified: cd362ff769a3bd6aa50437ef99b4a6c490dc6bd8
---

# Inbox: crew product calls

- Kinds: `pm-question` is `{by: 'any', blocking: true}`; `scope-change` is client-only (`KINDS` in `bin/inbox.ts`). `resolve --by pm` on a client-only kind is refused with `<kind> is resolved by the client, not by pm`, before any code is checked, so a refusal test needs no real client code.
- Dedupe: `escalate` on an open item with the same kind and `--ref` links the crew and returns `deduped: true` (the CLI prints `code: null`; `bin/inbox.ts` escalate). A listing row is `{id, kind, crews, ref, blocking, state, decision, by, note}`, plus `noteUnbound: true` when set. A crew-call wait can therefore escalate again on a resume and re-read through `inbox --kind <kind> --crew <slug>` without opening a second item.
- Ref: `crew-call:<slug>:<task>@<truss dir under .git/truss>[@<plan approvedAt>]` (`RUN_KEY`, `callRef`, `callAt` in `workflows/stage.js`). Inbox and dedupe span sessions, so the run key keeps another session's item with the same slug and task from answering this run's call. The stage reads `approvedAt` from `args.truss.approvedAt`; `bin/factory.ts` (`stageOut`) passes `plan.approvedAt` when it is a string, so the key is the dir path plus that stamp.
- Resume: a resumed stage runs `factory.ts inbox --kind <k> --crew <slug>` once per kind per crew through a runner (`restoreCalls`, `callRows`). `pendingCall` is the one place a resumed member reads its item: every `runMember` call site that can ask a `QUESTION:` (`runTask`, `knowledge()`, `fixBuilder()`) calls it first and passes the result as `first`. It deletes `crew.calls[at]` once taken, so one item answers one member.
- `restoreCalls` loops kinds in the fixed order `['pm-question','scope-change']`, so it compares item `ts`: a later item wins over an earlier one, an open one over a resolved one.
- Logging: `takeCall` logs a resolved item as a crew decision whose question ends `(inbox item <id>)`; a resumed run treats an item as logged only when a prior decision's question carries that id (text matching would drop a re-asked question). A resolved row with no note, or with `noteUnbound` true (a client resolve whose note `factory inbox` could not bind to the client's typed line), holds no answer: the crew stops as a `QUESTION:` and nothing is logged. That stop clears with an answers resume that carries an answer at the same task: `pendingCall` then spends the item and the member starts with that answer (`answersFor`).
- Hold wording: `admit()` forwards factory's `awaiting client: <id>` for any open blocking item, a `pm-question` included, so a fix-step hold reads as a client wait; the program-manager wording (`holdStop`) is on the `pendingCall` task path only.
- CLI test facts: a crew slug must match `SLUG` (lowercase, `bin/factory.ts`); `admit` and `start` need a `plan.json` in the session dir.
- Test stubs: any stage-test runner stub must script `inbox` and `escalate` (see `.claude/rules/plugin-tests.md`).
- Design: [ADR-0047](../../plugins/truss/docs/adr/0047-crew-decisions-reach-pm.md).
