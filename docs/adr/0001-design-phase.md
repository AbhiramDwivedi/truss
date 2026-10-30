# ADR-0001: a design phase, principle packs and planned work breakdown

Status: accepted (stage 0 of foundry 0.3.0). Date: 2026-10-26. Decided by: Ram (client), with the PM (project manager).

## Context

The intel run on 2026-10-26 took about six hours for three crews. Two of them merged with 10 and 12 agent reports. The third, gateway, needed 32: 8 builders, 9 testers, 7 writers, 4 QC engineers and 4 stress tests. Its decision log shows the cause. There was no gateway design, so the design happened inside the build:

- its file ownership was widened mid-run, and drift was accepted after the fact (schema, config key, two engines, a registry);
- acceptance tests couldn't be run with the crew's own access;
- a design question (the model byline) surfaced after building started and caused another build-and-qc cycle.

Foundry 0.2.1 splits work at two fixed levels: the PM splits into crews by file ownership, and foremen split into member tasks of "one sitting". Neither level has a rule for when a piece is small enough or too small. No artifact holds the design, so each brief carries its own paraphrase of it.

## Decision

### 1. The architecture lives in the project repo

Each project has one architecture doc. Truss's `init` writes it when it's missing (step 0). It holds:

- **Principles:** the rules every change follows, chosen from Truss's principle packs and adapted to this repo, with a reason wherever a pack rule is dropped.
- **Module map:** each module, the paths it owns, what it's responsible for, and its seams (the interfaces other modules use).
- **Decisions:** ADRs for the decisions already visible in the code, then one per design change.

Where the doc goes: the repo's existing architecture doc, if it has one, which `init` extends rather than replaces. Otherwise `docs/architecture.md`, with ADRs in `docs/adr/`. The doc's path is recorded in `<repo>/.claude/truss.json`. `init` writes only `architecture` and `adr`. The client can add the optional keys by hand; each has a default:

```json
{
  "architecture": "docs/architecture.md",
  "adr": "docs/adr",
  "agentCap": 40,
  "maxParallelCrews": 4,
  "merge": "sequential",
  "target": "<current branch>"
}
```

`merge` and `target` apply to auto-started runs (section 6).

### 2. Principle packs ship with Truss, as a skill

`skills/principles/` holds one file per domain. Each pack is a list of rules that can be checked against a diff, each with a one-line test ("a module imports another only through its index").

- `core`, applied to every project: high cohesion and loose coupling; depend on interfaces at module edges; SOLID where there are objects; explicit contracts at seams; fail fast; idempotent operations; observability; secure defaults; YAGNI.
- `service`: 12-factor (config in the environment, stateless processes, disposability, dev/prod parity, logs as streams), backing services as attached resources, health endpoints.
- `frontend`: component composition, one-way data flow, state kept next to its use, the design-system / app boundary, an accessibility baseline, performance budgets.
- `data`: idempotent re-runnable pipelines, schema contracts between stages, raw data never changed, lineage, backfills, data-quality checks as gates.
- `ai`: evals before changes, versioned prompts and models, deterministic seams around model calls, cost and latency budgets.
- `infra`: infrastructure as code, immutable deploys, least privilege, a rollback path.
- `library`: a stable public API, semver, no side effects on import.

`SKILL.md` indexes the packs and says how to pick them. A pack is loaded with the Skill tool and read from its base directory, so no agent needs the plugin's install path.

### 3. The design engineer

`agents/design-engineer.md`: Opus, effort high. It loads the packs the work touches, and that's what makes it a frontend, data or backend design engineer. Tools: Read, Grep, Glob, Bash (read-only git and read-only inspection, plus the acceptance test commands it proves and a schema validator fetched by `npx -y`, both in plan mode), Skill, Write and Edit. Write and Edit are limited to these files:
- the architecture doc;
- the ADR directory;
- `.claude/truss.json`, in init mode;
- `<truss dir>/plan.json` and `plan.md`, and scratch output under `<truss dir>/scratch/`, in plan mode;
- a contract artifact at a path the design crew owns, in design mode.

It never edits source or tests. It runs in three modes.

- **init:**
  - Started by the `truss:init` skill. That's the client running `/truss:init`, or the PM when a run finds no architecture doc.
  - It writes the architecture doc, the module map, the ADRs for decisions already in the code, and `.claude/truss.json`.
- **plan:**
  - Started by the PM at the start of every run, outside every crew, like the checking engineer.
  - For a goal, it writes the verdicts and the work breakdown (sections 4 and 5) as a draft `plan.json` plus a readable `plan.md`.
  - The draft sets `approval`: `client` when the plan has a stage-0 crew, `auto` otherwise.
  - The PM owns both files after that: it checks `approval`, sets `approvedAt`, and updates `status`.
- **design:**
  - A member of a design crew, started by that crew's foreman. A design crew sits in stage 0 or, as a mid-run design slice (section 7), in a later stage.
  - It writes the ADR and the architecture-doc change for each `change` verdict, and names the seams the crew's test-writer must pin with contract tests.

### 4. Extend or change, decided by Opus

For each module the goal touches, the design engineer gives one verdict.

- **extend:** new instances of existing patterns, inside existing modules, behind existing interfaces. Examples: a new route, stage, provider, component or command. This is the default.
- **change:** any of these:
  - a new module or seam;
  - a changed interface or stored data shape;
  - a new external service or dependency;
  - a principle added or broken.

  A `change` verdict must name the existing interface that can't take the work, and why.

The checking engineer reviews the verdicts on its own. If the two disagree, the design engineer gets one round to reconcile. The client is asked only when:

- they still disagree after that round;
- a change breaks a declared principle;
- it adds an external service or recurring cost;
- it changes a stored data shape in a way that's hard to undo.

### 5. Work breakdown on paper, by the leaf test

The design engineer splits the goal once, on paper, along the module map. Agents never start sub-foremen to split further.

1. **Items.** Each item lives in one module, or in one seam the contract tests pin.
2. **Leaf test.** An item stops splitting when all four hold:
   - it owns files no sibling item touches;
   - it has an acceptance test it can run with its own access, and the design engineer runs that command once while planning to prove it;
   - every design decision it needs is in the architecture doc or a stage-0 ADR;
   - it fits one agent's context.

   Split only along the condition that fails.
3. **Floor.** An item with no check that could fail for it alone is too small. It merges into a sibling in the same module.
4. **Crews.** Items group into crews, by module to start with. No two crews may edit the same file.
5. **Stages.**
   - Stage 0 holds the `change` work: ADRs, the architecture-doc change and the contract tests. It merges before any other stage starts.
   - A crew that needs another crew's new interface goes in a later stage, unless a stage-0 contract test pins that interface.
   - Each stage merges before the next starts.
6. **Parallelism.**
   - Every module the goal touches gets its own crew, so they all run in parallel within a stage.
   - Two modules share a crew only when one of them has too little work to clear the floor.
   - The hard rule is files, not modules: no two crews edit the same file. A large module can be split across crews when its parts own disjoint files. That's the design engineer's call, made when one crew couldn't hold the whole module's work.
   - A shared file inside a module (an index, registry or route table) goes to exactly one crew. Alternatively, stage 0 adds an extension point so each crew adds its own file instead.
   - When the parts are small enough for one foreman to coordinate, keep one crew and run its members in parallel instead. A second crew adds a foreman, a QC engineer and a rebase-and-re-qc at merge.
   - When a stage has more crews ready to run than `maxParallelCrews` allows (default 4, set in `.claude/truss.json`), the extra crews queue within the stage and start as running ones merge.
   - The plan shows the queue order.
7. **Allowance.** The plan gives an estimated agent count per crew and a total. A plan over the cap (default 40 agents, set in `.claude/truss.json` as `agentCap`) is re-planned with fewer, larger crews or more stages before anyone sees it.

   *Note, 2026-10-28:* the cap is retired in foundry 0.7.0. It had no real basis, `maxParallelCrews` already limits load, and in run 4 it was raised twice and never caught the one overrun (an unbounded stress-test loop). The plan still gives `estAgents` per crew and a total, as information for the PM. `agentCap` is deprecated and ignored; the schemas still accept it. The `agentCap` lines in the plan examples in sections 1 and 8 are history.
8. **Foremen split members by the same leaf test** and never re-split the design. Work that doesn't fit goes to the PM as `PROPOSAL:`.

### 6. Approval only when the design changes

- **Extend-only run, no stage 0:**
  - The design engineer's draft has `approval: "auto"`. The PM logs the plan, overwrites `approvedAt` with its own log time, and starts the crews without asking.
  - Merge mode and target come from `.claude/truss.json`. Without them, the merge mode is `sequential` and the target is the current branch. The PM logs which it used.
  - The client sees the plan in the end-of-run report.
- **Run with a stage 0:**
  - The design engineer's draft has `approval: "client"` and `approvedAt` null. The PM shows the plan table with the ADRs and asks for the merge mode and target as in 0.2.1.
  - It sets `approvedAt` when the client approves.
  - Later stages start as earlier ones merge, with no further pause.
  - `approvedAt` is null only while a run waits for the client.
- **Questions still reach the client** through the checking engineer's escalation rules in either case: a stage doesn't make the run silent.

### 7. Conformance

- The QC engineer adds one rubric question: does the diff conform to the architecture doc's principles and module map, and to this run's ADRs? A violation that doesn't affect the acceptance test is a QUESTION. One that breaks a declared principle is a FAIL.
- Crews never edit the architecture doc or ADRs. A needed design change goes to the PM as `PROPOSAL:`.
- **Mid-run design slice:** when the PM takes up a design proposal, it handles it like this.
  - It adds a design crew (`verdict: "design"`) to the earliest stage whose crews it doesn't depend on, first in that stage's queue and ahead of the crews that need it. A running crew isn't moved. (Amended 2026-10-29 to match `skills/run/SKILL.md:278`: a new stage after the last would deadlock when a running crew needs the slice.)
  - It moves only the crews that depend on the slice, and haven't started, one stage later. Running crews and crews that don't depend on it keep their stage.
  - The run-level `approval` and `approvedAt` don't change.
  - The slice waits for the client only when one of section 4's triggers applies. Then the PM sets the crew's `clientApproval` to `"pending"`, and to `"approved"` when the client answers.
  - Otherwise the slice starts like any crew.

### 8. The plan file contract

`plan.json` is the seam between the design engineer, the PM and the hooks:

```json
{
  "version": 1,
  "goal": "…",
  "architecture": "docs/architecture.md",
  "approval": "auto | client",
  "approvedAt": "ISO time or null",
  "agentCap": 40,
  "maxParallelCrews": 4,
  "crews": [
    {
      "slug": "auth",
      "stage": 0,
      "verdict": "extend | change | design",
      "modules": ["auth"],
      "owns": ["src/auth/**"],
      "acceptanceTest": "pnpm test -- auth",
      "acceptanceTestProved": true,
      "estAgents": 6,
      "clientApproval": "pending | approved (optional; mid-run design slices only)",
      "status": "planned | running | merged | dropped"
    }
  ]
}
```

- `verdict` describes a crew:
  - `design` is a crew that writes ADRs and contract tests;
  - `change` is a build crew whose module's design changed, so it runs after the design crew;
  - `extend` is a build crew working inside the existing design.
- `approval` is set once, at plan time. It's `client` exactly when the plan has a stage-0 crew; mid-run slices never change it.
- Within a stage, the order of the `crews` array is the queue order.
- The agent total is the sum of `estAgents`, so it isn't stored.
- `version` goes up whenever a field is added; the schema allows no other properties.
- The PM updates `status` as crews start and merge.
- The hooks treat the file as read-only.

### 9. Hooks

- **Stage gate:** an Agent call starting a `truss:foreman` whose slug is in `plan.json` is refused while any crew in an earlier stage isn't `merged` or `dropped`. Reason: `stage <n> isn't merged yet: <slugs>`.
- **Parallel cap:** starting a foreman is also refused while `maxParallelCrews` crews are already `running`. Reason: `<running> crews running, the cap is <cap>; start <slug> when one merges`.
- **Approval gate, run level:** when `approval` is `client` and `approvedAt` is null, starting any foreman in the plan is refused. Reason: `this run changes the design; get the client's approval first`.
- **Approval gate, crew level:** a crew whose `clientApproval` is `pending` is refused on its own. Reason: `<slug> waits for the client's approval`.
- **No plan file, or a slug not in it:** no gate. 0.2.1 runs keep working.
- **`/truss`** shows each crew's stage, verdict and status from `plan.json`, then the 0.2.1 member lines.
- **Failure:** the hooks fail open, like every other Truss hook.

## Consequences

- Design changes become visible and rare: the default is extend, and a change costs a stage and, sometimes, the client's attention.
- Extend-only runs need no human input before the end-of-run report.
- Planning costs one design engineer pass, plus a checking engineer review per run. That's cheaper than one gateway-style rework loop.
- `init` is now the first part of the old run 2. The kit-manifest extension work (role mapping, port slices, deploy target, prompt overrides) and `truss retro` stay in run 2.
- Risk: the design engineer over-calls `change`. Mitigation: the default and the rule that a change must name the interface that can't take the work. `retro` will measure it later.
- Risk: the hooks trust the PM's `status` field. A PM that marks a crew merged too early defeats the stage gate. The gate guards against forgetting, not against lying. The QC-gated merge is still the real control.
