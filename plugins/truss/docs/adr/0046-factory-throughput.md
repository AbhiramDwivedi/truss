# ADR-0046: factory throughput and QC quality (0.29.0, builder A items)

Status: accepted, 2026-11-12
Decided by: program manager (auto), resting on the 0.29.0 throughput goal (wave5 `goal-throughput.md`, items 1, 4, 5, 6, 7 and the pricing item)
Amends: ADR-0009 Decision 4 (step order), ADR-0015 (heavy slot count)

## Context

- A resumed crew got only the answers in the PM's newest `--answers` file. A ruling given on an earlier resume was lost unless the PM restated it, and the crew re-asked or rebuilt without it.
- Every factory command a stage runs costs one runner agent spawn; admit and reap wrap every member, and the same check re-ran on an unchanged head.
- The heavy slot was one lock for the whole host, and the load case ran on every QC round.
- The knowledge step and its lint ran once, before QC; a fix round after it left the knowledge docs stale. The stress test ran after the knowledge step, so knowledge never saw stress fixes.

## Decision

Each item below records what changed. Items not yet listed here were not done in this change; the builder's handoff says why.

### Item 5: a resume carries every unbuilt ruling

- `start --resume answers|stale|merge-ready` merges the crew's stored rulings into `entry.answers`: the new answers first, then each stored one not repeated (`carriedAnswers`, `bin/factory.ts`).
- The store is `<truss dir>/crews/<slug>/answers.json`, rows `{at, text, after, ts}`, rewritten on every resume (`saveAnswers`). `after` is the id of the crew's newest Workflow run when the ruling was first given.
- A stored ruling at a task name drops once a run after `after` finished that task: it is built, and re-sending it would make the resume re-run the task. Until then it rides along and keeps the task out of `done`. A ruling at a step name (red, split, green, qc, stress, UX) always rides along: a step has no "built" record.
- The red-record refusal looks only at the new answers, as before.

## Consequences

- The PM's answers file holds only new rulings (`skills/run/SKILL.md` section 7). A ruling the PM wants withdrawn must be overridden by a newer ruling at the same `at`; there is no delete command. Long-term cost: step rulings accumulate for the life of the crew and lengthen every resumed brief.
- Tests: `plugins/truss/tests/throughput-029.check.ts` (`i5 *`).
