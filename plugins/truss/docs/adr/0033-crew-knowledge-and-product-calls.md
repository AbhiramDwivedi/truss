# ADR-0033: crew knowledge capture, crew-level product calls and a product-owner plan review

Amended by ADR-0035 (path-scoped knowledge): crew product calls go to `docs/knowledge/product-decisions.md`, not `product-owner.md`, and the knowledge step routes, reconciles and is linted as that ADR says.

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

The **knowledge step** runs after a crew's green check (and the reply checkpoint of section B) and before the stress test and QC, in the crew branch. It runs only when members reported items, or when the crew diff adds, renames or deletes non-test source files (detected from git, not from member reports; in that case the writer gets those paths and adds feature-map entries); otherwise it is skipped silently, with no "nothing new" report. A crew whose tasks are all writer tasks skips it too. The writer (brief first line `Knowledge: crew <slug>`) runs on Sonnet at effort `medium`: it edits docs from given items, and QC (Opus) checks the result. After the knowledge commit green always re-runs, even for a commit that changed only `.md` files: markdown can be test input (this repo's own prose checks read `SKILL.md` and `agents/*.md`), and `land` runs no check. The step records its commit with `factory knowledge-commit --slug <slug> --sha <sha>` (with `--base` and `--head` the sha must be a non-merge commit in that range, else it is refused and nothing is recorded; the crew carries on, green re-runs, and the owns check then refuses any out-of-owns doc change), and on the workflow path the QC `Knowledge:` block (`knowledgeLines`) names that SHA. Items learned after the step (from stress or QC fixers) are listed in the crew result as `unrecorded` for the run-end reconcile pass, never silently counted. The writer updates:

- the **feature map**, `docs/features.md` by default or `featureMap` in `.claude/truss.json`: one entry per user-facing capability, with what it does, entry points as paths, the owning persona and doc pointers;
- the **persona files** the crew used: amend a Standards or Review checklist rule, fix a moved path;
- **`product-owner.md`**: this crew's product calls and domain truths;
- an **ADR** for a design decision;
- any other doc an item's `target` names.

The writer keeps entries terse and edits or merges existing entries instead of appending, because unbounded notes bloat the context that every later agent reads. It commits `docs(knowledge): <slug> learned`.

The step edits only markdown. A learned item whose `target` is not a `.md` file is skipped and listed in the report, never written. **Reachable knowledge:** learning can go to any doc, but a doc that no agent can find is as hidden as code. Whenever the step writes an item outside the feature map, it makes sure that doc is reachable from the feature map entry for the area (a doc pointer) or from the project's `CLAUDE.md` / `AGENTS.md` index.

**Scope.** Only the knowledge-step commit may touch files outside the crew's owns, and only `.md` files on the listed doc paths: the feature map, the ADR dir (`adrDir` in `.claude/truss.json`, default `docs/adr`), the product-owner file, `.claude/agents/*.md` and an item's `target`. The exemption keys on the knowledge commit SHA recorded with `factory knowledge-commit`, never on the commit subject, and a file counts only if it changed in that commit and in no other non-merge commit of the crew. A change to the YAML frontmatter of a persona file is never exempt. `owns-check` reports the exempt paths as `exempt`.

The QC engineer's brief carries a `Knowledge:` block. QC fails a diff that adds or moves user-facing functionality without a feature-map entry, and a crew product call missing from `product-owner.md`. It never fails for missing optional learning.

This applies to every process size, described the same way: a full crew's foreman runs the step (`stage.js` on the workflow path); a solo or lean crew's members report items and the main session runs the knowledge writer in that crew's branch when there are items. Solo and lean crews run the project's predefined persona agents like any crew.

The feature map is the routing table. Crews and the planner read it before scanning code. `truss:init` has the design engineer create it from the code on day 0.

The run-end pass shrinks to **reconciling** conflicting amendments across crews, across all the files above and not only the architecture doc, and anything a crew could not write.

### B. Product calls at crew level

A product question inside a crew is decided by the crew's lead. On the workflow path `stage.js` runs the `product-owner` persona with a brief whose first line is `Product call: crew <slug>`; it replies `PO: DECIDE` (answer and reason) or `PO: ESCALATE` (why). On the foreman path the foreman does the same and rules: it follows the reply by default and logs why when it doesn't. Each decision is logged as `PO crew <slug>: <question> | <answer> | product-owner | decided` and lands in `product-owner.md` through the knowledge step, so later crews follow it.

The `Product call:` brief carries every crew decision of the run so far (`factory decisions`), not only the asking crew's. The product owner follows an earlier call that settles the question and escalates when its answer would contradict another crew's call. This is how parallel crews stay consistent; the checking engineer's contradiction check at merge is the backstop.

A crew escalates to the PM when: the question is not a product question, it is outside the crew's approved scope, it touches another crew's area, it meets a client approval trigger, or the `product-owner` file and the requirements don't settle it. A solo or lean crew has no lead, so the PM decides its product calls. The PM still decides cross-crew and scope questions and is the only one who talks to the client. At merge, the checking engineer's drift and overlap check also flags contradictory product calls between crews.

The crew lead tells the main session each call as it makes it, and never waits:

- the crew posts a call with `factory crew-decision --crew <slug> --task <id> --question=<q> --answer=<a> --by=<who>`, which returns an id; free text goes in the `--flag=value` form, so a value that starts with `--` is safe;
- the main session watches `factory decisions --open` (a Monitor) and replies `factory decision-reply <id> ack` or `factory decision-reply <id> change --note=<text>`. The reply is written once (an exclusive create); a second reply is refused;
- the crew applies replies at **one checkpoint**: after every member has integrated and the green check has passed, and before the knowledge step. Nothing polls replies before a member spawn, in a fix builder, in stress or QC rework, or after the knowledge step. Why: applying a change while the asking member, or a parallel member, is still running races its integration, and applying one during QC rework loops QC;
- at the checkpoint the crew reads `factory decision-replies --crew <slug>` (it returns the replies not yet acked and consumes nothing), applies them, then runs `factory decision-ack --crew <slug> --ids <ids>`, which consumes them. A reply lost between the reader and the crew therefore shows up again. Then it runs `factory decision-checkpoint --crew <slug>`, which closes the crew's window: `decisions --open` stops listing that crew's calls, so the Monitor goes quiet;
- on `change`, the crew re-runs the asking task once, as a fix member on top of the integrated crew branch, with the note `Main session changed product call <id>: <note>`, integrates it, re-runs green, then runs the knowledge step, which records the corrected call in `product-owner.md`, marked as overruled by the main session;
- an unanswered call counts as accepted;
- a reply to a crew past its checkpoint is still written, and `decision-reply` returns `crewPastCheckpoint: true`. Past the checkpoint means `checkpoint.json` exists, or the crew is finished, merged or dropped. A stopped crew can be resumed and still reach its checkpoint, so it counts as past only when `checkpoint.json` exists; one that already passed stays past it on resume (`factory decisions --crew <slug>` reports `checkpoint: true`, and the resumed crew applies no reply). The crew result lists such a reply as `late`, and the main session turns it into a fix at merge;
- each reply is acked right after it is applied, so a Stop on a later change leaves the earlier one acked and a resume does not apply it twice;
- a direct crew (solo or lean) has no lead: the PM runs `decision-checkpoint` and `knowledge-commit` itself;
- on the foreman path the main session may also `SendMessage` the foreman directly.

The learned items a crew has gathered are stored with `factory crew-learned`, and its decisions are rebuilt from `factory decisions --crew <slug>`, so a resume keeps both.

### C. Product-owner plan review, before work starts

In plan mode, after the checking engineer reviews the verdicts, the product-owner judge (or this plan's draft of it, inlined) reviews the plan's acceptance criteria. The brief opens with `Plan review:`; the reply is `PO: ACCEPT` or `PO: REVISE` with numbered findings `<n>. <crew>: <what>. Fix: <fix>`. It rejects criteria that only prove the code runs: no representative or realistic data, no automated grader or eval for AI or LLM output, no check a user would recognise, a requirement with no acceptance test. There is one revise round with the design engineer and one re-review. The revise round carries the first plan verbatim (`planJson`, `planMd` and the `PERSONA:` blocks), and the revision changes only acceptance criteria, acceptance tests and test data. When the revision changes the slugs, verdicts, owns or modules, `plan.js` re-runs the checking engineer on the revised plan; the PM then copies `recheck.reviews`, not the first plan's `reviews`, into `decisions.md`. The PO review is skipped when the checking engineer already disagrees (the result says `productOwner: {skipped: ...}` and the plan goes back to step 2). The PO review gets the feature map path when the file exists. An `UNCLEAR` verdict (no `PO: ACCEPT` or `PO: REVISE` line) is never read as `ACCEPT`. A loaded product-owner persona judges a plan only when it is read-only. An inlined read-only persona always runs as `truss:judge`, a neutral read-only host agent, with the persona body inlined; it never runs as `general-purpose`, so a judge never gets write tools. `truss:judge` is declared read-only to kit's manifest. One caveat: Bash can still write, and every read-only truss agent shares that limit. A second `REVISE` goes to the PM as open findings to rule on, and to the client in a non-auto run. `factory plan-write`, not `plan.js`, writes the design engineer's persona drafts to `<truss dir>/personas/<name>.md` and lists them, so the PM runs `factory persona-install` from there. Each `PERSONA:` block is a four-backtick fence, because a persona body can hold ``` command blocks, and `persona-install` refuses a draft without a `## Standards` heading.

### D. Memory versus repo knowledge

The PM's Claude Code auto-memory holds only how this client works: preferences and authorisations. Anything a crew needs (stack rules, where functionality lives, domain truths, decisions) goes to the repo artefacts above, never to private memory. Personas get no `memory:` frontmatter field.

## Consequences

**Positive**

- A crew's learning merges with its code. It survives a run that stops early and reaches later crews of the same run.
- A crew and the planner find a capability from the feature map and skip the codebase scan.
- Product calls don't wait on the PM, and they accumulate in a file later crews follow. The main session can still correct one while the crew runs.
- A plan whose acceptance criteria only prove the code runs is sent back before work starts.
- The retro counts learned items per crew and knowledge steps run versus skipped, so the client can see if optional capture has decayed into none.

**Negative**

- The knowledge step costs one writer member (Sonnet, `medium`) per crew that has something to capture. Skipping it when there is nothing to capture, and keeping entries short, bound the cost.
- A wrong product call by a crew lead is built before the main session sees it. The ack and change flow and QC's rubric reduce the chance; a late change costs a fix at merge.
- The feature map can rot. QC's check on added or moved functionality and the reconcile pass reduce it and do not remove it.
- Two crews can write the same feature-map file and conflict at merge. The reconcile pass and the checking engineer's contradictory-calls check cover it.

**Neutral**

- The mechanics are in `workflows/stage.js` (`MEMBER_SCHEMA` `learned`, the knowledge step, the QC `Knowledge:` block, crew product calls), `workflows/plan.js` (the plan review and persona drafts on disk) and `bin/factory.ts` (`crew-decision`, `decisions`, `decision-reply`, `decision-replies`, `decision-ack`, `decision-checkpoint`, `knowledge-commit`, `crew-learned`), built by separate crews from this prose. Persona `loaded` uses a cross-platform session start. Read-only judges never run with write tools.
- Naming: the client wants the per-crew lead called "project manager" and the main session "program manager". A full rename (agent file, type, config keys, every doc) is a separate goal after this one merges. New text here says "crew lead".

**Reversing it** touches: the knowledge step and product-call prose in the run skill, the foreman, writer, QC, checking-engineer, design-engineer and planning-engineer prompts and the init skill; the knowledge step, product-call and plan-review code in `stage.js` and `plan.js`; the decision commands in `factory.ts`; and `tests/crew-knowledge-prose.check.ts`. Feature maps and `product-owner.md` entries already written stay in the repo as ordinary docs.
