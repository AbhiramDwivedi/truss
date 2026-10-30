# Truss

Intelligence, engineered together.

![Truss: the PM as the top chord, crews as panels led by foremen, the design engineer and QC engineer as the abutments](docs/truss.svg)

Specialized agents, like structural members, work together and share responsibilities. No single member needs to do everything. A bridge truss carries its load the same way: each member takes one kind of force, and the joints pass the rest along.

Truss is a Claude Code plugin that runs a large coding goal the way a small engineering team would: a design engineer plans it, crews build it in parallel, and an independent reviewer signs off before anything merges.

One Claude Code session handles a task that fits in its head. Give it something bigger, such as a feature across several modules, a refactor or a new subsystem, and the same things go wrong. The context fills and compaction drops details. The agent grades its own work. Tests get written to fit the code. Parallel agents edit the same files, and extras nobody asked for creep in.

Truss splits the goal into crews. Each crew owns its files and works in its own git worktree, and test-writers go before builders. A read-only QC engineer that never saw the builder's reasoning must rule PASS on proof, such as test output, before a crew's branch merges. Your main session becomes the PM (project manager): it plans, decides and merges, writes no feature code, and is the only agent that talks to you. You're asked about scope, deploys and pushes, not trivia.

```
claude plugin marketplace add AbhiramDwivedi/claude-ops
claude plugin install truss@claude-ops
```

Then run `/truss:run <goal>`. The first run writes your project's architecture doc if it has none. The [kit](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/kit) and [worktrees](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/worktrees) plugins are optional companions and still come from claude-ops.

## Why use it

Each row is a failure that shows up on long agent work, and the part of Truss that stops it.

| Problem | In plain Claude Code | How Truss handles it |
| --- | --- | --- |
| Context runs out | One session holds everything; compaction drops details mid-task. | Each crew starts with a fresh context sized to one job. Run state lives on disk (`plan.json`, goal files, `decisions.md`), so it survives compaction. |
| The agent grades its own work | The same model writes the code and declares it done. | A read-only QC engineer that never built the work rules on it. A hook blocks the merge without a `PASS`. |
| Tests fit the code, not the goal | Tests are written after the code, from the code. | Tests come first, from the brief, and must fail before the build starts. The builder can't touch them. |
| Parallel agents collide | Two agents edit one file, or one agent's half-finished work breaks another's. | One worktree per crew, file ownership declared in the plan, and gates that refuse overlaps. |
| Scope creep | The agent adds "helpful" extras nobody asked for. | Every brief cites the decisions it implements. The QC engineer flags anything else as outside approved scope, and extras go through a proposal first. |
| Too many questions, or too few | You're interrupted for trivia, or a big call is made silently. | A checking engineer answers or defers most questions. You hear about scope changes, deploys, pushes and real blockers. |
| The design drifts | Each change makes local sense and the architecture erodes. | The design engineer plans against your architecture doc. A `change` verdict names the interface that breaks and gets an ADR before anyone builds on it. |
| Review never ends | Review loops keep finding new nits in the last fix. | One stress-test round. A `DEFECT` is fixed, a `GAP` is deferred, and a rework allowance caps retries. |
| Wrong model, wrong bill | Subagents inherit the main model, often the costliest. | Every spawn names its model and effort, or the hooks refuse it. Sonnet writes code; Opus plans and does QC. |
| New asks mid-run | A new request derails the plan or gets lost. | The design engineer amends the running plan with a new goal, and its crews join without stopping the others. |
| No memory of what went wrong | Every session starts from zero. | Hooks log spawns, stalls and reports to `events.jsonl`, and `/truss:retro` turns the counts into config changes. |

## Built on what works in the field

Truss's rules come from practice, not theory: Anthropic's Claude Code guidance, posts from the people who build it, and an outside review of those practices. The [workflow-audit](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/workflow-audit) plugin keeps them, with sources, in [catalog/practices.json](https://github.com/AbhiramDwivedi/claude-ops/blob/main/plugins/workflow-audit/catalog/practices.json). Truss writes them into its prompts and, where a hook can see the rule, enforces them:

| Practice | Where Truss applies it |
| --- | --- |
| Give the agent a runnable check, and demand output as evidence, not a claim | Every crew has an acceptance test the design engineer proves once; every report carries command output; the QC engineer rules on that proof. |
| Have a fresh agent review long unattended work | The QC engineer is a new agent that never saw the build. |
| State the scope and forbid unasked-for work | Briefs quote the approved decisions; the QC engineer flags anything outside them. |
| Long contexts get less reliable; start fresh rather than correct a third time | Every task gets a fresh agent, never a resume. After two failed fixes, an Opus agent finds the root cause and a new builder starts from it. |
| Set the model on every subagent; Sonnet for most coding, Opus for reasoning | The hooks refuse a spawn with no model or effort. Sonnet builds; Opus plans and does QC. |
| Match effort to the task; high effort isn't the default | QC engineers, stress tests and writers run at `medium`; `high` needs your explicit call. |
| Run parallel work in separate worktrees | One worktree per crew, with file ownership declared in the plan. |
| Multi-agent work costs many times a chat; save it for work that splits | Small jobs run as crews with no foreman and no stress test; [What it costs](#what-it-costs) says when to skip Truss. |
| Put must-always rules in hooks; prompts are only advice | The merge gate, plan gates, model checks and rework allowance are hooks. |

## How work moves

```mermaid
flowchart LR
  client([Client]) --> PM[PM]
  PM <-.->|questions| checker[Checking engineer]
  PM --> arch[Design engineer<br/>plan, stages]
  arch --> a[Crew A<br/>tests, build] --> ja{QC engineer}
  arch --> b[Crew B<br/>tests, build] --> jb{QC engineer}
  arch --> c[Crew C<br/>tests, build] --> jc{QC engineer}
  ja -->|PASS| main[(main)]
  jb -->|PASS| main
  jc -->|PASS| main
  client -.->|new ask mid-run| PM
  arch -.->|plan amended| d[Crew D<br/>tests, build]
  d -.-> jd{QC engineer} -.->|PASS| main
```

Crews run side by side, each in its own worktree, and each must pass its QC engineer before it merges. Merges into the target land one at a time. A new ask partway through becomes a new goal in the same plan: its crew (dashed) joins while the others keep going.

## Who calls whom

Each role is started by the one above it.

- **Client**: you. You set the goal and rule on scope changes, production deploys and pushes.
  - **PM** (main session): plans the run, logs every decision and merges what passes.
    - **Design engineer** (Opus): drafts the plan against your architecture doc and ADRs, and amends it when new work arrives.
    - **Checking engineer** (Opus, read-only): sees every question before you do and recommends answer, defer or pass.
    - **Foreman** (one per crew): splits the crew's work into member tasks and merges the members' branches.
      - **Members** (Sonnet): test-writer first, then builder, writer, commissioning engineer.
      - **QC engineer** (Opus, read-only): rules PASS or FAIL from proof, never from the builder's reasoning.
      - **Stress test** (Opus): tries once to break high-impact work in a throwaway worktree.

A crew of one or two members can run with no foreman and no stress test. [Roles](#roles) has the full table.

## A run at a glance

1. **Client brief.** The PM asks whether the goal is the end or a step toward something bigger, then records numbered requirements (`R-1`, `R-2`…) that every crew traces back to.
2. **Plan.** The design engineer gives each module a verdict, `extend` if the design already fits or `change` if an interface must move, splits the work into crews and stages, and runs each crew's acceptance test once to prove it.
3. **Approve, only if needed.** A plan that only extends the design starts on its own. It waits for you when it changes the design or another client trigger applies.
4. **Build.** Each crew owns its files and works in its own worktree. Test-writers go first; their tests must fail before the builder starts.
5. **QC engineer.** The QC engineer reads the diff, the approved scope quoted word for word, and the acceptance test output, and writes `VERDICT: PASS` or `FAIL`. High-impact work gets one stress-test round first.
6. **Merge.** The PM merges one crew at a time and checks that the merged diff is the one the QC engineer passed.
7. **Retro.** `/truss:retro` counts stalls, rejections, overruled recommendations and spawns by model, and proposes changes to your Truss config.

[How a run goes](#how-a-run-goes) has every step in detail.

## What it costs

A crew is several agents and a QC engineer, so a small fix costs more and takes longer than doing it yourself. For a one-line fix, use plain Claude Code. Truss pays off when the goal spans several modules, or when you want proof, not a model's word, that the work is done.

The tests prove the rules are written into the prompts and enforced by hooks where hooks can see them, not that every agent always follows them. That is why the QC engineer reads proof and the retro counts what actually happened. [Limitations](#limitations) lists what hasn't been seen in a live run.

## Learn more

- [docs/architecture.md](docs/architecture.md): who talks to whom, the files on disk, each hook, and how a run recovers from failures.
- [docs/adr/](docs/adr/): one record per design decision, from the 0.3.0 design phase ([ADR-0001](docs/adr/0001-design-phase.md)) to mid-run intake ([ADR-0010](docs/adr/0010-mid-run-intake.md)).
- [CHANGELOG.md](CHANGELOG.md): what changed in each version.

## The client brief

After you pick the goal's altitude, the PM runs the `truss:brief` skill. It is the only part of Truss that asks you questions, and it asks only what the repo can't answer: the recommended answer comes first, so "yes" accepts it. The answers become numbered, checkable requirements in `docs/requirements.md` (next to the architecture doc), which is committed on the target branch before any crew starts. Truss is seeded and adapts to the needs the client brief finds in your task, not to a fixed list.

- **It is committed in the repo, scrubbed.** `docs/requirements.md` holds no names, emails, user paths or private infrastructure; the client brief says so when it asks about hosting or integrations, and records those by type.
- **The design engineer and crews trace to it.** The plan table has a `Requirements` column, and `plan.md` lists any R-id no crew serves under `Unserved:`. Each goal file has a `## Requirements` section, checked with `brief/cli.ts trace`. At the end of the run the PM marks the requirements it met.
- **Stopping early fills defaults.** Each question you didn't answer becomes a requirement with `Source: default`, and the start message lists them as `Defaults filled: R-<n> (<branch id>), ...`. The plan shows them to you.
- **Greenfield repos.** With no code, the PM runs the client brief first, then runs `truss:init` with a `Greenfield: <repo>/docs/requirements.md` line. The design engineer lists planned modules, each citing the R-ids it serves.

## Workflow engine

When the session has the Workflow tool, the PM plans and builds with scripts instead of long agent conversations. Crews with a `commissioning-engineer` member, or a member you raised to `high` or `xhigh` effort, stay on the foreman path, and so does every crew in a `single`-mode run. Workflow is the default; you don't need to opt in. Without Workflow, or when you opt out, the PM passes `--no-workflow` and every crew uses the foreman path described below.

- **Plan.** The PM writes the brief to `plan-brief.md`, runs `plan-args`, then `Workflow(plan.js)`: the design engineer, then a checking engineer review of the verdicts. `plan-write` saves the plan and `plan-check` validates it; a failed check resumes once.
- **Build.** `start` picks the next stage, makes each crew's worktree and returns the crews; the PM runs `Workflow(stage.js)`, which takes each crew through the acceptance test red, a split into member tasks, the members, the green check, an optional single stress-test round, the scope check and the QC engineer. Then `finish --transcript <T> --result <file>` records the run and merges: it is the merge gate for these crews.
- **Restart.** A stopped crew restarts with `start --resume answers`, a crew sent back for a conflict or a changed patch with `--resume merge-ready`, and a crew whose run died with `--resume stale`.

The CLI is `bin/factory.ts`; the scripts are `workflows/plan.js` and `workflows/stage.js`, and `workflows/roles.json` holds every script agent's type, model and effort. Design: [ADR-0009](docs/adr/0009-workflow-factory.md).

## Roles

| Role | Who | What it does |
| --- | --- | --- |
| Client | You | Picks the goal's altitude. Answers the client brief about the goal. Approves a plan that changes the design. Rules on changes to frozen scope, on production deploys, and on every push or PR. |
| PM | The main session, after `/truss:run` | Has the design engineer draft the plan, decides on it as product owner, and logs every decision. Starts the foremen, answers them, and merges what the crews deliver. Never does a crew's work or the design. |
| Design engineer | `truss:design-engineer`, Opus, effort `medium` | Loads the principle packs the work touches. Edits only the architecture doc, the ADRs and `.claude/truss.json` (in `init` mode); never source or tests, and never check code. In `plan` mode it hands `plan.json` and `plan.md` back and Truss's hook writes them. In `init` mode it writes the architecture doc. In `plan` mode, outside every crew, it drafts the run's verdicts and work breakdown. In `design` mode, as a member of a design crew, it writes the ADR and the doc change for each `change` verdict and names the seams to pin with contract tests. In `init` and `design` mode it draws mermaid diagrams: a context or container `flowchart`, and a `sequenceDiagram` for a flow across modules, each with at most about 12 nodes, a caption and the source files it traces to. |
| Checking engineer | `truss:checking-engineer`, Opus, effort `medium`, outside every crew | Read-only. Reviews each of the design engineer's verdicts on its own. For each question, proposal or blocker bound for you, recommends `answer`, `defer` or `pass`. Before the merge, checks the crews for drift from the plan and for overlap. It recommends; the PM decides. |
| Foreman | `truss:foreman`, Opus, one per crew | Splits the crew's goal into member tasks, delegates them, merges the members' branches into the crew branch, runs the checks and reports. |
| Members | Your project's agents, plugin agents, or `general-purpose` | Do the building. Each starts with an explicit model and effort and a name that starts with its crew's. |
| QC engineer | `truss:qc-engineer`, Opus | Never the builder. Checks the proof in the crew's reports, answers a five-question rubric, and reports `VERDICT: PASS` or `VERDICT: FAIL`. Runs at effort `medium`, whatever its builder runs at; `high` and `xhigh` only on your explicit call. In stress-test mode it tries to break the crew's work instead. |
| Writer | `truss:writer`, Opus | A member for the prose a crew ships. Loads the skill `writingSkill` names when the session lists it, else the best writing skill the session has (`technical-writer` when it's installed), and writes only what the code, a command it ran, or a page it fetched shows. |
| Commissioning engineer | `truss:commissioning-engineer`, Sonnet | A member that validates a deploy with proof: rollout status, health endpoint, smoke tests, logs. May deploy a preview or staging build. Never deploys to production or changes it. Takes the target and command from the `deploy` key when it's set, and asks its foreman otherwise. |

Truss works with or without agents of your own. When the project defines none that fit, members run as `general-purpose` with a prompt the foreman writes, which says what the job is rather than who the agent is. The [kit](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/kit) plugin's `builder`, `test-writer`, `reviewer` and `scout` make good members, and the `roles` key can map jobs to them. The [worktrees](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/worktrees) plugin starts each worktree from your current commit instead of `origin/HEAD`, and gives no worktree to the agent types kit's manifest declares read-only. Truss init declares the QC engineer and the checking engineer read-only, because their tools are only `Read, Grep, Glob, Bash`. kit is optional: without it, QC engineers and checking engineers still get worktrees unless you set worktrees' `noIsolateAgents`.

The principle packs ship as the `truss:principles` skill, one pack per domain: `core` (applied to every project), `service`, `frontend`, `data`, `ai`, `infra` and `library`. Each rule can be checked against a diff and comes with a one-line test, such as "a module imports another only through its index". The design engineer picks the packs and adapts them into the architecture doc's principles, giving a reason for each rule it drops.

## Set up the project

Run `/truss:init` once per project. A run does it for you when the architecture doc is missing.

1. It reads `.claude/truss.json` at the repo root. If the `architecture` key names a file that exists, it tells you where the doc is.
2. Otherwise it starts the design engineer in `init` mode. The design engineer writes the doc's principles, its module map (each module, the paths it owns, what it does and its seams) and an ADR for each decision already visible in the code. It extends an architecture doc the repo already has; with none, the doc goes to `docs/architecture.md` and the ADRs to `docs/adr/`. It writes `.claude/truss.json` with the `architecture` and `adr` keys.
3. After the doc check, it reads kit's manifest, `.claude/kit/manifest.json`:

   | What init finds | What it does |
   | --- | --- |
   | A valid manifest at `version` 1 that marks `truss:qc-engineer` and `truss:checking-engineer` read-only | Uses it, and says nothing about kit. |
   | A valid manifest without those declarations, and `kit:init` in the session's skills | Runs `kit:init` with the args `declare read-only: truss:qc-engineer, truss:checking-engineer`. kit shows you the declaration and writes it when you approve. |
   | No manifest, and `kit:init` in the session's skills | Says `no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)` and carries on. It never sets kit up for you. |
   | No manifest, or one without the declarations, and no `kit:init` | Says `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)` and carries on. |
   | A manifest that isn't JSON, fails kit's schema or has another `version` | Says `kit manifest unreadable, carrying on without it: <reason>` and carries on as if there were none. It doesn't rerun `kit:init` over it. |

4. It proposes the 0.4.0 keys (`roles`, `deploy`, `writingSkill`, `promptOverrides`) from the manifest and the repo: `roles` from the manifest's agents, such as `build: kit:builder` and `test: kit:test-writer`, and `deploy` from what the repo shows, only when the file has none. It writes only the keys you approve, and keeps every key and value already in the file. Before it writes, it validates the result against [docs/truss-config.schema.json](docs/truss-config.schema.json). An error in a key it would add stops the write and leaves the file as it was. An error in a value you wrote is reported by its path (for example `/merge: must be equal to one of the allowed values`) and left alone, because init never rewrites or "fixes" what you wrote.
5. It shows you what it wrote and stops. It doesn't commit. Commit the files before a run: crews work in worktrees, which see only committed files.

Every key but `architecture` and `adr` is optional, and leaving a 0.4.0 key out keeps 0.3.0 behaviour. You can set any of them by hand:

| Key | Default | What it sets |
| --- | --- | --- |
| `architecture` | `docs/architecture.md` | Path of the architecture doc. |
| `adr` | `docs/adr` | Directory of the ADRs. |
| `maxParallelCrews` | `4` | The most crews running at once within a stage. |
| `merge` | `sequential` | Merge mode of every run; the PM never asks. `single` also puts every crew on the foreman path. |
| `target` | the current branch | Target branch of every run; the PM never asks. |
| `roles` | picked from the session's agent types, as in 0.3.0 | Which agent type does each job: `build`, `test`, `review`, `search`, `docs` or `deploy`, mapped to a full type such as `kit:builder`. The PM uses a listed type when the session can start it. The QC engineer, checking engineer, foreman and design engineer are always Truss's own and can't be mapped. |
| `deploy` | none: commissioning engineer asks its foreman | `{"target", "command", "production"}`, all three required. A deploy to a target with `production: true` goes to you first, whatever else is set. |
| `writingSkill` | none | A skill the writer loads before it writes, such as `technical-writer`. Used only when the session lists it; otherwise the writer says so and carries on. |
| `promptOverrides` | none | Per role (`foreman`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`), a file directly under `.claude/truss/prompts/`, such as `.claude/truss/prompts/qc-engineer.md`. |

The skills read the file the same way, report each problem to you once, and never treat one as fatal. They ignore a key the schema doesn't declare and treat a rejected value as unset, so its default applies. A bad entry in `roles` or `promptOverrides` unsets only that entry. `deploy` fails closed: any error at or inside it, an undeclared key included, unsets the whole key, and a missing or non-boolean `production` is never read as `false`.

A prompt override names a file you write and commit, and `.claude/truss.json` never holds prompt text. The file adds to the role's prompt and never replaces it. The PM writes a `Prompt overrides:` line in each goal file, each foreman passes the right file into its QC engineer, writer and commissioning engineer briefs, and the PM does the same for the checking engineer and the design engineer. Each brief says the role's report format and the hooks' rules still hold. A missing file is reported and skipped.

## How a run goes

`/truss:run` loads the PM's protocol. The PM:

0. checks for the architecture doc. When it's missing, the PM runs the `truss:init` skill, then asks whether to go on. It reads `.claude/truss.json`, and asks you to commit the doc, its ADRs or that file if they have uncommitted changes;
1. asks you once whether the goal is the end or one step toward a bigger outcome, and describes the bigger version. You pick one. Then it runs the `truss:brief` skill (see "The client brief" below);
2. runs a short depth pass: what a top practitioner would do that wasn't asked for, what the rawest material is, which tools that practitioner would use, and what besides a model verifies the result. The answers go into the design engineer's brief;
3. lists the agent types the session can start (your project's `.claude/agents/*.md`, yours in `~/.claude/agents/`, plugin agents) and the project's skills, and takes the agent type for each job from `roles` where it's set;
4. starts the design engineer in `plan` mode. The design engineer gives each module the goal touches one verdict. `extend`, the default, means new instances of existing patterns behind existing interfaces, such as a new route, provider or command. `change` means a new module or seam, a changed interface or stored data shape, a new external service or dependency, or a principle added or broken; it must name the existing interface that can't take the work, and why. The design engineer then splits the work along the module map into crews and stages, runs each crew's acceptance test once to prove it, estimates agents per crew, and writes a draft `plan.json` with a readable `plan.md`. Truss doesn't invent port ranges: when the repo has a `.claude/worktree-setup.*` script, a crew's ports are its worktree slot (`PORT_BASE` to `PORT_BASE+9`), and without one the crew gets no ports and raises a `QUESTION:` if it needs one. The PM sends the draft back if two crews own one file, an acceptance test can be gamed or wasn't proved;
5. has a checking engineer review each verdict on its own. If they disagree, the design engineer gets one round to reconcile. You are asked only when they still disagree, a change breaks a declared principle, adds an external service or a recurring cost, or changes a stored data shape in a way that's hard to undo;
6. gets the plan approved. The design engineer's draft sets `approval`: `"client"` when the plan has a stage-0 crew, `"auto"` otherwise. In an extend-only run (no stage 0) the PM takes the merge mode and target from `.claude/truss.json` (else `sequential` and the current branch), logs them and starts without asking; you see the plan in the end-of-run report. A run with a stage 0 has `approval: "client"`: the PM shows you the plan table with the ADRs and shows the merge mode and target branch as information, without asking. Either way it shows each crew's estimated agents, their total and the queue order. Scope grows here, once, and freezes when the PM sets `approvedAt`;
7. writes a goal file for each crew and starts the crews stage by stage (a crew runs as a Workflow script or under a foreman; see "Workflow engine" below), in the background, each in its own worktree. Stage 0 holds the `change` work (ADRs, the architecture-doc change, the contract tests) and merges before any other stage starts. Within a stage the crews start in plan order, up to `maxParallelCrews` at once; the rest queue and start as running crews merge. The next stage starts, without a pause, once every crew in the earlier stages is `merged` or `dropped`;
8. handles the foremen's messages, each tagged `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. It decides what it can and logs it. Anything bound for you goes through a checking engineer first, and a `PROPOSAL:` defaults to no because the scope is frozen;
9. merges each crew once its newest QC file modified at or after `approvedAt` passes the merge gate: `VERDICT: PASS`, no `UNSCOPED` line, and a `Head: ` line equal to the crew branch's head or a `Patch: ` line equal to its patch id with the foreman's checks re-run green. It then sets the crew's `status` to `merged` in `plan.json`, and starts the next queued crew or stage;
10. reports to you, and asks before every push and every PR.

`plan.json` is the contract between the design engineer, the PM and the hooks. The design engineer drafts it and hands it back, and Truss's hook writes it with `approvedAt: null`; after that the PM owns it and sets `approvedAt` and each crew's `status` (`planned`, `running`, `merged` or `dropped`). Each crew's `verdict` is `design` (writes ADRs and contract tests), `change` (builds in a module whose design changed, after the design crew) or `extend` (builds inside the existing design). [docs/plan.schema.json](docs/plan.schema.json) is its schema.

A design change can also come up mid-run, as a foreman's `PROPOSAL:`. When the PM takes one up, it adds a design crew to the earliest stage that hasn't started and moves one stage later only the unstarted crews that depend on it. The run's approval doesn't change. The slice waits for you only when one of the triggers in step 5 applies; the PM then sets the crew's `clientApproval` to `pending`, and to `approved` when you answer.

You can also add a goal after the run has started. Ask the PM for work no crew covers and it takes the request as a new goal in the same run, without a new session: a plan design engineer in `amend` mode drafts the goal's crews, a checking engineer reviews them, and the PM adds them to `plan.json` under `goals`. Running crews continue. The goal waits for your approval only when one of the step 5 triggers applies; otherwise its crews start as soon as the cap allows. Each goal has its own stages, all goals share `maxParallelCrews`, and the PM tags its decision lines for the goal with `[<id>]`.

The PM logs its decisions in `decisions.md`, in the session's Truss folder. From 0.4.0 the log has a grammar, so `/truss:retro` can count it. Each run opens with a `## Run <start> | <goal>` heading, where the start is an RFC 3339 time from `date -u +%Y-%m-%dT%H:%M:%SZ`. A decision is `- HH:MM | <decision> | <reason> | <checker> | <outcome>`, and a checking engineer's advice is `- HH:MM | checker-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>`. The outcome is `followed`, `followed (deferred)` or `overruled: <reason>`.

The PM follows the checking engineer's recommendation by default. To overrule it, the PM logs a one-line reason, and every overrule appears in the end-of-run report. The PM clears a `BLOCKED:` itself when it can inside frozen scope, for example from the plan, the decision log or something it knows: a missing input, a collision with another crew. Every other `BLOCKED:` reaches you, and none is ever deferred. A production promotion, a change to frozen scope, and every push or PR reach you whatever the checking engineer recommends, unless the project grants the PM merge ownership for pushes and PRs.

## Inside a crew

A foreman first proves it can run its crew's checks in its own worktree. If it can't, it sends `BLOCKED:` before splitting any work. It then runs its own, fuller depth pass and turns the answers into member tasks. Anything that would add scope goes to the PM as a `PROPOSAL:`.

The foreman splits its crew's goal by the leaf test the design engineer used for crews. A task stops splitting when it owns files no sibling task touches, has an acceptance test its member can run with its own access, needs no design decision outside the architecture doc and the stage-0 ADRs, and fits one agent's context. A task with no check that could fail for it alone is too small and merges into a sibling. The foreman never re-splits the design and never starts a sub-foreman. Crews never edit the architecture doc or the ADRs: work that doesn't fit, and any design decision the doc doesn't hold, go to the PM as a `PROPOSAL:`. The exception is a design crew, whose foreman starts the design engineer in `design` mode and then a test-writer to pin the seams it names.

Every member report carries proof: a command and its output, before-and-after numbers, or a walk through the real flow. These don't count as proof: tests the builder wrote after building, "I verified it" with no output, a typecheck alone, a mocked end-to-end test, and output from another commit. Builders may not edit the acceptance test tests. Every commit carries a `Truss-Crew: <slug>` trailer and a `Truss-Role: <role>` trailer (`test-writer`, `builder`, `writer`, `commissioning`, `stress`, `designer`). The QC engineer uses the role to check that no `builder` commit touched the acceptance test tests; one that did fails the crew. A file changed outside the crew's ownership goes to the PM as a `QUESTION:` (extend the ownership, or revert), not a FAIL by itself.

After the last merge and a green run of the checks, the foreman starts a fresh QC engineer. The QC engineer's fifth rubric question asks whether the diff conforms to the architecture doc's principles and module map and to the run's ADRs. A departure that doesn't affect the acceptance test is a `QUESTION:` for the PM; one that breaks a declared principle is a FAIL. A project with no architecture doc doesn't fail on it. For a crew with high-impact paths, the plan can add a stress test first: `truss:qc-engineer` in stress-test mode, which works in its own worktree, first resets it to the crew head SHA with `git reset --hard <sha>`, proves each break with a command and its output, and leaves the worktree clean before it reports. A reproduced break is fixed, and a fresh stress test runs before the QC engineer does.

Builders and test-writers run on Sonnet; no Opus member writes code. When a Sonnet builder's two fix attempts end with the same check failing, the foreman has an Opus agent at effort `medium` find the root cause with evidence, writing no code, then starts a fresh Sonnet builder with that analysis. If that builder fails twice on the same check, the foreman sends `BLOCKED:`. Each step is a fresh agent, never a resume.

The foreman's final report has fixed sections: Summary, Branch, Changes, Proof, Checks run, Open questions. A report that starts with `CHECKPOINT:` means the foreman stopped with work left, and the PM starts a successor foreman, `<slug>-2`, from it.

## Merge modes

| Mode | What happens | Use it when |
| --- | --- | --- |
| `sequential` | Crews land on the target one at a time. The PM asks each foreman in turn to merge the target into its crew branch with `git merge <target>` (never a rebase or a cherry-pick), resolve the conflicts and run the checks. If the merge moved the head and changed the patch id, or the checks fail, a fresh QC engineer rules on it. On a PASS for that head, the PM fast-forwards the target to it. | You want one reviewable merge per crew. |
| `single` | One integrator agent (Opus, in a worktree) merges every crew branch into one integration branch, `truss-<short goal>`, resolves the conflicts and runs the checks. An integration QC engineer rules on the result. You get one PR. | Each merge to the target triggers something expensive, such as a deploy. |

Conflicts are always resolved by an agent, never in the main thread. With more than one stage, `single` mode integrates stage by stage: each stage's crews merge into the integration branch and pass an integration QC engineer before the next stage's foremen start from that branch.

## The end-of-run report

Before anything leaves the machine, the PM reports each crew's summary and what merged where, the checks and every QC engineer's verdict, the decisions it made and every checking engineer overrule with its reason, and the items the end-of-run sweep kept (a checking engineer drops the rest). It lists the high-impact files that changed and asks you to read those, and only those.

## What the hooks do

A crew is a `truss:foreman` started by the main thread, plus every agent below it, however deep. An agent goes by the name it was spawned with, else its id, and the crew by its foreman's. Agents outside every crew are left alone, which includes the checking engineer, the integrator and the integration QC engineer.

- **Reports are saved.** When a crew agent stops, its last message is written to `<git common dir>/truss/<session id>/reports/<crew>/<agent name>.md`. A report sent through the hand-back tool is saved instead. Outside git the folder is `~/.claude/truss/<session id>/`. The git common dir is the main checkout's `.git`, so every worktree writes to the same place. Hand-backs from nested agents have been lost on some machines; the foreman and the PM read the file when one doesn't arrive. Each Agent call that starts a foreman or a crew member gets a `[truss]` note naming the path, and the main session gets a `[truss] dir: <path>` note at session start. A foreman's interim stop (members still at work, or a tagged message to `main` unanswered) is saved as `<agent name>.interim.md` and leaves the report, the crew's status and its idle clock alone. A QC engineer's follow-up after its verdict goes to the interim file too, so the verdict stays. A stop the gate sends back is saved nowhere.
- **Empty hand-backs are refused.** A crew agent's hand-back under 40 characters, or one that is only `placeholder`, `todo` or `tbd`, is refused with a reason asking for the real report. One that starts `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` may be short, but not empty after its tag.
- **Crew messages follow the chain.** A member's `SendMessage` may go to its own foreman and the other members of its crew. A foreman's may go to `main`, its own members and the other foremen. Anything else from inside a crew is refused, with a reason telling a member to go through its foreman and a foreman to message the other crew's foreman. So is an address no agent of the session has had, and a name two live agents in different crews share.
- **Foreman-to-foreman messages are logged** to `<truss folder>/messages.jsonl` as `{ ts, from, to, summary }`. Once the log passes 3 MiB it moves to `messages.<n>.jsonl`, the first free number, and a new log starts.
- **Foremen start by the plan.** When `plan.json` lists a foreman's slug, an Agent call starting that `truss:foreman` is refused while a crew in an earlier stage isn't `merged` or `dropped` (`stage <n> isn't merged yet: <slugs>`), while `maxParallelCrews` crews are already `running`, while a run with `approval: "client"` has no `approvedAt` (`this run changes the design; get the client's approval first`), and while the crew's own `clientApproval` is `pending` (`<slug> waits for the client's approval`). With no `plan.json`, or a slug not in it, there is no gate, so 0.2.1 runs work as before. The hooks only read `plan.json`.
- **Crew agents set a model and an effort.** An Agent call from inside a crew without `model`, without `effort`, or with `effort: "max"` is refused, with a reason saying what to set.
- **A foreman can't stop without a report.** When a foreman with no live members and no members' background tasks running stops on a message that has no `## Proof` section and doesn't start with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, the stop is sent back with a reason. The hook sends a stop back at most twice in a row, then lets it through. That bound relies on Claude Code sending `stop_hook_active` on the stop after a block, which hasn't been seen live; Claude Code itself lets a stop through after 8 consecutive blocks. A stop while a member, or a member's background task, still runs goes through; the foreman's own background tasks don't count. A stop while the foreman's `QUESTION:`, `BLOCKED:` or `PROPOSAL:` message to `main` is unanswered goes through too: it asked once, and needs no tagged hand-back as well.
- **Stalls wake the PM.** Every minute the plugin checks for running crew agents with no tool call or model request for 15 minutes. It reports each one once, with a toast and a `[truss] stalled:` prompt to the main session. An agent that starts running again, or comes back into the list, counts as active from that moment, so a resumed agent isn't reported on its old activity.
- **An idle foreman wakes the PM.** A foreman the plugin saw go from running to `idle`, with no final report (a `## Proof` section, `CHECKPOINT:` or `BLOCKED:`) since it last resumed, no waiting tag and no member at work, gets one `[truss] idle foreman:` prompt after 15 minutes, naming the successor to start. The report and tag on disk count too, so after a reload nothing is prompted for until the plugin sees a foreman stop again.
- **A usage-limit reset wakes the PM.** When the five-hour window hits its limit while a foreman is still at work, the plugin sets a timer for two minutes after the reset and then sends a `[truss] limit reset:` prompt, once per reset. If the main session was already active after the reset, the prompt is skipped.
- **Decision times are real.** A Write or Edit of this session's `decisions.md` has the `HH:MM` that opens each new `- HH:MM |` line replaced with the clock's local time. A clock time already on a decision line of the text it replaces (the file for a Write, `old_string` for an Edit) is kept, so an edited line keeps its time. From 0.4.0 a literal `HH:MM` is always stamped, even when the replaced text holds the same line, since it marks no time. Write the log with Write or Edit, not Bash, or the hook doesn't see it.
- **Events are logged** to `<truss folder>/events.jsonl`, one JSON line per event, each with `v`, `ts`, `event`, `crew` and `agent`. A `spawn` line records each Agent call the hooks let through from inside a crew or that starts a foreman, with its `type`, `model`, `effort` and the agent that started it. A `stall` line records each stall and idle-foreman wake, a `tag` line each `QUESTION:`, `BLOCKED:` or `PROPOSAL:` a foreman sends `main`, and a `report` line each final report saved, with its opening marker, such as `VERDICT: PASS`. No line holds message, prompt or report text. At 3 MiB the log moves to `events.<n>.jsonl`, as the message log does. A failed append is logged and changes nothing else. From 0.8.0 a `fetch` line records each web call (see the next section). [docs/events.schema.json](docs/events.schema.json) is its schema.
- **`/truss`** shows each crew's stage, verdict and status from `plan.json` when there is one, then lists the crews: each foreman's name and status, its live members by model, when it last reported and was last active, any stalled agents, the verdict in its highest-numbered QC file, and its report folder. A foreman whose last message to `main`, or last captured report, starts with `QUESTION:`, `BLOCKED:` or `PROPOSAL:` shows as `waiting on you:`, `blocked:` or `proposal:` with the first line, until the PM messages it. A foreman that ended its turn while its members still work shows as `waiting on members`. Under each crew, one line per member gives its status, how long it has run, its model family and its last activity.

Every hook fails open. If Truss's own code throws, the call goes on as if the plugin were not installed, and the error goes to the debug log.

## What the fetch log records

From 0.8.0 every `WebFetch` and `WebSearch` call in the session passes one function, `fetchVerdict` in `hooks/register.ts`, whoever makes it: a crew member, a foreman, a Truss agent outside every crew, or the main session. Unlike the crew hooks above, this one covers callers outside every crew too. Today it allows every call. A guardrail added later (an allowlist, a deny list, a prompt to you, a size or count cap) changes that function and its tests alone; no prompt names a source, a domain or a limit.

Each call appends one `fetch` line to `<truss folder>/events.jsonl`, but only when the Truss folder resolves and holds `plan.json`. A failed append is logged and never blocks the call. The line has these fields:

| Field | Value |
| --- | --- |
| `v`, `ts` | As on every event line. |
| `event` | `fetch`. |
| `crew` | The caller's crew slug, or `main` for a caller outside every crew (a `truss:*` agent the PM started, or the main session). |
| `agent` | The agent's name, or `main` for the main session. |
| `tool` | `WebFetch` or `WebSearch`. |
| `url` | `WebFetch` only. The URL with its scheme, host, port and path kept, userinfo removed, each query value emptied (keys kept) and the fragment dropped. A `url` that isn't a string, or doesn't parse, is logged as `""`. |
| `query` | `WebSearch` only. The first 200 characters of the query. A query that isn't a string is logged as `""`. |

So `https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth` is logged as `https://example.com:8443/docs/api?version=&lang=`. No line holds a fetched page. The `fetch` branch of [docs/events.schema.json](docs/events.schema.json) is the schema, and [docs/architecture.md](docs/architecture.md) ("Fetch gate (0.8.0)") the design.

## Review a run

Run `/truss:retro` after a run, optionally naming a Truss folder. The default is the session's, `<repo>/.git/truss/<session id>/`.

The `truss:retro` skill runs `python scripts/retro.py <truss dir>` (Python 3.9 or later, standard library only). The script reads `decisions.md`, `events*.jsonl`, `messages*.jsonl`, the report files and `plan.json`, writes nothing, and prints one JSON object of counts for each `## Run` heading:

- decisions, by time (`clock`, `dateOnly`, `notRecorded`) and by outcome (`followed`, `overruled`, `other`), and free-form lines;
- checking engineer `RECOMMEND` lines, by `answer`, `defer` and `pass`;
- foreman-to-foreman messages;
- from `events.jsonl`, spawns by model and effort, stalls, escalations (`QUESTION`, `BLOCKED`, `PROPOSAL`) and QC engineer verdicts.

For the whole folder it also counts the QC files by verdict, and the plan's crews, stages and estimated agents. From 0.6.0 its `leftovers` key lists, with a `count` of agents, the `worktree-agent-<id>` branches and `.claude/worktrees/agent-<id>` folders still present for agents the event log shows were spawned; it is `"not recorded"` when there is no event log, the folder isn't `<git common dir>/truss/<session>`, or git can't be read. From 0.9.0 its `leftoverDetails` key gives, per leftover, the facts worktrees' cleanup sweep checks (`head`, `dirty`, `inMain`) and, in `skip`, the reason the sweep would keep it; it is `"not recorded"` whenever `leftovers` is, and when `git worktree list --porcelain` fails. With no such folder it exits 2 with `retro: NO_TRUSS_DIR: <path>`.

From 0.8.0 each run's counts also cover how the project grew. Each reads `"not recorded"` when its source is absent, never a 0 that stands in for missing data; a 0 means the source was read and nothing matched:

- `fetches`: the run's `fetch` lines, as `{total, perAgent: {<agent>: n}}`. `"not recorded"` when the folder has no event log, when the run has no parsed start time (so it can't be placed in the log's time windows), or when the log holds no `fetch` lines at all.
- `extendPasses`: commits from the run's start up to the next run's start whose subject starts `docs(arch): extend ` or is `docs(arch): adopt learned items`. It is 0 when git history can be read and no subject matches. `"not recorded"` when the run has no parsed start time, or git can't be read: the folder isn't `<repo>/.git/truss/<session>`, or `git log` fails.
- `defaultDecisions`: `.md` files in the ADR directory that hold the line `Decided by: default`, the forks no client has reviewed yet. `"not recorded"` when the folder isn't `<repo>/.git/truss/<session>` or git can't confirm it, `.claude/truss.json` can't be read, its `adr` key is missing, empty or not a string, or the directory it names doesn't exist or can't be listed.
- `openClientActions`: `- [ ] ` lines under a `Client actions` heading in the architecture doc; `- [x] ` lines are done and don't count. `"not recorded"` when the folder isn't `<repo>/.git/truss/<session>` or git can't confirm it, `.claude/truss.json` can't be read, its `architecture` key is missing, empty or not a string, or it doesn't name an existing file.

Retro's JSON is internal to the skill and may change between versions; read the skill's summary, not the field layout.

The skill shows you the counts and proposes changes to `.claude/truss.json` keys and prompt-override files, and writes only what you approve. Before it proposes anything, it writes one `CAUSE: <anomaly> | <evidence> | <fix location>` line for each leftover, QC engineer fail, stall, overrule or spent allowance, from git, the disk, `decisions.md`, the QC files' verdict and finding lines, and the plugin's own files; a cause in the Truss plugin itself is reported to you, never written. It hands repeated work it finds to `kit:revise` when that skill is listed, and says so when it isn't.

A log from before 0.4.0 has no `## Run` headings and no `events.jsonl`, so retro treats the folder as one run and reports the spawns, stalls, escalations and QC rulings as `"not recorded"`, not zero.

## Limitations

- The slash command is `/truss`, not `/truss:status`. A plugin registers its command under a bare name, and `/status` is built in.
- A member is matched to its crew through the agents' parent ids. An agent that ended before the plugin loaded (a reload mid-session) resolves to no crew, and a message to it from a crew agent is refused.
- A foreman restarted with the same name shares the old foreman's report folder. Start it as `<slug>-2` instead; the skill does.
- No prompt in 0.2.0 (the skill or any of the five agents it had) has yet run as a live agent in a real run. 0.3.0 adds the design engineer, the sixth agent. The hooks are covered by tests against a mock engine.
- What status a foreman shows after it ends its turn while its members still run hasn't been observed in a live session. `waiting on members` depends on it.
- Capturing a report from the hand-back tool, through a `tool.call` hook on `SubagentHandback`, is covered by tests but not yet verified in a live session.
- The limit-reset wake rests on three things a probe confirmed: `$.clock` timers run from `session.start`, a hot reload cancels them (so the wake is re-armed from plugin state), and `$.prompt.submit` wakes an idle session. Nobody has yet seen the wake fire after a real usage-limit stop.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists. There, reports are captured only from the hand-back tool. The foreman stop gate is a `SubagentStop` hook too, so it shouldn't run there either; that is inferred from the code, not seen.
- `agents/foreman.md` tells a foreman to load `subagent-limits:split-work`, a skill from the [subagent-limits](https://github.com/AbhiramDwivedi/claude-ops/tree/main/plugins/subagent-limits) plugin, when it is available. A run without that plugin hasn't been tested.
- The plan gates trust the PM's `status` field. A PM that marks a crew `merged` too early lets the next stage start on code that isn't there. The gates guard against forgetting, not against lying; the QC-gated merge is still the real control.
- The 0.3.0 prompts have run live: `/truss:init` 0.3.0 wrote this repo's architecture doc, and the run building 0.4.0 used the design engineer in plan mode, the plan flow and the plan gates.
- The 0.4.0 `/truss:init` has run headless in two scratch repos, one with a valid kit manifest and one without kit. It took both paths as designed and reported a client's bad value by path without changing it. In those runs, `claude -p` refused the Write of its validation candidate under `<truss dir>/scratch/` because `.git/` is a protected path, even with Write allowed through `--allowedTools`. Init stopped before its final write and left `.claude/truss.json` unchanged. An earlier run with the client's own settings loaded wrote the approved keys, but it had an older Truss loaded too, so it shows only that the write path works when permissions allow it. Nobody has yet checked an interactive run. The retro skill and the event log haven't run in a live run yet.
- Report files are named by crew. A later run in the same session folder that reuses a crew name leaves the earlier run's QC files beside the new ones. From 0.5.0 the merge gate and the spent-allowance count read only files modified at or after `approvedAt`, so stale files don't count. Per-run report folders aren't decided.
- The gate's two-block bound relies on Claude Code sending `stop_hook_active` on the stop after a block, which hasn't been seen live; Claude Code lets a stop through itself after 8 consecutive blocks.

## Testing

```bash
claude plugin validate .
claude plugin test .
```

*Drafted with AI assistance and reviewed by the author.*
