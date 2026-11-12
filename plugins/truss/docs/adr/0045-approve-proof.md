# ADR-0045: approve a plan only with the client's typed proof

Status: accepted, 2026-11-12
Decided by: program manager (auto), resting on goal item 1 of the 0.29.0 plugin-fix goal ("add a PM rule in the run skill: never call a client-only command") and R-85, with the program manager's 07:22 ruling on product-owner finding 1
Amends: ADR-0037 (a typed approve of the plan's `client-trigger` item now approves the plan)

## Context

- R-85 (`docs/requirements.md`): an agent cannot approve a plan or goal as the client.
- Before this change `factory.ts approve --by client` took no proof: `cmdApprove` checked only that `--by` was `client` or `auto` and that the plan was unapproved, then set `approvedAt`. The run skill (`skills/run/SKILL.md` section 5) told the program manager (PM) to "run `--by client` only after the client's yes", so the client's approval was whatever the program manager said it was.
- ADR-0037 already has a typed proof: `resolve --by client` stores a resolve only when a line the human typed in the session's main transcript holds the decision, the item id and its code (`typedProof`, `bin/inbox.ts:434`), and `verifiedItems` (`bin/inbox.ts:235`) re-proves every `by: client` row at each read, so a row written without that line counts as absent.
- The program manager's 07:22 ruling: the client-typed `/truss:inbox approve` of a plan-approval or client-trigger item performs the approval itself; the program manager never runs `approve --by client`; the attended and `--next` paths open the item and show its code.

## Considered Options

| Option | Kept or rejected |
| --- | --- |
| Keep `approve --by client` proof-free and rely on the run skill's prose | Rejected: prose is the gap R-85 names. |
| `approve --by client` needs `--item <E-id>`, and the program manager runs it after the client's typed resolve | Rejected by the 07:22 ruling: the program manager would still call a client-only command. |
| The client's typed inbox approve of the plan's item approves the plan; `approve --by client` passes only with that item as proof (option A of the product-owner fix) | Kept. One caller, the client's typed act. |

## Decision

We will tie the client's plan approval to a typed inbox resolve.

1. **The item.** The program manager opens the approval item with `escalate --kind client-trigger --ref run` and shows the client its id and code. `client-trigger` is a client-only, blocking kind (`KINDS`, `bin/inbox.ts:19`).
2. **The typed approve approves the plan.** When `resolve --by client --decision approve` stores a resolve for a `client-trigger` item whose ref is `run` and whose session is this truss dir (`planItem`, `bin/inbox.ts:535`), it then calls the plan approval that `factory.ts` registers with `onPlanApprove` (`bin/inbox.ts:503`, `bin/factory.ts:727`). That runs `cmdApprove` with `by: client` and the item, outside the inbox lock, so `approvedAt` is set and the decision line is logged. The output gains `approved: {approvedAt}`. A refusal from the approve (an open long-term cost, a plan already approved) leaves the resolve standing and rides in the output as `approveRefused` (`bin/inbox.ts:567-577`).
3. **What counts as proof.** `approve --by client` needs `--item <E-id>`, and `approvalProof` (`bin/inbox.ts:457`) passes the item only when all of these hold:
   - the item exists in `verifiedItems`, so its resolve, if any, is backed by a typed line;
   - its kind is `client-trigger`;
   - it was opened for this truss dir: its `session` is this dir's session;
   - its ref is `run` or the id of one of the plan's `goals` whose `approval` is `client`;
   - no later open row of the same kind, session and ref supersedes it;
   - it is resolved by the client with the decision `approve` (a `reject`, `answer`, `done` or `dismiss` does not count);
   - the resolve is not older than the plan: its `ts` is at or after the mtime of `plan.md` (else `plan.json`), so a proof the client gave before the plan was (re)written, or before `plan.json` existed, cannot approve the later plan (the replay guard of R-85; `bin/inbox.ts:475-480`). Once the plan is approved, `confirmApproval` skips this one condition (`approved` argument), because approving rewrote `plan.json` past the resolve.
   Otherwise `approve` refuses with the reason and leaves `approvedAt` null (`bin/factory.ts:715-718`). It fails closed: a stored row alone proves nothing.
4. **Confirm once.** When the typed approve has already approved the plan, the first `approve --by client --item <E-id>` with the same proof returns the stored `approvedAt` and marks the item applied for this session; any later call refuses as already approved (`confirmApproval`, `bin/inbox.ts:487`; `bin/factory.ts:702-706`).
5. **`--by auto` is unchanged.** It needs no proof and still refuses a plan or goal whose `approval` is `client` (`bin/factory.ts:709-713`).
6. **The program manager never calls a client-only command**: not `approve --by client`, and not a `resolve --by client` the client did not type (`skills/run/SKILL.md` section 5 and `--next` step 5).

## Consequences

- Positive: an agent cannot set `approvedAt` through `approve --by client` without a line the human typed. The acceptance cases in `tests/approve-029.check.ts` cover a forged resolve row, a proof for another item, a client `reject`, another kind, another truss dir and a superseded item. Replay is pinned by two cases there: a proof resolved before a re-plan, and one resolved before `plan.json` existed.
- Negative: the staleness check compares the resolve row's `ts` with the plan file's mtime, not the typed line's own time, and reads `plan.md`'s mtime first, so a `patchPlan` edit to `plan.json` alone is not seen. Neither is shown to be reachable in the skill flow (the plan is written once by `plan-write`, then approved); no test pins them.
- Negative: after an `approveRefused` for an open long-term cost the spent item cannot approve; the program manager opens a fresh `client-trigger --ref run` item (run skill section 5).
- Positive: the approval keeps one caller, so the run skill no longer has to trust the program manager's account of the client's yes.
- Negative: only a ref `run` item approves the plan through the inbox (`bin/inbox.ts:535`). A `client-trigger` item whose ref is a client goal's id passes `approvalProof`, but its typed resolve does not call the approval, and `cmdApprove` sets only the top-level `approvedAt`, never `goals[i].approvedAt`.
- Negative: `escalate` dedupes an open item by kind and ref without comparing sessions (`bin/inbox.ts:318-326`). While another truss dir of the same repo has an open `client-trigger` item with ref `run`, a second escalate links to that item, and `approvalProof` then refuses it as opened for another truss dir.
- Neutral: the client approves the plan the way it rules on every other blocking item, by `/truss:inbox approve <E-id> <code>`.
- Reversing this touches `cmdApprove` and the `onPlanApprove` registration in `bin/factory.ts`, `approvalProof`, `confirmApproval` and `resolveItem` in `bin/inbox.ts`, the tests that pass a proof fixture to `approve --by client`, and the run and inbox skills.
