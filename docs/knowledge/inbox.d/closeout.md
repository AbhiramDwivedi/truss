## Multi-line answers

- `multiLine` (`workflows-src/stage/calls.js`) keeps the lines of a product-owner answer, a question held in the inbox (`openCall`), and a resolved note (`takeCall`, cap 4000), so they reach the member's retry note intact. `oneLine` still flattens shell arguments (`escalate`, `crew-decision`), the decision log and the learned item (`recordCall`).
- `cmdPlanWrite` (`bin/factory/plan.ts`) moves a replaced plan's `crews` and `crew-decisions` dirs into `run-state` (`run-state-2`, and so on) under the plan lock, so a new run's crew of the same slug starts with no old reply checkpoint, answers or decisions.
