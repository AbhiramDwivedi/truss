# Truss architecture

Truss is three kinds of file. The protocol lives in prompts: the program manager's in `skills/run/SKILL.md`, and the agent definitions in `agents/` (`project-manager`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`, `planning-engineer`, `retro-judge` and `judge`, the neutral read-only host that runs an unloaded read-only persona with its body inlined; [ADR-0014](adr/0014-retro-fixes.md), proposed, adds `stress-engineer`). The rules a prompt can't be trusted to keep live in one hooks module, `hooks/register.ts`, which `hooks/hooks.json` loads. `types/index.d.ts` declares the one value the module keeps in Claude Code's plugin state.

The prompts decide what agents should do. The hooks refuse the calls that break the chain of command, save reports to disk, and wake the PM when something needs it.

Truss has a design phase: a design engineer, principle packs, a plan file and stages. [ADR-0001](adr/0001-design-phase.md) decides it. The parts are `agents/design-engineer.md`, the `skills/principles/` and `skills/init/` skills, and the plan gates in `hooks/register.ts`, which read `plan.json`. The plan file's contract is [`plan.schema.json`](plan.schema.json), with an example in [`plan.example.json`](plan.example.json).

Truss builds on kit and records what a run did (designed in foundry run 2, ADRs accepted 2026-10-27). [ADR-0002](adr/0002-kit-manifest-and-config.md): Truss init reads kit's manifest, has kit declare `truss:qc-engineer` and `truss:checking-engineer` read-only, and proposes the new `.claude/truss.json` keys ([`truss-config.schema.json`](truss-config.schema.json)); crews take ports from worktrees' slots. [ADR-0003](adr/0003-event-log-and-retro.md): the hooks append `events.jsonl` ([`events.schema.json`](events.schema.json)), `decisions.md` gets a grammar, and `retro/cli.ts counts` (`retro/counts.ts`) with the `truss:retro` skill counts both. Both apply the repo's extension rules, [repo ADR-0012](adr/claude-ops/0012-extension-framework.md). Run 2's stage 1 merged; the sections on kit, the config keys, the event log and `decisions.md` describe the code.

The quality gates (designed in foundry run 3, [ADR-0004](adr/0004-scope-repair-and-head-gates.md), accepted 2026-10-28 with the client's approval of the run-3 plan) are evidence-based for scope, repair and cost. Plan v2 carries a `reworkAllowance`. The project manager's report gains Examined and Not examined sections, and the QC engineer FAILs an absence claim that states no scope. The QC engineer writes fixed head and patch lines, so a hook can tell which head a PASS belongs to, and a PASS survives a merge of the target that leaves the patch id unchanged. The hooks refuse the QC engineer spawn that would exceed the allowance, and record the spent allowance in `events.jsonl`. They also refuse main-session `truss:*` calls that set no model or effort. Every new rule applies only to plans with `version >= 2` and fails open on v1. The effort ladder itself is a repo-level principle, in the amendment to repo [ADR-0011](adr/claude-ops/0011-agents-pin-their-model.md). Run 3 merged; the sections on the rework allowance and head guard describe the code.

Growth ([ADR-0005](adr/0005-growth-model.md), accepted 2026-10-29) is in the project's architecture doc instead of the plugin. The plugin keeps the seven generic packs and ships no domain content. A design engineer that finds a domain no pack or doc section covers reports it, and an init-mode extend pass writes a domain section into the project's doc, committed on its own. The design engineer and the writer gain `WebFetch` and `WebSearch`. Every web fetch in the session passes one hook function, `fetchVerdict`, which allows every call today and logs a `fetch` line to `events.jsonl`, so a guardrail added later changes that function alone. The extend pass and fetch gate sections are the design; stage 1 of the growth run builds them.

Leftover causes ([ADR-0006](adr/0006-leftover-causes.md), proposed 2026-10-29 by the `leftover-design` crew) say why each leftover worktree stayed. retro gains one top-level key, `leftoverDetails`, with `leftovers` and every other key unchanged. The stress test resets its own branch to the crew head instead of detaching, and leaves its worktree clean. The retro skill gains a root-cause step that writes one `CAUSE:` line per anomaly. Details are in "retro's leftover details" below.

[ADR-0012](adr/0012-self-improving-retro.md) (proposed 2026-10-31 by the `retro-design` crew) makes the retro improve truss from each run. `factory.ts finish` saves a mechanical extract of the session's transcripts in the truss dir, and a committed catalog of known problems names each one `check`, `stage.js`, the extract and a new `factory.ts doctor` meet again. `doctor` probes each crew's host `needs` before any crew starts and gives the client one approval bundle. At the end of every run the PM starts `truss:retro-judge` agents that cite transcript lines, a checking engineer triages their findings, and the fix-now findings become a goal that truss builds with QC. The next retro reports a fixed problem that came back. The retro now reads transcripts, so P24 no longer binds it; the event log still holds no message, prompt or report text (P8). Details are in "The self-improving retro (ADR-0012)" below.

[ADR-0014](adr/0014-retro-fixes.md) (proposed 2026-10-31 by the `fixes-design` crew) carries out the first retro's fix-now findings. Stress tests run as a new agent, `truss:stress-engineer`, which has Write and Edit for scratch dirs and its own worktree; the QC engineer stays read-only. A new hook gate, `mainEditVerdict`, refuses the PM's own Edit and Write calls on repo files while a run is active. In `ui/`, a pure `replyStep` holds a turn's reply card until its background tasks end, and the server watches its whole ancestor chain. The sections that say "ADR-0014, proposed" describe the design; the goal's later stages build it.

[ADR-0015](adr/0015-resource-aware.md) (proposed 2026-10-31 by the `resource-design` crew) sizes crews to the host. It is truss's ADR-0015, not the claude-ops worktree-cleanup ADR that "ADR-0015 item 9" below cites. A new module, `resources/index.ts`, samples free memory and load. `factory.ts admit` holds a crew or member start below a free-memory threshold, `factory.ts heavy` runs each red and green check through one heavy slot shared by every crew, and `factory.ts reap` kills a finished check's leftover process group by its recorded pgid. A Haiku agent, `truss:resource-monitor`, recommends an effective parallelism, and the PM writes it to the truss dir. Details are in "Resource-aware sizing (ADR-0015, proposed)" below.

[ADR-0016](adr/0016-plugin-fixes.md) (proposed 2026-10-31 by the `plugin-fixes-design` crew) fixes the plugin gaps this run proved, on the client's ruling "Don't just log a plugin bug, fix it." `factory.ts start` gains a `warnings` key that says when a stress crew needs `truss:stress-engineer` changed after the session started, and refuses a crew whose goal file is missing, by path. The hooks refuse a SendMessage that resumes a plan or amend design engineer, and `envFailure` and `tests-check` get stricter. Goal `tests-guard-fix` amends it ("Amendment: tests-guard-fix"): `tests-check` guards only acceptance-test files, the test-writer files and the named paths that match a test-file pattern, and follows a pure rename (`R100`) to the new path, while a rename with an edit is a touch.

[ADR-0013](adr/0013-plugin-layout.md) (decided by the client; amended by goal `plugin-move`) gives the repo its own marketplace: the plugin moves to a `plugins/truss/` directory, the catalog lives on its own `marketplace` branch, and a plugin-only install gets no `ui/`. Details, and what is built so far, are in "Repo layout (ADR-0013)" below.

[ADR-0024](adr/0024-factory-fixes3.md) (proposed 2026-11-03 by the `fixes3-design` crew, goal `factory-fixes3`) fixes plugin bugs 24 to 35 and pins four seams: `entry.head`, `envSeen`, `trussFile`/`workflowArgs` and `contained`. The `trussFile` seam is under "Workflow calls (ADR-0009)" below.

[ADR-0025](adr/0025-factory-fixes4.md) (proposed 2026-11-03 by the `fixes4-design` crew, goal `factory-fixes4`) fixes plugin bugs 36 to 44. `start` validates `--args-file` before it changes any state and skips crews of a goal whose `approvedAt` is null, the stale-agent warning names what changed, and resume fixes three factory-resume QC deferreds. The resource monitor holds instead of stepping down while running crews exceed the parallelism, and reads admit's line as a memory reading. It pins one seam, `entry.livePage`, under "Workflow calls (ADR-0009)" below.

[ADR-0026](adr/0026-factory-fixes5.md) (proposed 2026-11-03 by the `fixes5-design` crew, goal `factory-fixes5`) fixes plugin items 45 to 57. The resource monitor steps up above three times `minFreeMB` and backs off on memory pressure and swap, which the sampler now reads; an answer at a done task re-runs it; acceptance tests pin behaviour, not spelling; and the ui pretest names missing dependencies. It pins four seams: the answer at a done task, string args, `check-deps` and the sample's `memPressure` and `swapUsedPct`. It also decides the factory items 46, 49, 50, 53 and 56 and the admit hold on pressure, which a follow-up crew builds.

[ADR-0027](adr/0027-retro-fixes2.md) (proposed 2026-11-03 by the `retro-fixes2-design` crew, goal `retro-fixes2`) fixes retro 2's findings F-67, F-70, F-72, F-73 and F-74. `admit` in `stage.js` fails closed, and every factory command but `start` refuses a relative `--dir` (since 0.29.0 the `inbox` and `cost` commands do too, through `absDirOf` in `bin/inbox.ts`). A green fix builder that stops naming a tester file hands over to a tester. The QC prompt carries the foreground rule. `factory.ts decide` writes `decisions.md`, and a main-session `Bash` hook refuses a push or merge that scrub doesn't gate with `&&` (R-32). It also narrows two retro catalog patterns.

The container view below shows which part writes and which reads each stored file. Every node shown is built.

```mermaid
flowchart TB
  run["truss:run<br/>[skill: skills/run/SKILL.md]<br/>Makes the main session the PM"]
  init["truss:init<br/>[skill: skills/init/SKILL.md]<br/>Checks the architecture doc"]
  arch["truss:design-engineer<br/>[agent: agents/design-engineer.md]<br/>Writes the doc, ADRs and draft plan"]
  crew["Crew agents<br/>[agents: project manager, QC engineer, checking engineer, writer, commissioning engineer]<br/>Do and check the work"]
  hooks["Hooks module<br/>[hooks/register.ts]<br/>Gates, report capture, wakes"]
  retro["retro<br/>[retro/cli.ts counts, truss:retro]<br/>Counts what a run did"]
  fjson[(".claude/truss.json<br/>[project config]")]
  kitman[("kit's .claude/kit/manifest.json<br/>[kit's store, read by init]")]
  plan[("plan.json, plan.md<br/>[Truss dir]")]
  dec[("decisions.md<br/>[Truss dir]")]
  events[("events.jsonl<br/>[Truss dir]")]
  reports[("reports/, messages.jsonl<br/>[Truss dir]")]

  run -->|"Skill call when the doc is missing"| init
  init -->|"reads read-only declarations"| kitman
  init -->|"starts in init mode"| arch
  arch -->|"writes architecture, adr keys"| fjson
  fjson -->|"doc path, merge, target, caps, roles"| run
  run -->|"starts in plan mode"| arch
  arch -->|"writes the draft"| plan
  run -->|"sets approvedAt, status"| plan
  run -->|"starts project managers, by stage"| crew
  run -->|"writes decision lines"| dec
  crew -.->|"Agent, SendMessage, stops"| hooks
  hooks -->|"reads, gates project manager starts"| plan
  hooks -->|"saves reports, logs project manager messages, reads this run's QC files"| reports
  hooks -->|"stamps HH:MM"| dec
  hooks -->|"appends spawn, stall, tag, report, spent allowance"| events
  retro -->|"reads"| events
  retro -->|"reads"| dec
```

*Truss's containers and the files between them.*
Traces to: `skills/run/SKILL.md`, `skills/init/SKILL.md`, `agents/design-engineer.md`, `hooks/register.ts`, `docs/adr/0001-design-phase.md`, `docs/adr/0002-kit-manifest-and-config.md`, `docs/adr/0003-event-log-and-retro.md`, and the "On disk" section below.

## Role names (ADR-0042)

[ADR-0042](adr/0042-project-manager-rename.md) names the two lead roles, with no alias for the old crew-lead name:

- **Program manager**: the main session. It plans, starts crews, answers their questions, talks to the client and merges crews. This doc calls the program manager (PM) "the PM".
- **Project manager**: the agent that leads one full crew, agent type `truss:project-manager` (`agents/project-manager.md`). It splits the crew's goal, delegates to members, merges them and starts the QC engineer. This doc always spells it out.

The contract values carry the new name: the `promptOverrides` key and workflow role key `project-manager`, the `## Engine` value `project-manager`, the `factory start` output key `projectManagers`, the stall kind `idle-project-manager`, the retro key `stalls.idleProjectManager` and the prompt prefix `[truss] idle project manager:`. `hooks/register.ts` exports `PROJECT_MANAGER_TYPE`, `IDLE_LEAD_KIND` and three pure functions: `isLeadType(type)` for every crew-lead type check, `leadStartName(call)` for the start gate and `stopperIsLead(known, type)` for the stop gate. Nothing reads the old values.

```mermaid
flowchart LR
  client["Client"]
  PM["Program manager (PM)<br/>[main session]"]
  projmgr["Project manager<br/>[agent: truss:project-manager]"]
  mem["Members<br/>[project agents, QC engineer]"]
  client -->|"goal, rulings"| PM
  PM -->|"starts one per full crew"| projmgr
  projmgr -->|"tasks"| mem
  mem -->|"reports"| projmgr
  projmgr -->|"report"| PM
```

*Who leads whom. A solo or lean crew has no project manager; the PM runs its members itself.*

```mermaid
sequenceDiagram
  participant PM as Program manager (PM)
  participant H as hooks/register.ts
  participant P as Project manager
  PM->>H: Agent call, subagent_type truss:project-manager
  H->>H: leadStartName(call), via isLeadType
  H->>H: plan gate on the returned name
  H-->>PM: allow, or refuse with reason
  P->>H: stop
  H->>H: stopperIsLead(known, type)
  H-->>P: send back a stop with no report (at most twice), or let it stop
```

*A project manager's start and stop. An agent of any other type, the old crew-lead type included, fails `isLeadType`, so neither gate treats it as a project manager and it belongs to no crew (ADR-0042, Decision 4).*

## Roles and who talks to whom

The roles split into two diagrams: who the PM talks to, and what happens inside one `full` crew.

```mermaid
flowchart TD
  client(["Client<br/>[person]<br/>Approves, rules, pushes"])
  PM["PM<br/>[main session]<br/>Plans, settles, merges"]
  checker["Checking engineer<br/>[agent: truss:checking-engineer]<br/>Reviews items bound for the client"]
  arch["Design engineer<br/>[agent: truss:design-engineer]<br/>Drafts the plan"]
  sizer["Sizing engineer<br/>[agent: truss:sizing-engineer, ADR-0031]<br/>Recommends a size per task"]
  direct["Solo agent or lean crew members<br/>[agents, run by the PM, ADR-0031]<br/>Each in its own worktree"]
  integ["Integrator<br/>[agent, single mode]<br/>Merges every crew branch"]
  ijudge["Integration QC engineer<br/>[agent, single mode]<br/>Rules on the integration branch"]
  projectManagerA["Project manager, crew A<br/>[agent: truss:project-manager]"]
  projectManagerB["Project manager, crew B<br/>[agent: truss:project-manager]"]
  disk[("Truss dir<br/>[store]")]

  client <-->|"plan, rulings, push and PR"| PM
  PM -->|"items bound for the client"| checker
  checker -->|"RECOMMEND lines"| PM
  PM -->|"start: plan mode, every run"| arch
  arch -.->|"draft plan.json, plan.md"| disk
  PM -->|"goal it can't size at a glance"| sizer
  sizer -->|"TASK: name, solo, lean or full, reason"| PM
  PM -->|"task, worktree"| direct
  direct -->|"diff and its own proof"| PM
  PM -->|"start, answers, make-ready requests (merge the target in)"| projectManagerA
  PM -->|"start, answers, make-ready requests (merge the target in)"| projectManagerB
  projectManagerA -->|"QUESTION, BLOCKED, PROPOSAL, report"| PM
  projectManagerB -->|"QUESTION, BLOCKED, PROPOSAL, report"| PM
  projectManagerA <-->|"collisions only, logged"| projectManagerB
  PM -->|"start"| integ
  PM -->|"start"| ijudge
```

*Who the PM talks to: the client, the agents outside every crew, the project managers, and the solo and lean crews it runs itself.*
Traces to: `skills/run/SKILL.md`, `agents/project-manager.md`, `agents/checking-engineer.md`, `agents/design-engineer.md`, `hooks/register.ts`, and, for the sizing engineer and direct crews, [ADR-0031](adr/0031-right-size-process.md) Decisions 5, 6 and 9 (designed; the `sizing-build` crew builds them).

```mermaid
flowchart TD
  PM["PM<br/>[main session]"]
  projmgr["Project manager<br/>[agent: truss:project-manager]<br/>Splits, delegates, merges members"]
  mem["Members<br/>[agents: builders, test-writer, writer, commissioning engineer]<br/>Each in its own worktree"]
  qc["QC engineer<br/>[agent: truss:qc-engineer]<br/>Rules PASS or FAIL"]
  red["Stress test<br/>[agent: truss:stress-engineer, ADR-0014, proposed]<br/>Tries to break the work"]
  other["Another crew's project manager<br/>[agent: truss:project-manager]"]
  disk[("reports/crew/<br/>[Truss dir]")]

  PM -->|"start, answers"| projmgr
  projmgr -->|"tagged messages, report"| PM
  projmgr -->|"tasks"| mem
  mem -->|"reports with proof"| projmgr
  projmgr -->|"when the plan says yes"| red
  projmgr -->|"fresh QC engineer per ruling"| qc
  projmgr <-->|"collisions only"| other
  mem -.->|"reports, saved by the hooks"| disk
  qc -.->|"QC file, the merge gate"| disk
```

*Inside one `full` crew: the project manager's members, its QC engineer and stress test, and where their reports land.*
Traces to: `agents/project-manager.md`, `agents/qc-engineer.md`, `hooks/register.ts`.

Only the PM talks to the client. Only project managers message the PM, so a member's question reaches the PM through its project manager. Project managers message each other only when their work collides: a file another crew owns, a shared interface that changes, or the merge order. The hooks enforce the message rules for everything inside a crew (see [Hooks](#hooks)). The checking engineer, the integrator, the integration QC engineer, the sizing engineer and the design engineer in `plan` mode are started by the PM, so they sit outside every crew. The hooks don't police them and don't save their reports.

**Each task gets the process its size needs ([ADR-0031](adr/0031-right-size-process.md), R-49 to R-52).** The PM sizes every task as `solo`, `lean` or `full` and logs each size with a one-line reason. A `full` crew, the default, has a project manager or a `stage.js` chain, a red record and a QC engineer, as the diagram below shows. A `solo` task is one agent, with no red-then-green test and no QC engineer: the PM reviews its diff and the agent's own proof, then merges it. A `lean` crew has one or two members. The PM chooses whether it gets a QC engineer (`qc`) and a red-then-green test (`red`), records the choice in `plan.json`, and the merge gate follows it. The PM runs solo and lean crews itself; no project manager leads them. Process size does not follow the brief size of [ADR-0008](adr/0008-owner-interview.md).

**Members are persona agents ([ADR-0032](adr/0032-persona-agents.md)).** A persona is a project agent type, `<repo>/.claude/agents/<name>.md`, specialised by stack and area, with a `Standards` section of short, checkable rules. An editing persona does builder and tester work; a read-only judge (always including a `product-owner`) does none. The planning engineer gives every task a persona, and a task never spans two personas' areas. A task spawns as its persona's type, or as `general-purpose` with the persona's body inlined when the session hasn't loaded the file (a read-only judge is inlined into `truss:judge` instead, so it never gets write tools). The QC engineer holds the diff to the Standards of every persona the crew used and every judge, and a violated standard is a FAIL. When the goal needs a stack no persona covers, the design engineer drafts one in plan mode (the hiring step); the client approves it with the plan and `factory persona-install` installs it. `general-purpose` stays only for work with no stack.

**Cost meter ([ADR-0038](adr/0038-cost-budgets-and-ledger.md)).** `bin/cost.ts` `sweep(dir, repo?, {platform?, waitMs?})` reads the session's transcripts from its cursor under the lock `D/locks/usage` and returns `{rows, files, bad, found}` (`bin/cost.ts:75-182`). It appends one row per message id to `D/usage.jsonl`, skipping ids already in that file and rows whose token fields are all 0, and keeps `D/usage-cursor.json` as `{files, project, ccEstimate}`; on win32 the cursor's path keys are lowercased. When the usage lock stays busy, `sweepOrRead` reads `usage.jsonl` as it stands and marks the result `busy: true` (`bin/cost.ts:183-195`): `budgetVerdict` accepts that lag, while `crewCost` returns `{usd: null, why: 'usage sweep busy'}` so the ledger never records a too-low cost (`bin/cost.ts:356-366`). A row stores no attribution. Each read maps it, in order, to the Workflow agent's label slug, the crew of its `spawn` event, the crew whose worktree is the agent's `worktreePath`, the Agent call's `description` label slug, and otherwise `main` (no agent id) or `unattributed` (`bin/cost.ts:213-249`). A model is priced by the longest `pricing` key that is a prefix of its id; a fast-speed row needs a `fast` price, or it is unpriced rather than charged at the standard rate, and any unpriced row makes the sum `null`, never 0. A price may carry a `longContext` tier (0.29.0, ADR-0046): a standard-speed request whose prompt (input, cache read and both cache writes) is over its `abovePromptTokens` is priced wholly at those rates. Thinking and web-search tokens are counted but not priced (`bin/cost.ts:250-292`). `budgetVerdict` checks `sessionUsd` on every call, attended or not (an attended session at its cap is held at the next member start, and one typed raise lifts the hold for every crew), then `runUsd` (spend since `plan.approvedAt`), then the crew limit, the lower of `crewUsd` and the crew's work type `crewUsd`, each plus the client's raises; every hold's `why` starts `budget: `, and its refs are `budget:<sid>:session:session`, `budget:<sid>:run:run`, `budget:<sid>:crew:<slug>` and `budget:<sid>:workType:<slug>` (`bin/cost.ts:300-342`). `factory admit` and `factory start` hold on a budget before they look at memory (`holdOf`, `bin/factory.ts:2411-2431`), and `queue-next` checks the session limit before it claims an item (`budgetVerdict` call, `bin/queue.ts:258`). After each merge `finish` and `land` append the crew's cost to `S/ledger.jsonl`; a ledger failure becomes a decision line, never a refusal (`bin/factory.ts:3265-3271`).

**Crew knowledge and product calls ([ADR-0033](adr/0033-crew-knowledge-and-product-calls.md)).** The feature map (`docs/features.md` by default) lists each user-facing capability with its entry points, owning persona and doc pointers; crews and the planner read it before they scan code, and `truss:init` creates it. After a crew's green check and the single reply checkpoint, and before QC, an optional knowledge step (a Sonnet `medium` writer, brief `Knowledge: crew <slug>`; skipped for writer-only crews; its commit SHA is recorded with `factory knowledge-commit`; since ADR-0046 item 0 the crew owns the docs of its change, so a `.md` free doc (feature map, architecture doc, ADR dir, knowledge dir; no README, CHANGELOG or other `.md`) is exempt from owns when any non-merge crew commit changed it, and a prompt file (skills, agents and personas, rules dir, agents index, product decisions file) only when the knowledge commit alone changed it and it is no judge's agent file (`knowledgeDocs`); frontmatter is never exempt, a knowledge doc's `verified` and `sources` excepted) records the members' `learned` items in the crew branch, by the routing table of [ADR-0035](adr/0035-path-scoped-knowledge.md): an area rule to `.claude/rules/<area>.md` (frontmatter `paths`, `sources`, `verified`), a cross-cutting persona rule to the persona's Standards, a capability to the feature map, a product call to `docs/knowledge/product-decisions.md` (never the always-loaded persona file), a decision to an ADR, anything else nowhere. It runs only when there are items or the crew diff adds, renames or deletes non-test source files (detected from git), edits only markdown, cites a source for every fact, reconciles before it adds, sets `verified` to the crew head and stays within the line budgets (`AGENTS.md` index 60, persona 120, rule 40; `knowledgeBudgets`). Since [ADR-0046](adr/0046-factory-throughput.md) the step runs after the stress test, re-runs on the fix diff after every QC fix round, and before each QC round `stage.js` runs `factory knowledge-lint --base=<crew base>`, sending the writer back on new failures at most twice (`lintClean`, `LINT_FIX_ROUNDS`); QC fails a diff that adds or moves functionality with no feature-map entry, an unrecorded crew product call, or a lint failure marked `new: true` (a failure the crew inherited, and every warning, goes to the main session). A task whose files match a rule's `paths` globs gets a `Context for your files` line, from `stage.js`'s own matcher for the `**`, `*`, `?` glob dialect. A product question inside a crew goes to the `product-owner` persona (`PO: DECIDE` or `PO: ESCALATE`) and the project manager rules; the main session acks or changes each call while the crew runs, and the crew applies the replies once, at that checkpoint (a later reply is `late` and becomes a fix at merge). In plan mode the product-owner judge reviews the acceptance criteria before any work starts (`PO: ACCEPT` or `PO: REVISE`). The run-end pass only reconciles conflicts across crews.

| Agent | Started by | Model and effort | Edits files |
| --- | --- | --- | --- |
| PM | You, with `/truss:run` | The session's | Only `decisions.md`, `plan.md`, goal files, and the fast-forward in `sequential` mode; also `plan.json` and `plan.md` once the design engineer has drafted them: it sets `approvedAt` and each crew's `status`, and for a mid-run design slice adds the crew, moves its dependants a stage later and sets `clientApproval`. From [ADR-0014](adr/0014-retro-fixes.md) (proposed), `mainEditVerdict` refuses its Edit and Write calls on any other repo file while a run is active |
| Design engineer | `init`: the `truss:init` skill, run by you as `/truss:init` or by the PM when a run finds no architecture doc. `plan`: the PM, at the start of every run. `design`: the design crew's project manager | Opus, `medium` | Only the architecture doc and the ADR directory, plus `.claude/truss.json` in `init` mode, `plan.json`, `plan.md` and `<truss dir>/scratch/` in `plan` mode, and a contract artifact at a path the design crew owns in `design` mode; never source or tests |
| Checking engineer, `checker-<n>` | PM, fresh for each batch | Opus, `medium` | No |
| Project manager, `<slug>` | PM, in the background, in a worktree | Opus, `medium` | Merges members and the target into the crew branch, never rebases; writes code only for conflicts and small fixes the checks demand |
| Members, named after their project manager | Project manager | Set on every call; Sonnet for mechanical work, Opus for judgment | Yes, each in its own worktree |
| QC engineer, `<crew>-qc`, then `-2`, `-3` | Project manager | Opus, `medium`; `high` or `xhigh` only on the client's call (repo ADR-0011 amendment). On a v2 plan, at most `reworkAllowance` QC engineers after FAILs ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 5) | No |
| Stress test, `<crew>-stress` | Project manager, when the plan says yes | Opus, `medium` (repo ADR-0011 amendment) | Only inside its own worktree and temp dirs; never commits. It runs as `truss:stress-engineer` (`agents/stress-engineer.md`), with Write and Edit for those dirs only |
| Integrator | PM, `single` mode | `general-purpose`, Opus, `high` | Yes, the integration branch |
| Integration QC engineer | PM, `single` mode | Opus, `medium`, like every QC engineer (repo ADR-0011 amendment) | No |
| Planning engineer, `<slug>-planner`, then `-2` (ADR-0009) | `stage.js`, on the Workflow path only | Opus, `medium`, in its front matter and in `workflows/roles.json` | No; read-only, starts no agent |
| Sizing engineer (ADR-0031, designed) | PM, as an Agent call, for a goal it can't size at a glance | Sonnet, in its front matter | No; tools `Read, Grep, Glob`. It returns one `TASK: <name> \| solo\|lean\|full \| <one-line reason>` line per task; it recommends, and the PM decides and may overrule it with a logged reason |
| Solo agent, or lean crew member `<slug>-builder`, `<slug>-tester`, `<slug>-qc` (ADR-0031, designed) | PM, in the crew's worktree | Sonnet for the solo agent; set on every call for lean members | Yes, in its own worktree; a `<slug>-qc` QC engineer doesn't |

**Workflow crews have no project manager ([ADR-0009](adr/0009-workflow-factory.md), Decisions 2, 4 and 5).** On the Workflow path a crew is a chain inside the `stage.js` script, not a `truss:project-manager`. The script plays the project manager's orchestration role and makes every member, QC engineer and stress-test `agent()` call itself, because a workflow agent has no Agent tool and can't delegate (ADR-0009, Probe, probe 2; that `truss:project-manager` in particular has none is inferred from `kit:builder`, not run). Every agent's type, model, effort and isolation come from one table, `workflows/roles.json`, through the script's one `spawn()` function: `designer`, `checker`, `planner` (`truss:planning-engineer`) and `writer` on Opus at `medium`; `tester` and `builder` (the project's agent type, default `general-purpose`) and `resolver` on Sonnet at `medium`, a builder at `low` when its task says so; `rca`, `stress` and `qc` on Opus at `medium` (`stress` as `truss:stress-engineer`, `qc` as `truss:qc-engineer`); and `runner` (`general-purpose`, Sonnet, `low`), which runs one `factory.ts` command the script wrote out in full and relays its output. The table has no `project-manager`, `commissioning` or `integrator` role, and `workflowRoleVerdict` refuses one (ADR-0009, Decision 2). The planning engineer (`agents/planning-engineer.md`, Decision 5) does the project manager's depth pass and split, `agents/project-manager.md` sections 2 and 3, for one crew and returns the tasks in a schema; it writes nothing. A tester's commits still carry `Truss-Role: test-writer`, and a resolver's carry `Truss-Role: resolver`, a value defined in the member and QC engineer briefs `stage.js` writes, not in `agents/project-manager.md` (Decision 8). Crews with a `commissioning-engineer` member, crews whose members the client raised to `high` or `xhigh`, every crew of a `single`-mode run, and every crew in a session without the Workflow tool keep the project manager path, and the table above, unchanged (Decision 1, "start, engine split"). Whether the Workflow path is the default is an open client decision (ADR-0009, Client decisions, item 2; the ADR recommends yes).

The design engineer is `agents/design-engineer.md`. It loads the principle packs the work touches from the `skills/principles/` skill and runs in three modes ([ADR-0001](adr/0001-design-phase.md), sections 2 and 3):

- `init`: started by the `truss:init` skill. Writes the project's architecture doc (principles, module map, ADRs for decisions already in the code) and `.claude/truss.json`. The PM also starts it in `init` mode with an extend brief, to add domain sections to an existing doc (the extend pass, below).
- `plan`: started by the PM at the start of every run, outside every crew, like the checking engineer. For a goal, gives each touched module an `extend` or `change` verdict and splits the work into crews and stages by the leaf test, as a draft `plan.json` plus a readable `plan.md`. The PM owns both files after that.
- `design`: a member of a design crew, in the goal's first stage or a mid-run slice, started by that crew's project manager; a design crew exists only for an open design question ([ADR-0044](adr/0044-split-by-need.md)). Writes the ADR and architecture-doc change for each `change` verdict it carries, and names the seams the crew's test-writer must pin with contract tests.

Its tools are Read, Grep, Glob, Bash (read-only git and read-only inspection, plus the acceptance test commands it proves and a schema validator fetched by `npx -y`, both in `plan` mode), Skill, and Write and Edit for the files in the table above. It also has `WebFetch` and `WebSearch`, and so does the writer ([ADR-0005](adr/0005-growth-model.md), section 3). Project managers and members already have every tool, and commissioning engineer keeps `WebFetch`. The QC engineer and the checking engineer get no web tools: a QC engineer that needs an outside fact to rule has found a gap in the doc and reports it as a finding. Every agent prompt, and the PM's, carries ADR-0005's fetch rule word for word, and the project manager puts it in every member brief (section 2). Crews never edit the architecture doc or ADRs; a design change they need goes to the PM as `PROPOSAL:`, which the PM can take up as a mid-run design slice (lifecycle step 8).

**The extend pass.** Truss extends a project's doc only on evidence from the work ([ADR-0005](adr/0005-growth-model.md), section 4):

- At init, a goal given with `/truss:init` is passed to the design engineer, which covers the domains the goal names as well as the code, so a greenfield repo gets a doc.
- At plan time, a domain is uncovered when the goal touches a platform, product type or tool that neither a loaded pack nor a section of the doc covers. The plan-mode design engineer stays read-only: it hands back one `UNCOVERED: <domain> | <why the goal touches it>` line per domain and no plan blocks, so the plan-file route writes nothing. The PM then starts the design engineer in `init` mode with an extend brief naming those domains.
- At run end, when a project manager's report has a `## Learned` section, the PM starts the same pass with those items. The project manager stop gate doesn't require the section.

An extend pass adds one domain section under the doc's Principles, plus ADRs (section 5). Rules go in the section, at most 15, each in pack form with a test and tagged `from knowledge` or `checked: <url>`. Each fork gets an ADR with its alternatives and the line `Decided by: default`. Each bootstrap exception gets an ADR naming the rule it bends. Client actions go in the section's `Client actions` list, where `- [ ] ` marks an open action and `- [x] ` a done one; a crew whose work depends on an open one raises `BLOCKED:` at start. Before committing, the PM starts the checking engineer on the new section with a narrow brief: rules whose test can't be run or checked against a diff, rules that are really forks, forks with no alternative named. The PM then commits the pass on its own, on the run's target, as `docs(arch): extend <domain>` or `docs(arch): reconcile learned items`, never mixed into crew work (section 8). Extend passes write without client approval (section 6); `Decided by: default` marks what a later review step will read.

```mermaid
sequenceDiagram
  participant P as Design engineer, plan mode
  participant F as PM
  participant A as Design engineer, init mode
  participant C as Checking engineer
  participant T as Target branch
  F->>P: goal, plan brief
  P-->>F: UNCOVERED: domain | why, no plan blocks
  F->>A: extend brief naming the domains
  A->>A: domain section, fork and exception ADRs (fetch only for a fact it isn't sure of)
  A-->>F: INIT report
  F->>C: narrow brief on the new section
  C-->>F: RECOMMEND lines
  F->>T: commit docs(arch): extend domain
  F->>P: fresh plan design engineer, same goal
  P-->>F: plan.json and plan.md blocks
```

*The plan-time extend flow, as designed; it runs once, on the first run that touches the domain.*
Traces to: `docs/adr/0005-growth-model.md` (sections 4, 5 and 8, and its literals table), `hooks/register.ts:1334-1337` (`routePlanFiles` writes nothing for a hand-back with no fenced blocks).

A crew, as the hooks see it, is a `truss:project-manager` with no parent (the main thread started it) and every agent whose parent chain reaches it. A `truss:project-manager` started by some other agent is not a crew.

## The run lifecycle

The diagram shows steps 4 to 11 for one crew; the numbered steps below it are the full story.

```mermaid
sequenceDiagram
  actor Client
  participant F as PM
  participant A as Design engineer
  participant C as Checking engineer
  participant L as Project manager
  participant M as Members
  participant J as QC engineer
  Client->>F: /truss:run with a goal
  F->>A: start in plan mode
  A-->>F: draft plan.json and plan.md (verdicts, crews, stages)
  F->>C: review the verdicts
  C-->>F: RECOMMEND lines
  alt approval client, a client trigger applies
    F->>F: escalate client-trigger --ref run (ADR-0045)
    F->>Client: plan table with the ADRs, merge mode, target, the item's id and code
    Client->>F: /truss:inbox approve E-id code (typed)
    F->>F: resolve --by client sets approvedAt
  else approval auto
    F->>F: log the plan, overwrite approvedAt
  end
  loop each stage, at most maxParallelCrews crews at once
    F->>L: start with goals/slug.md (the hooks check plan.json)
    L->>M: member tasks
    M-->>L: reports with proof
    L->>J: start a fresh QC engineer
    J-->>L: VERDICT and Proof checked SHA
    L-->>F: final report
    F->>C: pre-merge review of the report and plan
    F->>F: merge on PASS whose SHA is the branch head
  end
  F->>Client: end-of-run report, then ask before push and PR
```

*One run, from goal to merge, for a single crew per stage.*
Traces to: `skills/run/SKILL.md`, `agents/design-engineer.md`, `agents/project-manager.md`, `agents/qc-engineer.md`, `docs/adr/0001-design-phase.md` (sections 3, 6 and 9).

0. Init: When a run finds no architecture doc, the PM runs the `truss:init` skill, which starts the design engineer in `init` mode; the client can also run `/truss:init`. If the repo already has an architecture doc of its own, `init` extends it rather than replacing it; otherwise it writes `docs/architecture.md`, with ADRs in `docs/adr/`. It records the doc's path in `.claude/truss.json`. Init then reads kit's manifest, runs `kit:init` when it is missing and kit is installed, and proposes the new `truss.json` keys ([ADR-0002](adr/0002-kit-manifest-and-config.md)).
1. Altitude: The PM asks the client once whether the goal is the end or a step toward a bigger outcome, and describes the bigger version.
2. Depth pass: The PM answers four questions (what a top practitioner would add, the rawest material, the practitioner's tools, what besides a model verifies the result). The answers decide which crews exist.
3. Inventory: The PM lists the agent types and skills the session can use. It starts from `roles` in `.claude/truss.json`, where set.
4. Size, then split: The PM first sizes each task as `solo`, `lean` or `full` ([ADR-0031](adr/0031-right-size-process.md), Decisions 1 to 5). When it can't size a goal at a glance, it starts `truss:sizing-engineer` and takes or overrules its recommendation. It logs one `factory.ts decide --line 'size <task> <process>[ qc <bool> red <bool>] | <reason>; sizing-engineer <size or none> | none | <followed or overruled>'` line per task. A goal whose tasks are all `solo` stops here: it writes no `plan.json` and runs no `plan.js`, so it has no plan design engineer, no checking engineer's plan review and no approval (R-52). The PM starts one Sonnet agent per task in its own worktree, reviews its diff and proof, merges, and logs the merge; with no plan, no hook gates this path. Every other goal is split. Each crew has an `owns` scope (two crews' scopes may share files, [ADR-0043](adr/0043-crews-share-files.md)), an acceptance test it can't game, its high-impact paths, a stress test yes or no, and a resource slice (port range, database or temp directory). The PM starts the design engineer in `plan` mode for this, at the start of every run that isn't all `solo`. It gives one verdict per touched module, `extend` by default, splits the work into crews and stages by the leaf test, runs each crew's acceptance test once to prove it, estimates agents per crew, and sets each crew's `process` (and a `lean` crew's `qc` and `red`) on a version-4 plan. The design engineer drafts `plan.json` and `plan.md`; the PM owns both after that. A checking engineer reviews the verdicts on its own; a disagreement doesn't send the plan back; only a gameable acceptance test does. The client is asked only when the checking engineer disagrees and the design engineer's reason doesn't settle it, or a change breaks a declared principle, adds an external service or recurring cost, or changes a stored data shape in a way that's hard to undo. `plan.json` has no fields for a crew's high-impact paths, stress test or resource slice, which the PM sets in its plan table and each project manager's brief (`skills/run/SKILL.md`); ADR-0001 doesn't say who sets them. The slice names no invented port range: a crew uses its worktree slot's `PORT_BASE` when the repo has a `.claude/worktree-setup.*`, and the plan says `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)` when it hasn't ([ADR-0002](adr/0002-kit-manifest-and-config.md), section 4).
5. Approval and freeze: The PM shows the plan table and asks for the merge mode and target branch. On approval it writes `plan.md`. From here the scope is frozen, and only the client can change it. The pause depends on the plan's `approval`, not on its stages ([ADR-0044](adr/0044-split-by-need.md)). A run with no client trigger, no open long-term cost and no brief asking for approval doesn't pause: the design engineer's draft sets `approval: "auto"`, and the PM logs the plan, overwrites `approvedAt` with its own log time, and starts the crews without asking. Its merge mode and target come from `.claude/truss.json` (`merge`, `target`); without them the merge mode is `sequential` and the target is the current branch, and the PM logs which it used. The client sees the plan in the end-of-run report. A run where one of those applies gets `approval: "client"` and `approvedAt: null` from the design engineer's draft: the PM checks it, opens a `client-trigger` item with ref `run`, and shows the plan table with the ADRs and the item's id and code. The client approves by typing `/truss:inbox approve <E-id> <code>`: that typed resolve sets `approvedAt` itself, and the PM never runs `approve --by client` ([ADR-0045](adr/0045-approve-proof.md)). `approve --by client` passes only with `--item <E-id>` of such an item that the client resolved `approve` by a typed line (`approvalProof`, `bin/inbox.ts`). Later stages start as earlier ones merge, with no further pause. `approvedAt` is null only while a run waits for the client. In either case, questions still reach the client through the checking engineer's escalation rules.
6. Project managers start: The PM writes `goals/<slug>.md` for each crew and starts all project managers in one message. A `solo` or `lean` crew gets no project manager; the PM runs it itself (step 7). Project managers start by stage. Stages come from dependency only ([ADR-0044](adr/0044-split-by-need.md)): a goal's first stage holds every crew that needs nothing merged first, a later stage exists only when one of its crews needs an earlier crew's merged work, and a `change` crew writes the ADR for an already-decided design itself, in the stage of its build. Each stage merges before the next starts. Within a stage, at most `maxParallelCrews` crews run at once; the rest queue and start as running ones merge. The queue order is the order of the `crews` array within the stage. The PM sets each crew's `status` in `plan.json` as it starts and merges.
7. Inside each crew: The crew's `process` decides what runs ([ADR-0031](adr/0031-right-size-process.md), R-50, R-51). A `solo` crew is one agent: it does the task and reports its own proof, with no red record and no QC engineer. A `lean` crew is one or two members that the PM runs in the crew's worktree; it gets a red-then-green acceptance test only when `red` is true, and a fresh QC engineer, `<slug>-qc`, only when `qc` is true. A `full` crew runs as follows. The project manager runs its checks to prove its environment works, runs a full depth pass, splits the work into member tasks, and delegates. Members report with proof. The project manager merges the members' branches with `git merge --no-ff`, runs the checks, then runs the stress test (when there is one) and a fresh QC engineer. Before the QC engineer it compares its diff with the files it owns and asks the PM for any extension. Every member commit carries `Truss-Crew: <slug>` and `Truss-Role: <role>` trailers. The QC engineer reads the role with `git log --format='%H %(trailers:key=Truss-Role,valueonly)'` and fails the crew if a `builder` commit touched the acceptance test tests. A file outside the crew's ownership is a `QUESTION:` for the PM in the QC engineer's findings, not a FAIL by itself. The QC engineer also asks whether the diff conforms to the architecture doc's principles and module map, and to the run's ADRs. A violation that doesn't affect the acceptance test is a QUESTION. One that breaks a declared principle is a FAIL.
8. Messages: Project managers send the PM `QUESTION:`, `BLOCKED:` or `PROPOSAL:`. The PM settles what it can and logs it. Items for the client go through a checking engineer first. When the PM takes up a design proposal, it runs a mid-run design slice. It adds a design crew (`verdict: "design"`) to the earliest stage whose crews it doesn't depend on, first in that stage's queue and ahead of the crews that need it; a running crew isn't moved (`skills/run/SKILL.md`, section 7, "Run a mid-run design slice", step 1). A new stage after the last would deadlock when a running crew needs the slice, since a later-stage project manager is refused while a running crew's stage is unmerged. The PM then moves only the crews that depend on the slice, and haven't started, one stage later; running crews and crews that don't depend on it keep their stage. The run-level `approval` and `approvedAt` don't change. The slice waits for the client only when one of the client triggers in step 4 applies: the PM then sets the crew's `clientApproval` to `"pending"`, and to `"approved"` when the client answers. Otherwise the slice starts like any crew.
9. Pre-merge review: A checking engineer reads each crew's final report and the plan, and checks for drift and duplicate work between crews (two crews may share a file).
10. Sized merge: Each crew merges under the gate its `process` names. A `solo` or `lean` crew in a mixed goal merges through `factory.ts land --slug <slug>` (step "Merge" below): it asks for a red record only when `red` is true, and for a QC PASS only when `qc` is true, so a `solo` crew needs neither. A `full` crew merges only on a QC PASS, as follows. The PM reads the crew's newest QC file modified at or after `approvedAt` itself, under the folder of the crew's newest project manager (`<slug>` or its latest successor `<slug>-<n>`), and merges only on a `VERDICT: PASS` with no `- UNSCOPED: ` finding whose `## Proof checked` `Head: ` matches the crew branch head, or whose `Patch: ` matches the branch's patch id with the project manager's checks re-run green on the merged head (`skills/run/SKILL.md`, section 9, "Merge"). In `sequential` mode each project manager in turn merges the target into its crew branch (`git merge <target>`, a real merge, never a rebase; ADR-0015 item 11), a fresh QC engineer rules if the head moved and the patch id changed, and the PM fast-forwards with `git merge --ff-only`. In `single` mode an integrator merges every crew branch into `truss-<short goal>` and an integration QC engineer rules on it.
11. End-of-run report: Crew summaries and what merged where, checks and verdicts, decisions and checking engineer overrules, the items the end-of-run sweep kept (a checking engineer drops the rest), and the high-impact files that changed. The PM then asks before every push and PR, unless the project grants it merge ownership. Production deploys always go to the client.

### The Workflow path (ADR-0009)

[ADR-0009](adr/0009-workflow-factory.md) gives Truss a second crew engine. Its files exist: `bin/factory.ts`, `workflows/roles.json`, `workflows/plan.js`, `workflows/stage.js` and `agents/planning-engineer.md`. The steps 0 to 11 above stay as the project manager path, the fallback. When the PM's session has the Workflow tool, planning runs as a Workflow script, and every crew whose goal file's `## Engine` section says `workflow` runs as one too (Decision 1, "start, engine split"):

```mermaid
flowchart TB
  fore["PM<br/>[main session: skills/run/SKILL.md]"]
  cli["factory CLI<br/>[script: bin/factory.ts, node]"]
  planwf["plan workflow<br/>[Workflow script: workflows/plan.js]"]
  stagewf["stage workflow<br/>[Workflow script: workflows/stage.js]"]
  roles[("roles table<br/>[workflows/roles.json]")]
  hook["Workflow gate<br/>[hook: hooks/register.ts]"]
  agents["Workflow agents<br/>[design engineer, checking engineer, planner, members, stress test, QC engineer, runner]"]
  wfrec[("journal.jsonl, agent-*.meta.json, agent-*.jsonl<br/>[Workflow transcript dir]")]
  fdir[("plan.json, decisions.md, events.jsonl, reports/<br/>[Truss dir]")]
  git[("crew branches, target<br/>[git]")]

  fore -->|"start, plan-args, settings: prints args JSON"| cli
  cli -->|"reads"| roles
  fore -->|"Workflow call with scriptPath and args"| hook
  hook -->|"lets through"| planwf
  hook -->|"lets through"| stagewf
  planwf -->|"agent() with role's model and effort"| agents
  stagewf -->|"agent() with role's model and effort"| agents
  agents -->|"runner runs check, integrate"| cli
  agents -.->|"recorded by the harness"| wfrec
  fore -->|"plan-write, finish"| cli
  cli -->|"reads results, models, efforts"| wfrec
  cli -->|"plan files, status, decision lines, spawn and report events, QC files"| fdir
  cli -->|"worktree add, merge, ff-only to target"| git
  hook -->|"reads plan, crew status"| fdir
```

*The Workflow engine's parts and what passes between them, as designed.* Traces to: `docs/adr/0009-workflow-factory.md:94-121` (the diagram, copied), which traces to `hooks/register.ts`, its line numbers re-taken at `f01caf4`: `:1928-2003` (the Agent gates it mirrors), `:400-438` (`gateOf` and `planVerdict`), `:619-684` (`qcRuling`, `patchIdOf` and `headVerdict`, with `branchOf` and `examinedVerdict` between them) and `:1029-1087` (`fencedBlock` and the plan-file route); and to the probe run's `journal.jsonl` and `agent-*.meta.json`. ADR-0009's own caption keeps the line numbers it took when it was written.

```mermaid
sequenceDiagram
  participant F as PM
  participant C as factory.ts
  participant H as Workflow gate hook
  participant W as stage.js
  participant A as Workflow agents
  F->>C: start --stage next
  C->>C: planVerdict per crew, status running, worktree, spawn line
  C-->>F: args JSON
  F->>H: Workflow(scriptPath stage.js, args)
  H->>H: crews running and planVerdict clean, roles valid
  H-->>W: let through
  W->>A: runner: factory.ts check --expect red
  W->>A: planner: tasks
  W->>A: tester, then builders (worktree each)
  W->>A: runner: integrate, check --expect green
  W->>A: stress test (if yes), QC engineer
  W-->>F: per crew: passed or stopped
  F->>C: finish --transcript dir
  C->>C: record reports and events, audit models, merge gate, ff target, status merged
  C-->>F: merged, needs-rework, refused
```

*One stage on the Workflow path, from start to merge, as designed.* Traces to: `docs/adr/0009-workflow-factory.md:125-147`, which traces to `skills/run/SKILL.md` sections 6 and 9, `agents/project-manager.md` sections 1, 3, 6, 7, 9 and 12, and the probe's `journal.jsonl`.

The run on this path, step by step (ADR-0009, Decision 7, "The PM's procedure"):

- **Plan (step 4).** The PM writes the brief to `<truss dir>/plan-brief.md` and runs `factory.ts plan-args`, then `Workflow(plan.js)`, then `factory.ts plan-write` and `plan-check`. `plan.js` runs `truss-designer` and `truss-checker`, with no reconcile round (a gameable acceptance test the checking engineer finds sends the PM back to the plan step with the findings); client items are collected and returned, never asked from the script. A failed `plan-check` gets one fix run (`truss-designer-3`, `truss-checker-3`, no reconcile), and a second failure goes to the client (Decision 3). `plan-write` overwrites an unapproved `plan.json`; over an approved one it refuses while any crew of it is `running` or `planned`, and otherwise, under the `plan` lock, renames `plan.json` and `plan.md` to `plan-<stamp>.json` and `.md`, where `<stamp>` is the first 20 letters and digits of `approvedAt` (a `-<n>` suffix when the name is taken), before it writes the new plan; `decisions.md` and `usage.jsonl` are left as they are, so a second run in one truss dir shares them (`keepExisting` in `cmdPlanWrite`, `bin/factory.ts`); only a plan already approved at the first unlocked check is archived, so an approve that lands during the `plan` lock wait is refused with "kept the existing plan: it is approved".
- **Approval (step 5).** Merge mode and target are read from `.claude/truss.json` by `factory.ts settings` (missing `merge` is `sequential`, missing `target` is the current branch), shown in the plan table as information and logged; the PM never asks for them, in either kind of run. This repo's `.claude/truss.json` holds `"merge": "sequential"` and `"target": "main"` beside `architecture` and `adr`. Approval itself stays: a plan with `approval: "client"` still waits for the client (ADR-0044 decoupled that from stage 0), and since [ADR-0045](adr/0045-approve-proof.md) the client's typed `/truss:inbox approve` of the plan's `client-trigger` item sets `approvedAt`; the PM never runs `approve --by client`. The question is deleted from `skills/run/SKILL.md` section 5 itself, so step 5 above stops asking it once `run-procedure` merges.
- **Start (step 6).** `factory.ts start --stage next` applies `planVerdict`, marks each workflow crew `running`, makes its worktree `.claude/worktrees/truss-<slug>` on branch `truss-<slug>`, appends a `by: "factory"` spawn line, and prints the `stage.js` args. Project manager crews come back under `projectManagers`, and the PM starts and merges them as on the project manager path. From [ADR-0031](adr/0031-right-size-process.md) (Decision 6, designed), a `solo` or `lean` crew comes back under a top-level `direct` key, as `{slug, process, qc, red, worktree, branch}`, and never in `truss.crews`, the Workflow args. `start` makes its worktree, marks it `running` and logs `started direct crew <slug> (process <p>) ...`, but appends no `by: "factory"` spawn line, so `finish` never picks it up. `start` counts all three kinds against `maxParallelCrews` (Decision 1, `start`).
- **Inside each crew (step 7).** `stage.js` runs each crew's chain, `agents/project-manager.md` sections 1 and 3 to 9 as code: red first (`check --expect red`), split (the planning engineer), members (testers before builders, each `integrate`d by the runner), green with the escalation ladder in code, stress test when the goal file says yes, `owns-check`, then a fresh QC engineer (Decision 4). Since [ADR-0046](adr/0046-factory-throughput.md) items 6 and 7, the reply checkpoint, UX review and stress test come before the knowledge step, and the knowledge step and its lint re-run after each QC fix round. From [ADR-0014](adr/0014-retro-fixes.md) (proposed, Decision 4), a QC or stress finding that names a file a tester task owns goes to a tester fix member, `<slug>-tester-<n>`, and a fix builder's "Files you may change" leaves out the tester tasks' files. A stopped crew returns its tag and text; the PM handles it as in step 8 and restarts it with `start --slug <s> --resume answers` (Decision 4, "Restarts"). From [ADR-0046](adr/0046-factory-throughput.md) item 5, every resume carries the crew's earlier rulings still unbuilt (`<truss dir>/crews/<slug>/answers.json`, `carriedAnswers` in `bin/factory.ts`), so the PM's answers file holds only the new ones.
- **Resume ([ADR-0048](adr/0048-resume-guard.md)).** `start --slug <s> --resume <kind>` first takes the crew's finisher lease and refuses with `{slug, why: "finisher live"}` while another finisher holds it; it releases the lease when it returns (`cmdStartResume`, `bin/factory.ts:2133-2135`, `:2191`). It then merges the target into the crew branch with `mergeIn`, as `sync` does; on a conflict `mergeIn` aborts the merge, leaving the worktree clean, and the paths go on the crew entry as `syncConflicts` (`cmdStartResume`). A merge, rebase, cherry-pick or revert already in progress in the worktree (the resolver's) is neither merged into nor aborted: its unmerged paths become `syncConflicts` and `sync` refuses with `inProgress` (`cmdStartResume`, `cmdSync` `bin/factory.ts:1015-1018`; ADR-0048 item 6). The sync runs before the answers are carried (ADR-0046 item 5), so `carriedAnswers` and `doneTasks` read the synced branch. In `stage.js`, `chain` runs `syncStep` first on every resumed run, before the red check and any member (`workflows/stage.js:2498`). `syncStep` runs `sync --slug <s>`; a conflict goes to the resolver and the sync runs again, and a sync still unmerged stops the crew `BLOCKED` at `R1` (`syncStep`, `workflows/stage.js:2464-2471`). `finish` takes the same lease for each crew it records: a crew whose finisher is live is listed under `refused` with `why: "finisher live"` and is not merged, and the leases are released on every return and throw (`cmdFinish` and `finishRun`, `bin/factory.ts:3471-3476`, lease taken at `:3502`, refreshed before each merge in `mergeCrew` at `:3360`).
- **Merge (steps 9 and 10).** A `solo` or `lean` crew merges through `factory.ts land --dir D --repo R --slug S` ([ADR-0031](adr/0031-right-size-process.md), Decision 6, designed). `land` runs `mergeCrew`'s steps with the red gate on only when `red` is true and the QC gate on only when `qc` is true: worktree on `truss-<slug>`, `owns-check`, the gates its booleans name, the target merged in, `check --expect green` on the merged head when `red` is true or the QC head moved, the fast-forward, `status` `merged`, and the decision line `crew <slug> merged into <target> at <head> | land: process <p>, qc <bool>, red <bool>...`. It exits 0 with `{merged: true, ...}`, 1 with `{merged: false, slug, why}` on a refusal (a `full` or absent `process` included), and 2 on a usage error or a `single`-mode repo. A `full` crew merges through `finish` as follows. `factory.ts finish` records each agent's report under `reports/<slug>/<label>.md`, audits every agent's real model and effort, then merges in plan order: the newest QC file this run must be a PASS with no UNSCOPED line, the red record `checks/<slug>-<n>.json` must exist, `qcFails` must not exceed `reworkAllowance`, and the head or patch must match under `mergeHeadVerdict`, a fail-closed wrapper around `headVerdict`. It fast-forwards the target locally and never pushes (Decision 1, "finish, merge step"). Only `merge: sequential` is supported on this path; a `single` run is all project manager path.
- **Goal check (step 9).** Once a goal's last crew merges, the PM runs `factory.ts goal-check --dir D --repo R [--goal ID]` (`cmdGoalCheck`, `bin/factory.ts`). It takes the plan's `goalCheck`, or with `--goal` that goal's own, and exits 2 when there is none. It resolves the target from `settingsOf` to a commit, adds a detached worktree at it under a fresh `mkdtemp` dir, runs the command there with `bash -c`, then removes the worktree, prunes and deletes the temp dir whatever the result. It appends one decision line, `goalCheck[ of <id>] passed|failed (exit <n>) at <target> <sha12> | run by factory goal-check in a temporary worktree`, and prints `{ok, goal, target, head, exit, output}` with the last 4000 characters of output, exiting 1 when the check fails. It never runs in the main checkout, never pushes and never moves a branch. It checks only the target's head, so in `single` mode the integration branch check stays a hand-run in the integrator's worktree.

The stress-test bound is an open client decision: whether every stress-test round after a crew's first counts against `reworkAllowance` on the Workflow path (ADR-0009, Client decisions, item 1; the ADR recommends yes, and `stage.js` step 5 is written that way). While a stage runs, `/truss` doesn't see its agents; they show in `/workflows`, and `/truss` fills each crew in when `finish` records it (ADR-0009, Consequences).

#### Resource-aware sizing (ADR-0015, proposed)

[ADR-0015](adr/0015-resource-aware.md) adds a module, `resources/index.ts`, and three factory commands. It is built: `resources/index.ts` and the factory commands `admit`, `heavy` and `reap` in `bin/factory.ts`.

```mermaid
flowchart LR
  PM[PM] -->|start| F[factory.ts]
  S[stage.js runner calls] -->|admit, heavy, reap| F
  F -->|sample, admits, heavy lock| R[resources/index.ts]
  R -->|imports takeOver| ST[bin/store.ts]
  F -->|reads| P[(resources/parallelism.json)]
  F -->|lock and pgid records| H[(resources/heavy.lock, resources/groups)]
  PM -->|Agent call| M[truss:resource-monitor, haiku]
  M -->|runs| R
  M -->|RECOMMEND parallelism n| PM
  PM -->|Write| P
```

- **Sampler.** `sample()` returns `freeMB` and `totalMB` from `os.freemem()` and `os.totalmem()`, plus `cpus` and `load1`. It leaves `load1` out where `os.loadavg()` is all zeros (Windows). `TRUSS_SAMPLE` (a JSON file, or `error`) and `TRUSS_MIN_FREE_MB` are its test seams. The default threshold is 2048 MB.
- **Admission.** `admit --slug S` exits 0 when admitted and 1 when held. A planned crew is also held while the running crews fill the effective parallelism. `start` applies the same rule and lists held crews under `held`; they stay `planned`. `stage.js` runs `admit` as a runner call before every non-runner spawn, and stops the crew `BLOCKED` with text `held by admission: ...` when it's held.
- **Heavy slots.** Only the runner-run red and green checks go through `heavy`; members' own builds and tests don't (a proven gap for the plugin fix goal). [ADR-0017](adr/0017-member-heavy-commands.md) (proposed) picks a member-side heavy path: each member brief would carry one literal `factory heavy` line. It isn't built yet. Up to `heavySlots` heavy runs go at once ([ADR-0046](adr/0046-factory-throughput.md) item 4): the truss.json key, else `TRUSS_HEAVY_SLOTS`, else `max(1, min(4, floor(cpus/4), floor(totalGB/8)))` (`heavySlotsOf` in `bin/factory.ts`, `defaultHeavySlots` in `resources/index.ts`). Slot 1 is the lock `D/resources/heavy.lock/`, slot n is `D/resources/heavy-<n>.lock/`; a heavy run takes the first free one, and a lock whose owner pid is dead is stale. The slots are not FIFO. One `heavy` run waits at most `HEAVY_WAIT_MS` (540 s, under the 600 s Bash timeout, `bin/factory.ts` `heavyWaitMs`); `check()` in `stage.js` runs it up to `HEAVY_WAIT_ROUNDS = 3` times with no sleep between rounds, about 27 minutes, then stops the crew BLOCKED with `heavy slot busy:`. A crew can still lose every round. `takeHeavySlot` and `releaseHeavySlot` take the platform as a parameter, and on win32 `releaseHeavySlot` removes the lock with `maxRetries: 5, retryDelay: 20` (`resources/index.ts` `releaseHeavySlot`).
- **Reaping.** `heavy` starts its command in a new process group and records it under `D/resources/groups/`. `stage.js` runs `reap --label <slug>-check` after each non-runner spawn and when the crew ends. Since [ADR-0046](adr/0046-factory-throughput.md) item 1 the reap after a spawn costs no runner spawn: it rides as `--reap-first <slug>` on the crew's next factory call, and `factory.ts` reaps before running that command (`takeReapFlag`, `reapFirst`); only the crew-end reap is a call of its own. `reap` signals only the recorded groups, never by name. The same item has green, owns-check and the tests check skip a re-run while the crew head has not moved since they passed (`crew.moves`, set from the head `integrate` and `sync` print).
- **Gates call.** Since 0.29.0 (ADR-0046 item 1) the checks before QC are one runner call: `factory gates --slug S --steps green,owns,tests,lint,admit` (`gatesMain`) runs the named steps in order, each as its single command would (green through `heavyMain`), stops at the first unmet one (`gateMet`) and prints `{ok, stopped, gates, codes, head, env, heavy, steps}`, each `steps` body being the single command's output. `stage.js` `gates(crew, want)` sends only the due steps (none when fewer than two are due) and caches the results in `crew.gates` with the move count; `check`, `scope`, `testsGuard`, `knowledgeLint` and `admit` take theirs with `takeGate` and fall back to the single command. `runFactory` drops the cache (`dropGates`) on any other factory call.
- **Parallelism.** `D/resources/parallelism.json` holds `{"parallelism": n}`, used only when `n` is an integer from 1 to `maxParallelCrews`. The PM starts `truss:resource-monitor` at each stage start and when `held` or a `held by admission:` stop reaches it, then writes the file itself.
- **Out of scope.** The project manager path (`agents/project-manager.md`) gets only `start`'s admission. Proof covers Linux only.
- **Holds before memory (0.25.0).** `admission(dir, repo, plan, crew, command, running)` runs `holdOf()` first (`holdOf`, `admission`, `bin/factory.ts`). `blockingFor` from `bin/inbox.ts` gives `awaiting: true` while a blocking inbox item names the crew. Then, only when `budget` in `.claude/truss.json` is an object, `budgetVerdict` from `bin/cost.ts` gives `budget: true` with `scope`, `spentUsd`, `limitUsd` and `why`, a `budget-hold` event and a `budget` escalation. A failed escalation never lifts the hold; its error goes into the hold's `escalateError` field. Free memory, memory pressure, swap and parallelism are checked only after that. `stage.js` `admit()` runs `admit --wait-ms 90000`, which re-checks only a memory hold, every 2 s inside factory (a budget or awaiting hold refuses at once; `cmdAdmit` loop, `bin/factory.ts`), and maps the answers to `BLOCKED: budget: <why>`, `BLOCKED: awaiting client: <why>` and `held by admission: <why>`. On exit 2 `store busy` it retries once, straight away: factory's own 5 s lock wait (`withLock`) is the pause, since a Workflow script has no timers (`admit`, `workflows/stage.js`). `start` output has no top-level `entries`: full crews are in `truss.crews`, direct crews in `direct`, project manager crews in `projectManagers`, held ones in `held` with `why`.
- **Owns and trailers (0.26.0, gates).** `factory.ts owns-extend --slug S --glob G --reason R` adds a glob to a crew's `owns` under the `plan` lock and appends a decision line (`cmdOwnsExtend`); it replaces hand-editing `plan.json`. Since [ADR-0043](adr/0043-crews-share-files.md) neither `owns-extend` nor `plan-check` refuses `owns` that overlap another crew's, in one stage or across goals, and `plan-check` no longer requires a crew of each stage to own a matched rule file. `integrate` refuses a non-merge commit with neither `Truss-Crew` nor `Truss-Role` that the target does not already hold (`untrailered`, `bin/factory.ts`). `mergeCrew` refuses a target that is not a local branch and says how to fix it (`mergeCrew`, `bin/factory.ts`). `holdOf` uses the budget verdict's `ref` when it carries one (`holdOf`, `bin/factory.ts`). `untrailered` fails closed: an unreadable `git log` range refuses with a `why` containing "trailers are unchecked" (`untrailered`), and `stage.js` `integrateNow` stops BLOCKED on a `why` with no `conflicts`, but sends an `inProgress` refusal to the resolver (`integrateNow`, `workflows/stage.js`). `plan.json` writers all take the `plan` lock (`patchPlan` re-reads under it, `cmdPlanWrite` re-checks inside it that no approve landed since its first check; only a plan already approved at that first check is archived, `keepExisting`), and `savePlan` goes through `writeJsonAtomic`, so unlocked readers never see a truncated file (`bin/factory.ts:98-103`).
- **Work type in the plan (0.25.0).** `plan.schema.json` forbids a crew `workType` below version 4 (the crew `not`/`anyOf` list, line 136), and `cmdPlanCheck` says `workType is version 4 only` (`bin/factory.ts:641`). It also checks the value against the repo's work-type profiles and requires a `workType` on every crew while the session is unattended (`workTypeErrors`, `bin/worktypes.ts:54-65`). The enum `WORK_TYPES` lives in `bin/factory.ts:558`. `state.schema.json` holds the stored row shapes as `$defs`: `inboxOp`, `ledgerRow`, `usageRow`, `usageCursor`, `queueItem`, `unattended` and `ltcPlan`. In `stage.js`, `qc()` returns `longTermCosts` only when the QC text holds a long-term cost line (`workflows/stage.js:2305`).
- **LONG-TERM-COST lines ([ADR-0034](adr/0034-long-term-cost-guard.md)).** `ltcLines(text)` reads a line that starts, after any bullet, number, quote, bold, italic or code markup, with the case-sensitive marker `LONG-TERM-COST:` (`LINE_RE`, `bin/guard.ts:16`); `ltcLinesOf` in `workflows/stage.js:2202` holds the same regex. The line's fields are `<what> | later: <the cost> | reversal: cheap|costly|irreversible`. A body that is only `none`, `n/a` or `-` is no cost (`NONE_RE`, `bin/guard.ts:18`). A bare marker or an empty `what` is kept as `(unnamed cost)`, and a missing or invalid reversal counts as `costly` (`bin/guard.ts:37-38`), so a sloppy line blocks rather than slips through. `ltcCrewGate` escalates every line not marked `cheap`, plus the triggers `ltcTriggers` finds in the diff (a dependency added to a `package.json`, a file added under a `migrations/` dir, matched case-insensitively, a new `*.sql`, `*.schema.json` or `schema.*` file), and refuses the merge until each item is resolved `approve` (`ltcTriggers`, `bin/guard.ts:61-112`; `ltcCrewGate`, `bin/guard.ts:187-204`).

## The client brief (ADR-0008)

[ADR-0008](adr/0008-owner-interview.md) adds a module that asks the client about requirements before the plan, and a requirements ledger that carries them from run to run. It is built: the skill is `skills/brief/` (`SKILL.md`, `branches.md`), the CLI and ledger code are `brief/cli.ts` and `brief/ledger.ts`, and section 1 of `skills/run/SKILL.md` (`:89`) runs the skill before the plan.

| Part | Path | What it does |
| --- | --- | --- |
| `truss:brief` skill | `skills/brief/SKILL.md` | Followed by the PM in the main thread; the only part of Truss that calls `AskUserQuestion` (Decision 1) |
| Branches | `skills/brief/branches.md` | The questions, one `## <id>` section per branch with `Pack`, `Visit`, `Fact`, `Ask`, `Recommend`, `Writes` and `Opens` lines; core branches such as `hosting`, `integrations`, `auth` and `secrets`, and at least two per non-core pack (Decision 5) |
| Ledger code | `brief/ledger.ts` | Pure functions over the branches, the state file and `requirements.md` (Seams 1 to 4) |
| CLI | `brief/cli.ts` | `next`, `remaining`, `check` and `trace`, run as `node <plugin>/brief/cli.ts <command> ...` (Seam 5) |
| Fact-finder | an `Agent` call, `roles.search` or `general-purpose`, Sonnet at `low` | The one new agent: reads the repo and reports `FACT:`, `UNKNOWN:` and `SPEC:` lines, never a decision (Decisions 4 and 10) |

```mermaid
flowchart LR
  client["Client<br/>[person]"]
  fore["PM<br/>[main thread: skills/run + skills/brief]"]
  facts["Fact-finder<br/>[subagent: general-purpose or roles.search, sonnet, low]"]
  cli["brief/cli.ts<br/>[CLI: Node, no deps]"]
  req["docs/requirements.md<br/>[file in the project repo]"]
  state["brief.json<br/>[file in the Truss dir]"]
  arch["truss:design-engineer<br/>[subagent: plan and init modes]"]
  goals["goals/slug.md<br/>[files in the Truss dir]"]
  client -- "answers via AskUserQuestion" --> fore
  fore -- "goal, branch Fact lines" --> facts
  facts -- "FACT / UNKNOWN / SPEC lines" --> fore
  fore -- "next, remaining, check, trace" --> cli
  cli -- "reads" --> state
  fore -- "writes, commits" --> req
  fore -- "R-ids of this run" --> arch
  fore -- "quotes R-n lines" --> goals
```

*The client brief's parts, as ADR-0008 designs them.* Traces to: `docs/adr/0008-owner-interview.md:32-52` (the diagram, copied), which traces to `skills/run/SKILL.md:8` (only the PM talks to the client) and section 3, "Hire the personas the goal needs" (the design engineer brief); the rest is new. The `docs/requirements.md` node shows the ADR's recommended location, which is an open client decision (below).

```mermaid
sequenceDiagram
  participant O as Client
  participant F as PM
  participant X as Fact-finder
  participant C as cli.ts
  participant A as Design engineer (plan)
  F->>O: altitude question (section 1)
  F->>X: goal + branch Fact lines
  X-->>F: FACT / UNKNOWN / SPEC
  loop until NEXT: none or stop
    F->>C: next ... 3
    C-->>F: NEXT: lines
    F->>O: AskUserQuestion, recommended first
    O-->>F: answers
  end
  F->>C: check requirements.md
  F->>F: commit docs(req)
  F->>A: brief + R-ids
  A-->>F: plan.md with Requirements column
  F->>C: trace ... goals
```

*One run from goal to the first project manager, with the client brief in place, as designed.* Traces to: `docs/adr/0008-owner-interview.md:177-200`, which traces to `skills/run/SKILL.md` sections 1 to 3 and section 4, "Draft the plan"; the client brief steps are new.

How it runs (ADR-0008, Decisions 2 to 9):

- **Hook point.** A new `### Brief the client` at the end of `skills/run/SKILL.md` section 1, after the client picks the goal and before the depth pass: the PM runs the skill with args `<goal> | <truss dir>/brief.json | <requirements path>` (Decision 2).
- **Size.** The PM sizes the goal `small`, `standard` or `large` and logs it. A small goal gets no fact-finder and no questions, only one functional requirement written from the goal (`Source: goal`). Greenfield, a new product, service or module, an external service, a stored data shape, or three or more non-core packs make it `large`. Nothing but the client brief reads the size; whether process size follows it is left to ADR-0009 (Decision 3).
- **Facts first, then questions.** For `standard` and `large`, the fact-finder runs before any question. A fact settles a branch as context for the design engineer and never becomes a requirement; only decisions do (Decision 4). `cli.ts next` returns up to three candidate branches, stopping after the first that can open others, so the next question depends on the last answer; the PM asks them in one `AskUserQuestion` call with the recommended answer first and `Stop the brief` last (Decision 5).
- **Stop.** The client brief ends on `NEXT: none`, a small goal, or the client's stop. What happens to the branches never asked is an open client decision: ADR-0008 designs filling them with the recommended answers as `Source: default` requirements, and recommends that, but the client hasn't ruled (Client decisions, item 1; Decision 6). The checking engineer never answers for the client.
- **Tracing.** The plan design engineer's brief gets the requirements path and this run's R-ids; `plan.md`'s crew table gains a `Requirements` column, and every run R-id is served by a crew or listed under `Unserved:`; `plan.json` and `plan.schema.json` don't change. Each goal file gains a `## Requirements` section quoting its R-n lines exactly, checked by `cli.ts trace` before the first project manager starts. The QC engineer needs no change: the goal file is already approved scope (Decision 8).
- **Greenfield.** With no code outside `docs/`, `.claude/`, `README*`, `LICENSE*`, `.gitignore` and `.gitattributes`, section 0 runs the client brief at size `large` before `truss:init`, and passes `Greenfield: <repo>/docs/requirements.md` to the init design engineer, which then maps planned modules citing R-ids (Decision 9).

Seams the build crews pin (ADR-0008, Seams; the tests are `tests/contract-interview.check.ts`, `tests/interview-skill.check.ts` and `tests/interview-wiring.check.ts`, none of which exists yet):

| Seam | Producer | Consumer | Contract |
| --- | --- | --- | --- |
| `brief/ledger.ts` exports `PACKS`, `parseBranches`, `remainingBranches`, `nextBranches`, `parseRequirements`, `goalRequirementLines`, `checkTrace` | `interview-ledger` crew | `cli.ts`, tests | ADR-0008 Seams 1 to 4; erasable TypeScript, Node built-ins only (P19) |
| `brief/cli.ts` `COMMANDS` and `main(argv)`: `next` 2-3 args, `remaining` 2, `check` 1, `trace` 3; `NEXT:`, `OK:`, `ERROR:`, `TRACE:` lines; exit 0, 1 or 2 | `interview-ledger` crew | the client brief and run skills | ADR-0008 Seam 5 |
| `skills/brief/branches.md` and the skill's `# Requirements` example | `interview-skill` crew | `cli.ts`, the PM | ADR-0008 Seam 6 |
| `cli.ts` calls and the goal-file `## Requirements` example in `skills/run/SKILL.md` | `interview-wiring` crew | the PM | ADR-0008 Seam 7 |
| `requirements.md` | the PM, through the client brief | the fact-finder (as `SPEC:` lines), the plan design engineer, goal files, `trace` | `parseRequirements` and its error strings, ADR-0008 Decision 7 |

## On disk

Truss keeps its state in two folders under the git common dir. A session folder D, `<git common dir>/truss/<session id>/`, holds what one session owns. From 0.25.0 a shared folder S, `<git common dir>/truss/shared/`, holds what every session of the repo reads and writes: the inbox, the merge ledger and the work queue (`sharedDir`, `bin/store.ts:131`). Every write to S goes through `bin/store.ts` under a lock in `S/locks/`.

```
<git common dir>/truss/shared/
  inbox.jsonl                inbox.ts (ADR-0037): append-only open, link, resolve and applied ops of every session,
                             written under locks/inbox.lock
  ledger.jsonl               ledger.ts (ADR-0038): one merge row per crew merge, appended under locks/ledger.lock
  queue/items/<Q-id>.json    queue.ts (ADR-0039): one work-queue item per file; <Q-id> is Q- plus 12 hex characters
                             of the sha256 of the item's source key; changed under locks/queue.lock
  locks/<name>.lock/         store.ts withLock: the lock dir, with owner.json { pid, host, token, since }
  locks/<name>.lock.break/   store.ts: the mutex one breaker holds while it removes a stale lock

<git common dir>/truss/<session id>/
  usage.jsonl                cost.ts (ADR-0038): this session's usage rows swept from its transcripts, once per msgId
  usage-cursor.json          cost.ts: how far each transcript was swept, plus the Claude Code cost estimate
  locks/usage.lock/          cost.ts: the sweep's lock, held by sweep()
  locks/finisher-<slug>.lease  store.ts takeLease (ADR-0048): the crew's finisher lease,
                             { pid, host, since, refreshed, token }, held by finish and start --resume
  locks/finisher-<slug>.lease.break/  store.ts: the mutex one breaker holds while it removes a stale lease
  unattended.json            queue.ts (ADR-0039): { since, item } while a --next run is unattended
  ltc-plan.json              guard.ts (ADR-0034): { rev, ids }, the long-term cost items of the plan revision
  decisions.md               PM: one line per decision, `- HH:MM | decision | reason | checker | followed`
                             (a `## Run <start> | <goal>` heading per run; grammar below)
  events.jsonl               plugin: one line per spawn, stall, tag and final report
                             (and one per WebFetch or WebSearch call, while plan.json exists)
  events.<n>.jsonl           plugin: the event log rolled over, past 3 MiB
  plan.md                    PM: the approved plan, written once the client approves
                             (the design engineer drafts it with plan.json; the PM owns it after that.
                             The plugin writes the draft from the plan-mode design engineer's hand-back, ADR-0015 item 9)
  plan.json                  the design engineer drafts it; the PM owns it after that; hooks only read it.
                             The plugin writes the draft, with approvedAt null, from the plan-mode
                             design engineer's hand-back (ADR-0015 item 9); `plan-write` first moves an approved
                             plan aside as plan-<stamp>.json and .md, and refuses while one of its crews is running
  plan-<stamp>.json, .md     plugin (plan-write): an earlier run's approved plan, kept when a second run plans
  goals/<slug>.md            PM: each crew's goal, acceptance test, owned files, high-impact paths
  reports/<crew>/<agent>.md  plugin: each crew agent's last report, QC engineers' included
  reports/<crew>/<agent>.interim.md  plugin: a project manager's interim stop, or a QC engineer's follow-up
  messages.jsonl             plugin: project-manager-to-project-manager messages
  messages.<n>.jsonl         plugin: the log rolled over, past 3 MiB
  scratch/                   design engineer: plan-mode scratch output
  scratch/truss.candidate.json  init: the config it would write, validated before the write (ADR-0002)
  brief.json                 ADR-0008, PM: the client brief's state for the run's first goal
  checks/<slug>-<n>.json     factory.ts check (ADR-0009): one record per acceptance-test run on the Workflow path
                             (ADR-0012: and a catalog key when the output hits a known problem)
  retro/extract.json         ADR-0012, factory.ts finish and retro/cli.ts extract: the transcript extract
  retro/findings.json        ADR-0012, retro/cli.ts findings and recur: the judges' kept findings
  retro/state.json           ADR-0012, retro/cli.ts state: where the end-of-run retro is, step by step
  retro/upstream/<F-n>.md    ADR-0012, PM: a drafted plugin fix, on a project that isn't the truss repo
  resources/heavy.lock/      ADR-0015 (proposed), factory.ts heavy: the one heavy slot, with owner.json
                             { pid, token, label, slug, since }; delete it by hand only when no heavy runs
  resources/groups/<pgid>.json  ADR-0015 (proposed), factory.ts heavy: a heavy run's process group,
                             kept while the group may have live processes; factory.ts reap deletes it
  resources/parallelism.json ADR-0015 (proposed), PM: {"parallelism": n}, the effective parallelism
```

The unattended flag, `unattended.json`, stays per session in D, never in S: the AskUserQuestion hook reads only its own session's file, so an attended session in the same repo still asks its questions (`bin/queue.ts:303`, ADR-0039). `usage.jsonl` and its cursor stay in D too, since a sweep reads only its own session's transcripts (`bin/cost.ts:83-84`). Another session's state is read only through S: `factory inbox` lists the items of every session, and the retro skill reads `S/ledger.jsonl` filtered by its `session`.

A lock in `locks/` is a directory: `mkdir` fails while another process holds it. `withLock` waits up to 5 s by default, retrying every 25 ms, then throws `StoreBusy`, which the CLI prints as `{"error": "store busy: <name>"}` with exit 2 (`bin/store.ts:149`, `:231-233`). A lock is stale when its owner pid is dead on the same host or its `since` is over 120 s old (`STALE_AGE_MS`, `bin/store.ts:155`). One breaker at a time removes a stale lock, holding `<name>.lock.break`; a lock is never renamed aside (`bin/store.ts:185-230`). A lock with no `owner.json`, and an abandoned `.break` mutex, count as stale after 3 s (`OWNERLESS_MS`, `bin/store.ts:158`); that 3 s rule stays inside `withLock`'s default 5 s wait, so a waiter clears an ownerless lock before it gives up with `StoreBusy`. The writers also sweep orphan `<name>.<pid>-<uuid>.tmp` files of a dead pid older than 120 s (`sweepTmp`, `bin/store.ts:304`). Recover a lock left by a crashed process by waiting out the 120 s; delete a lock dir by hand only when no truss command of any session runs.

A lease is a file, not a directory ([ADR-0048](adr/0048-resume-guard.md)). `takeLease` creates `D/locks/finisher-<slug>.lease` with `createExclusive` and returns `null` while a live lease holds it (`bin/store.ts:467-498`). A lease is stale when its host is this host and its pid is dead (a live pid keeps its lease however old), or, for another host's lease only, when `refreshed` is over `LEASE_STALE_MS` (300 s) old (`bin/store.ts:398`, `:483`). `LEASE_REFRESH_MS` is 30 s (`bin/store.ts:399`), but no caller runs it as a timer: `finish` refreshes its leases before each crew's merge (`bin/factory.ts:3583`). One breaker removes a stale lease under `<name>.lease.break`, re-checking its token, and never renames it aside. A finisher that crashed leaves its lease; on the same host the next `finish` or `start --resume` recovers it at once when its pid is dead; a lease of another host waits out 300 s. A same-host lease whose pid was reused by another live process is never recovered, because no process start time is recorded: it blocks `finish` and `start --resume` for that crew with `finisher live` until that process exits or the file is deleted by hand.

**Stored shapes.** `brief.json` ([ADR-0008](adr/0008-owner-interview.md), Decisions 2, 5 and 7) is the client brief's state, rewritten by the PM with Write after each round: a string `goal`, a `size` of `small`, `standard` or `large`, arrays `packs`, `opened` and `requirements` (the R-ids this run accepted), an object `visits` (`{ "by": "fact" | "client" | "closed" | "default", "note" }` per branch id) and a boolean `stopped`; `cli.ts` exits 2 on a state file without them (Seam 5). The CLI takes the state path as an argument, so another goal can use its own file; only `<truss dir>/brief.json` is fixed.

`requirements.md` is the client brief's stored shape: one file per project, append-only by id, `## R-<n>: <title>` headings with `Status` (`open`, `met`, `dropped` or `replaced by R-<k>`), `Kind` (`functional`, `nfr` or `constraint`), `Added`, `Source` (`client`, `default`, `goal` or `repo:<path>`), `Example` and `Measure` lines, and a required `## Non-goals` section. `parseRequirements` is its contract. The PM writes it, commits it alone as `docs(req): ...` before the plan, marks ids `met` at the end of the run, and no crew owns or edits it (ADR-0008, Decision 7). It lives in the project repo, at `<dir of the architecture key>/requirements.md` (`docs/requirements.md` here and on a greenfield repo; `skills/run/SKILL.md`, section 1, "Take the client brief"), committed so crews' worktrees see it.

`checks/<slug>-<n>.json` ([ADR-0009](adr/0009-workflow-factory.md), Decision 1, `check`) holds the command, exit code, `git rev-parse HEAD` of the checkout and the last 40 lines of output. `check` adds a new file each time and never changes an old one; the crew's lowest-numbered file is its red record, and `finish` refuses a merge when it is missing or has `exit` 0 (Decision 1, "finish, merge step", item 1). On the Workflow path `factory.ts finish` also writes the crew agents' reports, `reports/<slug>/<label>.md`, from the Workflow journal's results, with each file's mtime set to the agent's last transcript timestamp so `latestQc`'s newest-file rule orders QC engineers truthfully; it never overwrites a report with different text (Decision 1, "finish, record step" and "start, allowance and label numbering across runs"). `factory.ts` also writes `plan.json` and `plan.md` (`plan-write`, the plan-file route's rules), the Workflow crews' `status`, and stamped decision lines (ADR-0009, "What moves where").

`retro/extract.json`, `retro/findings.json` and `retro/state.json` follow [`extract.schema.json`](extract.schema.json), [`findings.schema.json`](findings.schema.json) and [`retro-state.schema.json`](retro-state.schema.json). The extract and the findings quote transcript lines, so they stay inside `.git` with the truss dir and are never committed ([ADR-0012](adr/0012-self-improving-retro.md), R-32).

The plugin writes only `reports/`, the message logs, the event logs and the draft `plan.json` and `plan.md` it takes from the plan-mode design engineer's hand-back ([ADR-0015](adr/claude-ops/0015-agent-worktree-cleanup.md) item 9). The PM writes `decisions.md`, `plan.md` and `goals/`, as `skills/run/SKILL.md` tells it to; the plugin only stamps the time on new `decisions.md` lines (see Decision times).

The folder is `git rev-parse --path-format=absolute --git-common-dir` run in the session's working directory, plus `truss/<session id>`. Every worktree of a repo shares one git common dir, so all crews write to the same place. Outside git the base is `$HOME/.claude` (or `%USERPROFILE%\.claude`). The path is worked out once per session and cached; a `/clear` works it out again. Session ids, crew names and agent names pass through `safeName` in `register.ts`: each run of characters other than letters, digits, `.`, `_` and `-`, and each run of two or more dots, becomes `-`; runs of `-` collapse to one; leading and trailing `-` and `.` are dropped; the result is cut to 100 characters, and an empty result becomes `agent`.

A report file is named after the agent's spawn name, else its id, under its crew's folder. A QC engineer's report is `reports/<crew>/<crew>-qc.md`, then `<crew>-qc-2.md` and so on; those are the merge-gate files. A stress test is named `<crew>-stress` so its report never lands on one. A successor project manager `<slug>-2` is a crew of its own as far as the hooks go, with its own folder.

Each line of `messages.jsonl` is `{ "ts", "from", "to", "summary" }`, where `from` and `to` are crew names and `summary` is the `SendMessage` summary. Only messages between two project managers of different crews are logged. When the log is 3 MiB or more, the next append first copies it to `messages.<n>.jsonl` at the first free `n` and starts a new log.

### `events.jsonl`

Each line is one JSON object under [`events.schema.json`](events.schema.json): `{ "v": 1, "ts", "event", "crew", "agent" }` plus the event's own fields. `spawn` (a crew agent's or a project manager's `Agent` call that went through) adds `agentId`, `type`, `model`, `effort` and `by`; `stall` (a stall or idle-project-manager wake) adds `kind` and `minutes`; `tag` (a project manager's tagged message to `main`) adds `tag`; `report` (a final report saved) adds `marker`, the report's leading marker or null. No line holds message, prompt or report text. Appends are serialized like the message log's and roll at 3 MiB the same way; a failed append is logged and changes nothing else ([ADR-0003](adr/0003-event-log-and-retro.md), section 1).

One more event kind records a spent rework allowance: `{ "v": 1, "ts", "event", "crew", "agent" }` and nothing else, with `agent` the QC engineer whose FAIL spent it. It is appended after that QC engineer's `report` line, on a v2 or later plan, whenever a saved QC engineer FAIL leaves the crew's this-run FAIL count above `reworkAllowance`. `v` stays 1, because a new event kind isn't a renamed or retyped field. A crew can get the line more than once, so readers count distinct crews. The event name is fixed in [ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 3. Spawn lines gain no keys.

The `fetch` event records one `WebFetch` or `WebSearch` call ([ADR-0005](adr/0005-growth-model.md), section 11): `{ "v": 1, "ts", "event": "fetch", "crew", "agent", "tool" }` plus `url` when `tool` is `"WebFetch"` or `query` when it is `"WebSearch"`, never both. `crew` is the caller's crew slug, or `"main"` for a caller outside every crew (a `truss:*` agent the PM started, or the main session). `agent` is the agent's name, or `"main"` for the main session. The `url` keeps scheme, host, port and path; userinfo is removed, each query value becomes an empty string with its key kept, and the fragment is dropped (P8). The `query` is cut to its first 200 characters. The line is written only when the Truss dir resolves and holds `plan.json`, so a session that never ran Truss gets no event log from its fetches. `v` stays 1, as for the spent-allowance line. The schema branch is in [`events.schema.json`](events.schema.json). Examples:

```json
{"v":1,"ts":"2026-10-29T08:12:03.512Z","event":"fetch","crew":"growth-contract","agent":"growth-contract-designer","tool":"WebFetch","url":"https://example.com:8443/docs/api?version=&lang="}
{"v":1,"ts":"2026-10-29T08:12:41.090Z","event":"fetch","crew":"main","agent":"main","tool":"WebSearch","query":"example-cli export command flags"}
```

The first came from `https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth`.

The `refusal` event records one tool call refused before or as it ran (P24): `{ "v": 1, "ts", "event": "refusal", "crew", "agent", "tool", "source", "category", "program", "shape" }`. `crew` and `agent` are as for `fetch`. `source` is `truss` (truss's own hooks), `worktree-guard` (Claude Code's built-in confinement of a worktree-isolated agent, which is no plugin), `classifier` (the auto-mode classifier), `permission` (a permission rule, or the person said no) or `other` (another plugin's deny). `category` is the refusal's own reason with quoted names and paths taken out, cut to 100 characters. `program` is a Bash command's first word (else `null`), and `shape` lists the kinds of part its first line holds (`heredoc`, `compound`, `cd`, `subst`, `var`, `pipe`, `loop`); the command's text is never written. truss's own denies are logged where they are made (`refuse()` in `hooks/register.ts`); the catch-all `tool.call` hook reads every other answer, a deny or an errored result whose text is one of the engine's refusals, and counts each result once. Like `fetch`, the line is written only while `plan.json` exists. Pure functions: `refusalOf`, `commandShape`, `refusalLine`; pinned by `tests/refusals.check.ts` and `tests/test_retro_refusals.py`.

```json
{"v":1,"ts":"2026-10-31T06:12:03.512Z","event":"refusal","crew":"ui-stage1","agent":"ui-stage1-builder-2","tool":"Bash","source":"worktree-guard","category":"is too complex to verify that it stays inside the worktree","program":"mkdir","shape":["heredoc","compound"]}
```

On the Workflow path ([ADR-0009](adr/0009-workflow-factory.md)), `factory.ts` writes spawn lines in place of the Agent hook. `start` appends one per workflow crew it starts, `{"event":"spawn","crew":slug,"agent":slug,"agentId":null,"type":"workflow-crew","model":null,"effort":null,"by":"factory"}`, and `start --resume stale` appends a fresh one with a new `ts`. `finish` appends, for each crew agent of a run, a `spawn` line with the `agentId`, the meta file's `agentType`, the `model` and `effort` the transcript records and `by: "workflow:<run id>"`, plus a `report` line with `markerOf`'s marker (Decision 1, `start` and "finish, record step"). `finish` merges only crews that have a `by: "factory"` line, and a run with no `by: "workflow:<run id>"` line counts as not recorded. Both `by` values are strings the schema allows (Decision 8), so the spawn lines needed no schema change. `finish` without `--result` also appends `{"v":1,"ts":"...","event":"incomplete","crew":"<slug>","run":"<run id>"}` per crew in the run (`cmdFinish`, `bin/factory.ts`), with `agent` set to the crew slug. `incomplete` is in the schema's `event` enum, and its branch requires a `run` string and allows no other extra field (`docs/events.schema.json:11`, `:212-222`), so the line validates.

[ADR-0015](adr/0015-resource-aware.md) (proposed) adds the `sampler-error` event: `{ "v": 1, "ts", "event": "sampler-error", "crew", "agent", "command", "error" }`, with `crew` and `agent` both the crew slug. `factory.ts admit`, `heavy` or `start` (named in `command`) appends it when the sampler throws and the start goes ahead anyway. `error` is the error's message, cut to 200 characters. The schema branch requires both fields and allows no other extra field. No producer writes the line yet; crew `factory-resources` builds it.

```json
{"v":1,"ts":"2026-10-31T12:00:00.000Z","event":"sampler-error","crew":"q","agent":"q","command":"admit","error":"TRUSS_SAMPLE=error"}
```

### `decisions.md` grammar

```
# <optional title>
## Run <RFC 3339 start> | <goal>
- HH:MM | <decision> | <reason> | <checker> | <outcome>
- HH:MM | checker-<n> RECOMMEND <answer|defer|pass>: <text> | <outcome>
```

The PM writes every line through `factory.ts decide --dir <absolute truss dir>` ([ADR-0027](adr/0027-retro-fixes2.md), F-73), never with Edit or Write. It has one form per line kind: the four-field decision line, the `checker-<n>` line and the `## Run` heading. decide stamps `HH:MM` with the clock's local time and `<start>` with the clock's UTC time, and appends one line. It exits 2 and writes nothing on a newline in any value, on a relative `--dir`, and, in the decision form only, on a field count other than four. The grammar has no continuation lines: decide refuses a newline, and the retro counts read only `## Run` headings and `- ` lines, so a continuation line in an older file is skipped. The factory's own lines (`appendDecision`, `bin/factory.ts:186`) keep the form `- HH:MM | <text> | none | followed`.

`<outcome>` is `followed`, `followed (deferred)` or `overruled: <reason>`. One `## Run` heading per run lets the retro counts split a session dir that holds several runs; without headings it reports the split as `"not recorded"`. retro also reads the older shapes (date-stamped lines, free-form lines, a literal `HH:MM`) and says `"not recorded"` for what they lack ([ADR-0003](adr/0003-event-log-and-retro.md), sections 2 and 3).

**Goal tags ([ADR-0010](adr/0010-mid-run-intake.md), section 6).** A goal added mid-run gets no heading of its own: it shares its run's `## Run` heading, plan, QC engineer window and event log, so retro's run split stays as it is. Every decision line about an added goal starts its decision field with `[<id>] `, the goal's id, for example `- HH:MM | [intake] intake-gates status running | ... | none | followed`; the first is `- HH:MM | [<id>] goal added: <goal on one line> | client request mid-run | none | followed` (section 4, step 2). Lines about the run's first goal, `run`, carry no tag. The retro counts (`retro/counts.ts`) count lines whose decision field matches `^\[([a-z0-9]+(?:-[a-z0-9]+)*)\] ` per goal, and adds a top-level `goals` key to its output only when `plan.json` has a non-empty `goals` array, so every existing output keeps its keys (section 6).

### `plan.json`

`plan.json` is the seam between the design engineer, the PM and the hooks: the goal, the architecture doc's path, `approval`, `approvedAt`, `maxParallelCrews`, and one entry per crew with its stage, verdict, modules, owned paths, acceptance test, whether that check was proved, estimated agents, an optional `clientApproval`, optional host `needs` ([ADR-0012](adr/0012-self-improving-retro.md), Decision 9), from version 4 an optional `process` with a `lean` crew's `qc` and `red` ([ADR-0031](adr/0031-right-size-process.md)), and status. [`plan.schema.json`](plan.schema.json) is the contract; [ADR-0001](adr/0001-design-phase.md), section 8, is the source. The rules it adds:

- `approval` (`auto` or `client`) is set once, at plan time. It's `client` when a client trigger applies, a long-term cost is open, or the brief says so, whatever the plan's stages ([ADR-0044](adr/0044-split-by-need.md)); mid-run slices never change it.
- `goalCheck` (optional, top level and on a `goals` entry): the command that proves the whole goal, such as a zero-match test, run once the goal's last crew merges ([ADR-0044](adr/0044-split-by-need.md)). `plan-check` refuses one that isn't a non-empty string.
- `approvedAt` is null only while a run waits for the client, so an `auto` run always has it. Otherwise it is an RFC 3339 date-time with a time-zone offset, such as `2026-10-26T14:03:00+01:00` or `2026-10-26T13:03:00Z`.
- `verdict`: `design` is a crew that writes ADRs and contract tests; `change` is a build crew whose module's design changed, so it runs after the design crew; `extend` is a build crew working inside the existing design.
- `clientApproval` (`pending` or `approved`) is set only on mid-run design slices that wait for the client.
- `process` (`solo`, `lean` or `full`; absent means `full`) is the crew's size, the PM's call per task. A `lean` crew also carries the booleans `qc` and `red`, the PM's proof choice, which `factory.ts land` follows.
- Within a stage, the order of the `crews` array is the queue order.
- The agent total is the sum of `estAgents`, so it isn't stored.
- `version` goes up when a field is renamed, retyped or removed, or when an added field is required or changes what a reader must refuse. An optional field that a reader may treat as absent keeps the version: crew `needs` came in at version 3 this way ([ADR-0012](adr/0012-self-improving-retro.md), Decision 11). The schema allows no other properties.

Validating a plan against the schema checks these constraints of its own:

- `version`, `goal`, `architecture`, `approval`, `approvedAt`, `maxParallelCrews` and `crews` are required; `reworkAllowance` is required at versions 2 and 3 (and 4) and forbidden at version 1; `goals` and a crew's `goal` are allowed only at version 3 (and 4); `agentCap` is optional. Every crew field is required except `goal`, `clientApproval`, `needs`, and, from ADR-0031, `process`, `qc` and `red`. `version` is `1`, `2` or `3`, and `4` from ADR-0031 (Plan v4, below); no other properties are allowed, at either level.
- `approval: "auto"` needs `approvedAt` to be a string. Since [ADR-0044](adr/0044-split-by-need.md), `approval: "client"` no longer needs a stage-0 crew.
- `approvedAt` is null or a JSON Schema `date-time`: RFC 3339 with an offset. The format is checked only by a validator that asserts formats, such as `ajv` with `ajv-formats`.
- Any crew may sit in stage 0, and a design crew may have any `process` ([ADR-0044](adr/0044-split-by-need.md); before it, stage 0 held only `full` design crews).
- `clientApproval` may appear only on a `design` crew.
- `slug` matches `^(?!.*-[0-9]+$)[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 100 characters: lowercase words joined by single hyphens, never ending in `-<digits>`, since a successor project manager is named `<slug>-<n>` and the hooks gate it as its base slug.
- `crews`, and each crew's `modules` and `owns`, hold at least one item; `modules` and `owns` items are unique non-empty strings.
- `stage` is an integer of 0 or more; `maxParallelCrews` and `estAgents` are integers of 1 or more; `goal`, `architecture` and `acceptanceTest` are non-empty strings.

**Plan v2 ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 1).** The schema describes versions 1 and 2. `version` is `1` or `2`. A v2 plan requires the top-level `reworkAllowance`, an integer of 0 or more: how many fresh QC engineers a crew may start after QC engineer FAILs in this run. The design engineer copies it from `.claude/truss.json` (default 2). A v1 plan may not carry it, and every v1 plan that was valid stays valid. There is no per-crew allowance. The hooks never validate the version. `parsePlan` passes `version` and `reworkAllowance` through unchecked, and each v2 rule asks `planAtLeastV2` (an integer `version` of 2 or more) first. So a v3 plan inherits the v2 rules, and a v1 plan, or one with no version, gets v1 behaviour.

**Plan v3: several goals in one run ([ADR-0010](adr/0010-mid-run-intake.md), sections 1 and 2).** Before v3 a plan held one goal, and the plan-file route never writes over an approved plan, so a goal the client added mid-run had no way in but a hand edit (ADR-0010, Context, items 1, 2 and 4). Now one `plan.json` per session holds the run's goal, and added goals are appended under the approved plan. The schema has version `3` (enum `[1, 2, 3]`; v3 requires `reworkAllowance` like v2) and two fields, both v3 only:

- `goals`, top level, optional: the goals added after the run's approval, in the order they were added, each `{ "id", "goal", "addedAt", "approval", "approvedAt" }`. `id` follows the crew-slug pattern and is never `run`; `approval` is `client` only when a client trigger applies to the goal, else `auto` (ADR-0010, amended 2026-10-30); `approvedAt` is null until the PM logs an `auto` goal or the client approves a `client` one, with the same conditional as the top level. The run's first goal stays in the top-level `goal`, `approval` and `approvedAt`, and its id is the reserved word `run`.
- `crews[].goal`, optional: the goal id the crew serves. Absent means `run`, and `"run"` written out means the same.

A conditional forbids both below version 3, so every v1 and v2 plan validates unchanged and every crew of one belongs to `run`. Stages are numbered per goal: an added goal's first stage is its stage 0, and the `clientApproval` rule and the plan-check `Why stage <n>:` warning apply within each goal. The schema can't check that a crew's `goal` names an entry; the hooks do (see [Plan gates](#plan-gates)).

**Plan v4: a process size per crew ([ADR-0031](adr/0031-right-size-process.md), Decisions 3, 7 and 8; designed).** `process` changes what the merge gates refuse, so it raises the version to 4 under the rule above. Version 4 inherits every v2 and v3 rule: `reworkAllowance` is required, and `goals` and a crew's `goal` are allowed. Three crew fields come in, valid only at version 4 or above:

- `process`: `solo`, `lean` or `full`, default `full`.
- `qc` and `red`: booleans, both required on a `lean` crew and forbidden on any other.

The schema forbids all three below version 4. `factory.ts plan-check` accepts versions 2, 3 and 4 and checks these rules itself. Each refusal names the crew's slug and the field it breaks:

- `qc` or `red` on a crew that isn't `lean`;
- `estAgents` above 1 on a `solo` crew;
- `estAgents` above 3 on a `lean` crew, or above 2 when `qc` is false.

`plan-check` also returns a `warnings` list, never a refusal, for each stage after a goal's first with no `Why stage <n>:` line in `plan.md` (or the goal's `plan-<id>.md`) ([ADR-0044](adr/0044-split-by-need.md)).

A plan with no `process` field may stay at version 2 or 3. A reader from before version 4 fails closed on a v4 plan: its `plan-check` refuses the version, and its merge gate still asks for a red record and a QC PASS. A goal whose tasks are all `solo` writes no `plan.json`.

Goals reach the plan through a new design engineer mode and a new hook route (ADR-0010, section 2). A main-session `truss:design-engineer` call whose prompt's first line is `Mode: amend` is tracked like a plan call, and its hand-back carries a ```` ````json plan-amend.json ```` block, `{ "goal": { "id", "goal", "approval" }, "crews": [ ... ] }`, and a ```` ````markdown plan.md ```` block. The plan-amend route calls `amendPlan(existing, amend, now)`, a pure function in the new `hooks/intake.ts`, inside the same chain as the plan-file route, writes the result to `plan.json`, and writes the markdown block to `<truss dir>/plan-<id>.md`, never to `plan.md`. `amendPlan` refuses, and the route writes nothing and logs `plan-amend route wrote nothing: <reason>`, when the plan isn't approved yet (the PM then re-plans in plan mode), when its `version` is below 2, when a block or field is malformed (`goal.id` not a slug or `run`, empty goal text, `approval` neither `auto` nor `client`, `crews` not a non-empty array, `goalCheck` present but not a non-empty string), when a slug repeats or collides with another goal's crew, or when the goal already exists and is approved or has started crews (`hooks/intake.ts:24-62`). On success it changes only what it adds: the amend's crews get `goal` and `status: "planned"`, `version` becomes 3, and a new goal and its crews go at the end (add path), or a still-unapproved goal's crews are swapped in place keeping its `addedAt` and queue position (replace path, a send-back's). Every other field and every other goal's crew deep-equals its value before, which is what keeps existing crews' approval intact, and the same amend sent twice leaves the file byte-identical. `routePlanFiles` and `keepReason` don't change: a `Mode: plan` hand-back over an approved plan is still kept.

```mermaid
flowchart LR
  client["Client<br/>[person]"]
  PM["PM<br/>[main session: /truss:run]"]
  arch["designer-amend-&lt;id&gt;<br/>[agent: truss:design-engineer, Mode: amend]"]
  checker["Checking engineer<br/>[agent: truss:checking-engineer]"]
  route["plan-amend route<br/>[hook: register.ts + intake.ts amendPlan]"]
  plan[("plan.json v3, plan-&lt;id&gt;.md<br/>[Truss dir]")]
  gate["gateOf / planVerdict<br/>[hook: tool.call on Agent]"]
  status["/truss<br/>[command: statusOf, planLines]"]
  projmgr["Project managers<br/>[agents: truss:project-manager]"]
  client -->|"new goal mid-run"| PM
  PM -->|"Mode: amend brief: goal, in-flight crews"| arch
  arch -->|"plan-amend.json + plan.md blocks"| route
  route -->|"append goal + crews, approvedAt null"| plan
  PM -->|"verdicts, collisions"| checker
  PM -->|"goals[i].approvedAt, status"| plan
  PM -->|"start ready project managers"| gate
  plan -->|"read fresh"| gate
  gate -->|"allow or refuse with reason"| projmgr
  plan -->|"goals, crews, wait text"| status
  status -->|"every goal and what each crew waits on"| client
```

*What mid-run intake adds around `plan.json`, as designed.* Traces to: `docs/adr/0010-mid-run-intake.md:147-169` (the diagram, copied), which traces to `hooks/register.ts:873-905` (plan route and its chain), `:327-348` (gates), `:1261-1312` (status), `:1681-1694` and `:1759-1761` (design engineer detection and hand-back), and `skills/run/SKILL.md`, section 4, "Draft the plan" (plan design engineer brief), line numbers the ADR took at `fa0fa9f`, which `b81ad50` leaves unchanged in both files.

```mermaid
sequenceDiagram
  participant O as Client
  participant F as PM
  participant A as designer-amend-<id>
  participant H as Hooks
  participant C as Checking engineer
  participant L as Project managers
  O->>F: new goal while crews run
  F->>F: log "[<id>] goal added", short depth pass
  F->>A: Agent, first line "Mode: amend"
  A-->>H: hand-back with plan-amend.json and plan.md blocks
  H->>H: amendPlan: validate, append goal and crews, write plan.json and plan-<id>.md
  F->>F: find -newer marker, check ownership and after
  F->>C: review the goal's verdicts and collisions
  alt goal approval is client
    F->>O: the goal's crew table
    O-->>F: approve
  end
  F->>H: set goals[i].approvedAt, then status running
  F->>L: start each crew whose wait text is "ready to start"
  H-->>F: refuse with the gate's reason when one applies
```

*Taking a goal mid-run, end to end, as designed.* Traces to: `docs/adr/0010-mid-run-intake.md:173-195`, which traces to `skills/run/SKILL.md`, section 4, "Draft the plan" (marker and `find -newer`) and "Have a checking engineer review the verdicts", section 5 (approval), section 6 (start and refusals), and the amend hand-back route (`routeAmendFiles`, `hooks/register.ts:1370`).

The PM's side is a new `### Take a new goal mid-run` in `skills/run/SKILL.md` section 7 (ADR-0010, section 4): a client message asking for work no crew covers, sent after `approvedAt` is set, is a new goal and the client's ruling on frozen scope; the PM acknowledges it in one line, logs the tagged `goal added` line, runs a short altitude and depth pass, starts the amend design engineer, checks the amendment, has a checking engineer review it (a send-back only for a gameable acceptance test), and approves and freezes the goal's scope with section 5's rules applied to that goal alone. The top-level `approval` and `approvedAt` and other goals' entries are never edited, and merge mode and target are the run's. An added goal waits for the client's approval of its plan only when a client trigger applies; approvals are not a mandatory step (ADR-0010, amended 2026-10-30).

One file lives in the project repo, not the Truss folder:

```
<repo>/.claude/truss.json  the project's truss config
```

`init` writes `architecture` and `adr`; it also proposes `roles`, `deploy`, `writingSkill` and `promptOverrides`, and writes those the client approves. The client can add any key by hand; each but the first two has a default. The contract is [`truss-config.schema.json`](truss-config.schema.json) ([ADR-0002](adr/0002-kit-manifest-and-config.md)). A key it doesn't declare is reported and ignored; a declared value it rejects is reported and unset. Inside `roles` and `promptOverrides` that unsets only the bad entry. `deploy` fails closed: any error inside it, an undeclared key included, unsets the whole key, so commissioning engineer asks its project manager. When init writes, errors in what the client wrote are reported by path and kept; a client value of the wrong shape to hold a key init would add, such as `roles: "x"`, is kept and that key is skipped; and only an error at a path init itself is writing stops the write:

| Key | Written by | Default | Used for |
| --- | --- | --- | --- |
| `architecture` | `init` | `docs/architecture.md`, unless the repo has an architecture doc of its own | The architecture doc's path |
| `adr` | `init` | `docs/adr` | The ADR directory |
| `maxParallelCrews` | the client | 4 | The most crews running at once |
| `merge` | the client | `sequential` | Merge mode of auto-started runs |
| `target` | the client | the current branch | Target branch of auto-started runs |
| `roles` | `init` on approval, or the client | the inventory | Agent type per job: `build`, `test`, `review`, `search`, `docs`, `deploy` |
| `deploy` | `init` on approval, or the client | none | `{target, command, production}` for commissioning engineer; `production: true` always goes to the client |
| `writingSkill` | `init` on approval, or the client | none | The skill the writer loads, when listed |
| `reworkAllowance` | `init` on approval, or the client | 2 | The integer of 0 or more the design engineer copies into a v2 `plan.json` ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 2) |
| `promptOverrides` | `init` on approval, or the client | none | Per role (`project-manager`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`), a file under `.claude/truss/prompts/` the role reads in addition to its prompt; never prompt text. The key is proposed like the others; the prompt files themselves are the client's |

Init also reads `<repo>/.claude/kit/manifest.json`, kit's record of what it set up (contract `docs/vendor/kit-manifest.schema.json`, repo ADR-0013). It runs `kit:init` through the Skill tool when that skill is listed and the manifest is missing or lacks Truss's read-only declarations, and otherwise carries on without it and says so ([ADR-0002](adr/0002-kit-manifest-and-config.md), section 1). The sequence, as designed:

```mermaid
sequenceDiagram
  actor Client
  participant I as truss:init
  participant A as Design engineer
  participant MF as .claude/kit/manifest.json
  participant K as kit:init
  participant KM as kit_manifest.py
  participant FJ as .claude/truss.json
  Client->>I: /truss:init
  I->>A: init mode, only when there is no architecture doc
  I->>MF: read
  alt valid, declares truss:qc-engineer and truss:checking-engineer read-only
    I->>I: use it
  else missing or lacks the declarations, and kit:init is listed
    I->>K: Skill kit:init, args declare read-only: truss:qc-engineer, truss:checking-engineer
    K->>Client: show the declaration (full init first when no manifest)
    Client-->>K: approve
    K->>KM: declare --by Truss, or write with the declaration in the facts
    KM->>MF: agents readOnly true, declaredBy Truss
  else kit:init not listed
    I->>Client: kit is not installed, Truss init carries on without a kit manifest
  else not JSON, fails the schema or another version
    I->>Client: kit manifest unreadable, carrying on without it
  end
  I->>Client: propose roles, deploy, writingSkill, promptOverrides
  Client-->>I: approve some
  I->>FJ: write the approved keys
```

*Truss init extending kit init: the four manifest cases and what each writes.*
Traces to: `docs/adr/0002-kit-manifest-and-config.md` (sections 1 and 2), `docs/adr/claude-ops/0013-kit-manifest.md`, `docs/vendor/kit-manifest.schema.json`, `skills/init/SKILL.md` (doc check).

Two kinds of state don't go to the Truss folder:

- `truss.limitReset` in Claude Code's plugin state, `{ resetsAt, fired }`: the five-hour reset a wake is armed for and whether it has gone out. It survives a hot reload of the hooks module.
- The module's memory: every agent seen this session with its spawn name, parent and model, each agent's start and last activity time, each agent's status at the last heartbeat, the stalled set, each project manager's tag, idle period and final-report time, the stop-gate counters, and when the main session was last active. A reload or `/clear` starts it over, except the main session's last activity, which `/clear` keeps.

## Hooks

All of these are in `hooks/register.ts`.

| Event | What it does |
| --- | --- |
| `classic.SessionStart`, main session only | Adds `[truss] dir: <path>` to the context, so the PM never derives the folder itself. |
| `session.start` | Registers `/truss`, starts the one-minute heartbeat, and re-arms a pending limit-reset wake from plugin state. |
| `session.end` with reason `clear` | Clears the module's memory. |
| `agent.spawn` | Records each agent's spawn name, type, parent, model and start time, and counts the spawn as activity. |
| `tool.call` on `Agent`, after the call | After a crew agent's or a project manager's call goes through, appends a `spawn` line to `events.jsonl`. |
| `tool.call` on `SendMessage` | Enforces who a crew agent may message, logs project-manager-to-project-manager messages, and tracks each project manager's tag for `/truss`. It also appends a `tag` line to `events.jsonl` for each tag set. |
| `tool.call` on `Agent` | Refuses crew agents' calls without `model` or `effort`, or with `effort: "max"`. Adds the report-path note to calls that start a project manager or a crew member. |
| `tool.call` on `Agent`, plan gates | Refuses starting a project manager that `plan.json` holds back: the run-level and crew-level approval gates, the stage gate and the parallel cap (see [Plan gates](#plan-gates)). |
| `tool.call` on `Agent`, model check | On a v2 or later plan: refuses a main-session `truss:*` call with no `model` or a missing or unknown `effort`, and refuses a crew's QC-named spawn once its rework allowance is spent (see [Rework allowance and head guard](#rework-allowance-and-head-guard)). |
| `tool.call` on `Workflow`, ADR-0009 | For a main-session `Workflow` call only: refuses a script that isn't Truss's `plan.js` or `stage.js` but names a `truss:` type, a Truss script with a bad `args.truss` or roles table, a plan script on an approved plan, and a stage script whose crews aren't `running` or fail `planVerdict` (see [Workflow calls](#workflow-calls-adr-0009)). |
| `tool.call` on `Bash`, [ADR-0027](adr/0027-retro-fixes2.md), proposed | The push and merge gate (R-32), for a main-session call only: refuses a command that runs `retro/cli.ts scrub` and then `git push` or `git merge` (with or without `-C <path>`) unless every operator from scrub to it is `&&` and scrub's output isn't piped. A pipe after the push, a plain `git push`, and `git merge-base` or `git log` after a scrub are allowed. A scrub run in an earlier call isn't seen. It fails open. |
| `tool.call` on `WebFetch`, `WebSearch` | The fetch gate: runs `fetchVerdict` on every call in the session, whoever makes it, and appends its `fetch` line to `events.jsonl` when there is one. Allows every call today (see [Fetch gate](#fetch-gate)). |
| `tool.call` on `Write`, `Edit` | Stamps the clock's time on new lines of this session's `decisions.md`; also on every literal `HH:MM`. |
| `tool.call` on `Edit`, `Write`, `MultiEdit`, `NotebookEdit`, [ADR-0014](adr/0014-retro-fixes.md), proposed | For a main-session call only: `mainEditVerdict` refuses an edit to a file in the repo or one of its worktrees while this session's `plan.json` has a crew neither `merged` nor `dropped`, and tells the PM to delegate it to a crew or agent. The truss dir, the requirements path and `.claude/settings.json` are exempt, and it fails open. Bash writes are not gated; F-7's rule covers them (ADR-0014, Decision 2). |
| `tool.call`, any tool | Records activity, the main session's too. On `SubagentHandback`, refuses an empty hand-back from a crew agent and captures the report. |
| `turn.step` | Records activity for each model request, the main session's too. |
| `classic.SubagentStop` | Runs the project manager stop gate and saves the stopping agent's report. Each final report saved (here or from `SubagentHandback`) appends a `report` line to `events.jsonl`. On a v2 or later plan, the gate also sends back a final report that lacks the Examined and Not examined sections, or that the head guard rejects. A QC engineer FAIL that spends the allowance appends the spent-allowance line. |
| `session.measure`, `classic.StopFailure` | Arm the limit-reset wake. |
| `command.run` for `truss` | Prints the crew status. |

### Message rules

A member may message its own project manager and the other members of its crew. A project manager may message `main`, its own members and the other project managers. An address resolves to the agent with that id; else to the live agents with that name, a trailing ` [ref]` dropped; else to the newest agent seen with that name. Refusals, word for word, with `<...>` filled in:

- A member to `main`: `[truss] Refused: crew members message only their own project manager and the other members of their crew. Put your question in a message to your project manager, <project-manager>, which asks "main" for you.`
- A member to anyone else outside its crew, or to an unknown address: `[truss] Refused: crew members message only their own project manager and the other members of their crew. To reach anyone else, tell your project manager, <project-manager>.`
- A project manager to another crew's member: `[truss] Refused: a project manager reaches another crew only through its project manager. Send it to that crew's project manager, <project-manager>, instead.`
- A project manager to an unknown address, or to an agent outside every crew: `[truss] Refused: a project manager reaches another crew only through its project manager. Message "main", your own members, or another crew's project manager.`
- A name that resolves to live agents in different crews: `[truss] Refused: more than one live agent is named "<address>", in different crews. Address it by its agent id.`

A project manager's message to `main` that starts with `QUESTION:`, `BLOCKED:` or `PROPOSAL:` sets its tag in `/truss`; an untagged one clears it. Any message from the PM to a project manager clears that project manager's tag.

[ADR-0016](adr/0016-plugin-fixes.md), proposed, adds three hook changes. `designerResumeVerdict` refuses a main-session SendMessage to a plan or amend design engineer and says to start a fresh one. `MAIN_MODEL_REFUSAL` stops naming a model. `workflowCallVerdict` parses an `args` given as a JSON string. Until its build crew merges, the rules above describe the code.

### Agent calls

From inside a crew, every Agent call needs `model`, and `effort` set to `low`, `medium`, `high` or `xhigh`:

- No model: ``[truss] Refused: inside a crew, every Agent call sets `model`: "opus" for judgment-heavy work (design, debugging, review, tricky code), "sonnet" for mechanical or well-specified work. Call Agent again with model set.``
- No effort, or an unknown one: ``[truss] Refused: inside a crew, every Agent call sets `effort` to one of "low", "medium", "high" or "xhigh": "low" for lookups and mechanical edits, "medium" for well-specified work, "high" or "xhigh" for hard design, debugging or review. Call Agent again with effort set.``
- `effort: "max"`: `[truss] Refused: effort "max" is not allowed inside a crew; "xhigh" is the top. Call Agent again with effort set to "low", "medium", "high" or "xhigh".`

The model check runs first. On a v1 plan, or with no plan, the PM's own Agent calls aren't checked, though the skill tells it to set both. On a v2 or later plan, a main-session call whose `subagent_type` starts with `truss:` must set `model` and one of the four efforts (`mainCallVerdict`, refusals `MAIN_MODEL_REFUSAL` and `MAIN_EFFORT_REFUSAL`, [ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 7). It runs before the plan gates. With no plan file, such as the plan-mode design engineer's start, it lets the call through. The hooks refuse `high` and `xhigh` nowhere. Whether the client asked for them is a prompt rule, and retro's target share for them is zero.

A call that starts a project manager from the main thread, or any agent from inside a crew, gets this note in its result: `[truss] If <name>'s report does not reach you, read <path> once it stops.`

### Workflow calls (ADR-0009)

A Workflow script's `agent()` is not an Agent tool call, so none of the Agent gates above runs for it: the probe's checking engineer with no model ran on the session model, and a project manager started past the cap ([ADR-0009](adr/0009-workflow-factory.md), Probe). ADR-0009, Decision 6, added three things to `hooks/register.ts` and changed nothing else in it:

- `export` on the existing `fencedBlock` (`register.ts:1303`), so `factory.ts plan-write` applies the plan-file route's block rules.
- Two pure exported functions. `workflowRoleVerdict(roles)` refuses a roles table that isn't an object, a role key that doesn't match `^[a-z]+$`, a `project-manager`, `commissioning` or `integrator` key or a role whose `agentType` is `truss:project-manager`, `truss:commissioning-engineer` or `truss:integrator`, a role that isn't an object, a model other than `opus` or `sonnet`, and an effort other than `low` or `medium` (`register.ts:722-735`). `workflowCallVerdict(plan, input)` (`register.ts:737`) returns undefined for no plan or a plan below v2. Otherwise it refuses a call that gives both `script` and `scriptPath`, and calls a script Truss's when its `scriptPath` is `<pluginDir>/workflows/plan.js` or `stage.js`, or its text equals one of those files byte for byte. A script that isn't Truss's is refused with "Truss agents run in a Workflow only from the plugin's plan.js and stage.js" when its `scriptPath` can't be read or its text contains `truss:`; any other such script gets undefined. A Truss script is refused with no `args.truss` object; then `workflowRoleVerdict(args.truss.roles)` applies; then it is refused when it matches both scripts, when `plan.js` doesn't run with `kind: "plan"` or `stage.js` with `kind: "stage"`, when `kind: "plan"` meets a plan whose `approvedAt` is set, or when `kind` is neither. A `stage` call is refused without `args.truss.crews` as a list, and for any crew with no slug, whose `status` isn't `running`, or that `planVerdict` refuses. Every refusal starts `[truss] Refused:`.
- One handler, `on('tool.call', { tool: 'Workflow' }, ...)`, right after the Agent handler, for main-session calls only (`e.agentId === undefined`): it reads the plan within `PLAN_READ_MS`, returns the verdict's deny or calls `next(e)`, and logs each refusal with `logRule`.
- The `trussFile` seam ([ADR-0024](adr/0024-factory-fixes3.md), item 29, proposed; goal `factory-fixes3`'s stage 1 builds it). When `start --args-file P` resolves inside the truss dir, its short output gains `workflowArgs: {"trussFile": P}`, and the PM passes that as the Workflow's `args`. For a plugin script, the handler's `expandTrussFile(args, trussDir, read)` reads P, takes its `truss` object, and refuses both keys at once, a path that isn't absolute or leaves the truss dir, and a file that isn't JSON or holds no object `truss`. `workflowCallVerdict` then checks the expanded object, and the handler calls `next` with `args: {truss}`. Without `trussFile` the handler is unchanged. `stage.js`, run without an object `args.truss`, throws at once with a message that names `args.trussFile`, so a runtime that ignores the rewritten args stops before any agent runs and the PM passes `args.truss` inline.
- The `livePage` seam ([ADR-0025](adr/0025-factory-fixes4.md), item 40, proposed; goal `factory-fixes4`'s stage 1 builds it): `factory.ts` `crewEntry` → `stage.js` `uxReviewPrompt`, which reads it as optional. Every `start` form sets `entry.livePage` to the first line of the goal file's `## UX` section that starts with `Live page`, after an optional `- ` or `* ` bullet, trimmed and given whole; it is `null` when there is no such line or no `## UX` section.

The three crew-keyed Agent gates, `agentVerdict`, `effortVerdict` and the rework-allowance gate, key on `crewOf(callerId)` and can't fire for a workflow agent, which has no `truss:project-manager` ancestor. On the Workflow path the script's `spawn()` (throws on a role without model or allowed effort), `workflowRoleVerdict` in `start`, `plan-args` and this gate, `stage.js`'s spend count and `finish`'s transcript audit and `qcFails` check replace them: those rules are the script's, the CLI's and the audit's, not a hook's refusal (ADR-0009, Decision 4, "What replaces the project manager's gates"). `finish` also audits every Workflow run of the session since the newest `## Run` header that is Truss's or holds a `truss:*` agent, and while any entry stands it merges nothing (Decision 1, "finish, session audit").

Workflow refuses a `scriptPath` inside the plugin cache, so `plan-args` and `start` copy the script byte for byte as `truss-plan.js` or `truss-stage.js` into a scripts dir and print the copy's path (`scriptPathFor`, `bin/factory.ts`). The dir is `--scripts-dir` when given, else the session scripts dir: `sessionScriptsDir` takes the path segment directly under `<git common dir>/truss/` of the truss dir as the session id, finds that session's main transcript with `transcriptsOf`, and returns `<dir of the transcript>/<session id>/workflows/scripts` (`sessionScriptsDir`, `bin/factory.ts`). When the truss dir is not under `<git common dir>/truss/` or no transcript is found, `scriptPath` is the plugin's own file, as before. The gate still recognises the copy by its text, and an inline `script` with the same text too (Decision 6, "scriptPath fallback").

Seams (ADR-0009, Seams to pin; none of these tests exists yet):

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `fencedBlock` export | hooks | `factory.ts plan-write` | the plan-file route's block rule, `register.ts:1301-1309` | `tests/workflow-gate.check.ts` |
| `workflowRoleVerdict`, `workflowCallVerdict` | hooks | the Workflow handler, `factory.ts` | ADR-0009 Decisions 2 and 6 | `tests/workflow-gate.check.ts` |
| `factory.ts` commands, flags, one-line JSON output, exit codes 0, 1 and 2 | `bin/factory.ts` | the PM, `stage.js`'s runner | ADR-0009 Decision 1 | `tests/factory.check.ts`, with fixtures in `tests/fixtures/workflow-run/` |
| `plan.js` and `stage.js` control flow, `roles.json` | `workflows/` | the Workflow tool | ADR-0009 Decisions 2 to 4 | `tests/workflows.check.ts`, with stubbed `agent()` |
| `settings` on this repo's `.claude/truss.json` | `factory.ts` | the PM | `{"merge":"sequential","target":"main","source":".claude/truss.json"}` | `tests/run-procedure.check.ts` |

### `bin/` modules (0.25.0)

`bin/factory.ts` spreads the command tables of four modules into its own (`INBOX_COMMANDS`, `COST_COMMANDS`, `QUEUE_COMMANDS`, `WORKTYPE_COMMANDS`, `bin/factory.ts:4270`). Each module imports only `node:` built-ins and relative paths, and never `factory.ts`, whose top-level `await` would make an import cycle (each file's header comment).

| Module | ADR | What it owns |
| --- | --- | --- |
| `bin/store.ts` | 0037, 0048 | The only lock (`withLock`, `StoreBusy`) and lease (`takeLease`, `refreshLease`, `releaseLease`), atomic-write (`writeJsonAtomic`, `createExclusive`), JSONL (`appendJsonl`, `readJsonl`) and transcript-finding (`transcriptsOf`) code, plus the helpers every module shares (`CliError`, `usage`, `refuse`, `flat`, `configOf`, `parseLabel` and others). `sharedDir(repo)` is S. |
| `bin/inbox.ts` | 0037 | `S/inbox.jsonl`: the commands `escalate`, `inbox`, `resolve` and `mark-applied`; the gate helpers `blockingFor` and `budgetRaises`; the typed-proof check that a client resolve has a prompt the client typed after the item opened, holding the decision word, the id and the item's code (`typedProof`, `bin/inbox.ts`). The escalation kinds and who may resolve each are its `KINDS` table (`bin/inbox.ts:16-29`). |
| `bin/notify-run.ts` | 0037 | Runs the client's `notify` command for one new inbox item in a child process, with `{repo, row}` on stdin. Exit 0 when the command exits 0 within 10 s; on a timeout it kills the whole process tree (`taskkill /T /F` on win32; elsewhere the descendants, walked from `/proc` on linux and with `pgrep -P` on macOS, then the process group). `escalate` starts it after the inbox lock is released (`notify`, `bin/inbox.ts:353-366`). |
| `bin/guard.ts` | 0034 | The long-term cost guard: `ltcLines`, `ltcTriggers`, `ltcPlan` (writes `D/ltc-plan.json`), `ltcPlanGate` (read by `approve`) and `ltcCrewGate` (read at merge). |
| `bin/cost.ts` | 0038 | The cost meter: `sweep` into `D/usage.jsonl`, `budgetVerdict`, `crewCost` and the `cost` command (see Cost meter). |
| `bin/worktypes.ts` | 0041 | The built-in work types (`feature`, `docs` and `refactor` solo; `bugfix` lean with `red`; `dependency` lean; `migration` full with a stress test), `profilesOf`, which lets `workTypes` in `.claude/truss.json` only tighten a profile, `workTypeErrors`, and the `worktypes` command (`bin/worktypes.ts:9-69`). |
| `bin/ledger.ts` | 0038 | `ledgerAppend(repo, row)`: one merge row appended to `S/ledger.jsonl` under its lock. |
| `bin/queue.ts` | 0040, 0039 | The work queue under `S/queue/items/`: the commands `intake`, `queue`, `queue-next` and `queue-set`, plus `unattended --on`/`--off`, which writes and removes `D/unattended.json`. Item states are `new`, `claimed`, `running`, `triage`, `done` and `dropped` (`bin/queue.ts:14-22`). |

### Plan gates

The gates apply to an Agent call from the main thread that starts a `truss:project-manager` with a non-empty `name` ([ADR-0001](adr/0001-design-phase.md), section 9). A project manager started by another agent, or with no name, is never gated. On every such call the hook reads `<truss dir>/plan.json` fresh, so the PM's edits count at once, and it never writes the file. A leading UTF-8 BOM is stripped before parsing.

The project manager's name picks the plan entry it is gated as. A name that is a plan slug is that crew. Otherwise, a name `<base>-<n>`, with `n` an integer of 2 or more and `<base>` a plan slug, is a successor and is gated as `<base>`, so restarting a crew under a fresh name can't slip past its gates. Only one suffix is stripped, and a name that is itself a slug is never stripped. Any other name, including `<slug>-1`, isn't gated.

The gates run in this order, and the first match refuses the call with `[truss] Refused: <reason>`:

1. Approval gate, run level: while `approval` is `client` and `approvedAt` is null, every project manager in the plan is refused. Reason: `this run changes the design; get the client's approval first`.
2. Approval gate, crew level: a crew whose `clientApproval` is `pending` is refused on its own. Reason: `<slug> waits for the client's approval`.
3. Stage gate: refused while any other crew in an earlier stage isn't `merged` or `dropped` (a crew with no status counts as not merged). Reason: `stage <n> isn't merged yet: <slugs>`, naming the lowest such stage and its crews in `crews` order. A crew without a numeric stage skips this gate, and crews without one are ignored.
4. Parallel cap: refused while the count of other crews with status `running` is at or above the cap. The cap is `maxParallelCrews` when it is an integer of 1 or more, otherwise 4. Reason: `<running> crews running, the cap is <cap>; start <slug> when one merges`.

In each reason, `<slug>` is the plan slug, so a successor's refusal names its base. Entries with the target's slug are left out of the stage and cap checks, so a crew can't hold itself back, and a restart or a successor whose base already says `running` doesn't count against the cap.

With no Truss dir, no plan file, a file that is empty, not JSON, not an object or without a `crews` array, or a name the plan doesn't hold, no gate applies, so runs without a plan keep working. Any error while reading or checking the plan is logged and lets the call through, like every other Truss hook. The gates trust the PM's `status` field: a crew marked `merged` too early gets past the stage gate. The QC-gated merge is still the real control.

**Goal-aware gates ([ADR-0010](adr/0010-mid-run-intake.md), section 3).** For plan v3, `planVerdict` keeps its signature and prefix and is built on `register.ts` `gateOf` (`:330`), `gateOf(plan, name): { deny, waits } | undefined`, which gives each refusal a `/truss` wait text too. A crew's goal is `goalOf(crew)`, exported from `hooks/intake.ts`: its `goal` when that is a string, else `run`. The checks, first match wins:

| # | Gate | Refusal reason | `/truss` wait text |
| --- | --- | --- | --- |
| 1 | run approval, unchanged | `this run changes the design; get the client's approval first` | `waits for the client's approval of the plan` |
| 2 | a `goals` entry has the id `run` | `goal id run is reserved for the run's first goal; rename it in plan.json` | `waits for a fix: goal id run is reserved` |
| 3 | the crew's goal isn't `run` and names no entry in `goals` | `<slug> names goal <id>, which isn't in the plan` | `waits for a fix: goal <id> isn't in the plan` |
| 4 | the goal's `approval` is `client` and its `approvedAt` is null | `goal <id> changes the design; get the client's approval first` | `waits for the client's approval of goal <id>` |
| 5 | `clientApproval` is `pending`, unchanged | `<slug> waits for the client's approval` | `waits for the client's approval` |
| 6 | stage gate, within the crew's goal only | `stage <n> isn't merged yet: <slugs>` for `run`; `stage <n> of goal <id> isn't merged yet: <slugs>` for an added goal | `waits for stage <n> to merge: <slugs>` |
| 7 | parallel cap, global across goals, unchanged | `<running> crews running, the cap is <cap>; start <slug> when one merges` | `waits for a free slot: <running> of <cap> running` |

So each goal runs its own stage sequence, and a new goal's stage 0 can start while the run goal is mid-stage; only the shared cap and queue couple the goals. All goals share one `maxParallelCrews` and one queue, the `crews` array, with added goals' crews at its end, so at equal readiness older goals' crews start first. The PM starts the planned crews whose wait text is `ready to start`, in array order, up to the free slots. Crews of any goals may share files ([ADR-0043](adr/0043-crews-share-files.md)); they merge one at a time, and the hooks never compare `owns` across crews. The successor and duplicate-slug rules don't change, and on a v2 plan every crew is in `run`, so the gates behave as above.

The idle-project-manager prompt also reads the plan, to name a successor the gates map back to the same crew: a plan slug `C` gets `C-2`, a successor `B-<n>` gets `B-<n+1>`, counting past any name that is itself a plan slug (plan `[auth, auth-2]` gives `auth-3`). It waits at most 2 seconds for that read, on the engine clock. A read that hasn't settled by then, or one that fails, gives the plain name (`auth` to `auth-2`, `gateway-3` to `gateway-4`), and the prompt still goes out.

### Report capture

When a crew agent stops, the hook writes its last assistant message to its report file. When the agent sent its report through `SubagentHandback`, the hook writes that message instead, and the stop that follows leaves the file alone. A project manager's hand-back is written only if it would pass the stop gate; otherwise the stop decides what's written.

A crew agent's hand-back under 40 characters once trimmed (`HANDBACK_MIN`), or one that is only `placeholder`, `todo` or `tbd`, is refused. A hand-back that starts `QUESTION:`, `BLOCKED:`, `PROPOSAL:` or `CHECKPOINT:` is exempt from the length, but is refused when nothing, or only a stand-in, follows the tag: `[truss] Refused: that hand-back is too short to be a report. Hand back your real report: what you did, the branch, and proof.` If the crew can't be read, the hand-back goes through.

### The project manager stop gate

A project manager's stop is checked against its hand-back, else its last message. It goes through when the text starts with `CHECKPOINT:`, `BLOCKED:`, `QUESTION:` or `PROPOSAL:`, or has a `## Proof` heading, or while the project manager's tagged message to `main` is unanswered (its tag in `/truss`; any message from the PM clears it). Otherwise the stop is sent back with:

`[truss] Not done yet: finish with your report, in the sections Summary, Branch, Changes, Proof, Checks run and Open questions (each a "## " heading), or, if you cannot finish, start your final message with CHECKPOINT:, BLOCKED:, QUESTION: or PROPOSAL:.`

The gate sends a stop back at most twice in a row (`PROJECT_MANAGER_STOP_BLOCKS`), then lets the next one through, so a project manager can't loop forever. A stop while the project manager still has work out is interim and always goes through: a descendant is live, or a background task belonging to a descendant is running or pending. A stop excused by an unanswered tag is interim too. An interim stop's text is saved to `<agent>.interim.md` and doesn't change the report file, its tag or the project manager's idle period. A stop the gate sends back is saved nowhere. The gate applies to `truss:project-manager` agents only.

A report that already holds a ruling (its first line starts `VERDICT: PASS`, `VERDICT: FAIL` or `STRESSTEST`) is never overwritten by a later stop of the same agent that has no ruling of its own: that text goes to `<agent>.interim.md`, logs no `report` event and spends no rework allowance. A resumed QC engineer that rules again replaces the file. The merge gate and `/truss` read the ruling from the report file, so a QC engineer answering a follow-up question can no longer erase its verdict.

On a v2 or later plan, an untagged text that passes by its `## Proof` section gets two more checks, in this order:

1. `examinedVerdict`: both the Examined and the Not examined headings must be present, as fixed in ADR-0004, section 3.
2. `headVerdict`: the head guard, below.

Their send-backs count in the same streak, so the two-block bound still holds. An unanswered tag doesn't excuse them. A hand-back is saved as the report only if it passes the first check. The head guard runs only at the stop, because it calls git.

### Rework allowance and head guard

Designed in [ADR-0004](adr/0004-scope-repair-and-head-gates.md), sections 5 and 6; the literals are in its section 3, and the exported functions in section 9. Both rules read the crew's **this-run QC files**: `reports/<crew>/<crew>-qc*.md`, not interim, modified at or after `plan.json`'s `approvedAt`. This session dir already holds `design-judge.md` to `-qc-7.md` from earlier runs that reused the crew name, so counting by name alone would be wrong.

- **Allowance.** A crew's FAIL count is the number of its this-run QC files that start `VERDICT: FAIL`. Once that count is greater than `reworkAllowance`, the allowance is spent. A QC-named spawn from inside the crew is then refused with the `ALLOWANCE_REFUSAL` prefix, and the hooks append the spent-allowance line when the FAIL that spent it is saved. The project manager sends `main` the allowance-blocked message and stops. A successor project manager has its own folder, so it starts a fresh count.
- **Head guard.** The QC engineer writes its head and patch lines under `## Proof checked`. At a project manager's final stop, the hook takes the crew's newest this-run QC file. It must be a PASS with no UNSCOPED finding and with both lines. The hook then compares the judged head with `git rev-parse <branch>`, where the branch comes from the report's Branch line. If the head moved, it compares the judged patch id with the current one, computed by `PATCH_COMMAND`. An equal head, or an equal patch id, goes through: the patch-bound PASS. A different patch id is sent back. An unknown head or patch id fails open.
- **Merge gate.** The PM reads the same file under the same rule, and merges a moved head only on an equal patch id with the project manager's checks re-run green.

```mermaid
sequenceDiagram
  participant L as Project manager
  participant H as Hooks (register.ts)
  participant J as QC engineer
  participant R as reports/crew/
  participant E as events.jsonl
  participant F as PM
  L->>H: Agent truss:qc-engineer, name crew-qc-k
  H->>R: list and read this-run QC files
  alt FAIL count > reworkAllowance (v2 plan)
    H-->>L: Refused, rework allowance spent
    L->>F: BLOCKED message, last findings
  else within allowance
    H->>J: start
    J->>R: report with VERDICT, head and patch lines (saved at its stop)
    opt VERDICT FAIL leaves the allowance spent
      H->>E: append the spent-allowance line
    end
  end
  L->>H: final report (stop)
  H->>R: newest this-run QC file
  H->>H: git rev-parse branch, and on a moved head PATCH_COMMAND
  alt no clean PASS, no head lines, or patch id differs
    H-->>L: Not done yet (counts in the stop streak)
  else same head, or same patch id
    H->>F: report goes through
    F->>R: merge gate re-reads the same file
  end
```

*The bounded repair loop and the head guard on a v2 plan, as designed.*
Traces to: `docs/adr/0004-scope-repair-and-head-gates.md` (sections 5 and 6), `hooks/register.ts:2202` (the `Agent` handler the gate joins), `:2506` (the stop gate, `classic.SubagentStop`), `:1534` (`writeReport`, where the spent-allowance line is appended), `:1671` (`qcFilesOf`), `:615` (`latestQc`) and `:646` (`qcRuling`), which pick the crew's newest QC file this run and rule it (line numbers at 0.26.0), `agents/project-manager.md:133-139`, `:160-162`.

### Seams

Each row is a seam inside Truss that ADR-0004 adds or changes. The contract tests read only `tests/fixtures/contract-050/**` or inline data.

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `plan.json` v2, `reworkAllowance` | design engineer (copied from `.claude/truss.json`) | hooks (`reworkAllowanceOf`, `planAtLeastV2`), PM | `plan.schema.json` versions 1 and 2; ADR-0004 section 1 | ajv on `plan.example.json` and `fixtures/contract-050/plan-v1.json` |
| `.claude/truss.json` `reworkAllowance` | client, `truss:init` on approval | design engineer | `truss-config.schema.json`; ADR-0004 section 2 | the schema |
| QC engineer head and patch lines under `## Proof checked` | QC engineer | hooks (`qcRuling`, `headVerdict`), PM's merge gate | ADR-0004 sections 3 and 6, `PATCH_COMMAND` | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| Project manager's Examined and Not examined headings, and its Branch line | project manager | hooks (`examinedVerdict`, `branchOf`), QC engineer | ADR-0004 sections 3, 4 and 6 | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| QC engineer's UNSCOPED finding tag | QC engineer | hooks (`qcRuling`'s `unscoped`), PM | ADR-0004 sections 3 and 4 | `tests/contract-gates.test.ts`, `tests/gates.check.ts` |
| Spent-allowance record: the `events.jsonl` line, and the project manager's allowance-blocked message | hooks (line); project manager (message) | retro (`allowancesSpent`, from the line only); PM (message) | `events.schema.json`; ADR-0004 sections 3 and 5 | `tests/contract-gates.test.ts`, `tests/test_contract_retro_050.py` |
| retro's per-run `allowancesSpent` | `retro/counts.ts` | the `truss:retro` skill | ADR-0004 section 8 (`retro` stays 1) | `tests/retro-counts-contract.check.ts` `RUN_KEYS`, `tests/retro-counts-050.check.ts` |
| Main-session `truss:*` calls on a v2 plan | PM | hooks (`mainCallVerdict`) | ADR-0004 section 7 | `tests/contract-gates.test.ts` |

### Fetch gate

Designed in [ADR-0005](adr/0005-growth-model.md), section 11. Every `WebFetch` and `WebSearch` call in the session, whoever makes it, passes one exported pure function. A guardrail added later (an allowlist, a deny list, a client prompt, a size or count cap) is a change to this function and its tests alone; no prompt names a source, a domain or a limit.

```ts
export type FetchEvent =
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebFetch'; url: string }
  | { event: 'fetch'; crew: string; agent: string; tool: 'WebSearch'; query: string }
export type FetchVerdict = { kind: 'allow'; line: FetchEvent | null } | { kind: 'deny'; line: FetchEvent | null; reason: string }
export function fetchVerdict(tool: 'WebFetch' | 'WebSearch', input: { readonly url?: unknown; readonly query?: unknown }, crew: string, agent: string, hasPlan: boolean): FetchVerdict
```

- **Pure (P3).** It takes plain values and touches neither `$` nor the file system. `FetchEvent` joins the `TrussEvent` union; `appendEvent` adds `v` and `ts` as for every line.
- **Inputs.** `tool` is the call's tool name and `input` the call's input (`e as unknown as { url?: unknown; query?: unknown }`, as the `SendMessage` handler reads its input). The handler resolves `crew` and `agent` before the call: `crew` is the caller's crew slug from `crewOf`, or `"main"` for a caller outside every crew (a `truss:*` agent the PM started, or the main session); `agent` is the agent's name, or `"main"` for the main session. `hasPlan` is true when the Truss dir resolves and `plan.json` exists in it.
- **Decision.** `kind` is `'allow'` for every call today. A later guardrail returns `{ kind: 'deny', line, reason }`; `reason` is the refusal text the caller sees.
- **Line.** `line` is `null` when `hasPlan` is false. Otherwise it is the `fetch` event for the call, with `crew`, `agent` and `tool` as passed. For `WebFetch`, `url` is `input.url` with userinfo removed, each query value replaced by an empty string (keys kept, in order, duplicates kept), and the fragment dropped; scheme, host, port and path stay as the WHATWG `URL` parser gives them, so a default port is dropped. `https://user:secret@example.com:8443/docs/api?version=2&lang=en#auth` gives `https://example.com:8443/docs/api?version=&lang=`. A `url` that isn't a string, or doesn't parse, is logged as `""`. For `WebSearch`, `query` is `input.query` cut to its first 200 characters (`slice(0, 200)`); a non-string is logged as `""`.
- **The handler.** `on('tool.call', { tool: ['WebFetch', 'WebSearch'] }, ...)`, ending in `.catch(failOpen)` (P5), like the `Write`/`Edit` handler. It calls `fetchVerdict`, awaits `logEvent` with a non-null `line`, then returns `{ deny: reason }` when `kind` is `'deny'` (the refusal shape `agentVerdict` uses) and calls `next(e)` when it is `'allow'`. `logEvent` queues the append like every event line, waits at most `EVENT_WAIT_MS` and never rejects, as for `spawn` lines; a failed append, a throwing `$.fs.write` included, is logged and never blocks the call.

```mermaid
sequenceDiagram
  participant C as Caller (member, project manager, Truss agent or main session)
  participant H as tool.call handler (register.ts)
  participant V as fetchVerdict
  participant Q as event queue (logEvent)
  participant E as events.jsonl
  participant T as WebFetch or WebSearch
  C->>H: WebFetch url, or WebSearch query
  H->>H: crew and agent (crewOf, or "main"); hasPlan (dir resolves, plan.json exists)
  H->>V: tool, input, crew, agent, hasPlan
  V-->>H: kind allow, line or null
  opt line is not null
    H->>Q: logEvent(line), waits at most EVENT_WAIT_MS
    Q->>E: append v, ts and the line (a failure is logged only)
  end
  H->>T: next(e), the call goes through
```

*The fetch gate, as designed: every call is allowed, and a line is logged while a plan exists.*
Traces to: `docs/adr/0005-growth-model.md` (section 11), `hooks/register.ts:169-176` (`TrussEvent`), `:1567-1573` (`appendEvent`, which adds `v` and `ts`), `:1604-1624` (`logEvent`'s queue, wait cap and failure log), `:2268` (the awaited `spawn` line), `:2478` (how a handler reads its input), `:2445-2449` (the `Write`/`Edit` handler the fetch handler follows).

### Seams

Each row is a seam inside Truss that ADR-0005 adds or changes. The contract tests read only `tests/fixtures/contract-080/**` or inline data.

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `fetchVerdict` and the fetch handler | hooks | the session's `WebFetch` and `WebSearch` calls; `appendEvent` | the signature and rules above; ADR-0005 section 11 | `tests/contract-fetch.test.ts` |
| The `fetch` line in `events.jsonl` | hooks | retro (`fetches`) | `events.schema.json` `fetch` branch; "On disk" above | `tests/contract-fetch.check.ts`, `tests/test_contract_retro_080.py` |
| retro's per-run `fetches`, `extendPasses`, `defaultDecisions`, `openClientActions` | `retro/counts.ts` | the `truss:retro` skill; retro's JSON stays internal (P15) | `fetches` is `{total, perAgent: {<agent>: n}}`; `extendPasses` counts commits in the run's window whose subject starts `docs(arch): extend ` or is `docs(arch): adopt learned items` or `docs(arch): reconcile learned items`; `defaultDecisions` counts ADRs in the adr dir holding the line `Decided by: default`; `openClientActions` counts `- [ ] ` lines under a `Client actions` heading; each is `"not recorded"` where its source is absent, as ADR-0003 does | `tests/retro-counts-080.check.ts` |
| The plan-mode `UNCOVERED: ` hand-back | design engineer | PM; `routePlanFiles`, which writes nothing for it | ADR-0005 section 4 and its literals table | `tests/contract-fetch.test.ts` (regression guard), `tests/gates.check.ts` |
| A project manager report's optional `## Learned` section | project manager | PM's run-end extend pass; `projectManagerStopPasses`, which neither needs nor refuses it | ADR-0005 section 7 | `tests/contract-fetch.test.ts` (regression guard), `tests/gates.check.ts` |
| The fetch rule, the literals and the web tools in the prompts | `agents/*.md`, `skills/run/SKILL.md` | every agent and the PM | ADR-0005 sections 2, 3 and the literals table | `tests/gates.check.ts` |

### retro's leftover details

Designed in [ADR-0006](adr/0006-leftover-causes.md). retro's top-level keys are now `retro`, `dir`, `split`, `runs`, `qcFiles`, `plan`, `eventsSkipped`, `eventsOutsideRuns`, `leftovers` and `leftoverDetails`. `leftoverDetails` is `"not recorded"` whenever `leftovers` is (and when `git worktree list --porcelain` fails), else an array sorted by `id`, one entry per agent `leftovers` counts, each with exactly the keys `id`, `branch`, `folder`, `head`, `dirty`, `inMain` and `skip` (null where absent). `skip` is the reason worktrees' `decideSelfClean` would give, checked in its order for the checks retro can see, or `passes every check retro can see`. retro copies those rules from `plugins/worktrees/hooks/register.ts:734-752` without importing them (repo ADR-0001), so they can drift; ADR-0006 section 1 records the source and what retro can't see.

```mermaid
flowchart LR
  retro["retro/cli.ts counts<br/>[Truss script: erasable TypeScript, retro/counts.ts]"]
  events[("events.jsonl<br/>[Truss dir]")]
  git[("Local git<br/>[refs, worktree list, main checkout HEAD]")]
  disk[(".claude/worktrees/agent-id<br/>[folders on disk]")]
  skill["truss:retro<br/>[skill: skills/retro/SKILL.md]"]
  sweep["worktrees sweep<br/>[other plugin: decideSelfClean]"]
  retro -->|"reads spawn agentIds"| events
  retro -->|"for-each-ref, worktree list, status, is-ancestor, merge-tree (quarantined), cherry, branch --show-current"| git
  retro -->|"isdir"| disk
  retro -->|"JSON: leftovers, leftoverDetails"| skill
  sweep -.->|"rules copied by hand, never imported"| retro
```

*Where `leftoverDetails` comes from: git and the disk only; the dashed edge is the copied rule set, not a call.*
Traces to: `retro/counts.ts` (`leftovers`, which `leftoverDetails` shares its ids and "not recorded" rules with, and `gitOut`, `GIT_OPTIONAL_LOCKS=0`); `plugins/worktrees/hooks/register.ts:734-752` (`decideSelfClean`), `:1261-1272` (`inMainBy`), `:1324` (the detached drop); ADR-0006 section 1.

```mermaid
sequenceDiagram
  participant S as truss:retro skill
  participant R as retro/cli.ts counts
  participant G as Local git
  participant J as reports/*/*-QC engineer*.md
  S->>R: node retro/cli.ts counts <truss dir>
  R->>G: worktree list --porcelain; status; is-ancestor / merge-tree / cherry; branch --show-current
  R-->>S: leftoverDetails [{id, branch, folder, head, dirty, inMain, skip}]
  S->>J: VERDICT: and finding lines only (P24)
  S->>G: at most 3 reads per anomaly
  S-->>S: CAUSE: <anomaly> | <evidence> | <fix location>
```

*The root-cause step: one `CAUSE:` line per anomaly, from git, the disk, `decisions.md`, QC engineer verdict and finding lines and the plugin's own files.*
Traces to: ADR-0006 section 3; `skills/retro/SKILL.md` (sections 2 to 4, after stage 1).

the stress test's first step becomes `git reset --hard <sha>` in its own worktree (no longer `git checkout --detach <sha>`), and before it reports it runs `git reset --hard <sha>` and `git clean -fd` and confirms `git status --porcelain --untracked-files=all` prints nothing. It never commits, even when the worktrees hook tells it to commit; it discards instead (ADR-0006 section 2).

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| retro's `leftoverDetails` | `retro/counts.ts` | the `truss:retro` skill's root-cause step; retro's JSON stays internal (P15) | ADR-0006 section 1 | `tests/retro-counts-leftover-details.check.ts` |
| retro's top-level key set | `retro/counts.ts` | the `truss:retro` skill | `TOP_KEYS` grows by exactly `leftoverDetails` | `tests/retro-counts-contract.check.ts`, `tests/retro-counts-050.check.ts` |
| the stress test's start and end state | `agents/stress-engineer.md`, `agents/project-manager.md` | the stress engineer; worktrees' sweep | ADR-0006 section 2 and its literals table | `tests/redteam-reset.check.ts` |
| The root-cause step | `skills/retro/SKILL.md` | the model running `/truss:retro` | ADR-0006 section 3 | `tests/retro-cause.check.ts` |

### The self-improving retro (ADR-0012)

This section is the design of goal `retro-judge`, whose stage-1 and stage-2 crews have merged: `retro/`, `agents/retro-judge.md` and `factory.ts doctor` exist at `f01caf4`. [ADR-0012](adr/0012-self-improving-retro.md) holds every rule; this section maps the parts.

| Part | Path | What it does | Built by |
| --- | --- | --- | --- |
| retro-core | `retro/**` (`extract.ts`, `catalog.ts`, `scrub.ts`, `cli.ts`, `catalog.json`) | Reads the session's transcripts into the extract, holds and matches the known-problems catalog, checks committed text for names, emails, home paths and tokens, and gives the PM the `extract`, `findings`, `recur`, `scrub` and `state` commands. Node built-ins only. | crew `retro-core`, stage 1 |
| `truss:retro-judge` | `agents/retro-judge.md` | Opus at `medium`, `Read`, `Grep` and `Glob` only. Reads the spans the extract points to and returns `finding` blocks, each citing a transcript line. One per crew with items, plus one combining judge. | crew `retro-skill`, stage 1 |
| The retro skill and triage | `skills/retro/SKILL.md`, `agents/checking-engineer.md` | Runs the steps in order and records each in `retro/state.json`; the checking engineer's `Retro triage.` brief returns `TRIAGE:` lines. | crew `retro-skill`, stage 1 |
| Run wiring | `skills/run/SKILL.md`, `agents/design-engineer.md`, `skills/init/SKILL.md` | `doctor` in section 5, the automatic retro in section 10, crew `needs` in the plan, and truss writing `.claude/settings.json` with the classifier's refusal shown, never worked around. | crew `run-wiring`, stage 1 |
| The UI's retro stage | `ui/server/state/**`, `ui/web/**` | The state's `retro` key from `retro/state.json`, shown as the region `Retro stage` after the crew lanes. | crew `ui-retro`, stage 1 |
| factory doctor | `bin/factory.ts`, `workflows/stage.js` | `doctor` probes needs and catalog entries; `check` adds `catalog` hits; `finish` writes the extract; `stage.js` names known problems in its stop and fix-builder texts. | crew `factory-doctor`, stage 2 |

```mermaid
flowchart LR
  T[("transcripts<br/>&lt;session&gt;.jsonl, subagents/**")]
  C[("retro/catalog.json<br/>[plugin, committed]")]
  P[("plan.json<br/>crew needs")]
  F["factory.ts finish"]
  D["factory.ts doctor"]
  K["factory.ts check"]
  X[("retro/extract.json")]
  J["truss:retro-judge x (1 + crews)"]
  R["retro/cli.ts findings, recur"]
  FD[("retro/findings.json")]
  TR["checking engineer<br/>Retro triage."]
  G["fix goal<br/>amend, ADR-0010"]
  S[("retro/state.json")]
  UI["UI: Retro stage"]
  P --> D
  C --> D
  C --> K
  T --> F
  C --> F
  F --> X
  X --> J
  T -. "spans only" .-> J
  J --> R
  C --> R
  R --> FD
  FD --> TR
  TR --> G
  G -. "fixedBy" .-> C
  R -. "state" .-> S
  S --> UI
```

`doctor` runs after `plan-check` and before any crew starts; its bundle (allow rules, downloads, standing rulings) goes to the client with the plan as one approval. The retro starts after the end-of-run sweep without the client asking. Each step writes `retro/state.json` through `retro/cli.ts state`, and the UI shows it.

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| `<truss dir>/retro/extract.json` | `factory.ts finish`, `retro/cli.ts extract` | the judges, `findings`, `recur` | `extract.schema.json`; ADR-0012 Decision 2 | `tests/retro-contract.check.ts`, `tests/retro-replay.check.ts` |
| `retro/catalog.json`, its six seed ids and anchors | retro-core | the extractor, `check`, `doctor`, `stage.js`, `recur` | `catalog.schema.json`; ADR-0012 Decision 3 | `tests/retro-contract.check.ts` |
| `finding` blocks and `<truss dir>/retro/findings.json` | the judges; `retro/cli.ts findings` and `recur` | triage, the PM | `findings.schema.json`; ADR-0012 Decisions 4, 5 and 7 | `tests/retro-contract.check.ts` |
| `retro/cli.ts` commands and exports | retro-core | the PM, the retro skill | ADR-0012 Seams | `tests/retro-contract.check.ts` |
| `factory.ts doctor`, crew `needs` | factory-doctor; the plan design engineer | the PM | `plan.schema.json` `$defs.need`; ADR-0012 Decision 9 | `tests/doctor-contract.check.ts` |
| `check`'s `catalog` key, `finish`'s extract | factory-doctor | `stage.js`, the PM | ADR-0012 Decision 10 | `tests/doctor-contract.check.ts` |
| The retro skill, the judge and triage prompts | retro-skill | the PM, the judges, the checking engineer | ADR-0012 Decisions 1, 4 and 6 | `tests/retro-skill.check.ts`, `tests/retro-cause.check.ts` |
| Run skill sections 5 and 10, the init sentence | run-wiring | the PM | ADR-0012 Decisions 6 and 12 | `tests/run-retro.check.ts`, `tests/init.check.ts` |
| `<truss dir>/retro/state.json`, the `retro` state key and the `Retro stage` region | `retro/cli.ts state`; ui-retro | ui-state; the client | `retro-state.schema.json`, `ui/contract/state.schema.json`; ADR-0012 Decision 8 | `ui/contract/state.check.ts` |

Every file in the "Pinned by" column exists at `f01caf4`. The build crews' own tests add to them: `tests/retro/catalog.check.ts`, `cli.check.ts`, `extract.check.ts` and `scrub.check.ts`, and `tests/factory-retro.check.ts` (the stress cases and `stage.js`'s `known problem` text, its header says).

### Heartbeat and stalls

Every 60 seconds the module checks each crew agent listed as `running`. An agent counts as active at its spawn, each tool call and each model request. One with nothing on record starts counting from the first check. One that is `running` now but wasn't at the last check, or wasn't listed then, counts as active now and leaves the stalled set: a resumed agent isn't reported on its old activity. An agent idle for 15 minutes or more is reported once, until it is active again, with a toast, `[truss] stalled: <agent> (crew <crew>), no activity for <n>m`, and a prompt to the main session:

`[truss] stalled: <agent> in crew <crew>, no activity for <n>m. Check /truss and message the <crew> project manager. Read its transcript tail before you stop it; a resumed agent may be compacting.`

Each stall wake, and each idle-project-manager wake below, appends a `stall` line to `events.jsonl` (`kind` `agent` or `idle-project-manager`).

### Idle project managers

The same check looks at each listed project manager that a check saw go from `running` to stopped, is now `idle` (never `waiting`, `killed`, `failed` or `completed`) and has no member at work. A project manager first seen stopped, as after a reload, is never a candidate until it runs and stops again. A candidate is excused while it waits on the PM (a `QUESTION:`, `BLOCKED:` or `PROPOSAL:` tag) or after a final report (a `## Proof` section, `CHECKPOINT:` or `BLOCKED:`) in its current stint. A stint begins at the check that sees the project manager running again; activity alone doesn't start one, so a sign-off after a final hand-back doesn't undo it. The report and tag in its report file count as well when written in the stint, so a reloaded module doesn't prompt for a project manager that already reported. Otherwise its idle period starts at the first check, and after 15 minutes the main session gets one prompt per period:

`[truss] idle project manager: <project-manager> in crew <crew>, no report for <n>m and no member at work. Read its last message and resume it with SendMessage, or start <crew>-2 from its report.`

The period ends when the project manager runs again or a report of its own is captured. The successor named is the crew's next one: `auth` gives `auth-2`, `auth-2` gives `auth-3`.

### Limit-reset wake

Two events arm it, and only while a project manager is live: a `session.measure` showing the five-hour window at 100 percent, or a `StopFailure` with error `rate_limit` (the hook then reads the session's usage, and arms only if that shows the five-hour window at 100 percent too). The module sets a timer for two minutes after `resetsAt` and records the reset in plugin state. When the timer fires, it claims the reset in plugin state and sends:

`[truss] limit reset: the five-hour usage window reset at <resetsAt>. Check /truss and message each project manager whose crew isn't done to resume.`

The wake goes out once per `resetsAt`. A hot reload cancels the timer with the old module, and `session.start` arms it again from plugin state. If the main session made a tool call or model request after `resetsAt`, the reset is claimed and no prompt goes out: the PM is already at work.

### Decision times

A `Write` or `Edit` of `<truss dir>/decisions.md` for this session has each new line that starts `- HH:MM |` rewritten with the clock's local time. A line keeps its time when that `HH:MM` is already on a decision line of the text the call replaces: the file on disk for a `Write`, `old_string` for an `Edit`. So a reworded line keeps its time, and only new lines are stamped. A pattern of just `^- (\d{1,2}:\d{2}) \|`, misses the literal `HH:MM` the run skill tells the PM to type, so those lines would keep no time; the pattern is `^- (\d{1,2}:\d{2}|HH:MM) \|`, and a literal `HH:MM` is always stamped, since it marks no time ([ADR-0003](adr/0003-event-log-and-retro.md), section 2). An `Edit` changes only `new_string`. A log written through Bash isn't seen. Line endings are kept. Any other file, and another session's log, is left alone.

### `/truss`

Prints `Crews (<n>):` and one line per project manager: name, status (`ended` once the agent list drops it), live members by model family, then one of `waiting on you: <question>`, `blocked: <text>`, `proposal: <text>`, `waiting on members`, `no report yet` or `last report <time> ago`, then `last active <time> ago`. Under each project manager it lists stalled agents, the verdict in the crew's newest QC file this run and the report folder. That verdict is read the way the merge gate reads it: `qcFilesOf` (`register.ts:1671`) lists the crew's QC files, `latestQc` (`:615`) picks the newest one modified at or after `approvedAt`, and `qcRuling` (`:646`) rules it, so a `VERDICT:PASS` with no space is no PASS here either. (Built by the `hooks-cleanup` crew; status once kept a parser of its own that picked the file by its `-qc-<k>` number.) Then it lists one line per member: `<name> <status> <n>m (<family>), last activity <time> ago` (or `no activity seen`), timed from its spawn or first sighting. The last lines name the message log, when there is one, and `Truss dir: <path>`. With no crews it prints `No truss crews in this session. Start them with /truss:run.` If reading the crews fails: `truss could not read the crews; see the debug log.`

`/truss` first shows the plan, read through the same guard as the gates: `Plan (<n> crews, approval <approval>):`, with `, waiting for the client` added while `approval` is `client` and `approvedAt` is null, then one line per crew sorted by stage, ties in `crews` order: `- stage <stage>: <slug>, <verdict>, <status>`, with `, waits for the client's approval` when `clientApproval` is `pending`. A missing field prints as `?`. Then come the lines above. With no plan, or one it can't read, the output is just the lines above.

**Goals and wait reasons ([ADR-0010](adr/0010-mid-run-intake.md), section 5).** `planLines` changes in two ways. Every `planned` crew gets `, ` plus its wait text from `gateOf` (see [Plan gates](#plan-gates)), or `, ready to start` when no gate refuses it; other statuses get no suffix, and a pending crew's line reads as before. When `goals` is a non-empty array, the header becomes `Plan (<n> crews, <k> goals, approval <a><waiting>):` with `k = 1 + goals.length`, and each goal gets a line, `Goal <id> (approval <a>[, waiting for the client][, done]): <text>`, with its crews under it in today's order: `run` first, then `goals` in array order, then any unknown ids crews name, as `Goal <id> (not in the plan):`. `<text>` has each whitespace run collapsed to one space and is cut to its first 99 characters plus `…` when longer than 100. Without `goals` there are no goal lines and the header is today's. ADR-0010's example, a plan with the run's four crews and one added goal `intake`:

```
Plan (7 crews, 2 goals, approval client):
Goal run (approval client): Make truss prod-grade on quality and bloat, from the reviewed anti-bloat analysis: (1) hook clean…
- stage 0: eval-design, design, merged
- stage 1: hooks-cleanup, extend, merged
- stage 1: evals-build, change, running
- stage 2: prompt-rules, change, planned, waits for stage 1 to merge: evals-build
Goal intake (approval client): Mid-run intake: start new crews mid-run, tell the client what is in progress, take more work
- stage 0: intake-design, design, running
- stage 1: intake-gates, change, planned, waits for prompt-rules to merge
- stage 1: intake-retro, change, planned, waits for prompt-rules to merge
```

The live-crew block below it doesn't change, and the PM answers a progress question from this view or from `plan.json`, one line per goal.

### Failing open

Each hook step runs inside a guard. If Truss's code throws, the guard logs `truss: <step> failed, letting the call through: <error>` or `truss: a hook failed and was skipped: <error>` to the debug log, and the call goes on as if the plugin weren't installed. A step that fails refuses nothing.

The Workflow handler ([ADR-0009](adr/0009-workflow-factory.md), Decision 6; `register.ts:2281`) fails open the same way, through `.catch(failOpen)`. So a throw in the Workflow gate, or a `tool.call` that never fires for the main session's Workflow call, lets the run through unchecked. The gates don't rest on that hook alone: `factory.ts start` refuses a crew `planVerdict` refuses, `spawn()` in `plan.js` and `stage.js` throws before `agent()` on a role that is missing or fails `workflowRoleVerdict`'s rules, and `finish`'s session audit blocks every merge while it finds a `truss:*` agent in a run that isn't Truss's, or an agent of an in-scope run with no explicit model or a model family other than opus or sonnet. So without the hook an agent on the wrong model can still run and spend tokens, but its work can't reach the target (ADR-0009, Decision 6).

The resource checks ([ADR-0015](adr/0015-resource-aware.md), proposed) fail open too. When the sampler throws, `admit`, `heavy` and `start` let the start through and append a `sampler-error` event. A missing or bad `resources/parallelism.json` means `maxParallelCrews`. The runner's result is the exception: `admit` in `stage.js` fails closed ([ADR-0027](adr/0027-retro-fixes2.md), F-67). A result that isn't JSON, or has no boolean `admitted`, stops the crew BLOCKED with the runner's output, under a reason that starts `admission check failed:`, never `held by admission:`. A sampler error still prints `admitted: true` with `freeMB: null`, so it still admits (ADR-0015, G7).

## Local web UI

`ui/` is an optional local web UI for one Truss run ([ADR-0011](adr/0011-local-web-ui.md), proposed 2026-10-30 by the `ui-design` crew). The client starts one Node process with `node ui/server/main.ts` (or `npm --prefix ui start`), opens the printed URL, and runs Truss from the browser. The process hosts a Claude Code session through `@anthropic-ai/claude-agent-sdk`, with the Truss plugin loaded, and shows the run live from the files Truss writes, plus this run's Claude Code workflow transcripts, read-only, first brief line only, bounded ([ADR-0029](adr/0029-real-data.md) section 2, the client's ruling "Yes, read them"). That is how R-9 reads now: it never changes the plugin, and it never writes to the Truss dir, the repo or the Claude dir. ui-state, ui-session and ui-server exist under `ui/server/`; the web client is being rebuilt, as below.

The web client is redesigned by [ADR-0018](adr/0018-ui-redesign.md) (proposed 2026-11-02, goal `ui-redesign`), which supersedes ADR-0011's no-bundler web client only, and amended by [ADR-0023](adr/0023-factory-floor-ui.md) (proposed 2026-11-03, revision 5b). ADR-0023 replaces ADR-0018's visual direction with direction D and D2, and keeps ADR-0018's behaviour contract. The client is React 19, TypeScript, Vite, Tailwind CSS v4 and shadcn/ui restyled to D2's tokens (`ui/contract/redesign/tokens.json`), with lucide icons and Geist, and its source in `ui/app/`. Crew floor-shell builds the shell and store, and crew floor-views the views. `npm --prefix ui run build` writes `ui/web/index.html` and its assets, and `main.ts` serves `ui/web/` (`ui/server/main.ts:80`). Today `ui/web/` still holds the tracked vanilla client; floor-shell replaces it with untracked build output. When the build is missing, the server still starts, prints one stderr line naming the build command, and answers `GET /` with an error page that names it (ADR-0018, section 3). The routes and the SSE wire keep their shape; ADR-0023 adds optional state fields and an optional message `intent`, listed under "Gap fields" below.

The UI rework, [ADR-0028](adr/0028-ui-rework.md) (proposed 2026-11-04, crew `rework-design`), amends ADR-0023's layout and ADR-0011's session input to follow the client's design reference (R-36 to R-47). The page has two columns. The rail holds the run status, the target repository, the thread with the PM and the composer, and the one list of ADRs and decisions. Main holds Your move, the build network (PM node, wires and crews of agent cards), the deliverables with the architecture drawn, and the run metrics. With no `plan.json`, a goal sent from the page reaches the session as `/truss:run <text>`. The design panel draws mermaid blocks under the unchanged CSP. The new optional fields are listed under "Rework fields" below.

```mermaid
flowchart LR
  browser["Browser tab<br/>[ui-web: source ui/app/, build output ui/web/]<br/>Your move, metrics, composer, crews, deliverables"]
  http["ui-server<br/>[ui/server/http, ui/server/main.ts]<br/>127.0.0.1, token, SSE"]
  state["ui-state<br/>[ui/server/state]<br/>Files to one state"]
  session["ui-session<br/>[ui/server/session]<br/>The only SDK importer"]
  sdk["Claude Code<br/>[@anthropic-ai/claude-agent-sdk]<br/>PM session, Truss plugin loaded"]
  hooks["Truss hooks<br/>[hooks/register.ts, unchanged]"]
  tdir[("Truss dir<br/>plan.json, plan.md, events*.jsonl,<br/>messages*.jsonl, reports/, decisions.md")]
  repo[("Repo<br/>.claude/truss.json, architecture doc,<br/>ADR dir, git branches")]

  browser -->|"GET /api/events (SSE)<br/>POST message, answer"| http
  http -->|"snapshot, since, subscribe"| state
  http -->|"send, answer"| session
  session -->|"setSession(view)"| state
  session -->|"query(): streaming input,<br/>canUseTool replies"| sdk
  sdk -->|"messages, canUseTool calls"| session
  sdk -.->|"loads"| hooks
  hooks -->|"writes"| tdir
  state -->|"polls, reads by byte offset"| tdir
  state -->|"reads, runs git"| repo
```

*The UI's modules and what each reads. Solid arrows are calls or reads inside the UI process, or the SDK link. The UI writes no file.*
Traces to: ADR-0011, Decisions 1 to 9; ADR-0023, section 8.

### Module map

| Module | Path | Responsibility | Built by |
| --- | --- | --- | --- |
| ui-state | `ui/server/state/**` | Reads the Truss dir, `.claude/truss.json`, the architecture doc, the ADR dir and git. Given a `claudeDir`, fills a member's missing task from the first brief line of its Claude Code transcript, read-only, and reads none without one ([ADR-0029](adr/0029-real-data.md) section 2). Reduces them, with the session view, into one in-memory state. Emits a snapshot and numbered deltas, and keeps a replay ring of 1024. | crew `ui-state`, stage 1 |
| ui-session | `ui/server/session/**` | Hosts the session with `query()`. Turns `canUseTool` calls and turn ends into question, approval and reply-needed requests, and answers each at most once. The only module that imports the SDK (ai rule 7). | crew `ui-session`, stage 1 |
| ui-server | `ui/server/http/**`, `ui/server/main.ts`, `ui/server/node-version.ts`, `ui/server/lifecycle.ts` | Serves `ui/web/`, the SSE stream and the POST routes on `127.0.0.1`, behind the Host, Origin and token checks. `main.ts` parses flags, resolves the Claude dir (`--claude-dir`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`) and passes it to `createStore`, wires the modules and prints the URL. | crew `ui-server`, stage 1 |
| ui-web | `ui/app/**` (source), `ui/web/` (build output), `ui/e2e/**`, `ui/README.md` | A React and Vite client ([ADR-0018](adr/0018-ui-redesign.md), styled to direction D and D2 by [ADR-0023](adr/0023-factory-floor-ui.md)), built by `npm --prefix ui run build`. Applies the snapshot and deltas, and renders Your move, the live metrics, the composer with its follow-ups, the crews in stage groups, the retro stage, deliverables, decisions, ADRs and the design panel. Before ADR-0018: static HTML, CSS and plain ES modules, no bundler. | crew `ui-web`, stage 2; redesign by goal `ui-redesign`, crews floor-shell and floor-views |

ui-server's two startup files came after its crew, outside any crew. `node-version.ts` is the startup check: `readEnginesRange(dir)` reads `engines.node` from `<dir>/package.json`, or null, and `nodeVersionWarning(running, range)` returns one warning line when the running Node is older than a `>=X[.Y[.Z]]` or `^X[.Y[.Z]]` range, and null otherwise; it never throws or exits (`ui/server/node-version.ts:1-36`, `ui/server/main.ts:39-40`; commits `de8abc9` and `d133450`). `lifecycle.ts` is the process lifecycle for `main.ts`: shutdown on `SIGINT`, `SIGTERM`, `SIGHUP` and `SIGBREAK`; a parent-death watch on an unref'd timer, skipped under ppid 1; a per-port lockfile `truss-ui-<port>.json` in the OS temp dir, created exclusively with mode 0600 and holding no token; and the "port in use" message, naming a live lock's pid when there is one. It uses Node built-ins only, and no function throws (`ui/server/lifecycle.ts:1-230`, `ui/server/main.ts:88-121`; commits `8489b53` and `668c05b`). The watch checks only the direct parent today (`ui/server/lifecycle.ts:32-45`), so on Windows a server started by `npm --prefix ui start` outlives the task, its parent being `cmd.exe`. [ADR-0014](adr/0014-retro-fixes.md) (proposed, Decision 5) makes `watchParent` read the ancestor chain once at start, through an injected `ancestors()`, and check each ancestor's liveness every 1 s; when the chain can't be read, it falls back to the parent-only check.

`ui-design` (stage 0) owns the shared files: `ui/package.json`, its lockfile, `ui/.gitignore`, `ui/playwright.config.ts`, `ui/contract/**` and `ui/spike/**`.

### Seams

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| Snapshot and delta messages | ui-state | ui-server (carries), ui-web (applies) | `ui/contract/state.schema.json`; ADR-0011 Decision 5 | `ui/contract/state.check.ts`, `ui/contract/http.check.ts` |
| `StateSource`, `Store`, `createStore`, `trussDirFor` | ui-state | ui-server, `main.ts` | ADR-0011 Decision 9 | `ui/contract/state.check.ts` |
| `SessionControl`, `Session`, `createSession`, the pure folds and the registry | ui-session | ui-server, `main.ts` | ADR-0011 Decisions 3 and 9 | `ui/contract/session.check.ts` |
| `replyStep`, when a reply-needed card opens, [ADR-0014](adr/0014-retro-fixes.md), proposed | ui-session (`ui/server/session/index.ts`) | `onMessage` in `ui/server/session/session.ts` | ADR-0014 Decision 3 and Seams section 3 | `ui/contract/background-reply.check.ts` |
| `SessionView` passed to `store.setSession` | ui-session | ui-state | the schema's `session`, `requests`, `transcript`; ADR-0011 Decision 9 | `ui/contract/session.check.ts` |
| HTTP routes, status codes, SSE ids, Host, Origin and token rules | ui-server | ui-web | ADR-0011 Decision 6 | `ui/contract/http.check.ts` |
| The page, by role and accessible name | ui-web | the client | R-3 to R-7, R-15, R-18 | `ui/contract/e2e/live-status.spec.ts` |
| SDK messages and `canUseTool` | Claude Code | ui-session | the recorded stream `ui/contract/fixtures/sdk-stream.jsonl`; ADR-0011 Spike | `ui/contract/session.check.ts` (replay), `ui/contract/live.check.ts` (live) |
| Truss files the UI reads | Truss hooks and the PM | ui-state | `docs/events.schema.json`, `docs/plan.schema.json`, "On disk" above | `ui/contract/state.check.ts` on `tests/fixtures/retro-040` and `docs/plan.example.json` |
| Claude Code workflow transcripts the UI reads: the first line of `agent-<agentId>.jsonl` under `<claudeDir>/projects/<projectKey>/<session id>/subagents/` (in `workflows/<wf id>/` for a `workflow:<wf id>` spawn), read-only | Claude Code | ui-state | [ADR-0029](adr/0029-real-data.md) section 2 | `ui/contract/rework/real-data.check.ts` |
| The retro stage: `<truss dir>/retro/state.json`, the state's `retro` key, and the region `Retro stage` with one list item per step, `<label>: <status>` | `retro/cli.ts state`; ui-state; ui-web | the client | `docs/retro-state.schema.json`, `ui/contract/state.schema.json` `$defs.retro`; ADR-0012 Decision 8 | `ui/contract/state.check.ts`, `ui/contract/e2e/retro-stage.spec.ts`, `ui/test/state/retro.test.ts` |
| The gap fields and `POST /api/message` with `intent`, returning `{ok, id}` | ui-session, ui-state, ui-server | ui-web | [ADR-0023](adr/0023-factory-floor-ui.md), section 1; `ui/contract/state.schema.json` | `ui/contract/gaps.check.ts`, one case per filled gap titled `gap <x>: ...` (written by crew floor-design) |
| D2's tokens in the built CSS | ui-web (`ui/app/styles/`) | the page | `ui/contract/redesign/tokens.json`; ADR-0023, section 2 | `ui/contract/redesign/tokens.check.ts` |
| `createStore(StoreDeps {open, reload})` and `getState()` over the ten state fixtures | ui-web (`ui/app/store/store.ts`) | the views | ADR-0018 section 9; ADR-0023, sections 6 and 7 | `ui/contract/redesign/store.check.ts` (written by crew floor-design) |

Each contract check imports its producer and, when the import fails, fails with `producer missing: ui/server/<module>`.

### Answering a request

```mermaid
sequenceDiagram
  participant B as Browser (ui-web)
  participant H as ui-server
  participant S as ui-session
  participant C as Claude Code (SDK)
  participant T as ui-state
  C->>S: canUseTool("AskUserQuestion", input, {signal})
  S->>S: registry.open(question card)
  S->>T: setSession(view)
  T-->>H: delta (set.requests)
  H-->>B: SSE id <instance>:<seq>
  B->>H: POST /api/requests/<id>/answer {answers}
  H->>S: answer(id, body)
  S-->>C: {behavior: "allow", updatedInput: {questions, answers}}
  H-->>B: 200 {ok: true, request}
  B->>H: same POST again
  H->>S: answer(id, body)
  H-->>B: 409 {error: "answered", request}
```

*A question card, answered once. A permission card is the same with `{decision}`. A reply-needed card opens on each top-level `result`, and its answer goes into the streaming input as text (ADR-0011 Decision 3). From [ADR-0014](adr/0014-retro-fixes.md) (proposed), `replyStep` holds a result that ends while background tasks run, and opens its card when they drop to 0.*

### Gap fields

[ADR-0023](adr/0023-factory-floor-ui.md), section 1, rules on the eight server gaps that D2's screens showed. Each filled gap is additive: the fields are optional in `ui/contract/state.schema.json`, no `required` list grows, and the guard and CSP don't change. Crew floor-server builds them.

| Gap | Ruling | Field and source |
| --- | --- | --- |
| a | fill | `transcriptEntry.id` and `intent` (`goal`, `add` or null). `POST /api/message` takes an optional `intent` and answers `202 {ok, id}`; with an intent the session prepends one fixed line. Answers still use the answer route. |
| b | fill | `session.queue`: `{id, text, intent, at}` for each message the SDK has not yet taken, from the session's queue and outbox. |
| c | ship without | `run.version` keeps its meaning; the UI shows no plan revision. |
| d | fill | `run.goals`: `{id, goal, approval, approvedAt}`, the run's first goal first as id `run`, then plan.json `goals` in order. |
| e | fill | `usage.live`: running token counters from assistant `usage` and task_progress `usage.total_tokens`, with an `at` stamp. Result usage is unchanged. |
| f | fill | `crew.estAgents` from plan.json. There is no task total, so the tasks tile shows no denominator. |
| g | fill | `crew.stuck`: `{kind, since, minutes, detail}` from the crew's latest `stall` event, or null. |
| h | ship without | No control endpoints. The stuck-crew buttons send ordinary messages; Pause is disabled with D2's tip. |

The page's ten screenshot states, their copy and the fixtures under `ui/contract/fixtures/run/<state>/` are in ADR-0023, sections 4 to 6.

### Rework fields

[ADR-0028](adr/0028-ui-rework.md) adds these optional fields, again with no `required` list growing:

| Field | Source |
| --- | --- |
| `session.flow`: `{at, tool, to, summary}`, the last 200 | the PM's top-level `Agent`, `SendMessage` and `Workflow` tool calls; `to` is a crew slug or null |
| `member.agentId` | the spawn line's `agentId` |
| `member.task` | the latest SDK `task_started` or `task_progress` `description` whose `task_id` equals `agentId` |
| `member.purpose` | the first sentence of `agents/<type>.md` `description:` |
| `replyRequest.approvalAsk` | a rule in ui-session on the turn's text; false when unsure |
| `crew.eventsUnread` | the count of the crew's event lines skipped for `version` |

ADR-0028 section 1 also changes what intent `goal` sends before a plan exists: `/truss:run <text>` instead of the fixed line. The rework fixture states are under `ui/contract/fixtures/rework/<state>/`.

### On disk

Nothing. The state, the replay ring, the requests and the transcript live in the process's memory (R-13). Restarting the server starts them over; a reconnecting tab from the old process gets a fresh snapshot, because its `instance` differs.

### Principles: what binds `ui/`

**P19 binds the plugin, not `ui/`** (R-11, `docs/requirements.md:81`). The plugin stays erasable TypeScript on Node built-ins only. `ui/` is its own package with its own `package.json` and lockfile. Its runtime dependencies are `@anthropic-ai/claude-agent-sdk`, `marked` and `mermaid` (exactly `12.2.0`, [ADR-0028](adr/0028-ui-rework.md) section 5); its dev dependencies are `@playwright/test` and `@axe-core/playwright`. Its server code is still erasable TypeScript, run by Node 24 as is. No file in `ui/` imports the plugin, and the plugin imports nothing from `ui/`.

**Core pack: all 15 rules adopted.** Rule 1: each module exports from its `index.ts` only. Rule 3: ui-server takes `StateSource` and `SessionControl` as interfaces, which `http.check.ts` implements. Rule 6: every POST body and query is checked at ui-server. Rule 7: a repeated answer POST leaves the same state. Rule 10: the server binds `127.0.0.1` and refuses requests without the token.

**Frontend pack.**

| Rule | Ruling | Reason |
| --- | --- | --- |
| 1 to 11 | adopted | ui-web is small, but the rules cost nothing extra. Rule 6 covers no Truss dir yet, an empty run and the session error. Rules 10 and 11 back R-18. |
| 12 | adopted, in the e2e run | The repo has no CI. `npm --prefix ui run e2e` runs an axe check (`@axe-core/playwright` 4.14.0, WCAG 2.2 AA tags) over each page state the e2e specs reach, and fails on any violation. ui-web writes that spec under `ui/e2e/`. |
| 13 | dropped | No routes, no bundler and no public users: one local page on loopback. A per-route budget has nothing to measure against. R-15's 2 s and 1 s times are the budget, checked by the e2e specs. |
| 14 | adapted | No rule-13 budget, but code the first screen doesn't need loads through `import()`: `marked` loads when the design panel first opens (ADR-0011 Decision 7). `mermaid` loads through `import()` in `ui/app/views/design/DesignPanel.tsx` only, the first time an architecture with a mermaid block opens, with `securityLevel: 'strict'` and no CSP change (ADR-0028 section 5). The client accepted the change from "Mermaid isn't added" for R-38. |

**Service pack.**

| Rule | Ruling | Reason |
| --- | --- | --- |
| 1, 2 | adapted | Config is flags, not environment: `--repo`, `--plugin`, `--truss-dir`, `--port`, `--claude-dir`, with `INIT_CWD` as the repo default. `--claude-dir` falls back to `CLAUDE_CONFIG_DIR`, then `~/.claude`, resolved in `main.ts` only ([ADR-0029](adr/0029-real-data.md) section 2). Bad flags or a plugin root without `.claude-plugin/plugin.json` exit 2 at start. |
| 3 | dropped | One process holds the session and the state in memory by design. A restart starts over (R-13). |
| 4 | adopted | The only attached resource is the local Claude Code, reached through the SDK. |
| 5 | dropped | No health endpoint: one local process and one tab, and the SSE ping every 15 s tells the tab the process is there. The process checks liveness the other way, from [ADR-0014](adr/0014-retro-fixes.md) (proposed): `watchParent` checks its ancestor chain every 1 s and shuts the server down when one dies. |
| 6 | dropped | No backing service to check; there is one process and one user. |
| 7 | adopted | `SIGINT` and `SIGTERM` close the session and the server and exit 0. |
| 8 | adapted | The process prints one stdout line, the URL. Errors go to stderr, one line each. |
| 9, 10 | dropped | There is one environment, the client's machine, and no build artifact. |
| 11 | adopted | `ui/package.json` pins exact versions and `ui/package-lock.json` locks them. |
| 12 | adopted | Each git child process has a 10 s timeout. The SDK call has none, by R-22 and because a `canUseTool` prompt may wait for the client indefinitely. |
| 13 | dropped | No admin or one-off tasks; the UI has no data to migrate. |

**AI pack.** The UI hosts the PM session; it makes no model call of its own and owns no prompt.

| Rule | Ruling | Reason |
| --- | --- | --- |
| 1 to 4 | dropped | The UI changes no prompt, model or retrieval setup, so there is nothing to eval. Truss's prompts and evals stay in the plugin (ADR-0007). |
| 5 | dropped | R-20: the session uses Claude Code's default model. The UI passes no model and shows the one `init` reports. |
| 6 | dropped | Claude Code traces its own calls. The UI shows the model, cost and token counts the SDK reports (R-22) and keeps no trace (R-13). |
| 7 | adopted | ui-session is the only module that imports the SDK. |
| 8 | adopted | ui-session parses SDK messages and `canUseTool` input into the schema's types at the seam; a message it doesn't know is ignored, not passed on. |
| 9 | adopted | Routing a prompt to a card kind, and the at-most-once answer rule, are code in ui-session. |
| 10 | adopted | `session.check.ts` replays the recorded stream with no network. `live.check.ts` is the only live check, and no acceptance test runs it. |
| 11 | adopted | Every tool the session can't run unprompted waits for the client's approval card. The UI never sends `updatedPermissions`. |
| 12 | adopted | The client's text goes in as a user message. The UI adds no system prompt. |
| 13 | dropped | R-22: no spending ceiling. The header shows the session's total cost instead. |
| 14 | dropped | A turn may run, or a prompt may wait for the client, as long as the PM needs; a timeout would cut a run off. |

### Not verified yet

The open points are in ADR-0011, "Not confirmed". The one that can stop a run: whether the `[truss] dir:` note reaches the PM when the SDK hosts the session. `ui/contract/live.check.ts` and the client's own R-21 run must show it.

## Repo layout (ADR-0013)

The move to plugins/truss/ is done: the plugin lives at `plugins/truss/`, beside `ui/` at the repo root, and the catalog is `marketplace/.claude-plugin/marketplace.json`, with `marketplace/README.md` beside it. Publishing the `marketplace` branch from `marketplace/` is still a PM ship step (ADR-0013, "Ship steps").

This section is the design from [ADR-0013](adr/0013-plugin-layout.md) and its amendment for goal `plugin-move`. A user runs two commands, `claude plugin marketplace add AbhiramDwivedi/truss` and `claude plugin install truss@truss`, and gets the plugin with no `ui/` anywhere under their Claude config (ADR-0013, "The client's rulings"). Two things make that work: the plugin lives in its own directory, `plugins/truss/`, and the catalog lives on its own `marketplace` branch, whose one entry is a `git-subdir` source into `main:plugins/truss`. When the move lands, this section moves with the doc to `plugins/truss/docs/architecture.md`.

### What moves

The move takes the 17 top-level plugin paths that `git ls-tree --name-only HEAD` lists at 1cc086f, beside `.claude`, `.gitignore`, `LICENSE`, `checks` and `ui`: `agents`, `bin`, `brief`, `docs`, `evals`, `hooks`, `resources`, `retro`, `scripts`, `skills`, `tests`, `types`, `workflows`, `.claude-plugin`, `tsconfig.json`, `README.md` and `CHANGELOG.md`. `resources/` (ADR-0015) came after ADR-0013 was written; decision C6 adds it. `plugins/truss/` also gets a copy of `LICENSE`, and the 24 tracked `tests/__pycache__/*.pyc` files are untracked (`.gitignore` already ignores `__pycache__/` and `*.pyc`).

After the move the repo root holds exactly `.claude`, `.gitignore`, `LICENSE`, `checks`, `marketplace`, `package.json`, `plugins` and `ui` (the plugin-move acceptance test's root-tree guard).

### The two branches

```mermaid
flowchart TB
  subgraph main["branch main (repo root)"]
    plugin["truss plugin<br/>[plugins/truss/**]<br/>agents, bin, brief, docs, evals, hooks, resources,<br/>retro, scripts, skills, tests, types, workflows,<br/>.claude-plugin, LICENSE copy"]
    ui["Local web UI<br/>[ui/**]<br/>Optional; never installed by the plugin"]
    mdir["Catalog source<br/>[marketplace/.claude-plugin/marketplace.json,<br/>marketplace/README.md]"]
    checks["Root contract<br/>[checks/repo-home.check.ts]"]
    root["Root files<br/>[package.json, LICENSE, .gitignore, .claude/truss.json]"]
  end
  subgraph mbranch["branch marketplace (GitHub default)"]
    cat["Published catalog<br/>[.claude-plugin/marketplace.json, README.md]<br/>tree = main:marketplace"]
  end
  subgraph cfg["User's Claude config dir"]
    mclone["Marketplace clone<br/>[plugins/marketplaces/truss/]<br/>two files"]
    cache["Plugin cache<br/>[plugins/cache/truss/truss/VERSION/]<br/>plugins/truss/** only"]
  end

  mdir -->|"PM: git subtree split --prefix=marketplace main"| cat
  cat -.->|"git-subdir entry: url https://github.com/AbhiramDwivedi/truss.git,<br/>path plugins/truss, ref main"| plugin
  ui -->|"--plugin, default ui/../plugins/truss<br/>(ui/server/main.ts)"| plugin
  root -->|"architecture, adr = plugins/truss/docs/..."| plugin
  checks -->|"reads, runs the install commands"| mdir
  checks -->|"reads"| plugin
  cat -->|"claude plugin marketplace add"| mclone
  plugin -->|"claude plugin install truss@truss<br/>(sparse fetch)"| cache
```

*The layout after the move. main holds the plugin, the UI and the catalog source; the `marketplace` branch holds only the published catalog. Solid arrows are writes, reads or fetches; the dotted arrow is the catalog entry's reference into main. Neither box under the config dir gets `ui/`.*
Traces to: ADR-0013 Decision 1 and 2, and its "Architecture-doc text for the later goal"; ADR-0013 "Amendment (goal plugin-move)"; `checks/repo-home.check.ts:47-84`, `:160-168`.

### Install flow

```mermaid
sequenceDiagram
  actor User
  participant CC as claude CLI
  participant GH as github.com/AbhiramDwivedi/truss
  participant Cfg as Claude config dir

  User->>CC: claude plugin marketplace add AbhiramDwivedi/truss
  CC->>GH: clone the default branch (marketplace)
  GH-->>CC: .claude-plugin/marketplace.json, README.md
  CC->>Cfg: write plugins/marketplaces/truss/ (two files, no ui/)
  User->>CC: claude plugin install truss@truss
  CC->>Cfg: read the truss entry: source git-subdir, url https://github.com/AbhiramDwivedi/truss.git, path plugins/truss, ref main
  CC->>GH: sparse fetch of main:plugins/truss
  GH-->>CC: plugins/truss/** only
  CC->>Cfg: write plugins/cache/truss/truss/VERSION/ (no ui/, checks/, plugins/ or package.json)
```

*The two documented commands. Neither step downloads `ui/`. The entry's `ref` `main` is required: without it, the git-subdir fetch would land on the default branch, which is the two-file `marketplace` branch (ADR-0013 Decision 2).*
Traces to: ADR-0013 Decision 2 and "Install flow"; `checks/repo-home.check.ts:151-152` (the two commands, run literally), `:77-80` (the entry), `:160-168` (the cache).

The install flow is proven against a local smart-HTTP copy of the repo, not against github.com (ADR-0013, "Scope of the proof"). The PM's real-GitHub check after the ship steps proves it there.

### Seams the move pins

| Seam | Producer | Consumer | Contract | Pinned by |
| --- | --- | --- | --- | --- |
| The plugin root the UI loads | plugin | `ui/server/main.ts` | Default plugin dir `join(uiDir, '..', 'plugins', 'truss')` when no `--plugin` is given. Today `ui/server/main.ts:43` is `resolve(args.plugin ?? join(uiDir, '..'))`, ui/'s parent. | the plugin-move acceptance test (the ui server starts with no `--plugin`) |
| The architecture doc paths | repo layout | truss hooks and `bin/factory.ts` | `.claude/truss.json` `architecture` = `plugins/truss/docs/architecture.md`, `adr` = `plugins/truss/docs/adr`; `merge` `sequential` and `target` `main` stay. Today it names `docs/architecture.md` and `docs/adr`. | `checks/repo-home.check.ts:61-65` (suite `repo-home layout`); the plugin-move acceptance test |
| The catalog entry | marketplace | Claude Code's installer | `marketplace/.claude-plugin/marketplace.json`: name `truss`, an owner, one plugin `truss` with no `version`, source `{"source":"git-subdir","url":"https://github.com/AbhiramDwivedi/truss.git","path":"plugins/truss","ref":"main"}`; `marketplace/` tracks exactly that file and `marketplace/README.md` | `checks/repo-home.check.ts:68-84` (suite `repo-home marketplace`) |
| Root scripts | repo layout | the developer | root `package.json` with no `dependencies` or `devDependencies`; `scripts.test` = `node --test plugins/truss/tests/*.check.ts plugins/truss/tests/*/*.check.ts && node --test checks/*.check.ts`, `scripts["test:ui"]` = `npm --prefix ui test` | `checks/repo-home.check.ts` ('root package.json has no dependencies and a test script'); the plugin-move acceptance test (exact scripts) |
| The published branch | the PM's publish step | `claude plugin marketplace add` | `origin/marketplace^{tree}` equals `main:marketplace` | the sync check, a PM ship step (ADR-0013 amendment); no automated check |

The ADR-0013 amendment lists the other files the move changes: 13 ui files that take the plugin to be ui/'s parent, and 6 plugin files that break under a pure move.

Doc line citations are checked by `citationFailures` in `plugins/truss/tests/release-026.check.ts:156`. A `path:line` citation passes when a symbol it names (a backtick identifier in its clause or line, or an `ABOUT` pin) is in the cited lines or anywhere in the cited file. It fails only when every named symbol is absent from the file, the file is missing, or the line is past its end. A bare `:N` after another citation is not checked. So line drift never fails the check; to find drift, confirm the cited lines themselves hold the symbol. Cite as `symbol` (`path:line`) in one clause.

## Plugin dependencies

truss uses kit, worktrees and subagent-limits where they live, in the claude-ops marketplace, and copies none of them. [ADR-0021](adr/0021-plugin-dependencies.md) records the decisions; this section is the map.

| Dependency | Range | What truss uses it for |
| --- | --- | --- |
| kit | `^0.4.0` | The project manifest init builds on, `kit:init` when the manifest is missing, `kit:persona` (how to write a persona agent file, ADR-0032), and the `kit:builder` and `kit:test-writer` member types where no persona covers an area |
| worktrees | `>=0.8.4 <0.11.0` | Worktree slots and `PORT_BASE` (ADR-0002 Decision 4); it also cleans merged, clean `wf_*` worktrees |
| subagent-limits | `^0.3.2` | The context budget in every subagent's brief, the `nudgeAtK` checkpoint and `stopAtK` stop, and the `split-work` skill the project manager and planner load |

Every entry names `marketplace: "claude-ops"`. The truss catalog allows it with `allowCrossMarketplaceDependenciesOn: ["claude-ops"]`. A user installs with the claude-ops marketplace added first:

```
claude plugin marketplace add AbhiramDwivedi/claude-ops
claude plugin marketplace add AbhiramDwivedi/truss
claude plugin install truss@truss
```

Without the claude-ops marketplace, truss fails to load. Add it, then reinstall truss.

```mermaid
flowchart LR
  truss["truss plugin<br/>[plugins/truss/.claude-plugin/plugin.json]"]
  cat["truss catalog<br/>[marketplace/.claude-plugin/marketplace.json]"]
  kit["kit ^0.4.0"]
  wt["worktrees >=0.8.4 <0.11.0"]
  sl["subagent-limits ^0.3.2"]
  truss -->|"dependencies, marketplace claude-ops"| kit
  truss --> wt
  truss --> sl
  cat -.->|"allowCrossMarketplaceDependenciesOn: claude-ops"| truss
```

*truss's three dependencies, all from the claude-ops marketplace. The dotted arrow is the catalog's permission for a cross-marketplace dependency.*
Traces to: ADR-0021 Decision 1.

What changes at run time (ADR-0021 Decisions 2 to 7):

- Init proposes `nudgeAtK` about 150 and `stopAtK` about 200 for the client to approve, below the 300/450 defaults that no Workflow agent has reached.
- When a `kit:` skill is listed, the run skill passes `--type builder=kit:builder --type tester=kit:test-writer`, and the factory reads `.claude/truss.json` `roles`. Otherwise the `workflows/roles.json` defaults stand.
- stage.js restarts a member that returns `CHECKPOINT` or no report, up to `max(1, reworkAllowance)` times per chain, with no rework spend, then stops `BLOCKED`. `finish` appends one `restart` event per restarted member to `events.jsonl`.
- `finish` removes its own run's merged, clean `worktree-wf_<id>-<n>` worktrees, never with `--force` and never a locked one, and lists those it leaves in `leftWorktrees`.
- `finish` retires every member worktree and branch of a crew that merged, was dropped or spent its rework allowance, from any run this truss dir recorded ([ADR-0030](adr/0030-retire-members.md)). A tip the target lacks is kept as `refs/truss/archive/<run id>/<branch>` first (pruned after 30 days), and each retirement is a `retire` event. An untracked symlink into the main checkout is clean. A worktree with real changes or a lock stays in `leftWorktrees`. Truss signals no process: the PM stops finished agents and background shells with TaskStop (a 30-minute CronCreate job and the end-of-run sweep), which stops what they left running on every OS, and members start long-running processes only with `run_in_background` (shell rules and the detach gate).

## Failure modes and recovery

**A stalled agent.** The heartbeat prompts the PM. The PM messages the stalled agent's project manager, or the project manager itself, and asks for its state. `/truss` keeps showing the agent as stalled until it does something. Before stopping it, the PM or project manager reads its transcript tail: a resumed agent may be compacting.

**An idle project manager.** A project manager seen to go idle without a final report in its stint, while no member works, gets one `[truss] idle project manager:` prompt after 15 minutes. The PM resumes it with a message, or starts its successor from its report.

**The usage limit.** When the five-hour window runs out while crews work, the limit-reset wake prompts the PM after the reset. The PM messages each project manager that hasn't sent its final report: "Usage limit reset. Resume from where you stopped."

**A project manager stops with work left.** Its report starts with `CHECKPOINT:`. The PM starts a fresh project manager, `<slug>-2` (then `-3`), from that report. The successor's brief names the original goal file, the predecessor's branch and commit, and the crew's original base commit; the successor resets its worktree to the predecessor's branch first. Its members, QC engineers and report folder carry its own name. The other project managers are told the new name. A member that stops with `CHECKPOINT:` is handled the same way inside the crew: a fresh member from its handoff note, never a resume.

**A project manager tries to stop without a report.** The stop gate sends it back, at most twice in a row. After that the stop goes through, and the PM sees a report that isn't in the fixed format.

**A lost hand-back.** Hand-backs from nested agents have been lost on some machines. The report is on disk anyway: the project manager reads `reports/<crew>/<member>.md`, and the PM reads `reports/<project-manager>/<project-manager>.md`, at the path in the `[truss]` note from the Agent call.

**A QC engineer FAIL.** The project manager sends the findings to a builder. Each later QC engineer is a fresh agent under the next unused name, never a resume, and any fix after a FAIL or a stress-test break needs a fresh QC engineer. When two fix attempts at one level end with the same check failing, the project manager climbs the ladder: Sonnet, then Opus at `medium`, `high`, `xhigh`, each step a fresh agent whose first deliverable is a root-cause analysis with evidence. When `xhigh` fails twice, the project manager sends `BLOCKED:` with the failing check, its output and the theories ruled out, and the PM takes it to the client. In `single` mode an integration-qc FAIL goes back to the integrator, and a fresh `integration-qc-2` rules next.

On a v2 plan, the QC engineer FAILs a crew may repair are bounded. Once a crew's this-run FAIL count is greater than `reworkAllowance`, the hooks refuse its next QC engineer, and the project manager sends the allowance-blocked message to `main` with the last findings. A spent allowance goes to the PM, never up an effort level. The PM takes it to the client, or re-plans; a successor project manager starts a fresh count ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 5).

**A verdict on the wrong commit.** The PM merges only when the QC file's `## Proof checked` SHA equals `git rev-parse <crew branch>`. After a merge of the target that moved the head, the old PASS doesn't count. The SHA is the QC engineer's head line, and a PASS also stands for a moved head when the patch line equals the merged branch's `PATCH_COMMAND` id, with `<base>` the target head last merged in, and the project manager's checks passed again after the merge. The project manager stop gate enforces the same rule as a send-back ([ADR-0004](adr/0004-scope-repair-and-head-gates.md), section 6).

**A start held by admission** ([ADR-0015](adr/0015-resource-aware.md), proposed). `start` lists the crew under `held` and leaves it `planned`; a member held inside a stage stops its crew `BLOCKED` with text `held by admission: ...`. The PM starts `truss:resource-monitor`, writes `resources/parallelism.json` if it lowers the parallelism, and re-runs `start` or resumes the crew with `start --slug <s> --resume answers` once memory recovers.

**A stuck heavy lock** (ADR-0015, proposed). A waiter takes over a lock whose owner pid is dead, or one with no `owner.json` older than 3 s (`OWNERLESS_MS`, `bin/store.ts:158`). When no `heavy` runs and a lock still blocks, delete `resources/heavy.lock/` in the truss dir by hand.

**A reload mid-session.** The module's memory starts over. An agent that ended before the reload resolves to no crew, so a message to it from a crew agent is refused. A pending limit-reset wake survives in plugin state.

## Not verified yet

- The rework allowance and head guard rules were designed before run 3's stage 1 merged. One thing was checked at design time: `PATCH_COMMAND` gives the same id, `a40f2083…`, for `edeb6ef...80d4ccd` (a merge commit) and for `9ab68c0^...9ab68c0` (the single commit it merged), and prints nothing for an empty range (`80d4ccd...80d4ccd`). The hook's two-step form feeds the diff to `git patch-id` through `$.process.run`'s `stdin`, which worktrees' hooks already use (`plugins/worktrees/hooks/register.ts:843`). It hasn't been run from Truss's hooks.

- The plan gates, `/truss` plan lines and idle-prompt successor name are covered by `tests/v03.test.ts`, run against the mock engine, not observed in a live run. [`plan.example.json`](plan.example.json) validates against [`plan.schema.json`](plan.schema.json).

- No prompt, neither the skill nor any of the five original agents, has run as a live agent in a run of the original protocol. The hooks are covered by `tests/crew.test.ts`, `tests/hooks.test.ts` and `tests/v02.test.ts`, which run `register.ts` against the mock engine from `claude-code/testing`.
- A project manager's status after it ends a turn while its members still run is unobserved. `/truss` shows `waiting on members` for a project manager that isn't `running` and has live descendants, and the stall check skips any agent that isn't `running`; both rest on that status.
- Capturing a report from `SubagentHandback` is covered by tests, not observed live.
- The limit-reset wake rests on three things a probe confirmed: `$.clock` timers run from `session.start`, a hot reload cancels them (so the wake is re-armed from plugin state), and `$.prompt.submit` wakes an idle session. Nobody has yet seen the wake fire after a real usage-limit stop.
- Where an organization manages Claude Code, `SubagentStop` hooks run only in plugins it lists. There, reports come only from the hand-back tool. The project manager stop gate is a `SubagentStop` hook too, so it shouldn't run there either; that is inferred from the code, not seen.
- `/goal` is session-only: a Stop hook on the main session judges it, so a project manager can't use it. Truss uses the goal file and the project manager stop gate instead (backlog item 20).
- The gate's two-block bound relies on the engine setting `stop_hook_active` on the stop after a block. That comes from the hook type docs and hasn't been seen live. Claude Code also lets a stop through itself after 8 consecutive blocks.
- The Workflow path ([ADR-0009](adr/0009-workflow-factory.md), "Probe") is a design, and four facts it touches are unverified. Each has a design answer that doesn't rely on it: whether `tool.call` fires for the main session's own `Workflow` call (if not, the CLI and `finish`'s audit hold the gates); whether `scriptPath` accepts a file inside the plugin (the fallback is the `--scripts-dir` copy, then the inline `script`, then `start --no-workflow`); whether the Workflow call blocks the PM's turn until the script returns (the stale-run rules cover a dead run either way); and what `agent()` returns when the agent ends with SubagentHandback, not final text. Also unverified: that a `truss:project-manager` run by `agent()` has no Agent tool (inferred from `kit:builder` in probe 2); whether a SendMessage from a workflow agent reaches the PM or a project manager; whether Workflow accepts a script the CLI, not the harness, placed in the session's `workflows/scripts/` dir; and that agent transcripts are appended every turn, which the stale check relies on. The stale rule's `STALE_MS` of 30 minutes is a chosen margin, not a proof.
- The resource-aware design ([ADR-0015](adr/0015-resource-aware.md)) is proven on Linux only, by probes of `os.freemem()`, process-group kill and `/proc` cwd grouping. A live `truss:resource-monitor` call waits for a session restart. Group kill and per-worktree sampling on macOS and Windows are unproven. The 2048 MB default threshold, the 540000 ms heavy wait and the monitor's rule are chosen numbers, not measurements.

*Drafted with AI assistance and reviewed by the author.*
