# ADR-0042: Rename the crew lead to project manager and the main session to program manager, with no alias

Status: accepted, 2026-11-11
Decided by: client (rulings of 2026-11-11 19:30 and 19:33: rename completely, no aliases, historical ADRs and past CHANGELOG entries rewritten too, git history left as is)
Requirements: R-75, R-76, R-78 to R-81 (`docs/requirements.md`)

## Context

Up to 0.26.0 the agent that leads a full crew carried the old crew-lead name: agent type `truss:` plus that name, agent file `agents/<old>.md`, and the same word in config keys, CLI output keys, the idle-stall event kind, the retro key and a hook prompt prefix. The main session was "the PM", spelled out in some files as "project manager". ADR-0033 recorded that the client wants the per-crew lead called "project manager" and the main session "program manager", as a separate goal.

The client ruled that the rename is complete: no alias, no allow-list, no dual reader. The plugin is used only by the client, so no other user depends on the old names.

## Decision Drivers

- One name per role in prompts, docs, code and data, so no agent has to map two words to one role.
- The client is the only user, and accepted the costs under Consequences.
- No file `git ls-files` lists under `plugins/truss`, `docs` or `checks` names the old crew lead (R-81). Git history and old run dirs under `.git/truss/` stay as they are.

## Considered Options

1. **Rename with an alias for one release.** The old type, key and event kind stay readable beside the new ones. This was the first plan (the old R-72 to R-74 and R-77); the client's ruling replaced it.
2. **Rename with no alias (chosen).** Every contract value gets its new name, and nothing reads the old one.

## Decision

### 1. Role names

- **Project manager**: the agent that leads one full crew. It splits, delegates, merges members and starts the QC engineer.
- **Program manager**: the main session. It plans, starts crews, talks to the client and merges crews.
- **PM** means the program manager. A file that keeps "PM" defines it once as "program manager (PM)". "Project manager" is always spelled out.

### 2. Contract values

Each value below replaces the old one. The old value is not read after 0.27.0.

| Contract | Where (at `642c3aef`) | New value |
|---|---|---|
| Crew-lead agent type | `hooks/register.ts` (const, agent predicate, stop gate, lead-start gate) | `truss:project-manager`, exported as `PROJECT_MANAGER_TYPE` |
| Agent file | `agents/` | `agents/project-manager.md`, `name: project-manager`, moved with `git mv` (no copy, no symlink) |
| Banned workflow type and role key | `workflows/stage.js`, `workflows/plan.js`, `hooks/register.ts` | type `truss:project-manager` and role key `project-manager` are refused |
| `promptOverrides` key | `docs/truss-config.schema.json` (`additionalProperties: false`) | `project-manager` |
| `factory start` / `start-args` output key | `bin/factory.ts` | `projectManagers` |
| `## Engine` value of a goal file | `bin/factory.ts` (`engineOf`) | `project-manager`; reasons and refusals say "project manager path" |
| Stall event `kind` | `hooks/register.ts`, `docs/events.schema.json`, `retro/counts.ts`, ui | `idle-project-manager`, exported as `IDLE_LEAD_KIND` |
| Retro output key | `retro/counts.ts` | `stalls.idleProjectManager` |
| Hook prompt prefix | `hooks/register.ts` | `[truss] idle project manager:` |
| `workflows/roles.json`, spawn labels (`parseLabel`, `bin/store.ts`) | | unchanged: neither uses the old name |

Every crew-lead type comparison goes through one exported pure function, `isLeadType(type)`. The stop gate calls the exported pure `stopperIsLead(known, type)`, and the lead-start gate calls the exported pure `leadStartName(call)`.

### 3. No alias and no dual reader

No code in the plugin or in ui names the old value, and nothing reads it as a fallback. ui reads the new values only. `engineOf` takes any `## Engine` word other than `workflow` to the project manager path; that is its existing default branch, not an alias.

### 4. What an old-type start does

The plugin ships no agent under the old type, and `truss:` names only plugin agents, so the old type names no agent in a session that loads 0.27.0. If such a start happens anyway, `isLeadType` is false for it: `leadStartName` returns nothing, so the plan gate does not apply; `stopperIsLead` is false, so the report stop gate does not hold it; and `crewOf` finds no crew lead, so the agent belongs to no crew, gets no crew-member allowances and is never prompted as idle. Nothing truss ships starts that type: only the run skill starts a project manager, and only `plan.js` and `stage.js` route roles.

TODO: whether Claude Code refuses an Agent call whose `subagent_type` names no known agent is Claude Code's behaviour, not truss's, and is not confirmed from this repo.

### 5. Library pack rule 6 is broken on purpose

`skills/principles/library.md` rule 6 asks that a public symbol be deprecated, with a warning and a named replacement, for at least one minor release before removal. This rename removes the old names in the same release that adds the new ones. The client ruled it so; there is no deprecation release.

## Consequences

- A 0.26.0 config that sets the old `promptOverrides` key fails schema validation. The client renames the key by hand.
- A 0.26.0 plan or goal file that starts the old agent type no longer starts a gated crew lead (Decision 4).
- Old run logs' idle-stall events, under the old kind, are not in the event enum: retro does not count them, and an old-kind stall line shows in ui as a plain stall.
- ui does not show a run written by a plugin before 0.27.0 with its crew lead ranked first or with its idle-lead stuck state. That includes runs made by a program manager on an installed 0.25.0 or 0.26.0 plugin.
- ADR-0001 to ADR-0041, the claude-ops ADRs and past CHANGELOG entries are reworded to the new names. Their Decisions and Statuses keep their meaning. Where a foundry-era text used the old word for the main session, it now says "program manager".
- Reversing this decision means renaming every value in Decision 2 back, in the plugin, ui, docs and tests, with the same lack of a migration path.
