# ADR-0044: split by need

Status: accepted, 2026-11-11
Decided by: client
Amends: ADR-0001 (sections 5, 6 and 8: stage 0 and approval), ADR-0009 (the `plan-check` and `approve` rules that tie approval to stage 0)

## Context

The client's ruling, 2026-11-11, word for word: "Stages are not necessary. A work may be split into multiple stages and multiple crews in each stage, but all of that is determined by work complexity. In general we should split just enough that work can be done by a PM of 300k context window." (The client's "PM" here is the crew's project manager, not the program manager (PM) the rest of truss's docs mean by it.)

Until now the plan split by rule, not by need. Any `change` verdict brought a whole stage-0 design crew, even for one ADR paragraph the client had already decided (ADR-0001 section 5). Stage 0 made the plan need the client's approval (`plan-check` required `approval: "client"` exactly when a stage-0 crew existed) and a `full` process. Each module got its own crew whatever its size. A goal-wide check, such as a whole-tree zero-match test, had no home but a last-stage crew. The program manager's plan brief named a crew and stage count. The 0.27.0 rename goal, one mechanical change, came back as four crews over three stages.

Requirements R-82 and R-83 in `docs/requirements.md` are the acceptance.

## Decision

1. **Stages from dependency only.** A goal's first stage holds every crew that needs nothing merged first. A later stage exists only when one of its crews needs an earlier crew's merged work, and `plan.md` states it in one line per later stage: `Why stage <n>: <crew> needs <crew>'s merged <what>`. Never a stage only for an ADR, a doc, a release bump or a goal-wide check. `plan-check` warns, and never refuses, on a later stage with no such line; the warning asks for the line or says to merge the stage into the one before it. Since crews may share files ([ADR-0043](0043-crews-share-files.md)), an `owns` overlap with an earlier stage is no evidence of a dependency, so the warning does not look at `owns`.
2. **Crews from the context budget.** The design engineer plans the fewest crews such that each crew's project manager needs at most half of the subagent-limits checkpoint (`nudgeAtK`, read from the client's config when readable, else 300K), so at most 150K at the default. `plan.md` shows each crew's estimated project-manager context in K tokens. The leaf test still splits items; the budget decides how items group into crews.
3. **A design crew only for an open design question.** When the client or an accepted ADR already decided the design, the `change` crew that builds it writes the ADR (`Decided by: client`) itself. A design crew, in any stage, is for a design question the plan cannot settle, and it may be `lean`.
4. **Approval is decoupled from stage 0.** `approval` is `"client"` when a client trigger applies (ADR-0001 section 4), when a long-term cost is open, or when the brief says so; otherwise `"auto"`. `plan-check` no longer ties it to a stage-0 crew, and `approve --by auto` refuses a plan or goal whose `approval` is `client`, not a stage-0 crew.
5. **Goal-wide checks after the last merge.** An optional plan field `goalCheck`, top-level for the run's first goal and on each `goals[]` entry, holds the goal's goal-wide check. The program manager runs it after the goal's last merge: in single mode on the integration branch before the integration QC, in sequential mode on the target before any push. A failure starts a fix crew. `plan-check` requires a non-empty string when the field is present. It is optional, so a reader may treat it as absent, and the plan version stays as it is (plan.schema.json's version rule). A release bump or CHANGELOG entry goes to an existing crew.
6. **The plan brief names no crew or stage count.** The program manager describes the goal; the split is the design engineer's, by the rules above. The program manager sends a plan back for a later stage with no `Why stage` line.
7. The unattended-start eligibility condition "needs no stage-0 crew" (ADR-0039) reads "needs no design crew": a stage-0 crew is no longer a design marker.

## Consequences

- The context estimate is a guess. An oversized crew hits the checkpoint and hands over to a successor. The retro should compare the estimate with the real peak.
- Bigger crews mean bigger diffs for one QC engineer, and less parallelism.
- Without a stage-0 design crew, parallel crews on a new seam have nothing pinning the interface first. Point 3 limits this to settled decisions, but "settled" will be misjudged sometimes.
- Fewer plans wait for the client's approval.
- In sequential mode a failing `goalCheck` finds the target already moved; it stays red until the fix crew lands. That is why it runs before any push.
- Reading `nudgeAtK` couples the plan to subagent-limits' option name; the 300K fallback keeps a plan possible without it.
