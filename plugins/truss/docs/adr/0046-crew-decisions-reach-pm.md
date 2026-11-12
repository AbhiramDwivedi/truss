# ADR-0046: route escalated crew product calls through the inbox and hold the asking crew

Status: accepted, 2026-11-12
Decided by: program manager (auto), on the product owner's plan finding 3, 2026-11-12 (rests on the client rule that scope changes are the client's to rule on)
Amends: ADR-0033 section B (product calls at crew level: what an escalated call does, and that a crew never waits)

## Context

ADR-0033 section B sends a crew's product question to the `product-owner` persona, which replies `PO: DECIDE` or `PO: ESCALATE`, and says the crew "tells the main session each call as it makes it, and never waits" (`docs/adr/0033-crew-knowledge-and-product-calls.md:74-80`). On the workflow path an escalation opened nothing: `productCall` returned `{escalate}`, and the member's `QUESTION:` stopped the crew with the reason appended (`workflows/stage.js:805-822`). No item reached the inbox of the program manager (PM). The 0.29.0 goal records this as "Crew decisions auto-accept without reaching the program manager" and asks that a crew decision that needs the program manager "reach the PM's inbox and wait" (R-86).

Two rulings shape the fix:

- 07:20 plan review: "a new KINDS row fits the existing {by,blocking} shape", so the inbox gets a kind, not a new store.
- 07:22, product owner finding 3: "the program manager answers only escalations within approved scope; a call that contradicts approved scope or a client ruling becomes a client scope-change item that only the linked crew waits on, never resolved by the program manager".

Workflow scripts have no timers, so a stage cannot sleep until an item resolves (`workflows/stage.js:1022-1023`).

## Decision Drivers

- The program manager sees every in-scope escalation in one place, the inbox.
- A scope change stays the client's call: nobody but the client resolves it.
- One crew's open question never stops another crew.
- The wait is decided by the item's state, never by a clock.

## Considered Options

| Option | Kept or rejected |
|---|---|
| Keep ADR-0033: the escalation stops the crew as a `QUESTION:` with no inbox item | Rejected: it is the wave-3 symptom, nothing reaches the inbox. |
| Wait with a timer or a poll loop inside the stage | Rejected: Workflow scripts have no timers, and a poll loop burns a session. |
| A new store or item shape for program-manager questions | Rejected (07:20): a `KINDS` row with the existing `{by, blocking}` fields is enough. |
| Let the program manager answer every escalation, scope changes included | Rejected (07:22): scope changes are the client's to rule on. |
| An inbox item per escalation, a crew stop while it is open, and a re-read on resume | Kept. |

## Decision

We will route an escalated product call by whether it stays inside the crew's approved scope.

**The product owner's replies.** The `Product call:` brief now offers three first lines (`workflows/stage.js:925-938`):

- `PO: DECIDE`, then the answer and a `Reason:` line.
- `PO: ESCALATE <why>` when the question stays inside the crew's approved scope but is not the product owner's to settle: it is not a product question, it touches another crew's area, or neither the product decisions file nor the requirements settle it.
- `PO: SCOPE-CHANGE <why>` when the answer would contradict the approved scope or a client ruling, or the question hits a client approval trigger in the goal file.

Any other first line stops the crew as a `QUESTION:`, as before (`workflows/stage.js:970`).

**A call that touches no scope line.** A `PO: DECIDE` is logged with `factory crew-decision --crew <slug> --task <id> --question=<q> --answer=<a> --by product-owner` and the asking member re-runs with the answer at once (`workflows/stage.js:972-976`, `recordCall` at `:980-1001`). It never waits. This is ADR-0033's default, kept for that case; the main session's `ack` / `change` replies and the single checkpoint stay as ADR-0033 says.

**An in-scope escalation goes to the program manager.** `PO: ESCALATE` opens a `pm-question` item (`openCall`, `workflows/stage.js:1037-1062`):

```
factory escalate --kind pm-question --crew <slug> --blocking --ref crew-call:<slug>:<task>@<run key> --title=<question> --detail=<crew, role, task, question and the product owner's reason>
```

`pm-question` is `{ by: 'any', blocking: true }` (`bin/inbox.ts:19`), so the program manager resolves it:

```
factory resolve <E-id> --decision answer --by pm --code <code> --note=<the answer>
```

**A scope or client-ruling contradiction goes to the client.** `PO: SCOPE-CHANGE` opens a `scope-change` item the same way. `scope-change` is `{ by: 'client', blocking: true }` (`bin/inbox.ts:18`); `resolve --by pm` on it exits 1 with `scope-change is resolved by the client, not by pm` (`bin/inbox.ts:539`). The program manager never resolves it: it tells the client, who resolves it with `/truss:inbox`. A member that reports `PROPOSAL:` stops its crew with that tag (`workflows/stage.js:818-822`); the program manager carries the proposal to the client and does not rule on it either.

**Only the linked crew waits.** When the item is open, the stage stops that crew with `BLOCKED` and the text `awaiting program manager: <E-id> (pm-question, <ref>): <question>` or `awaiting client: <E-id> (scope-change, <ref>): <question>`, followed by `Resume the crew after the item is resolved.` (`holdStop`, `workflows/stage.js:1032-1034`). The item holds only the crew it names (`blockingFor`, `bin/inbox.ts:381-386`); every other crew runs.

**The wait is a factory re-check, never a timer.** On a resume the stage reads `factory inbox --kind <kind> --crew <slug>` once per crew, before its first task starts, and keeps each task's item by its ref (`restoreCalls` and `pendingCall`, `workflows/stage.js:1077-1108`; `callRows` at `:1024-1028`). For the asking task:

- an open item stops the crew again with the same `awaiting` text;
- a resolved item starts the member with the answer, under `The program manager (or the client, for a scope change) answered your QUESTION through the inbox:` (`workflows/stage.js:778`), and logs it once as a crew decision `--by program-manager` or `--by client` (`takeCall`, `workflows/stage.js:1065-1074`). A decision other than `answer` reaches the member as `<decision>: <note>`;
- a resolve with no note holds no answer, so the crew stops as a `QUESTION:`.

**Refs are per run.** The ref is `crew-call:<slug>:<task>`, suffixed with `@<truss dir under .git/truss>@<plan approvedAt>` (`workflows/stage.js:1004-1021`). `escalate` dedupes an open item with the same kind and ref, so a re-run of the same task reuses its item, and an older run's item never answers this run.

**No item, no fake wait.** When `escalate` returns no id, the crew stops as a `QUESTION:` with `(no <kind> inbox item could be opened: <why>)` appended, the ADR-0033 path (`workflows/stage.js:1050`).

**The checkpoint is confirmed.** `statusLine` keeps the `checkpoint` field (`bin/factory.ts:4045`), so `decision-checkpoint` prints a `truss-status:` line carrying it, and `stage.js` (`markCheckpoint`, which waits for the `checkpoint` field) logs `decision-checkpoint not confirmed` only when it is missing (`workflows/stage.js:1235-1240`).

## Consequences

Positive:

- Every in-scope escalation is an inbox item with a code, a ref and the crew it holds, so the program manager sees it with `factory inbox` and the retro can count it.
- The rule "the program manager never rules on scope" is enforced by `resolve`, not by prose.
- A waiting crew costs nothing while it waits: it is stopped, not polling.

Negative:

- The wait is a stop and a resume. The program manager must resolve the item and then resume the crew; resolving alone restarts nothing.
- The `awaiting` stop text carries the item id but not its code. The program manager gets the code of a `pm-question` item from `factory inbox --recover-codes --repo <repo>` (`bin/inbox.ts:567-592`), and the client gets a `scope-change` code from the notify row or, on request, the same command.
- A resume with `--resume answers` still needs an answers file (`bin/factory.ts:1992-1996`), though the member's answer comes from the inbox note.

Neutral:

- ADR-0033's crew-decision log, replies and checkpoint are unchanged for a `PO: DECIDE`.

Reversing this would touch `productCallPrompt`, `productCall`, `openCall`, `takeCall`, `restoreCalls`, `pendingCall` and `runTask` in `workflows/stage.js`, the `pm-question` row of `KINDS` in `bin/inbox.ts`, the run skill's "Watch crew decisions" paragraph, and `tests/pm-calls-029.check.ts`.
