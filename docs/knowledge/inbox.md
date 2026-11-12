---
sources:
  - plugins/truss/bin/inbox.ts
  - plugins/truss/workflows/stage.js
  - plugins/truss/tests/pm-calls-029.check.ts
verified: 293a0779db1196ea29670a54d7c7e07e169b36d6
---

# Inbox: crew product calls

- Kinds: `pm-question` is `{by: 'any', blocking: true}`; `scope-change` is client-only (`bin/inbox.ts:18-19`). `resolve --by pm` on a client-only kind is refused with `<kind> is resolved by the client, not by pm`, before any code is checked (`inbox.ts:481`), so a refusal test needs no real client code.
- Dedupe: `escalate` on an open item with the same kind and `--ref` links the crew and returns `deduped: true` with code `''` (`inbox.ts:316-326`). A listing row is `{id, kind, crews, ref, blocking, state, decision, by, note}` (`inbox.ts:549-557`). A crew-call wait can therefore escalate again on a resume and re-read through `inbox --kind <kind> --crew <slug>` without opening a second item.
- Ref: `crew-call:<slug>:<task>@<truss dir under .git/truss>[@<plan approvedAt>]` (`workflows/stage.js:1005-1014`). Inbox and dedupe span sessions, so the run key keeps another session's item with the same slug and task from answering this run's call. The stage reads `approvedAt` from `args.truss.approvedAt`; `bin/factory.ts` passes none yet (no `approvedAt` is added to the stage args in `factory.ts`), so the key is the dir path alone. TODO: confirm the caller once resume-guard lands.
- Resume: a resumed stage runs `factory.ts inbox --kind <k> --crew <slug>` once per crew (`restoreCalls`, `pendingCall`, `stage.js:1074-1101`).
- CLI test facts: a crew slug must match `SLUG` (lowercase); `admit` and `start` need a `plan.json` in the session dir (`bin/factory.ts:3594`).
- Design: [ADR-0046](../../plugins/truss/docs/adr/0046-crew-decisions-reach-pm.md).
