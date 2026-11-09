# ADR-0033: crew knowledge capture, crew-level product calls and a product-owner plan review

Status: accepted, 2026-11-09
Decided by: client ruling, 2026-11-09 (learning is captured automatically and kept in the repo; product calls are made at crew level; the plan is reviewed before any work starts)
Amends: ADR-0032 Decision 9 (the product-owner judge advises the crew lead, not only the PM); the run skill's "Adopt what the run learned" pass

## Context

The client's direction: "just like architecture evolves and functionality gets added, learning should be captured automatically and made available for future use."

In the client's reference project each agent knows which path to take because it is documented: an `AGENTS.md` routing table and `docs/knowledge/`. Without that, every agent re-analyses a large codebase to find where a capability lives.

Truss's capture has these gaps:

- `## Learned` in a foreman's final report is optional. Only full crews' foremen have it; a solo or lean crew's members report no such items.
- Items are adopted only at run end. If the run stops early, what the crews that finished learned is lost. It is also too late for later crews of the same run, who start without it. (A crew that did no work has nothing to capture.)
- Adoption feeds only the architecture doc. A persona's stale path, a domain truth or the location of a capability has no place to go.
- The PM answers product questions for every crew. It sits outside the crews, so it is a bottleneck, and its answers are not in a file later crews read.
- Nothing reviews the plan's acceptance criteria as a user would. A criterion that only proves the code runs passes the checking engineer.
- The PM's Claude Code auto-memory is private. Anything a crew needs that lands there is invisible to the crews.

## Decision Drivers

- Knowledge reaches the crews that need it, in the same run, through the repo.
- Capture must not bloat the context every later agent reads: it stays optional and terse.
- Product calls are made by whoever leads the work, and the main session can still correct them.
- Keep the authority split: the PM talks to the client and decides cross-crew and scope questions.
- Reuse what exists: the writer, the QC rubric, the product-owner judge, the decision log.

## Considered Options

| Option | Kept? | Why |
| --- | --- | --- |
| Make `## Learned` mandatory and adopt it at run end | Rejected | A mandatory section fills with filler and bloats the docs. Run-end adoption is lost when a run stops and is too late for later crews. |
| Capture in the crew branch, after the green check, when there is something to capture | Kept | The knowledge merges with the code, so a finished crew's learning survives a stopped run and later crews of the run read it. |
| Keep learning in the PM's auto-memory | Rejected | It is private to one user and one machine; a crew can't read it. |
| One knowledge file only (the architecture doc) | Rejected | Persona rules, domain truths, capability locations and design decisions belong in different files. |
| The PM answers every product question | Rejected | Crew leads wait on it. The PM is also not in the crew's context. |
| Crew leads decide product calls and tell the PM without waiting | Kept | No stall, and the PM can ack or change a call while the crew runs. |
| A persona `memory:` frontmatter field | Rejected | It would be private state again. |

## Decision

### A. Per-crew knowledge capture, in the crew branch

Members' reports may carry `learned` items `{kind: feature|persona|product|decision, text, source, target?}`. A member lists an item only when a later crew couldn't cheaply get it from the code. `target` is an optional repo path (a README, a runbook, `docs/knowledge/*`, `AGENTS.md`, `CLAUDE.md`, a persona, `product-owner.md`, an ADR or the architecture doc). The kind-to-file mapping below is only the default.

The **knowledge step** runs after a crew's green check and before the stress test and QC, in the crew branch. It runs only when members reported items, or when the diff adds or moves user-facing functionality; otherwise it is skipped silently, with no "nothing new" report. A writer member (brief first line `Knowledge: crew <slug>`) updates:

- the **feature map**, `docs/features.md` by default or `featureMap` in `.claude/truss.json`: one entry per user-facing capability, with what it does, entry points as paths, the owning persona and doc pointers;
- the **persona files** the crew used: amend a Standards or Review checklist rule, fix a moved path;
- **`product-owner.md`**: this crew's product calls and domain truths;
- an **ADR** for a design decision;
- any other doc an item's `target` names.

The writer keeps entries terse and edits or merges existing entries instead of appending, because unbounded notes bloat the context that every later agent reads. It commits `docs(knowledge): <slug> learned`.

The QC engineer's brief carries a `Knowledge:` block. QC fails a diff that adds or moves user-facing functionality without a feature-map entry, and a crew product call missing from `product-owner.md`. It never fails for missing optional learning.

This applies to every process size, described the same way: a full crew's foreman runs the step (`stage.js` on the workflow path); a solo or lean crew's members report items and the main session runs the knowledge writer in that crew's branch when there are items. Solo and lean crews run the project's predefined persona agents like any crew.

The feature map is the routing table. Crews and the planner read it before scanning code. `truss:init` has the design engineer create it from the code on day 0.

The run-end pass shrinks to **reconciling** conflicting amendments across crews, across all the files above and not only the architecture doc, and anything a crew could not write.

### B. Product calls at crew level

A product question inside a crew is decided by the crew's lead. On the workflow path `stage.js` runs the `product-owner` persona with a brief whose first line is `Product call: crew <slug>`; it replies `PO: DECIDE` (answer and reason) or `PO: ESCALATE` (why). On the foreman path the foreman does the same and rules: it follows the reply by default and logs why when it doesn't. Each decision is logged as `PO crew <slug>: <question> | <answer> | product-owner | decided` and lands in `product-owner.md` through the knowledge step, so later crews follow it.

A crew escalates to the PM when: the question is not a product question, it is outside the crew's approved scope, it touches another crew's area, it meets a client approval trigger, or the `product-owner` file and the requirements don't settle it. A solo or lean crew has no lead, so the PM decides its product calls. The PM still decides cross-crew and scope questions and is the only one who talks to the client. At merge, the checking engineer's drift and overlap check also flags contradictory product calls between crews.

The crew lead tells the main session each call as it makes it, and never waits:

- the crew posts a call with `factory crew-decision --crew <slug> --task <id> --question <q> --answer <a> --by <who>`, which returns an id;
- the main session watches `factory decisions --open` (a Monitor) and replies `factory decision-reply <id> ack` or `factory decision-reply <id> change --note <text>`;
- the crew reads `factory decision-replies --crew <slug>` before each member spawn, before the knowledge step and before QC;
- on `change`, the crew re-runs the asking member with the main session's note and records the corrected call in `product-owner.md`, marked as overruled by the main session;
- an unanswered call counts as accepted when the crew finishes;
- on the foreman path the main session may also `SendMessage` the foreman directly;
- a change that arrives after the crew finished becomes a fix at merge, decided by the main session.

### C. Product-owner plan review, before work starts

In plan mode, after the checking engineer reviews the verdicts, the product-owner judge (or this plan's draft of it, inlined) reviews the plan's acceptance criteria. The brief opens with `Plan review:`; the reply is `PO: ACCEPT` or `PO: REVISE` with numbered findings `<n>. <crew>: <what>. Fix: <fix>`. It rejects criteria that only prove the code runs: no representative or realistic data, no automated grader or eval for AI or LLM output, no check a user would recognise, a requirement with no acceptance test. There is one revise round with the design engineer and one re-review. A second `REVISE` goes to the PM as open findings to rule on, and to the client in a non-auto run. The plan workflow writes the design engineer's persona drafts to `<truss dir>/personas/<name>.md` and lists them, so the PM runs `factory persona-install` from there.

### D. Memory versus repo knowledge

The PM's Claude Code auto-memory holds only how this client works: preferences and authorisations. Anything a crew needs (stack rules, where functionality lives, domain truths, decisions) goes to the repo artefacts above, never to private memory. Personas get no `memory:` frontmatter field.

## Consequences

**Positive**

- A crew's learning merges with its code. It survives a run that stops early and reaches later crews of the same run.
- A crew and the planner find a capability from the feature map and skip the codebase scan.
- Product calls don't wait on the PM, and they accumulate in a file later crews follow. The main session can still correct one while the crew runs.
- A plan whose acceptance criteria only prove the code runs is sent back before work starts.

**Negative**

- The knowledge step costs one writer member (Opus, `medium`) per crew that has something to capture. Skipping it when there is nothing to capture, and keeping entries short, bound the cost.
- A wrong product call by a crew lead is built before the main session sees it. The ack and change flow and QC's rubric reduce the chance; a late change costs a fix at merge.
- The feature map can rot. QC's check on added or moved functionality and the reconcile pass reduce it and do not remove it.
- Two crews can write the same feature-map file and conflict at merge. The reconcile pass and the checking engineer's contradictory-calls check cover it.

**Neutral**

- The mechanics are in `workflows/stage.js` (`MEMBER_SCHEMA` `learned`, the knowledge step, the QC `Knowledge:` block, crew product calls), `workflows/plan.js` (the plan review and persona drafts on disk) and `bin/factory.ts` (`crew-decision`, `decisions`, `decision-reply`, `decision-replies`), built by separate crews from this prose. Persona `loaded` uses a cross-platform session start. Read-only judges never run with write tools.
- Naming: the client wants the per-crew lead called "project manager" and the main session "program manager". A full rename (agent file, type, config keys, every doc) is a separate goal after this one merges. New text here says "crew lead".

**Reversing it** touches: the knowledge step and product-call prose in the run skill, the foreman, writer, QC, checking-engineer, design-engineer and planning-engineer prompts and the init skill; the knowledge step, product-call and plan-review code in `stage.js` and `plan.js`; the decision commands in `factory.ts`; and `tests/crew-knowledge-prose.check.ts`. Feature maps and `product-owner.md` entries already written stay in the repo as ordinary docs.
