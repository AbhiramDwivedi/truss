## Generic retro: the counting step (ADR-0051)

- What: `problems(directory)` counts where a run's wall-clock and tokens went and returns ranked findings, each with counted evidence, a cost, a fix and a target. It works on a truss run dir and on a plain project dir with no `plan.json`; there its targets are project config or a proposed goal. It covers time (slot waits, test runs, QC rounds, conflict resumes, idle and stop waits, API outages), the quality loop (failed QC rounds, failed checks, spent rework allowance, rulings on QC findings), rules and gates (refusals and gate stops) and cost (tokens per crew and role, spawns, model mix, USD when the client's `pricing` config has the model). Findings are ranked by wall-clock, then tokens, never by category. It reads no transcript.
- Entry points: `plugins/truss/retro/problems.ts` (`problems`, `assemble`, `CHECKLIST`), re-exported from `plugins/truss/retro/counts.ts`; `plugins/truss/tests/retro-generic-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/docs/adr/0051-generic-retro.md`; [architecture](../plugins/truss/docs/architecture.md) ("The counting step of the generic retro (ADR-0051)").

## Generic retro: findings and triage in the retro CLI (ADR-0051)

- What: `retro/cli.ts` has a `problems <truss dir>` command that prints the counting step's JSON and writes `<truss dir>/retro/problems.json` atomically. `findings` keeps a judge's finding of any category, including one outside `CHECKLIST`, and drops one whose evidence names a missing measure or a different value, naming the measure in the reason. A finding whose target path is product code gets target kind `proposed-goal`; a bare top-level `bin/` or `hooks/` is the plugin only when the judge declares kind `plugin`. `parseTriage` keeps the `TRIAGE: <id> | <fix now|defer|drop> | <reason>` grammar, and a `fix now` on a proposed goal is listed as a proposed goal and never enters the fix goal.
- Entry points: `plugins/truss/retro/cli.ts` (`main`, `parseFindings`, `parseTriage`); `plugins/truss/tests/retro-generic-032.check.ts`.
- Owner: `truss-plugin-node`.
