## Crew product calls reach the program manager

- What: a `PO: ESCALATE` opens a `pm-question` item the program manager resolves with `--by pm`; a `PO: SCOPE-CHANGE` opens a client-only `scope-change` item. Only the asking crew stops BLOCKED while it is open, and a resumed stage re-reads it through `factory inbox`, never a timer. `PO: DECIDE` never waits. Since 0.32.0 the question in the hold stop and the ruling handed to the asking member keep their line breaks (`multiLine` in `workflows-src/stage/calls.js`); the escalate title and detail, the `crew-decision` arguments, the decision log and the learned item stay one line (`oneLine`). `pm-question` is a valid escalate kind in `docs/events.schema.json` and `docs/state.schema.json`.
- Entry points: `plugins/truss/workflows-src/stage/calls.js` (`productCall`, `recordCall`), `plugins/truss/workflows-src/stage/replies.js` (`openCall`, `takeCall`, `pendingCall`, `restoreCalls`), `plugins/truss/bin/inbox.ts` (`KINDS`); tests `plugins/truss/tests/pm-calls-029.check.ts`, `plugins/truss/tests/stage-bundle.check.ts` (the R-127 cases), `plugins/truss/tests/closeout-review-stage-032.check.ts`.
- Owner: `truss-workflow-scripts`.
- Docs: [inbox](knowledge/inbox.md), `plugins/truss/docs/adr/0047-crew-decisions-reach-pm.md` (amends ADR-0033 section B), `plugins/truss/docs/goals/0.32.0-closeout.md`.

## Second run in one truss dir

- What: `plan-write` over an approved plan renames `plan.json` and `plan.md` to `plan-<stamp>.json` and `.md` (`<stamp>`: the first 20 letters and digits of `approvedAt`, `-<n>` added on a clash) and writes the new plan; it refuses, writing nothing, while a crew of the earlier plan is `running` or still `planned` (a planned crew counts as a live run). An unapproved plan is still overwritten. Whenever it replaces an existing `plan.json`, it also moves the earlier run's `crews/` and `crew-decisions/` dirs to `run-state/crews` and `run-state/decisions` (`run-state-<n>` when the name is taken), so a new crew with an old slug starts with no reply checkpoint and no old crew decisions. `decisions.md` and `usage.jsonl` stay shared.
- Entry points: `plugins/truss/bin/factory/plan.ts` (`cmdPlanWrite`, `keepExisting`), `plugins/truss/tests/lifecycle-029.check.ts`, `plugins/truss/tests/closeout-review-node-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/skills/run/SKILL.md` section 4 ("Draft the plan", step 4); [architecture](../plugins/truss/docs/architecture.md) ("Plan (step 4)", "Closeout fixes (0.32.0)").
