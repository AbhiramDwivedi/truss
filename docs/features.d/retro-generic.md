## Generic retro: the counting step (ADR-0051)

- What: `problems(directory)` counts where a run's wall-clock and tokens went and returns ranked findings, each with counted evidence, a cost, a fix and a target. It works on a truss run dir and on a plain project dir with no `plan.json`; there its targets are project config or a proposed goal. It covers time (slot waits, test runs, QC rounds, conflict resumes, idle and stop waits, API outages), the quality loop (failed QC rounds, failed checks, spent rework allowance, rulings on QC findings), rules and gates (refusals and gate stops) and cost (tokens per crew and role, spawns, model mix, USD when the client's `pricing` config has the model). Findings are ranked by wall-clock, then tokens, never by category. It reads no transcript.
- Entry points: `plugins/truss/retro/problems.ts` (`problems`, `assemble`, `CHECKLIST`), re-exported from `plugins/truss/retro/counts.ts`; `plugins/truss/tests/retro-generic-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/adr/0051-generic-retro.md`; [architecture](../plugins/truss/docs/architecture.md) ("The counting step of the generic retro (ADR-0051)").
