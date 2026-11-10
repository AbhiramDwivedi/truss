# ADR-0031: size the process per task: solo, lean or full

Status: accepted, 2026-11-08
Decided by: client ruling, 2026-11-08 (R-49 to R-54, confirmed in the client brief)
Amends: ADR-0009 Decisions 1 and 3; ADR-0001 section 8 (the plan file)
Amended by: ADR-0041 (a crew's work type sets the least process the PM may give it)

## Context

Every crew pays for the full process today, whatever the task.

- `mergeCrew` refuses a crew with no red record: `bin/factory.ts:2368-2369`. The resume path refuses the same way: `bin/factory.ts:1455`.
- `finish` merges a crew only on a QC PASS with no UNSCOPED finding (`bin/factory.ts:2553-2555`), and `mergeHeadVerdict` refuses anything else (`bin/factory.ts:1918-1922`).
- `plan-check` accepts only plan versions 2 and 3: `bin/factory.ts:470`.
- `$defs/crew` is `additionalProperties: false` (`docs/plan.schema.json:178`), so a crew has nowhere to record a process size or the PM's proof choices.
- The run skill's foremanless crew, for at most 2 members, still runs a test-writer, a builder and a QC engineer (`skills/run/SKILL.md:263`).

A docs fix and a new factory feature get the same planner, red-then-green test and QC engineer. The client ruled on 2026-11-08 that this changes:

- R-49: the PM sizes each piece of work, from one agent to a full crew.
- R-50: a one-agent task needs no red-then-green test and no QC engineer.
- R-51: a small crew is one or two members, and the PM picks its proof.
- R-52: a sizing agent can recommend the tasks and crew sizes. A goal whose tasks are all one-agent tasks skips the plan design engineer, the checking engineer's plan review and plan approval.
- R-53: the sizing tests are cheap: 0 agents, 0 model calls, under 10 s.
- R-54: sizing works on Linux, macOS and Windows.

The `docs/requirements.md` non-goals (lines 389-390) also bind this ADR. There is no measurement against an earlier run, and full crews keep today's process.

Two facts constrain the shape:

- ADR-0008 (`docs/adr/0008-owner-interview.md:60-66`) sizes the goal's brief as `small`, `standard` or `large`. It says "nothing else here reads it", and that "whether process size ... follows the same size is ADR-0009's call".
- The hooks already let a sized crew through. `gateOf` checks approval, goal, stage and the parallel cap, and never reads a crew's process (`hooks/register.ts:433-466`). `mainEditVerdict` is inactive with no plan, or with no crew that isn't merged or dropped (`hooks/register.ts:1070-1074`).

## Decision Drivers

- Spend agents only where the task needs them (R-49, R-50).
- Keep the gates mechanical. A merge gate follows a recorded choice, not the PM's memory (R-51).
- A reader that predates this ADR must fail closed.
- Keep full crews exactly as they are (`docs/requirements.md:390`).
- Keep the tests cheap and portable (R-53, R-54).

## Considered Options

| Option | Kept? | Why |
| --- | --- | --- |
| Process size follows the brief size (`small` gives a small crew) | Rejected | The brief size measures how deep the client brief goes. A `small` goal can hold a feature that needs a full crew, and a `large` goal can hold one-line fixes. |
| One per-crew field, `process`, set per task by the PM | Kept | It sits where the gates read. Each size has one default, and only the middle size is a choice. |
| Name the sizes `small`, `standard`, `large` | Rejected | The names collide with the brief sizes (`docs/architecture.md:453`). |
| Let a `lean` crew carry free-text proof | Rejected | A merge gate can't read prose. Two booleans, `qc` and `red`, can be read. |
| Let the design engineer size an all-solo goal | Rejected | That starts the agent R-52 exists to save. It also loads a 292-line prompt (`agents/design-engineer.md`) for a one-screen answer. |
| A new read-only sizing agent | Kept | This reuses an existing pattern, the read-only advisor `agents/resource-monitor.md:1-8`: "You recommend; the PM decides". |
| Teach `finish` to merge solo and lean crews | Rejected | `finish` reads a `stage.js` run's results and transcript (`bin/factory.ts:2459-2583`). A solo or lean crew has neither. |
| A new `land --slug` merge gate | Kept | It reuses `mergeCrew`'s steps and leaves `finish` unchanged. |

## Decision

### 1. Names

We will give a crew an optional field `process`, with the value `solo`, `lean` or `full`. An absent `process` means `full`.

- `solo`: one agent, with no QC engineer and no red-then-green test (R-50).
- `full`: today's crew, with a planner, members, a red record, a QC engineer and a stress test where the goal file says yes.
- `lean`: one or two members. The crew also carries two booleans, `qc` and `red`, which record the PM's proof choice (R-51). Both are required on a lean crew and allowed on no other crew.

The size names avoid the brief sizes `small`, `standard` and `large`.

### 2. Process size does not follow brief size

This settles the question that ADR-0008:66 left to ADR-0009. The brief size still sets only how deep the client brief goes. Each task's `process` is the PM's own call, logged with a one-line reason (R-49).

For ADR-0009 Decision 3: a goal whose tasks are all `solo` never runs `workflows/plan.js`. It has no plan design engineer, no checking-engineer plan review and no plan approval (R-52). Every other goal runs `plan.js` unchanged, and the plan design engineer sets `process` on each crew in plan mode.

### 3. Plan version 4

A plan version goes up when an added field "changes what a reader must refuse" (`docs/architecture.md:523`). `process` changes what the merge gates refuse, so we will raise the plan `version` to 4.

- `process`, `qc` and `red` are valid only at version 4 or above.
- Readers keep gating on `version >= 2` (`docs/plan.schema.json:18`). A version-3 rule applies at version 4 too: `plan-check` changes its `plan.version === 3` tests (`bin/factory.ts:472`, `:502`) to `>= 3`.
- A plan with no `process` field may stay at version 2 or 3.
- A 0.20.1 reader fails closed on a version-4 plan. Its `plan-check` refuses the version (`bin/factory.ts:470`), and its merge gate still asks for a red record and a QC PASS.

### 4. Record each size

The PM logs every size with `factory.ts decide --line`, whose four fields `cmdDecide` requires (`bin/factory.ts:2608-2611`):

```
factory.ts decide --dir D --line 'size <task> <process>[ qc <true|false> red <true|false>] | <one-line reason>; sizing-engineer <solo|lean|full|none> | none | <followed|overruled>'
```

The outcome is `overruled` when the PM's size differs from the sizing engineer's recommendation. Otherwise it is `followed`, and `none` stands in for the recommendation when the PM didn't start the sizing engineer. A `solo` or `lean` crew in a mixed goal also carries its size in `plan.json`.

### 5. All-solo goals

An all-solo goal never writes `plan.json`. The PM:

1. logs one size line per task (item 4);
2. starts one Sonnet agent per task, in its own worktree;
3. reviews the diff and the agent's own proof, such as a checker's OK line (R-50);
4. merges the task branch into the target under the run's merge mode;
5. logs the merge with `decide --line`.

With no plan, `gateOf` and `mainEditVerdict` are inactive (`hooks/register.ts:434`, `:1070`), so no hook refuses this path.

### 6. Mixed goals: `start` and `land`

**`start`.** `factory.ts start` (`bin/factory.ts:1492-1617`) treats a planned `solo` or `lean` crew that starts now as a direct crew. It applies the same goal-file check, `admission` and `planVerdict` as it does to a workflow crew. It skips the engine split and the `## Members` check. Then it:

- makes the worktree `.claude/worktrees/truss-<slug>` on branch `truss-<slug>` (`ensureWorktree`);
- sets the crew's `status` to `running` and saves `plan.json`;
- appends the decision line `started direct crew <slug> (process <p>) in stage <n> | worktree truss-<slug> from <target>`;
- appends no `by: "factory"` spawn line, so `finish`'s `factorySpawned` filter (`bin/factory.ts:2477`) never picks the crew up;
- counts the crew against `maxParallelCrews`, like foreman crews.

The output gains a top-level key `direct`, beside `held`, `foremen` and `refused`. It is an array of `{ "slug", "process", "qc", "red", "worktree", "branch" }`, where `qc` and `red` are `false` on a `solo` crew. A direct crew never appears in `truss.crews`, the object the PM passes as the Workflow args (`bin/factory.ts:1052`). `--args-file` writes the same body. The PM runs each direct crew itself, naming its agents `<slug>-builder`, `<slug>-tester` and `<slug>-qc`.

`start --slug S --resume ...` refuses a `solo` or `lean` crew with exit 1 and `why: "<slug> is a <process> crew; it runs direct, so merge it with land"`. This keeps the resume path's red-record check at `bin/factory.ts:1455` for full crews only.

**`land`.** We will add the merge gate for direct crews:

```
factory.ts land --dir D --repo R --slug S
```

| Exit | Body | When |
| --- | --- | --- |
| 0 | `{ "merged": true, "slug", "process", "qc", "red", "head" }` | Merged and recorded |
| 1 | `{ "merged": false, "slug", "why" }` | A gate refused. The crew stays `running` and nothing is written. |
| 2 | `{ "error" }` | Usage: `--slug` is missing, no such crew is in the plan, or `merge` is `single` (as `finish`, `bin/factory.ts:2463`) |

`land` runs `mergeCrew`'s steps (`bin/factory.ts:2353-2417`), with the red and QC gates switched on by the crew's booleans. A `solo` crew runs with both off.

1. A crew that isn't `running` is refused. So is a crew whose `process` is absent or `full`, with `why` naming `process`; it merges through `finish`.
2. The crew worktree must exist and be on `truss-<slug>`. `owns-check` must pass.
3. When `red` is true, the red record must exist with a non-zero integer `exit`, as at `bin/factory.ts:2369`.
4. When `qc` is true, the newest QC file under `reports/<slug>/` from this run must be a PASS with no UNSCOPED finding. The PM saves the QC hand-back there, as `skills/run/SKILL.md:263` already says. `qcFails` must not exceed `reworkAllowance`.
5. `land` merges the resolved target into the crew branch, never by rebase. A conflict aborts the merge and refuses with `why: "conflict"`.
6. When `qc` is true, the merged head must pass `mergeHeadVerdict`. When `red` is true, or `qc` is true and the head moved past the QC engineer's `Head:`, `check --expect green` must pass on the merged head.
7. `land` fast-forwards the target, with the same dirty-target and target-moved refusals as `mergeCrew`.
8. It sets `status` to `merged`, removes the crew worktree, and appends:

```
crew <slug> merged into <target> at <head> | land: process <p>, qc <bool>, red <bool>[, red record exit <n>][, QC PASS on <sha>]
```

`finish` and its gates don't change for `full` crews, and `stage.js` doesn't change.

Under merge mode `single`, a `solo` or `lean` crew takes the foreman path like a full crew, because `land` refuses `single` (exit 2). `factory.ts start` guards this with `settings.merge !== 'single'`, and `skills/run/SKILL.md` says the same.

### 7. plan-check rules

`plan-check` (`bin/factory.ts:465-531`) accepts versions 2, 3 and 4. Every new refusal goes into `errors` as `<slug>: <rule> ...`, so it names the crew's slug and the field it breaks: `process`, `estAgents`, `qc` or `red`.

- `<slug>: process must be solo, lean or full`
- `<slug>: process is version 4 only`, and the same for `qc` and `red`
- `<slug>: qc is lean only` and `<slug>: red is lean only`
- `<slug>: qc must be a boolean on a lean crew`, and the same for `red`
- `<slug>: estAgents <n> is above 1 for a solo crew`
- `<slug>: estAgents <n> is above 3 for a lean crew`
- `<slug>: estAgents <n> is above 2 for a lean crew without qc`
- `<slug>: process must be full on a stage-0 design crew, not <p>`

A lean crew's limits follow R-51: one or two members, plus a QC engineer when `qc` is true.

### 8. Schema shape

`docs/plan.schema.json` changes as follows.

- `version` becomes the enum `[1, 2, 3, 4]`. The `reworkAllowance` conditional covers `[2, 3, 4]`. `goals` stays forbidden only at 1 and 2.
- `$defs/crew.properties` gains:
  - `process`: enum `["solo", "lean", "full"]`, default `"full"`
  - `qc`: boolean
  - `red`: boolean
- `$defs/crew.allOf` gains two conditionals:
  - if `process` is `"lean"`, then `qc` and `red` are required;
  - otherwise, neither `qc` nor `red` may appear.
- The stage-0 conditional also requires `process`, when present, to be `"full"`.
- A top-level conditional: if `version` is in `[1, 2, 3]`, no crew may carry `process`, `qc` or `red`.

### 9. Sizing engineer

`plugins/truss/agents/sizing-engineer.md` defines `truss:sizing-engineer`. Its frontmatter is `model: sonnet` and `tools: Read, Grep, Glob`: no Write, Edit, MultiEdit or NotebookEdit. The PM starts it as an Agent call, outside every crew, for a goal it can't size at a glance. It returns one line per task:

```
TASK: <name> | solo|lean|full | <one-line reason>
```

It recommends and never decides. The PM may overrule it, logging the reason (item 4, R-52). A goal that needs a plan doesn't use it: the plan design engineer sets `process` there.

### Seams to pin

Stage 0 pins these seams. The test-writer builds them on fixture git repos and truss dirs under `os.tmpdir()`, with `path.join` for every path. The tests use no `/proc` and no POSIX-only shell (R-54), and start 0 agents (R-53).

- `docs/plan.schema.json` `$defs/crew` is read as JSON from `process.env.TRUSS_PLAN_SCHEMA`, or else from the repo copy. The test uses no validator dependency (`tests/sizing-schema.check.ts`).
- `factory.ts plan-check`, `start` and `land` run as child processes through `process.execPath` (`tests/sizing-contract.check.ts`).
- `gateOf` and `finish` are the guards: guard 10 checks that `finish` still refuses a full crew without a red record, and guard 11 checks that the plan gate does not refuse a solo or lean crew for its process.
- The frontmatter of `agents/sizing-engineer.md` names no write tool.

## Consequences

**Positive**

- A one-line fix costs one agent, not a planner, tester, builder and QC engineer (R-49, R-50).
- Every merge of a sized crew follows a recorded choice, `qc` and `red` in `plan.json`, logged by `land` (R-51).
- Full crews, `finish` and `stage.js` behave as before.

**Negative**

- A solo task has no independent check: the PM's review of the diff and the agent's proof is the only gate. Picking the wrong size is a new kind of mistake, and the size lines make it countable. Counting them in the retro is left for later, not done here.
- The PM runs lean crews' members by hand, as it runs the foremanless crew today.
- A 0.20.1 session can't read a version-4 plan. It fails closed rather than merge a sized crew under the wrong gate.

**Neutral**

- The hooks don't change. Guard 11 pins that.
- The foremanless crew of `skills/run/SKILL.md:256` and `:263` is deleted and replaced by `lean`. Stage 1 makes that change, together with the design engineer's per-crew `process` and the new agent file.

**Reversing it** touches:

- the `process`, `qc` and `red` schema fields and the version-4 enum;
- `plan-check`'s rules;
- `start`'s `direct` key;
- the `land` command;
- `agents/sizing-engineer.md`;
- the run skill's sizing text;
- the two seam test files.

Plans written at version 4 would need rewriting to version 3, without the fields.
