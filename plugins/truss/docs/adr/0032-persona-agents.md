# ADR-0032: persona agents: stack-specialised project agents, a hiring step and a product-owner judge

Status: accepted, 2026-11-09
Decided by: client ruling, 2026-11-09 (persona agents are day-0 functionality)
Amends: ADR-0009 Decision 2 (the builder and tester types); ADR-0022 (a hand-written one-off becomes the general case)

## Context

Truss binds agents to roles (planner, tester, builder, QC engineer) and not to a stack. `skills/run/SKILL.md` section 3 runs members as `general-purpose` when the project has no agent for the job, and says "Truss never writes agents or skills". `workflows/roles.json` defaults `builder` and `tester` to `general-purpose`.

The evidence that this is wrong:

- **The ui-redesign run.** The `web-app` crew shipped a generic UI built from stock shadcn defaults. It passed QC, because the QC engineer checks a diff against the brief, the architecture doc and the ADRs, and none of them held a design standard. The client rejected it. The fix was `truss:ux-engineer` ([ADR-0022](0022-ux-engineer.md)), a role written by hand for one run and one kind of work.
- **The client's reference project.** It runs eight persona agents under `.claude/agents/`: a frontend UI developer, a backend service architect, an AI service developer, a Postgres architect, a functional tester, a devops agent, a workflow-tool developer and a read-only senior architect reviewer. Its `AGENTS.md` routes each kind of change to one persona, and every delivery loops through the reviewer until it approves. Each persona carries the quality standards of a senior in its stack.

What the reference project shows about the content of a persona:

- **What earns its place:** short, concrete, checkable stack rules ("never `.block()`", "R2DBC, not JPA", "all API calls through `lib/api.ts`", "`uv`, not `pip`", "update the Postman collection in the same commit as an API change"). The reviewer repeats the same rules as an anti-pattern list, so a slip is caught twice. A check with a fixed output shape, such as an env-var coverage table (code, config, Helm values, `.env.example`), beats a vague concern.
- **What doesn't:** generic boilerplate (SOLID, "comprehensive tests", accessibility platitudes). Worse are rules the repo can't follow, such as unit tests with a test framework the frontend doesn't have.
- **What rots:** hard-coded counts, versions, paths and run commands (a migration range "v1 to v10" when the repo is at v56; a banned convention still listed; a path that no longer exists; a raw restart or test command that conflicts with the project's scripts).

Standards are stack-idiomatic. A Java persona never leaves open version ranges in `pom.xml`; a Node persona uses caret ranges and a committed lockfile. Each is right in its own ecosystem and wrong in the other.

Truss has a PM that makes product calls itself, logged as `PO:` lines in `decisions.md`, while the client decides the approval triggers. In the client's own projects the client is the product owner. Truss runs unattended, so it needs a product owner it can consult.

## Decision Drivers

- No generic builders and testers when the stack is known. A persona is day-0 functionality, not a retro fix.
- Standards the QC engineer can check, so a violated standard fails a crew.
- Personas that stay true: pointers to the truth, never copies of it.
- Keep the authority split: the PM decides with the client.
- Reuse what exists: project agent types, `kit:persona`, `kit:init`, the factory's start and QC flow.

## Considered Options

| Option | Kept? | Why |
| --- | --- | --- |
| Keep `general-purpose` plus a longer brief per task | Rejected | This is today's behaviour, and the ui-redesign run shows its result. A brief lives for one task; a persona is reused and reviewed. |
| Ship a fixed set of stack personas inside truss | Rejected | A stack list in the plugin goes stale, and it can't know a project's scripts, paths or conventions. The project owns its personas. |
| Add a hand-written role for each discipline, as `ux-engineer` did | Rejected | One plugin edit per discipline does not scale, and the roles table is not the place for a client's stack. |
| A persona is a project agent type the design engineer drafts, the client approves and the factory installs | Kept | It uses the agent-file mechanism Claude Code already loads, and the project can edit the file. |
| The QC engineer checks personas only through the brief | Rejected | The brief is written per task and may omit a standard. A QC engineer that reads the persona's own Standards section cannot be talked out of it. |
| A product-owner role inside truss's own prompts | Rejected | The domain rules belong to the project. A `product-owner` persona file is drafted from the project's own requirements. |

## Decision

### 1. A persona is a project agent type

A persona is a file `<repo>/.claude/agents/<name>.md` (symlinks are followed; some projects keep the real files in `.agents/` and link them). The agent type is the file's name.

- An **editing persona** has Write or Edit in its `tools`, or no `tools` line. It does builder and tester work.
- A **judge** is a project agent without Write and Edit (`readOnly`), such as a product-owner or an architect reviewer. A judge gets no builder or tester tasks.
- Optional frontmatter: `model` (`opus` or `sonnet`, default `sonnet`) and `effort` (`low`, `medium` or `high`, default `medium`). `description` names the stack and the area.

### 2. The factory reports the personas

`factory.ts start` puts a `personas` map into the stage.js args: name to `agentType`, `model`, `effort`, `file`, `description`, `readOnly` and `loaded`. `loaded` is false for an agent file this Claude Code session has not loaded, because agent types load at session start.

### 3. The planning engineer assigns a persona to every task

The planning engineer gives every task a `persona` (a name, or null) and may set the task's effort to `high`. A task never spans two personas' areas; the planner splits along them. `persona` is null only when no persona fits.

### 4. Spawning

A persona task spawns as the persona's agent type when `loaded`. Otherwise it spawns as `general-purpose` with the persona's body inlined as its system prompt. The model comes from the persona; the effort is the higher of the persona's and the task's. The foreman path delegates the same way. `## Members` in the goal file applies only to tasks with no persona. The task's role still decides its step, its isolation and its report shape.

### 5. QC holds the diff to the Standards

The QC engineer's brief lists, under `Standards:`, the persona files the crew used and every judge persona. The QC engineer holds the diff to each file's Standards section and quotes the item it rules on. A violated standard is a FAIL.

### 6. Install

`factory.ts persona-install --from <dir> --repo <root> [--replace]` validates persona drafts and copies them into `.claude/agents/`, then commits them.

### 7. Persona-writing rules

The design engineer drafts a persona by `kit:persona` when the session lists it, and by these rules when it doesn't (they are repeated in `agents/design-engineer.md`):

1. A persona names its stack and area in `description`, and holds a `Standards` section of short, concrete, checkable rules in that stack's idiom. Every rule names what to do or never do, and how a reviewer sees a slip.
2. A judge repeats the editing personas' key rules as an anti-pattern list, so a slip is caught twice. A check with a fixed output shape (a table with named columns) beats a vague concern.
3. No boilerplate: no SOLID, no "comprehensive tests", no accessibility platitudes. No rule the repo can't follow, such as unit tests with a test framework the project lacks.
4. A persona holds stack invariants and pointers to where the truth lives: the file, script or doc that owns it. It holds no count, version or command that a script or `AGENTS.md`/`CLAUDE.md` already owns. It runs the project's own scripts, never raw commands that conflict with them.
5. Every path a persona names exists when the persona is written.

### 8. The hiring step

In plan mode, the design engineer does a staffing pass: it maps each crew's areas to personas. When the goal needs a stack or discipline no persona covers, or the project has no product-owner judge, it drafts persona files to `<truss dir>/personas/<name>.md`. It never drafts a generic "builder" persona. The checking engineer reviews the drafts with the verdicts: stack-specific, checkable, every named path exists, no rotting counts, versions or commands, no boilerplate. The plan shows the drafts and the client approves them with the plan. After approval the PM runs `factory persona-install --from <truss dir>/personas --repo <root>` before it starts any crew. A persona installed this session runs inlined until the next restart (`loaded` is false), and the run report says so. A persona a run finds stale (a named path gone, a rule the code contradicts) goes into the end-of-run report as an amendment, and the PM does not edit it silently.

`general-purpose` stays only for work with no stack, such as pure git chores.

### 9. The product-owner judge

Every project gets a read-only `product-owner` persona. The design engineer drafts it, at day 0 or in the hiring step, from `docs/requirements.md`, the README and the domain found in the code: who the users are, the domain rules a generic engineer would get wrong, what "done" means for a user, and pointers to the requirements doc. It sits in every crew's QC `Standards:` (Decision 5). Before a product call, the PM and the checking engineer read its file. It is advice; the PM rules. The authority split is unchanged: the PM decides with the client, logs a `PO:` line, and the client still decides the approval triggers.

### 10. Day-0 personas

`truss:init` proposes personas when the project has none: through `kit:init`'s persona step when kit is loaded, otherwise by the design engineer in init mode with `kit:persona` or the rules above. It proposes one per stack found, plus the product-owner judge. The `roles` key's `build` and `test` mapping (`kit:builder`, `kit:test-writer`) is the fallback only for an area no persona covers. Truss references `kit:persona` by name and loads it when the session lists it. kit 0.4.0 provides it, so truss 0.22.0 depends on kit `^0.4.0`.

## Consequences

**Positive**

- A crew's builder knows the stack's idioms and a reviewer can fail a diff that breaks them. The ui-redesign failure now fails QC.
- A persona is a normal project file: the client edits it, reviews it in a PR and reuses it outside truss.
- The PM gets a written product view to consult, so its `PO:` calls rest on the requirements and not on memory.

**Negative**

- Day-0 setup now includes a client approval of persona files. A bad persona misleads every crew until someone fixes it, and QC fails the diff against a wrong standard.
- Agent types load at session start. A persona installed in a run runs inlined for that run, with the body as the system prompt and without the type's own tool list.
- A persona can rot. The pointers-not-copies rule and the stale-persona amendment in the run report reduce it, and do not remove it.

**Neutral**

- `workflows/roles.json` keeps `general-purpose` as the default for a task with no persona.
- The mechanics (the `personas` map, spawning, the `Standards:` block, `persona-install`) are in `bin/factory.ts` and `workflows/stage.js`, built by a separate crew from this prose.

**Reversing it** touches: the persona prose in the run skill, the design, planning, QC, checking-engineer and foreman prompts, the init skill; the `personas` map in `factory.ts start`; the `persona` field of the planner's tasks; `persona-install`; and `tests/personas-prose.check.ts`. Installed persona files stay in the project's `.claude/agents/`, where they are ordinary agents.
