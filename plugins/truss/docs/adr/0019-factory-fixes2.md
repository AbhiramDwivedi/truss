# ADR-0019: factory-fixes2: the plugin bugs this run logged, fixed and pinned

Status: proposed, 2026-11-02. Written by the design crew `fixes2-design` (stage 0 of goal `factory-fixes2`). It becomes accepted when the program manager (PM) merges this crew. The goal's approval is `auto` (plan-check ok, unproved none), and its plan is revision 2 (`plan-factory-fixes2.md` in the truss dir), which applied 8 PO rulings. The client's words: "Don't just log a plugin bug, fix it."

Amended by [ADR-0043](0043-crews-share-files.md) (2026-11-11, client): item 8 is reversed; plan-check reports no owns overlap between crews of different goals.

Amended by [ADR-0026](0026-factory-fixes5.md) (proposed 2026-11-03, goal `factory-fixes5`): item 48 adds to item 12's answer routing. An answer whose `at` names a done task re-runs that task with the answer, and a tester task commits with `Truss-Role: test-writer`.

VERDICT: change. Two modules change: the **factory CLI** (`bin/factory.ts`) and the **stage workflow** (`workflows/stage.js`). Three extend: the **plugin docs** (this ADR, plus wording in ADR-0020 and ADR-0021), the **plugin manifest and catalog**, and the **planning engineer prompt** with the **repo docs and root checks**.

## Context

This run logged bugs in the factory, the stage workflow, plan-check and the planner prompt. Each one is listed below as an item, 1 to 21, with the code line that shows it on main at `b4b19ad`. Every fix is pinned by a test that fails without it: `tests/factory-fixes2.check.ts` (runtime-factory) and `tests/stage-fixes2.check.ts` (runtime-stage) hold one `i<k> N:` case per item.

The code facts the items rest on:

- `cmdOwnsCheck` keeps a changed file only when `path.matchesGlob(file, g)` holds for some owned glob (`bin/factory/crew.ts`). On Node v24.22.0, `path.matchesGlob('marketplace/.claude-plugin/marketplace.json', 'marketplace/**')` is `false`, and so is `path.matchesGlob('plugins/truss/.claude-plugin/plugin.json', 'plugins/truss/**')`. `**` does not match a dot segment.
- `doneTasks` takes the task name from the member's own `result.task` and counts it only when `merge-base --is-ancestor <branch> truss-<slug>` succeeds (`bin/factory/start.ts`).
- `cmdStartResume` builds the entry with `done: doneTasks(...)` and no answers filter (`bin/factory/start.ts`). `runMembers` skips every name in `done` (`workflows-src/stage/tasks.js`).
- `recordRestarts` links a checkpointed member to the next agent of the same crew and role that started after its result (`bin/factory/audit.ts`), not to the next agent of the same task.
- The merge step refuses a crew whose `redRecord` is missing or has exit 0 (`bin/factory/finish.ts`). An answers resume skips red unless an answer's `at` is `red` (`workflows-src/stage/chain.js` `chain`).
- `cmdPlanCheck` compares owns only between crews of the same stage and the same goal (`bin/factory/plan.ts`).
- `crewEntry` copies `goal`, `scope` (the goal file's `## Approved scope`) and `acceptanceTest` into every entry, beside `goalFile` (`bin/factory/start.ts`). `start --args-file` writes that whole object to the argsFile and prints a pointer (`bin/factory/start.ts` `argsFileOut`).
- `memberPrompt` puts `Approved scope: ${e.scope}` and `Acceptance test: ${e.acceptanceTest}` in every member brief (`workflows-src/stage/prompts.js`). The same fields reach prompts at `plannerPrompt`, `green`, `qcPrompt` and `qcPrompt`.
- `runFactory` does `JSON.parse(res.stdout)` on the whole stdout (`workflows-src/stage/runner.js`), so one non-JSON line before the result makes `parsed` null.
- `taskPrompt` emits `Task: ${task.name}` and adds only the answers whose `at` equals that task's name (`workflows-src/stage/prompts.js`).
- Two test-path rules exist: `isTestPath` in `workflows/stage.js` (a `tests/`, `test/` or `__tests__/` segment, or `.check.`, `.test.`, `.spec.`) and a wider one in `bin/factory/crew.ts`, which feeds the guarded set in `cmdTestsCheck`.
- `rolesWithTypes` reads truss.json `roles` whenever it is an object (`bin/factory/shared.ts`). It never checks whether kit is loaded.
- `claude plugin validate plugins/truss` on main passes with two plugin-directory warnings: `icon: No icon (ICON_MISSING)` and `README.md: Listing link or icon path not accepted (LISTING_URL_SCHEME)`. The second names the example URL `https://user:secret@example.com:8443/...` in `README.md` section "What the fetch log records".

## Decision

The goal runs as four crews in three stages. Stages run in sequence, so the owns that repeat across stages (ADR-0021 in stages 0 and 1; `bin/factory.ts`, `tests/workflows.check.ts` and `tests/fixtures/workflow-run/start.cases.ts` in stages 1 and 2) never overlap.

```mermaid
flowchart LR
  S0["stage 0: fixes2-design<br/>ADR-0019, ADR-0020, ADR-0021<br/>items 13b, 20; records 5, 13c"]
  F["stage 1: runtime-factory<br/>bin/factory.ts<br/>items 1, 2, 3, 4, 8, 9 start side, 13a, 17, 18, 19, 21"]
  M["stage 1: plugin-meta<br/>plugin.json, icon.png, CHANGELOG, README,<br/>planning-engineer.md, ADR-0021, checks<br/>items 6 prompt, 14, 15"]
  R["stage 2: runtime-stage<br/>workflows/stage.js, bin/factory.ts entry<br/>items 5, 7, 9 reader side, 11, 12, 16"]
  S0 --> F
  S0 --> M
  F --> R
  M --> R
```

### Ruling 1: why runtime-stage also owns the entry

Main's stage.js inserts `e.scope` and `e.acceptanceTest` into prompts (`workflows-src/stage/prompts.js`, `workflows-src/stage/split.js`, `workflows-src/stage/green.js`, `workflows-src/stage/qc.js` `memberPrompt`, `plannerPrompt`, `green`, `qcPrompt`). If stage 1 shipped lean entries, the old stage.js would brief members with "Approved scope: undefined" until stage 2 merged. So item 7 is runtime-stage's, both halves: the lean entry in `bin/factory.ts` and the goal-file reader in `stage.js` land in one merge. The `guarded` and `ownTests` fields of item 9 only add keys the old stage.js ignores, so they land in stage 1.

### The items

**Item 1** (runtime-factory). owns-check misses dot segments such as `marketplace/.claude-plugin/` under `marketplace/**`, because `path.matchesGlob` does not match them (Context). The fix makes an owned `**` cover dot segments; the case pins `marketplace/**`.

**Item 2** (runtime-factory). doneTasks reads the task name from the member prompt's `Task: <name>` line (`workflows-src/stage/prompts.js` `taskPrompt`). When the prompt has none, it falls back to `result.task` with a leading `<slug>: ` prefix stripped. The name no longer depends on what a member wrote in its result.

**Item 3** (runtime-factory). `start --resume answers` refuses an answer whose `at` is a step after red while `redRecord` is missing or has exit 0. That resume skips red (`workflows-src/stage/chain.js` `chain`), and the merge step would refuse the crew anyway (`bin/factory/finish.ts` `mergeCrew`), so the refusal comes before members are paid.

**Item 4** (runtime-factory). New command `factory mark-merged --dir --repo --slug`. It sets the crew's status to `merged` only when `truss-<slug>` is an ancestor of the target, and logs a line. It gives a crew merged outside `finish` a true status, which the item 8 rule reads.

**Item 5** (runtime-stage). `memberPrompt` gains the member heavy line of ADR-0017 Decisions 1 and 2, built from the same values as `heavyLine()` (`workflows-src/stage/gates.js`). See "Note on ADR-0015 Decision 6" below.

**Item 6** (plugin-meta). The planning engineer prompt (`agents/planning-engineer.md`) gains one rule: builder briefs mark test files read-only, and a guarded edit goes to a tester task.

**Item 7** (runtime-stage, both halves). Lean entries. `goal` is dropped from the crew entry. `scope` and `acceptanceTest` are left out when the goal file has `## Approved scope` and `## Acceptance test`. stage.js points members to `goalFile` for them. On resume, the tasks already in `done` are stubbed. This shrinks the argsFile the PM reads and passes as the Workflow's args (`bin/factory/start.ts` `argsFileOut`).

**Item 8** (runtime-factory). plan-check reports an owns overlap between crews of different goals whenever neither crew is merged or dropped (ruling 6). There is no held-goal exemption and no later-stage exemption. The error names both crews. The fixture uses crewalpha, crewbeta and crewgamma, each matched with `grep -w`: crewalpha and crewbeta are named, a merged crewgamma is not, and the check passes once crewbeta is merged.

**Item 9** (split). One test-path rule. Start side, runtime-factory: `factory start` emits `guarded` (the guarded set of `bin/factory/crew.ts` `cmdOwnsCheck`) and `ownTests` in each crew entry, from the one rule in `bin/factory.ts`. Reader side, runtime-stage: stage.js drops its own `isTestPath` (`workflows/stage.js`) and reads `ownTests`, for example in `testerFiles`. The acceptance grep `isTestPath *=\|tests\?\|\|__tests__\|\(check\|test\|spec\)` must find nothing in stage.js. It fires on main's, and it also fires on the `_{2}tests_{2}` evasion that gamed the older grep (ruling 3).

**Item 10** (dropped). Under `claude plugin test` on main, 290 cases pass and 174 fail across all 17 `*.test.ts` files. Fixing that is a separate goal.

**Item 11** (runtime-stage). `runFactory` parses the last stdout line that is a JSON object, not the whole stdout (`workflows-src/stage/runner.js`).

**Item 12** (runtime-stage). An answer whose `at` is not a task name goes to every member. Today `taskPrompt` passes only answers whose `at` equals the task name (`workflows-src/stage/prompts.js`), so an answer at a step reaches no member.

**Item 13** (split by part).
- (a) runtime-factory: a test for an agentId with no result before a resumed one, the ADR-0020 rank rule.
- (b) fixes2-design: ADR-0020 says report lines are deduplicated per crew, label and marker (`bin/factory/audit.ts` `recordRun`). Done in this crew.
- (c) fixes2-design: the `.run<N>` note, held here (below).
- (d) **deferred**: resumed QC and stress gate labels, and the retro `QC_FILE` glob. They reverse the gate that `rl 4` pins, and no run has hit it.
- (e) folded into items 2 and 17.

**Item 14** (plugin-meta). Three parts: reword the example URL in `README.md` section "What the fetch log records" so LISTING_URL_SCHEME stops firing; add an icon; and add `tests/plugin-validate.check.ts`, which runs `claude plugin validate` and fails on any `(CODE)` warning, with no exemption. The check resolves the plugin root from its own module path (`path.dirname(fileURLToPath(import.meta.url))`), never from `process.cwd()`, so the base-copy run validates the base tree and can go red (ruling 4).

The icon (ruling 5 and the PO ruling on item 14): `plugin.json` has an `icon` field, but the plan uses the default path `.claude-plugin/icon.png` with no key. The validator looks there, and the file turns ICON_MISSING off; there is no ICON_MISSING exemption. plugin-meta commits a deliberately designed square PNG with a truss motif, not a blank placeholder, of 512 to 2048 px a side and under 2 MB. The reason: validate warns that the icon "may become the listing icon only once: the first time the plugin is saved or submitted in the developer portal". The client is told before any portal save.

**Item 15** (plugin-meta). Version 0.16.0 becomes 0.17.0 and the subagent-limits dependency `^0.3.1` becomes `^0.3.2` (`.claude-plugin/plugin.json` key `version`, key `dependencies`), with the compose-manifests pins and a CHANGELOG entry. The nudge is re-proved live in an isolated `CLAUDE_CONFIG_DIR` and recorded in ADR-0021.

**Item 16** (runtime-stage). The stage half of item 6: builder prompts carry the read-only list of test files, and `validateTasks` (`workflows-src/stage/split.js`) sends back a task plan that breaks the rule. The exact send-back condition is runtime-stage's to pin in `stage-fixes2.check.ts`. `tests/stage-briefs.check.ts`'s `entry()` fixture (`entry`) gains `ownTests`, since F-27 depends on the tester derivation item 9 changes.

**Item 17** (runtime-factory). doneTasks also counts a task whose branch has a full patch-id match on `truss-<slug>`, not only an ancestor, so a task whose commits reached the crew branch under other hashes stays done.

**Item 18** (runtime-factory). `start` and `start --resume` resolve `--dir` and `--repo` to absolute paths, as `heavy` already does for a factory command (`bin/factory/heavy.ts` `heavyMain`).

**Item 19** (runtime-factory). `recordRestarts` links a successor by task name (the `Task: ` line), not by the next agent of the same role (`bin/factory/audit.ts`). Tests: two parallel builders, and a two-crew `finish` leftWorktrees case.

**Item 20** (fixes2-design). ADR-0021's Factory and Roles bullets said the truss.json `roles` mapping applies only when kit is loaded. The code maps whenever configured (`bin/factory/shared.ts` `rolesWithTypes`). The bullets now say it maps whenever configured; the config author owns the kit dependency. Done in this crew.

**Item 21** (runtime-factory). `start --resume answers` drops from `done` every task an answer's `at` names. That task reruns, and `taskPrompt` already appends the answer (`workflows-src/stage/prompts.js`). Today `done` has no answers filter (`bin/factory/start.ts` `cmdStartResume`), so an answered task is skipped (`workflows-src/stage/tasks.js` `runMembers`). Test i21: a run stopped at green with every task done and an answer at task X gives `done` without X and with the others.

### Note on ADR-0015 Decision 6 (item 5)

ADR-0015 Decision 6 says only runner-run commands go through `factory heavy`, that members' builds and tests are not queued, and that `reap` doesn't catch a member's own processes (`0015-resource-aware.md` section "Checks through heavy: runner-run commands only", section "Reap: its own runner call"). Once item 5 merges, that changes: members run their builds and test suites through `factory heavy` with `--label <slug>-check`, so they share the one heavy slot with red and green checks, and the existing `reap` after each member covers their orphans (ADR-0017 Decision 1 and Consequences). This ADR holds the note because ADR-0015 is not this crew's to edit.

### Note on architecture.md, the run<N>.md files (item 13c)

`docs/architecture.md` section "The Workflow path (ADR-0009)" says `finish` records each agent's report under `reports/<slug>/<label>.md`. Since ADR-0020 that is true only for the first-ranked agentId under a label. A later agentId with a result, at rank k >= 2, is filed as `reports/<slug>/<label>.run<k>.md`, written `<label>.run<N>.md` with N the rank, except under a QC or stress gate label, where it is refused. The goal ui-redesign owns `architecture.md`, so the note lives here until that doc is next edited.

## Seams to pin

- **Crew entry from `factory start`.** Stage 1 adds `guarded` and `ownTests`. Stage 2 makes `scope` and `acceptanceTest` absent when the goal file holds `## Approved scope` and `## Acceptance test`, and drops `goal`. stage.js accepts both forms: entries without `guarded`, `ownTests` or the lean form still run, because the compose-runtime, compose-runtime-contract, stage-resources, stage-resources-contract and harness-banner checks build entries by hand and runtime-stage doesn't own them.
- **`factory mark-merged --dir --repo --slug`.** The ancestor check of `truss-<slug>` against the target, the status write, and the log line. Not an ancestor: no status change.
- **The `Task: <name>` prompt line** (`workflows-src/stage/prompts.js` `taskPrompt`) is the source of the task name for doneTasks and recordRestarts.
- **doneTasks.** A task is done when its branch is an ancestor of `truss-<slug>` or has a full patch-id match there, minus every task an answer's `at` names.
- **plan-check cross-goal error.** It names both crews and ignores merged and dropped crews.

## Consequences

- **Item 8's accepted cost.** A held or newly amended goal is refused while an overlapping crew of another goal is unmerged, even when the two would never run at once. Its crews must avoid the path, or wait for the other crew to merge (or be marked merged with item 4).
- Member briefs get shorter: the Approved scope and Acceptance test text lives once, in the goal file.
- One test-path rule (item 9) means the factory's guarded set and stage.js's tester files can't disagree.
- An answered task reruns with its answer (item 21), and an answer at a step reaches every member (item 12).
- `claude plugin validate` on the plugin reports no `(CODE)` warning, and `plugin-validate.check.ts` keeps it that way. The committed icon may become the permanent listing icon at the first portal save.
- Deferred: item 13d, the resumed QC and stress gate labels and the retro `QC_FILE` glob. Dropped: item 10, the `claude plugin test` failures.
- Proof covers Linux only. A flaky base test, `resources/sample.check.ts` "worktrees: lists the worktree dir holding a live process, not the idle one", failed once under load in the plan-time mock and passed on re-run.
