## retro-generic: who updates the six old-shape retro tests

- Question: the `cli.ts` rewrite to the ADR-0051 finding shape leaves six cases on the old shape (`retro-contract.check.ts` at two cases, `retro/cli.check.ts` at four), and the builder may not edit tests. Who fixes them?
- Answer: the test-writer rewrites each case to the new shape, with `findings` reading `retro/problems.json`. The builder adds no fallback to the old shape.
- Reason: the cases are inside the crew's owns, and ADR-0051 Consequences already says the crew changes the retro-contract cases.
- Decided by: product-owner persona (crew retro-generic).

## retro-generic: refusal retry timing in the wave-4 run

- Domain truth: in `events.jsonl` a `refusal` event's `agent` is the agent id for a subagent (crew `main`) and `main` for the main session, so a retry's cost is the agent's next usage row. In the wave-4 fixture the worktree-guard refusals retried within about 1 to 2 seconds (`plugins/truss/tests/fixtures/retro-generic/wave4-run.json`, `plugins/truss/retro/problems.ts` `rulesPart`).
