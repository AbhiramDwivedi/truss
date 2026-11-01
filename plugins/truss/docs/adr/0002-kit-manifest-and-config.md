# ADR-0002: Truss init builds on kit's manifest, and truss.json describes jobs

Status: accepted, 2026-10-27
Proposed on 2026-10-26 by foundry run 2's design crew, for foundry 0.4.0. It applies repo [ADR-0012](claude-ops/0012-extension-framework.md) and was accepted with it on 2026-10-27.

## Context

Truss init (`skills/init/SKILL.md`) only checks for the architecture doc and has the design engineer write one. It takes nothing from kit: the run skill lists agent types by hand each run (section 3), and `.claude/truss.json` holds only `architecture`, `adr` and four client keys (module doc, config table). Four things a project would set once are re-decided every run or not at all: which agent type does which job, how the project deploys, which writing skill the writer uses, and client additions to a role's prompt. And the design engineer invents a port range per crew in `plan.md` (`agents/design-engineer.md:72`) that nothing ties to worktrees' `PORT_BASE` slots (repo ADR-0005).

The interfaces that can't take the work: the config table has no keys for these, init has no input from kit, and the run skill's inventory step has nothing stored to start from.

## Decision

### 1. Truss init reads kit's manifest; kit stays a soft dependency

After step 1 (the doc check), init looks at `<repo>/.claude/kit/manifest.json` (contract: `docs/vendor/kit-manifest.schema.json`, repo [ADR-0013](claude-ops/0013-kit-manifest.md)). There is no plugin.json `dependencies` entry (repo ADR-0012, rule 5).

| What init finds | What it does |
| --- | --- |
| A valid manifest at `version` 1 that marks `truss:qc-engineer` and `truss:checking-engineer` read-only | Uses it (below). |
| A valid manifest without those declarations, and `kit:init` listed among the session's skills | Runs `kit:init` through the Skill tool with args `declare read-only: truss:qc-engineer, truss:checking-engineer`. kit shows the client the declaration and writes it on approval. |
| No manifest, and `kit:init` listed | Says `no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)` and carries on. It doesn't start `kit:init` (amended 2026-10-27, foundry 0.4.1, below). |
| `kit:init` not listed | Says `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)` and carries on. |
| A manifest that isn't JSON, fails the schema or has another `version` | Says `kit manifest unreadable, carrying on without it: <reason>` and carries on as if there were none. It doesn't rerun `kit:init` over it. |

The rows don't overlap, because init decides on the manifest before it looks at the skill list. The first and last rows depend on the manifest alone. A valid manifest that already holds both declarations means there is nothing to do, whatever kit's install state: init uses it and says nothing about kit, even when `kit:init` isn't listed. An unreadable manifest gets the `unreadable` line, listed or not. Only when the manifest is absent, or valid but without the declarations, does the skill list decide: `kit:init` listed means the second or third row, and not listed means the `kit is not installed` line.

**Amendment, 2026-10-27 (foundry 0.4.1).** As accepted, the no-manifest row ran `kit:init`, so kit set the project up inside Truss init. On the first live init (a repo with its own hooks and no kit) that made init stop and ask the client, because a full kit setup is a large, separate change and Truss needs only two read-only declarations from it. A missing manifest now gets the line and no `kit:init`; the client runs `/kit:init` on its own when they want kit. A manifest without the declarations still gets `kit:init` with the declare args, since kit is already set up there and only the declaration is shown.

The QC engineer and checking engineer are the declared types because both are `tools: Read, Grep, Glob, Bash`. The writer, commissioning engineer, foreman and design engineer edit files and stay isolated. Once kit records them, worktrees gives them no worktree (repo [ADR-0014](claude-ops/0014-worktrees-declared-read-only-agents.md)) and kit's stop gate skips them.

### 2. New truss.json keys

The contract is [`truss-config.schema.json`](../truss-config.schema.json), which also declares the 0.3.0 keys. Every new key is optional, and leaving it out keeps 0.3.0 behaviour (P9). The file has no `version`: its keys are only ever added. A reader reports an undeclared key to the client and ignores it, and treats a value that fails the schema as unset; inside `deploy` either one unsets the whole key (below).

| Key | Shape | Default | Read by |
| --- | --- | --- | --- |
| `roles` | job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type | inventory, as 0.3.0 | the PM's (project manager's) inventory and member choices (run skill, sections 3 and 4) |
| `deploy` | `{target, command, production}` | none: commissioning engineer asks its foreman | the commissioning engineer member's brief; `production: true` always goes to the client first |
| `writingSkill` | a skill name, such as `technical-writer` | none | the writer's brief: load it when listed, else say so |
| `promptOverrides` | Truss role (`foreman`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`) to `.claude/truss/prompts/<name>.md` | none | briefs (below) |

init proposes these from the manifest and the repo. `roles` comes from the manifest's agents, for example `build: kit:builder`, `test: kit:test-writer`, `review: kit:reviewer`, `search: kit:scout`; `deploy` from what the repo shows. init shows the client the proposed keys and writes only the approved ones. It writes only keys the schema declares and keeps every key and value already in the file, at any depth.

**Validation, and what init does with errors it didn't cause.** The schema is closed at the top level and inside `roles`, `deploy` and `promptOverrides` (`additionalProperties: false`), and its enums and patterns also apply to keys the client wrote by hand. So a file can fail validation for reasons init had no part in: a stray key at any depth, or a bad client value such as an out-of-enum `merge`. init builds the file it would write (the current file plus the approved values) as a candidate outside the repo, `<truss dir>/scratch/truss.candidate.json`, and validates the candidate with `npx -y -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats --all-errors --errors=json -s <truss-config.schema.json> -d <candidate>`, as the design engineer does for `plan.json`. It then sorts each error by its path: the error's `instancePath`, plus `/<params.additionalProperty>` for an `additionalProperties` error or `/<params.missingProperty>` for a `required` one. So a hand-written `roles["qc-engineer"]` is `/roles/qc`, and a `deploy` without `production` is `/deploy/production`.

The paths init writes are the leaf paths it adds in this run, such as `/roles/build` or `/writingSkill`. Because init keeps every value already in the file, these are always paths the current file doesn't have. `deploy` is proposed, approved and written as one unit, so writing it writes all three of its leaves, `/deploy/target`, `/deploy/command` and `/deploy/production`; init proposes `deploy` only when the file has none. Each error then falls under exactly one of three rules:

- **An error at one of the paths init writes** stops the write. init writes nothing, `.claude/truss.json` stays exactly as it was, and init reports the error with its path. Such an error is init's own fault, since it proposes only values the schema accepts.
- **An error at a proper ancestor of a path init writes** means the client's value there is the wrong shape to hold init's key, for example `roles: "x"` when init would add `/roles/build`. init doesn't write any of the paths it planned under that ancestor, keeps the client's value unchanged, reports both the error and the keys it skipped (`/roles: must be object; skipped /roles/build, /roles/test`), builds the candidate again without them and validates again. It still writes its other approved keys. The root path is an ancestor of every path, so a file that isn't a JSON object gets nothing written.
- **Any other error** is at a path the client wrote: an unrelated key, or a sibling of a path init writes, such as a hand-written `/roles/qc` next to init's `/roles/build`. It is not fatal. init reports it to the client by path (for example `/merge: must be equal to one of the allowed values` or `/roles/qc: undeclared, ignored`), keeps it unchanged, and carries on: it still writes its approved values, including `/roles/build`. It never deletes, rewrites or "fixes" what the client wrote.

Readers (the run skill, the PM's briefs) treat the file the same way, and report each problem once. Outside `deploy`, an undeclared key at any depth is ignored, and a rejected value unsets the smallest thing it can:

- **`deploy` fails closed, as a whole.** Any error at or inside `/deploy`, whether a wrong type, a missing or bad field, or an undeclared key, unsets the whole `deploy` key, so the commissioning engineer member asks its foreman, as when `deploy` is absent. A reader never fills in or defaults one field of `deploy` on its own: a missing or non-boolean `production` is never read as `false`.
- **`roles` unsets only the bad entry.** A job whose agent type fails the pattern is picked from the inventory, as if it weren't listed; the other jobs keep their mapping. When `roles` itself is rejected (not an object, or empty), every job is picked from the inventory.
- **`promptOverrides` unsets only the bad entry.** A role whose prompt file fails the pattern has no override; the other roles keep theirs. When `promptOverrides` itself is rejected, no role has an override.
- **Any other declared key** whose value fails the schema is treated as unset, so its default applies. `architecture` and `adr` have no default, so a rejected one counts as init missing.

### 3. Prompt overrides name files, and the briefs carry them

`promptOverrides` stores paths, never prompt text (P21). The files are the client's, committed in the project. They add to a role's prompt and never replace it: no `skill.prompt` hook, no re-registered agent type (repo ADR-0012, rule 4). The PM writes a `Prompt overrides:` line in each goal file, naming the role and file for every configured role. Each foreman's brief names the foreman's file. The foreman puts the right line into each QC engineer, writer and commissioning engineer brief: "Read `<path>` before you start; it adds to your instructions. Your report format and the hooks' rules still hold." The PM does the same for the checking engineer and the design engineer. A missing file is reported and skipped.

### 4. Ports come from worktrees

Truss stops inventing port ranges. The design engineer's resource slice in `plan.md` names ports only as one of these two lines:

- `ports: the crew's worktree slot (PORT_BASE to PORT_BASE+9, from .claude/worktree-setup.*)`, when the repo has a setup script;
- `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)`, when it doesn't.

A crew that needs a port in a repo without a setup script raises a `QUESTION:`. The run skill's example table drops its `ports 4100-4109`. There is no `ports` key: nothing about it is the project's to choose.

### 5. Diagrams

The design engineer's prompt asks for mermaid diagrams in `init` and `design` mode (a context or container `flowchart`, and a `sequenceDiagram` for a flow across modules), each with at most about 12 nodes, a caption, and the source files it traces to.

Truss goes to 0.4.0 (P16).

## Seams

`tests/contract.check.ts`, run by `node --test` like `packs.check.ts`, reads the prompt files and the schema as text. It pins:

1. `skills/init/SKILL.md` names `.claude/kit/manifest.json`, `kit:init`, the args `declare read-only: truss:qc-engineer, truss:checking-engineer`, and the sentence `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)`.
2. `skills/init/SKILL.md` names `truss-config.schema.json` and each new key the schema declares (`roles`, `deploy`, `writingSkill`, `promptOverrides`).
3. `skills/run/SKILL.md` names `PORT_BASE`, `Prompt overrides:` and `roles`, and no longer holds `4100-4109`.
4. `agents/design-engineer.md` asks for `mermaid` diagrams, holds `ports: none (no .claude/worktree-setup.*; worktrees gives no PORT_BASE)`, and no longer holds `port range`.
5. `docs/truss-config.schema.json` parses as JSON, has `additionalProperties: false`, and each `promptOverrides` value pattern accepts `.claude/truss/prompts/qc-engineer.md` and rejects `../qc-engineer.md` and `.claude/truss/prompts/a/b.md` (checked with `new RegExp`).

## Consequences

- A project without kit gets 0.3.0 behaviour plus the new keys, and its QC engineers and checking engineers still get worktrees unless the client sets worktrees' `noIsolateAgents`.
- Truss init can now start a second skill that writes into the project. Each write still goes through that skill's own approval step.
- Port slices stop overlapping, because worktrees' slot lock allocates them (repo ADR-0006). A repo with no setup script gets no ports, and has to say what it needs.
- `.claude/truss.json` has no `version`, which departs from P29 (stored shapes are declared and versioned). The departure dates from 0.3.0, and this ADR widens it by adding keys. Keys that are only added and optional keep every older reader working, and the closed schema declares each one. The file gets a `version` key, and the schema a matching `const`, on the first change of meaning: a key renamed, removed, or read differently. This ADR adds no `version` now. It is Truss's own config, not an extension point (repo ADR-0012, "Extension points declared by this run").
- Prompt overrides are text the client wrote and the base's tests never see. They only add instructions, and the hooks still enforce what code can (repo ADR-0008).
