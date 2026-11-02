# ADR-0020: a resumed run's second agentId under one label is filed as `<label>.run<N>.md`

Status: accepted, 2026-11-02. Written by the builder of crew `resume-labels`. The goal was added at 13:05 on the client's ruling, option 2 "Fix the factory first" (checker-37). Plan revision 2 was approved (auto) at 13:26 after checker-39, and checker-38's send-back named the TAP cases `rl 1` to `rl 4` and the rank wording. It amends [ADR-0009](0009-workflow-factory.md) Decision 4 ("finish"); nothing else in that decision changes.

## Context

A Workflow run that is resumed (run `wf_0dff946d-af1`) can hold two agentIds under one label: the agent that started before the resume, and the one that started after it. Both have a `started` line in the run's journal with the same `label`, and each has its own `result` line and transcript.

`recordRun()` in `bin/factory.ts` filed every agent at `reports/<slug>/<label>.md`. The second agentId's text differed from the first's, so `finish` audited it with "a report file with different text already exists; not overwritten", and the audit stopped the crew's merge. `decisions.md` of 12:38 to 12:45 records the stall on `repo-docs`, and checker-37 recommended fixing the factory before finishing that goal. Four labels of that run already have spawn and report lines for both agentIds in the live `events.jsonl`, so the fix has to be idempotent against those lines.

## Decision

### The filing rule

Among the agentIds under a label that returned a result text, the k-th distinct one in the run's journal (`started` order) owns `<label>.md` for k=1 and `<label>.run<k>.md` for k>=2. N is that rank, not the first free name on disk.

`recordRun` computes the rank from the run's agents (the `started` lines, in journal order, deduplicated by agentId, per label), counting only agentIds that left a result text: an agent interrupted before it returned has no report, takes no rank, and so a resumed agent after it is rank 1 and files `<label>.md`. Spawn lines (once per agentId and run) and report lines (once per crew, label and marker) are appended as before, with `agent` set to the label, not the file name.

A refusal ("a report file with different text already exists; not overwritten") happens only when the file an agentId owns by this rule already holds different text. That includes a file whose origin is unknown: a first-rank agent finds `<label>.md` holding other text and is refused, so the existing finish case that pre-seeds a different report stays green unchanged. Every other audit in `recordRun` is unchanged.

### How the agentId is known

A report file does not record who wrote it. The rank is the only link between a file and an agentId, and it is derived from the journal, which `finish` reads on every run. So the file name for an agentId never depends on what is on disk. Running `finish` again gives the same ranks, the same file names, the same events and the same output, and the live `events.jsonl`, where both agentIds of four labels already have lines, adds nothing. A "first free name" rule would break this: a second pass would find `.run2` taken by the agent that owns it and move to `.run3`.

### The gate-role exception

The merge gate reads one QC file per label and the stress gate one `<slug>-stress.md`. For a label whose role is `qc` or `stress`, a second agentId that also returned a result (rank 2 or more) is not filed as `.run<k>`. It keeps a refusal, with its own audit text: "a second agentId (...) under the gate label ...; the merge and stress gates read one file per label, so it is not filed". The audit blocks the crew's merge, as before. The rank-1 agent of a gate label is filed as `<label>.md` as always.

### labelFromOf

`labelFromOf()` (the next free label number per role) ignores names ending in `.run<N>.md`, so a `.run` file never moves a role's next label number.

## Consequences

- A resumed journal with two agentIds under one non-gate label passes `finish`: `<label>.md` holds the first agentId's text and `<label>.run2.md` the second's, and both have spawn and report lines.
- Finishing the same run twice is a no-op the second time.
- `reportsOf()` lists `.run<N>.md` files like any report. A reader that globs reports by prefix sees them. The retro qc glob and the `isQcFile` check in `hooks/register.ts` are not changed here.
- Gate labels (QC and stress) of a resumed run are still refused. Filing a resumed QC or stress, the retro qc glob and `doneTasks` are left for factory-fixes-2.

## What this ADR cannot change

`docs/architecture.md:301` describes report files as one file per label. It should name `<label>.run<N>.md` and the rank rule. The redesign-design crew owns `architecture.md`, and this crew must not touch it. The change is left for factory-fixes-2.
