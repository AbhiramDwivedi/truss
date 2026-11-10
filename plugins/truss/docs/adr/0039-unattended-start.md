# ADR-0039: run one queued item with no one present

Status: accepted, 2026-11-10
Decided by: client, through the wave 2 goal (contract-025 revision 2, section 7); the PM, acting as product owner for the absent client, accepted the plan's client triggers for it on 2026-11-10
Amends: ADR-0008 (the client brief gains an unattended path that fills defaults instead of asking)

## Context

R-60 asks for `/truss:run --next`: take one queued item and run it with no human present. Today every run assumes someone answers:

- The client brief asks its questions through `AskUserQuestion` (`skills/brief/SKILL.md:8`, `:64`). In a session with no one at the keyboard, that call waits forever.
- An all-solo goal skips plan.js and writes no plan (`skills/run/SKILL.md:161-165`), so the plan and main-edit hooks never engage. An unattended run would then have no approved plan for the gates to check against (contract-025 finding #5).
- Truss already has a per-session root, `rootOf` (`hooks/register.ts:1279`), and a tool-call gate for fetches (`hooks/register.ts:2462`) whose failure path is `failOpen` (`hooks/register.ts:1208`). A new gate can follow the same pattern.
- The inbox (ADR-0037) gives the PM a place to leave a question for the client and carry on. A `link` with `blocking: true` holds exactly the crews it names at `start` and `admit` (contract-025 section 3).
- R-64: the flow must work on Linux, macOS and Windows. A daemon, `flock` or `fs.watch` would not.

The intake queue that supplies the item is ADR-0040.

## Decision Drivers

- A question must never hang the session. The PM escalates and keeps working on whatever does not depend on the answer.
- The flag that says "unattended" must belong to one session. Another session in the same repo, attended or not, must not be affected.
- Every stop is an inbox item the client can see later, never a silent end.
- Nothing is pushed or deployed without the client.
- The pieces are local commands and one hook, so they run on all three platforms.

## Considered Options

| Option | Kept or rejected |
|---|---|
| Tell the PM in prose not to ask, with no hook | Rejected. Nothing enforces it, and one slip hangs the run. The hook is one handler next to an existing one. |
| A hook that refuses `AskUserQuestion` while a flag file exists | Kept. |
| Keep the flag in `<common>/truss/shared/`, the repo or the home dir | Rejected. It would turn every session in the repo unattended. The plan's round-2 brief scoped it to the session dir. |
| A Stop hook that refuses plain-text questions too | Out of scope (contract-025 section 10). The run skill forbids them in prose instead. |
| A blocking question for each unanswered brief branch | Rejected. One unanswered branch would hold the whole run. A default plus a non-blocking question lets the crews go on; the design engineer names the crews that wait on a branch (`AWAITS:`), and only those are held. |
| Cloud Routines to schedule runs | Rejected. A fresh clone has no `<common>/truss`, so the session state, inbox and queue are lost. |
| A truss daemon | Out of scope (contract-025 section 10). `/loop` in a local session does the scheduling. |
| Auto-push or auto-land after the run | Out of scope (contract-025 section 10). The run escalates `push-pr` instead. |

## Decision

We will mark a session unattended with a file, refuse `AskUserQuestion` from a hook while that file exists, and give `/truss:run --next` a fixed flow whose every stop is an escalation.

### 1. The flag: `D/unattended.json`

- `factory unattended --on --dir D` writes `D/unattended.json` as `{since, item: null}` and appends an `unattended` event `{on: true, item}` to `D/events.jsonl`. `--off` removes the file and logs `on: false`. Each prints one line, `{on, item|null}`.
- D is the session truss dir, `<common>/truss/<sid>/`. No unattended.json is ever written to `<common>/truss/shared/`, the repo or the home dir.
- `queue-next` writes the claimed item's id into the file, but only when the file exists (ADR-0040).
- The file is replaced atomically or deleted, never edited in place.

### 2. The hook

`hooks/register.ts` gets one handler next to the fetch gate: `on('tool.call', {tool: ['AskUserQuestion']})`. It calls `unattendedAskVerdict` with the session root from `rootOf`.

- It refuses only on the main thread (no `agentId`), and only when `<rootOf>/unattended.json` exists. It never looks at another session's file.
- The refusal says: "[truss] unattended run: no one is here to answer. Run `factory escalate --kind client-question …` and go on with the work that doesn't depend on the answer."
- On a read error it fails open: the handler ends `.catch(failOpen)`, so a broken check never blocks an attended session.

### 3. The `--next` flow

The run skill holds this flow (written by D2):

0. **Start.** Run `factory unattended --on`, then `factory intake`, then `factory queue-next`. A `null` item prints "queue empty" and ends. A `held` result ends too; the budget escalation already exists. Then run `factory queue-set --id <id> --state running`: `queue-next` leaves the item `claimed`, and only `running` may move on to `done`.
1. **Resume.** Run `factory inbox --unapplied` and apply each resolved item, then `mark-applied`. An `answer` replaces R-<n> and resumes the held crews with `start --resume`. A `reject` drops the crew.
2. **Gate.** The PM passes the fenced item and the `factory worktypes` output to the sizing engineer, which recommends a size and a workType. The checking engineer answers `ELIGIBLE: yes|no — <reason>`. The item is eligible when it names a checkable outcome, fits one workType, needs no stage-0 crew, adds no external service and no stored data shape, and touches no production system. On a no, the PM escalates `intake-triage` with `--ref queue:<id>`, moves the item to `triage` and ends.
3. **Brief.** The client brief runs its "Unattended brief" section (`skills/brief/SKILL.md`). The brief records `source: {kind: "intake", id}` and writes its own goal sentence. A `large` item goes to triage. A `standard` item gets `by: "default"` on every branch the facts don't answer, each with a non-blocking `client-question` whose ref is `brief:<sid>:<branch>`. The closing question is skipped and the brief logs `Defaults filled: …` with the E-ids.
4. **Plan.** `--next` always writes a plan; the all-solo path is off. plan-check refuses a crew without a `workType` while `D/unattended.json` exists. For each `AWAITS: R-<n> | crews: <slugs>` line from the design engineer, the PM escalates `client-question` with the same `brief:<sid>:<branch>` ref, `--crew <slug>` and `--blocking`. Dedupe turns that into a blocking `link` on the open question, which holds exactly those crews.
5. **Approve.** `approve --by auto` only. When the factory refuses (a client goal, a stage-0 crew, or an open plan long-term cost), the PM escalates `client-trigger` or `long-term-cost` and ends.
6. **Stages.** Every item the client must rule on becomes an escalation linked to its crew. Every crew not linked to one keeps running. The PM never waits and never asks in plain text. Drift is dropped; a meaningful change outside the crew's owned files becomes a `scope-change` item; an ADR that no longer holds becomes an escalated design proposal (the client's rule of 2026-11-09).
7. **End.** Merge locally with `finish` or `land`; held crews stay unmerged. Always escalate `push-pr`; nothing is pushed. Set the item to `done` when every crew merged, or to `running` with a progress note. Run `unattended --off`.

### 4. Stops

An unattended run stops only on the escalation kinds of contract-025 section 3. `prod-deploy` is escalated and never run.

### 5. Scheduling

The client schedules runs with `/loop <interval> /truss:run --next` in a local session. Cloud Routines are not supported.

## Consequences

**Positive**

- A run with no one present never hangs on `AskUserQuestion`; the hook turns the call into an instruction to escalate.
- Unattended state is per session. An attended session in the same repo still asks its questions.
- Every reason a run stopped or guessed is an inbox item with an E-id. `Defaults filled:` names each guess, so the client can review it.
- Unanswered brief branches hold only the crews the design engineer names; the rest of the run goes on.

**Negative**

- **Planning spend per `/loop` tick is uncapped by the run and crew budgets.** Intake, the gate, the brief and plan.js run before any crew exists. Only `sessionUsd` counts that spend (ADR-0038; contract-025 section 9, risk 12), so a client who sets no `sessionUsd` has no ceiling on it, and a queue of items that all fail the gate still pays for every gate.
- Crews build on defaults. A later answer replaces R-<n> and resumes only the held crews; a crew that already merged locally on the default is not revisited, so a different answer means new work.
- A permission prompt still hangs the session. `--next` needs auto mode or a full allowlist (contract-025 section 9, risk 6).
- Resume works within one session only. A stale claim restarts its item from scratch in a new session, and `/loop` keeps growing one session's context (risk 7).
- The hook stops `AskUserQuestion` only. A plain-text question in the PM's reply is forbidden by prose alone.
- Fail-open means a broken file check lets one question through, and that question hangs the run.
- Supporting Routines later needs a remote store for `<common>/truss` (risk 8).

**Neutral**

- `/loop` is Claude Code's scheduler, not truss's, so its interval and retry behaviour are outside this decision.
- The item is untrusted text; how it is fenced is ADR-0040.

**Reversing it** touches the `AskUserQuestion` handler in `hooks/register.ts`, the `factory unattended` command, `queue-next`'s write to `unattended.json`, plan-check's unattended `workType` rule, the "Unattended brief" section of `skills/brief/SKILL.md`, and the `--next` section of `skills/run/SKILL.md`.
