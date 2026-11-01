# Truss backlog

Working list for the next Truss runs, collected 2026-10-26 from a design conversation with Ram. Sources: Felix Rieseberg, "How to be more ambitious" (felixrieseberg.com); Thorsten Ball, "How I work with Agents" (X article, 2026-10-25); Addy Osmani's Clarity (clarity.addy.ie). foundry 0.1.0 itself builds run 1.

## Roles

| Role | Who | Power |
| --- | --- | --- |
| Client | Ram | Rules on blockers, on changes to frozen scope, on production deploys, and on every push or PR. |
| King | The PM (project manager, the main session) | Product owner for the run. Decides what "right" means, logs every decision. Asks the client only when two choices lead to clearly different outcomes with significant impact, or when a blocker can't be resolved. |
| Checking engineer | New agent, Opus high, outside every crew | Recommends, never decides. Gates every question bound for the client: answer it from the plan, defer it to the end-of-run list, or pass it on. Checks drift, including overlap between crews. Stateless: reads the approved plan and decision log fresh each call. Can't suppress a `BLOCKED:`. |
| QC engineer | New agent, inside each crew | Never the builder. Opus high at least, and one effort level above the builder it reviews, capped at xhigh. Gates the merge: the PM merges only when the QC engineer's report says pass. Also rules on the integration branch in `single` mode. |
| Generals | Foremen | As in 0.1.0, plus the depth pass, the ladder and the proof rules below. |
| Troops | Members | As in 0.1.0. |
| Writer | New member type | See "Technical writer". |
| Commissioning engineer | New member type | See "Commissioning engineer". |

A more capable QC engineer means a higher effort level on Opus, not a different model. Fable stays out unless the client asks for it.

## Run 1: foundry 0.2.0, the core factory

1. **QC engineer and proof.** Every report carries proof: the command and its output, before/after numbers, or a walk through the real flow. The QC engineer checks the proof against a "not evidence" list: tests the builder wrote after building, "I verified it" with no output, a typecheck alone, a mocked end-to-end test, output from another commit. It re-runs the proof itself only when the proof looks suspect or the change touches a high-impact path. Re-running everything costs too much.
2. **Acceptance tests the crew can't game.** A crew's acceptance test is code it doesn't own, or tests written by a test-writer before the builder starts, which the builder may not edit. The example plan in 0.1.0, where `auth` owns `tests/auth/**`, breaks this.
3. **Checking engineer**, as in the roles table. The PM follows its recommendation by default and logs a one-line reason for any overrule. Overrules appear in the end-of-run report.
4. **Message tags.** Foremen tag messages `BLOCKED:` (can't continue) or `PROPOSAL:` (more scope), as well as the existing `QUESTION:`.
5. **Altitude check.** The PM asks once whether the goal is the end or one step toward an outcome, and offers the bigger version. The client decides.
6. **Depth pass, at two levels.** Before planning, answer: what would a top practitioner do that wasn't asked for, what's the rawest material, which tools would they use, what besides the model verifies the result. A short pass by the PM shapes which crews exist; a full pass by each foreman shapes its members' tasks.
7. **Scope freeze.** Expand once while planning (altitude, depth, stress test), get the client's approval, then freeze. The checking engineer enforces the freeze.
8. **Escalation ladder.** Trigger: two fix attempts at one level end with the same check failing. Then a fresh agent one level up, never a resume. Its first deliverable is a root-cause analysis with evidence, then the fix. When it starts, it names competing theories and tests the cheapest to rule out first. Ladder: Sonnet, then Opus medium, high, xhigh. If xhigh fails twice, the foreman sends `BLOCKED:`. A hook refuses `effort: max` from inside a crew. Every Agent call in a run sets model and effort.
9. **Be brave.** Builders and foremen get: "Be brave: take the hard path, keep going when it gets difficult, don't ask permission for anything in scope. Never be brave with the truth: proof or it didn't happen." The ladder catches stubbornness.
10. **Describe jobs, not characters.** Role prompts say what the agent does, not who it is.
11. **Stress test, optional.** An Opus member whose brief is to break the crew's work. Suggested for crews that touch high-impact paths (auth, money, migrations, CI, lockfiles).
12. **High-impact paths.** Tagged in the plan. They trigger the stress test, and they're the only files the end-of-run report asks the client to read. The QC engineer's rubric (from Thorsten): it works; it's understood at the boxes-and-arrows level; it was tested end to end; it can be changed a month from now.
13. **Foreman checks its environment first.** Before splitting the work, a foreman proves it can run its own checks in its worktree. If it can't, that's an early `BLOCKED:`.
14. **Resource slices.** The PM gives each crew its own port range and its own database or temp directory, so parallel end-to-end tests don't collide.
15. **Heartbeats.** A hook writes a "last active" timestamp per crew agent on each tool call. A running agent with no tool call for N minutes counts as stalled, and `/truss` shows it. A timer wakes the PM to check. Needs a probe.
16. **Scheduled follow-ups.** For example, resume after the 5-hour limit resets: read the reset time from the `usage-limits` plugin, save a resume point, schedule a wake-up after the reset. If the Claude Code process can't stay open while limited, the fallback is Windows Task Scheduler starting `claude --resume`. Needs a probe.
17. **Commissioning engineer.** Generic: it reads the deploy target, health checks and smoke URLs from project config. It validates deploys with proof: health endpoint, smoke test, logs, rollout. It may validate a preview. Promoting to production always goes to the client.
18. **Technical writer.** See below.
19. **Skills in the plan.** The PM lists the project's skills alongside its agent types, matches them to crews in the plan, and foremen pass them to members.
20. **Foreman goal enforcement.** The goal and what done means go in a file the foreman re-reads. A `SubagentStop` hook refuses a foreman's stop until its report carries proof against the goal, or starts with `CHECKPOINT:` or `BLOCKED:`. Check whether `/goal` exists and whether a subagent can use it.
21. **Commit trailers.** Members' commits carry `Truss-Crew: <slug>`.
22. **Architecture docs.** `docs/architecture.md`: roles and who talks to whom (with a diagram), the run lifecycle, what's stored on disk, each hook and what it enforces, failure modes and recovery. Outline at the start of the build, content at the end. Written by the writer.

### Technical writer

Truss ships a `truss:writer` agent (Opus) whose job is the prose a crew ships: READMEs, docs, release notes, the architecture doc. It loads the best writing skill the session has. That's the client's `technical-writer` skill when it's installed. A project can name another in its Truss config. Without one, the agent falls back to rules built into its own definition: Zinsser's clarity, simplicity and brevity; Google developer style for reference and how-to; never invent a fact. The writer's work goes through the QC engineer like any other.

The writer doesn't write the king's reports or foremen's reports. Those keep their fixed, terse formats.

### Probes before planning run 1

1. Does an in-session timer (Cron, Monitor) fire while the PM is idle, and does it survive a usage-limit stop?
2. Does `/goal` exist, and can a subagent use it?
3. Can a `SubagentStop` hook block a foreman from stopping?
4. Can an agent definition preload skills, and can it fix its effort level?

## Run 2: the extension framework

- **RFC: how skills and plugins extend each other.** No inheritance; it breaks like a fragile base class does. Instead, data contracts on disk (a base skill writes a manifest with a schema, an extension reads it) plus named extension points the base declares. First check what Claude Code already offers: skill-to-skill calls, agent skill preloads, plugin dependencies, the mod API.
- **Prototype: `truss init` extending `kit init`.** kit writes its manifest (checks, agents, risky paths). Truss adds role mapping, port slices, deploy target, the writing skill, prompt overrides per role. These describe jobs, not characters. If the manifest is missing, Truss runs `kit:init` first.
- **`truss retro`.** Reads the decision log and reports: escalations by level, checking engineer recommendations and overrules, stalls, interruptions of the client, QC engineer rejections. Proposes changes to the project's Truss config and prompts. Turning repeated work into skills goes to `kit:revise`.

## Next: right-size the process per crew

The client's point, from run 4: not every goal needs a design stage and contract tests. The run and each foreman should pick the steps the work needs. Some work needs no design change at all and is only implementation. The steps in the process are a toolbox to put together per crew, not a sequence to follow every time.

Already flexible: the design engineer's `extend`/`change` verdict per module; an extend-only plan auto-approves with no stage 0; a foreman splits members by the leaf test.

Still applied every time:

- Any `change` verdict brings a whole stage-0 design crew (design engineer, probe, test-writers, QC engineer), even when the change is one ADR paragraph that a crew's own foreman could write.
- Contract tests are always written up front by a separate crew, even for a small change a crew can test itself.
- Plan time always chains design engineer, checking engineer, reconcile round, checking engineer.
- Every crew gets the full set: test-writer, builder, QC engineer, repair QC engineer.

Proposal:

- The design engineer gives each crew a rigour level with a one-line reason: `implement` (no design change; builder plus QC engineer), `design-in-crew` (the foreman starts the design engineer for a short ADR note inside the crew; no stage 0), or `design-stage` (today's stage 0). Stage 0 is only for design that several crews build against.
- The foreman may drop or add steps inside its crew and says which in its report, with a reason. The QC engineer checks that the steps it dropped weren't needed for the proof.
- Two things stay fixed: an acceptance test proved red before the work and green after it, and a QC engineer who isn't the builder. Everything else is optional.
- The checking engineer's verdict review runs only when the plan has a `change`, and the reconcile round only on a `disagree`.
- Measure it: agents and wall-clock per merged crew, against run 4.

## Separately: technical-writer skill update (ai-tools repo)

Add from Clarity: state logical relations with connectors, not by placing sentences side by side; chain paragraphs (test: cover the page and predict what comes next); give the strongest objection its own paragraph; name who did it; revise by reordering as well as cutting; ask the author when TODOs would outnumber facts. Credit Clarity in `craft.md`. Keep the existing rule against question openers. One agent can do this; it doesn't need a crew.

## Waiting on data

Each item waits on something Truss doesn't have yet.

- **Change-failure rate in retro.** It needs real post-merge history: which merged crews were later reverted or fixed. Truss hands off before the push, so it records none. The Rejected list already has "post-merge follow-ups" for the same reason. Wait until a project's own history can supply the count.
- **Mutation testing.** The check that a test fails when the code is wrong needs a runner, and there is no mutation testing runner for TypeScript that Truss can use. Wait for one.
- **The prune run and the word budget.** A run that deletes prompt rules, and a word budget that caps a prompt's length, both need to know which rules fire and what the evals score. Truss has neither the eval results nor rule-firing data yet. Wait until the client's eval runs and retro's counts supply them.
- **Consolidating the release-named test files.** Merging the test files named for releases is safe only when the evals and mutation data show which tests catch what. Until then a merge could drop a check nothing else covers.

## Rejected

- Unmeasured stretch goals ("2x or don't stop"). Allowed only as a number the QC engineer re-measures.
- An A/B eval of 0.2.0 against 0.1.0.
- "Stop managing context": the client's data says otherwise.
- "Don't worry about duplication" across crews.
- Post-merge follow-ups like "check CI": out of scope, Truss hands off before pushing.
