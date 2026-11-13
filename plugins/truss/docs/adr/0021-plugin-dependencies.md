# ADR-0021: truss depends on kit, worktrees and subagent-limits as plugins from the claude-ops marketplace

Status: accepted, 2026-11-02. Written by the writer of crew `compose-design` for goal `compose-ops` (plan revision 2, approved auto with checker-41, and the program manager (PM) and PO rulings of 14:40 to 15:10). Truss goes to 0.16.0. It amends [ADR-0002](0002-kit-manifest-and-config.md) Decision 1, [ADR-0009](0009-workflow-factory.md) Decision 4 and [ADR-0013](0013-plugin-layout.md), and adds the "Plugin dependencies" section of [architecture.md](../architecture.md).

## Context

The client asked, on 2026-11-02 at 12:30, for truss to use kit, worktrees and subagent-limits where they live: "keep them there and just reference and use them here". All three live in the claude-ops marketplace (`name: "claude-ops"`). Until now truss treated kit as a soft dependency with no plugin.json `dependencies` entry (ADR-0002 Decision 1, after repo ADR-0012 rule 5), and never named the other two.

Two interfaces can't take that as they stand: plugin.json has no `dependencies` key, and the truss catalog (`marketplace/.claude-plugin/marketplace.json`) has no `allowCrossMarketplaceDependenciesOn`, so it can't take a dependency from another marketplace.

### What the evidence settles (item 1)

- **The subagent-limits contract reaches Workflow agents.** All 27 agent transcripts of run `wf_e804087f-eaa` contain `[subagent-limits] Context budget.` (`grep -lF` over the run's `agent-*.jsonl` lists 27 files; its journal has 27 `started` lines), and so does every agent transcript of `wf_0dff946d-af1` after 2026-11-02T17:30Z. The string is the plugin's contract (subagent-limits README:65).
- **Nudge and stop never fired.** Across the 806 Workflow agent meta files under `~/.claude/projects` when the plan was written, the largest request context was 181K tokens (181,414, run `wf_0af69b63-4d4`), under the defaults `nudgeAtK` 300 and `stopAtK` 450 (subagent-limits plugin.json `userConfig`, README:14-15).
- **A refused agent returns no report.** Past `stopAtK` an agent gets 8 more tool calls, then every tool call is refused (README:8). Such an agent's `agent()` call ends with no schema object, and `reportOf` in `workflows/stage.js:314-317` stops the crew `BLOCKED` with `the member returned no report`.
- **Worktrees.** `WorktreeCreate` fires for Workflow worktrees: `.git/claude-worktrees/slots.json` `"active"` holds `wf_*` entries (for example `wf_e804087f-eaa-18` and `wf_0dff946d-af1-6`). SubagentStart and `SubagentStop` miss them, so worktrees never cleaned them up: the plan counted 49 stale `wf_*` worktrees, each on a `worktree-wf_<id>-<n>` branch at `.claude/worktrees/wf_<id>-<n>`.
- **Plugin agent types work as agentType.** Meta files show `truss:writer`, `truss:planning-engineer` and `truss:qc-engineer` runs. No Workflow agent has yet run as a `kit:*` type: 0 of the meta files.

## Decision

### 1. plugin.json depends on the three plugins from claude-ops

`plugins/truss/.claude-plugin/plugin.json` gets a `dependencies` list, each entry with `marketplace: "claude-ops"` and a `^` range: kit `^0.3.1`, worktrees `^0.8.4` and subagent-limits `^0.3.2` (`^0.3.1` until factory-fixes2, 0.17.0; see the live-probe record in Decision 2). The ranges are `^`, not exact pins, so a patch or minor release of a dependency installs without a truss release. The truss catalog adds `"allowCrossMarketplaceDependenciesOn": ["claude-ops"]`; without it the dependencies don't install. Nothing is copied into truss.

Installing takes two commands, with the claude-ops marketplace first:

```
claude plugin marketplace add AbhiramDwivedi/claude-ops
claude plugin marketplace add AbhiramDwivedi/truss
claude plugin install truss@truss
```

Every README puts `marketplace add AbhiramDwivedi/claude-ops` on a line before its truss lines, and no README names `truss@claude-ops`.

**When the claude-ops marketplace is missing, truss fails to load.** The fix: add the claude-ops marketplace (`claude plugin marketplace add AbhiramDwivedi/claude-ops`), then reinstall truss. The README and the 0.16.0 CHANGELOG entry say so. PM gate 1 records whether truss still loads alone by `--plugin-dir`.

The catalog entry's url is `https://github.com/AbhiramDwivedi/truss.git`, not the shorthand, so an install needs no SSH key (commit 748d090).

Decided by: the client (12:30, "keep them there and just reference and use them here"); the PO, install option A (14:40, checker-40 agrees); PM ruling C (14:55, checker-41); PM ruling E (15:05) for worktrees `^0.8.4`, not the plan's `^0.8.3`.

### 2. Lower context limits, proposed by init

Init proposes `nudgeAtK` about 150 and `stopAtK` about 200 for the client to approve, and writes them only on approval. The defaults (300/450) sit above every context a Workflow agent has reached (181K), so they never fire for truss's members. At about 150K a member that grows large is asked to checkpoint, and stage.js restarts it fresh (Decision 5). 200K keeps `stopAtK` at least 50 above `nudgeAtK`, as subagent-limits requires (README:15), and stops a runaway member before its context costs more than a fresh one. PM gate 1 runs one Workflow member with `nudgeAtK=50` and records in `decisions.md` whether the nudge text reached it.

Decided by: the plan, item 1(b) (approved auto, checker-41); the client approves the values at init.

**Live-probe record (2026-11-02).** subagent-limits 0.3.1 never nudged: at gate 1 a Workflow member reached 197K with `nudgeAtK` 50 and got no "Your context has reached" note, and at gate 1b a plain Agent subagent missed it too (session 8a98061b, agent-ae4245f9146afc8e3), so the bug was in 0.3.1, not in Workflow members (`decisions.md` 15:33, 15:36). claude-ops fixed it in subagent-limits 0.3.2 (ed0c651, tag `subagent-limits--v0.3.2`): 0.3.1 judged each tool call by the previous request, because tools start before the step's usage lands (`decisions.md` 15:41). The verify probe against 0.3.2 at ed0c651, with `nudgeAtK` 50 and `stopAtK` 100, nudged each subagent once (`decisions.md` 15:43):

- Plain Agent subagent, session 7896191d, agent a73f5234fe21bf05d, after the 65.0K request (65,022 tokens). Its transcript holds one `hook_additional_context` attachment (PostToolUse, hook `tool.call`): "[subagent-limits] Your context has reached 65K tokens. Finish the item you are on, or back it out if it is far from done, then checkpoint: ... At 100K your tools start being refused."
- Workflow member, session cb2dbdea, wf_ce6ff9d9-5fd/agent-ad39c818019eca8d3, after the 62.8K request (62,754 tokens), with the same text at 63K.

The client accepted this probe in place of the isolated `CLAUDE_CONFIG_DIR` re-probe that ADR-0019 item 15 names. Truss 0.17.0 requires subagent-limits `^0.3.2`.

### 3. kit is the default when kit is loaded

"kit is loaded" means a `kit:` skill is among the session's skills.

- **Run.** The run skill passes `--type builder=kit:builder --type tester=kit:test-writer` to `factory.ts start` and `plan-args` only when kit is loaded. Otherwise it passes no `--type`, and the `roles.json` defaults (`general-purpose`, `workflows/roles.json:5-7`) stand.
- **Factory.** `rolesWithTypes` (`bin/factory.ts:305-318`, today `--type` only) also reads `.claude/truss.json` `roles`: `roles.build` sets builder and resolver, `roles.test` sets tester. A `--type` wins over `roles`. No `roles` leaves `roles.json` as it is. The truss.json mapping maps whenever configured; the config author owns the kit dependency.
- **Init, missing manifest.** When `.claude/kit/manifest.json` is missing and `kit:init` is among the session's skills, init runs `kit:init` through the Skill tool; kit proposes and writes only on the client's approval. Init then proposes `roles` `build: kit:builder` and `test: kit:test-writer`, and the limit values of Decision 2. This reverses ADR-0002's no-manifest row and its 0.4.1 amendment, which `tests/init.check.ts:9-13` pins today.
- **Init, kit absent.** The kit-absent line stays word for word, because truss loaded alone by `--plugin-dir` still reaches it: `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)`.

PM gate 1 runs a member as `kit:builder` before stage 1 and records its meta.json agentType. If it fails, the PM re-plans this decision before stage 1 starts.

Decided by: the plan, items 2 and 3 (approved auto, checker-41); PM ruling D (14:55, checker-41).

### 4. split-work is loaded unconditionally

The project manager prompt and the planning engineer's prompt in stage.js both load `subagent-limits:split-work` before splitting work. Today `agents/project-manager.md:42` loads it only "If the `subagent-limits:split-work` skill is available", and `plannerPrompt` (`workflows-src/stage/split.js`) doesn't name it.

Decided by: the plan, item 4 (approved auto, checker-41).

### 5. A CHECKPOINT or a missing report restarts a fresh member

Today `runMember` (`workflows-src/stage/members.js`) starts one fresh member after a `CHECKPOINT` and stops `BLOCKED` on the next non-DONE, and `reportOf` stops `BLOCKED` on a missing report.

The new rule, for every `runMember` chain (tester, builder and writer tasks, and fix builders):

- A member that returns `CHECKPOINT`, or returns no report (its result is not an object), is restarted: a fresh member of the same role, with a new label, from the same task.
- A chain restarts at most `max(1, reworkAllowance)` times.
- Restarts add no rework spend: no QC FAIL is counted, `spendOf` (`workflows-src/stage/crew.js`) is unchanged, and no `guardAllowance` call runs per restart.
- A successor's `QUESTION`, `BLOCKED` or `PROPOSAL` stops the crew with that tag and text. A `DONE` goes on as usual.
- Running out of restarts stops the crew `BLOCKED`.

Each restart carries the previous member's note and is told to read the branch's commits. MEMBER_SCHEMA (`workflows-src/stage/schemas.js` `MEMBER_SCHEMA`) and the stage.js result shapes don't change.

**Worst case.** A task runs at most `(1 + reworkAllowance) x (1 + restarts)` member runs per task: one first member and up to `reworkAllowance` fix builders, each chain restarted up to `restarts = max(1, reworkAllowance)` times. With `reworkAllowance` 2 that is 3 x 3 = 9 member runs.

Decided by: the plan, item 5 and item 1's missing-report finding (approved auto, checker-41).

### 6. Restart events in events.jsonl

`finish` (`recordRun`, `bin/factory.ts:1276-1336`) appends one `restart` event to `events.jsonl` per restarted member, naming crew, label, n and reason. It learns of restarts from the run's journal, the only place they show (Seams to pin).

Decided by: the plan, item 5; PO ruling F (15:10) for the event shape.

### 7. finish removes its own run's merged wf_* worktrees

When `finish --transcript T` merges a crew, step 5 (`bin/factory.ts:1489-1500`) already removes the crew's `truss-<slug>-*` member worktrees whose branch is an ancestor of the crew branch. It now also removes the Workflow worktrees of run `T`:

- Only worktrees whose branch is exactly `worktree-<basename of --transcript>-<digits>` and whose path ends `<basename of --transcript>-<digits>`. The basename is already `wf_<id>`, so the branch is `worktree-wf_<id>-<n>`.
- `git worktree remove` without `--force`, so a dirty worktree stays.
- Never a `locked` worktree.
- The branch is deleted only after `git merge-base --is-ancestor <branch> <truss-slug or target>` exits 0, so an unmerged one stays.
- Every matching worktree it leaves goes in a new output field, `leftWorktrees`: `[{path, branch, why}]`. It is never in `audit`, and `finish` never refuses because of it.

Another run's worktrees stay, and so do near-miss names.

Amended 2026-11-07 (truss 0.20.0, ADR-0030): the sweep now runs once per finish, after every merge. Every member of a crew that merged, was dropped or spent its rework allowance is retired, from this run and from earlier runs, unmerged or not; a tip the target lacks is first kept as `refs/truss/archive/<run id>/<branch>`. An untracked symlink into the main checkout no longer makes a worktree dirty, and processes the run started inside a retired worktree are stopped by pid.

Decided by: the plan, item 6; PM rulings A and B (14:55, checker-41), which replace item 6's "records every worktree it leaves in the audit"; PM ruling E keeps this as the bounded, run-scoped path beside worktrees 0.8.4.

### 8. The claude-ops issues are external dependencies, resolved upstream

Two issues belonged to the claude-ops session, and no acceptance test or contract case of this goal depends on them:

1. **No release tags.** claude-ops now tags every plugin release `<name>--v<version>`. `git ls-remote --tags https://github.com/AbhiramDwivedi/claude-ops.git` lists `kit--v0.3.1`, `worktrees--v0.8.4` and `subagent-limits--v0.3.1`, among others.
2. **SubagentStart/Stop miss wf_* worktrees.** Worktrees 0.8.4 (claude-ops b83265e, "worktrees 0.8.4: clean up Workflow agents' wf_* worktrees; tag every plugin release"; tag `worktrees--v0.8.4` peels to it) retires and cleans merged, clean `wf_*` worktrees itself.

Truss's own removal (Decision 7) stays: it is bounded to one run and one merged crew, and it reports what it left.

Decided by: the client in chat (14:40, external dependencies); PM ruling E (15:05, from the claude-ops session's report, verified by `git ls-remote`).

## Seams to pin

The stage-1 crews build to these strings and shapes, and the contracts (`cs`, `cf`, `cp`, `cm`) assert them.

### cs: stage.js

- **Restart log line**, one per restart, through the Workflow `log()`:
  `restart: crew <slug>, label <label>, n <n>, reason <reason>`
  `<label>` is the restarted member's label, `<n>` counts from 1 within the chain, and `<reason>` is the marker `CHECKPOINT` or `no report`.
- **Successor prompt.** After a CHECKPOINT it holds the previous note word for word. After a missing report it holds `A member before you returned no report.` Both hold `Read the branch's commits before you start.` and name the predecessor's branch when its report gave one.
- **Out of restarts.** `BLOCKED` at the task name (or the fix step), text starting `restarts spent:` and naming the last label and reason.
- **Planner prompt** holds `Load the \`subagent-limits:split-work\` skill before splitting work.`

### cf: factory.ts

- **recordRun restarts.** The journal holds `launched`, `started` (`key`, `agentId`, `label`) and `result` (`key`, `agentId`, `result`) lines, as `tests/fixtures/workflow-run/harness.ts` `mkRun` writes. Per crew and member role (tester, builder, writer), in `started` order: an agent whose result is a `CHECKPOINT` object, or whose result line holds something that is not an object, was restarted when a later agent of the same crew and role started after that result line; the first such agent not already linked is its successor. An agent with no result line was interrupted and is never a restart. `n` is 1, or the predecessor's `n` + 1 when it was itself a successor.
- **The event line**, once per crew and label, so a second `finish` adds nothing:
  `{"v":1,"ts":"<iso>","event":"restart","crew":"<slug>","agent":"<label>","label":"<label>","n":<n>,"reason":"CHECKPOINT"|"no report"}`
- **leftWorktrees.** `why` is one of `dirty`, `locked` or `unmerged`. Fixtures use a real-shaped id such as `wf_e804087f-eaa`; `wf_e804087f-eaa-1x`, `wf_e804087f-eaax-1` and another run's id stay.
- **Roles.** `roles.build` sets builder and resolver, `roles.test` sets tester, and the mapping maps whenever configured; the config author owns the kit dependency; `--type` wins; no `roles` leaves `roles.json` as it is.

### cp: init, run and project manager

- `skills/init/SKILL.md` runs `Skill({ skill: "kit:init" })` on a missing manifest when `kit:init` is listed, no longer holds `no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)`, keeps the kit-absent line, and proposes `build: kit:builder`, `test: kit:test-writer`, `nudgeAtK` and `stopAtK`.
- `skills/run/SKILL.md` holds `--type builder=kit:builder --type tester=kit:test-writer` and `only when kit is loaded`.
- `agents/project-manager.md` holds `Load the \`subagent-limits:split-work\` skill before splitting work.` and no longer `If the \`subagent-limits:split-work\` skill is available`.

### cm: manifests

- plugin.json: the three dependencies of Decision 1 (subagent-limits `^0.3.2`) and `version` `0.17.0`.
- The catalog: `allowCrossMarketplaceDependenciesOn` holds `claude-ops`; no shorthand url.
- Each README: `marketplace add AbhiramDwivedi/claude-ops` on a line before `marketplace add AbhiramDwivedi/truss`; no README names `truss@claude-ops`.
- With both marketplaces added (the local claude-ops checkout, no network), the install enables all four plugins; without the allowlist, the dependencies are missing.

## Consequences

- A user who skips the claude-ops marketplace gets a truss that fails to load, and the fix is in the README.
- `docs/events.schema.json`'s `event` enum has no `restart` today (it holds `spawn`, `stall`, `tag`, `report`, `allowance-spent`, `fetch`, `incomplete`, `refusal`, `sampler-error`). compose-runtime (stage 1), which owns that file under PO ruling F, adds `restart` with `crew`, `label`, `n` and `reason`. compose-design never edits it.
- `tests/workflows.check.ts:808-813` (a second member that is not DONE after a CHECKPOINT stops BLOCKED, with no third member) is the one existing case reversed; compose-runtime may change only those lines. The case above it (`:801-807`, a CHECKPOINT then DONE) still holds.
- `tests/init.check.ts:9-13` is reversed with Decision 3; compose-wiring owns it. `tests/contract.check.ts` stays green, because the kit-absent line stays.
- A task can take more member runs than before (the worst case above), but each is a fresh, smaller context.

## Left for later

- Have retro propose `kit:revise`.
- factory-fixes-2 shipped as factory-fixes2 in 0.17.0 ([ADR-0019](0019-factory-fixes2.md)).
- The PM runs `/tidy` on the stale `wf_*` worktrees and branches left before this change.
