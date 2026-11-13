# ADR-0041: a crew's work type sets its minimum process

Status: accepted, 2026-11-10
Decided by: client brief and contract-025 revision 2 (R-62), as the approved-scope rows of the b-cost goal record
Amends: ADR-0031 (adds a floor under the PM's per-task `process` call)

## Context

ADR-0031 lets the program manager (PM) size each crew `solo`, `lean` or `full`, and logs the call with a one-line reason. Nothing stops the PM, or the plan design engineer in plan mode, from sizing a bug fix or a schema migration as `solo`. In an attended run the client sees the plan and can object. In an unattended run (wave 2 of level-4 autonomy, contract-025) nobody reads the plan before the crews start, so a wrong size goes straight to merge with less proof than the change needs.

R-62 asks for a crew field that names the kind of work and sets the least process that kind may get. Its example (`docs/requirements.md:439`): a v4 plan with a crew `workType: "bugfix"` and `process: "solo"` fails `plan-check` with `<slug>: process solo is below the bugfix minimum lean`. The same plan without `workType` passes outside an unattended run and fails inside one with `workType is required in an unattended run`.

## Decision Drivers

- A floor, never a ceiling. The PM may always give more process than the work type asks for.
- The check runs in `plan-check`, with no model call, so it is cheap and the same on Linux, macOS and Windows.
- A project may make its own floors stricter, never looser: a config that weakens a built-in floor is a mistake to report, not a setting to honour.
- Attended runs keep working unchanged. A plan without `workType` must still pass when the client is present.
- The read-only sizing engineer (`agents/sizing-engineer.md:5`, `tools: Read, Grep, Glob`) must be able to see the floors without Bash.

## Considered Options

| Option | Verdict | Why |
|---|---|---|
| A JSON file `workflows/worktypes.json` holding the profiles | Rejected | A second file to load and validate. Contract-025 section 5 says there is no such file. |
| The profiles as a constant in `bin/worktypes.ts`, tightened by `.claude/truss.json` `workTypes` | Kept | One place in code; the config can only raise a floor, and every refusal names the key. |
| Let the config replace a profile outright | Rejected | A project could set `migration` to `solo` and lose the stress test the floor exists to force. |
| Require `workType` in every v4 plan | Rejected | Breaks attended v4 plans that carry no work type. The field is required only where nobody reviews the plan. |

## Decision

### 1. Built-in profiles

`bin/worktypes.ts:10-17` holds the built-in profiles:

| Work type | `minProcess` | Also requires |
|---|---|---|
| `feature`, `docs`, `refactor` | `solo` | nothing |
| `bugfix` | `lean` | `red: true` |
| `dependency` | `lean` | nothing |
| `migration` | `full` | `stressTest: true` |

A crew names its work type in the optional `plan.json` field `workType`. It is valid only at plan version 4 (`bin/factory/plan.ts` `cmdPlanCheck`), and its value must be one of the six names (`bin/factory/plan.ts` `WORK_TYPES`, `:627`).

### 2. The config only tightens

`profilesOf(cfg)` (`bin/worktypes.ts:20-49`) starts from a copy of the built-ins and applies `.claude/truss.json` `workTypes`, keyed by work type. It returns `{profiles, errors}`.

- `minProcess` may only rise along `solo < lean < full` (`bin/worktypes.ts:37-40`).
- `stressTest` and `red` may only become `true` (`bin/worktypes.ts:41-44`).
- A refused value leaves the built-in in place and adds one error, each starting `config: workTypes.<wt>`:
  - `config: workTypes.<wt>.minProcess <value> loosens the built-in <min>`
  - `config: workTypes.<wt>.<key> false loosens the built-in true`
  - `config: workTypes.<wt> is not a known work type`
  - `config: workTypes.<wt>.<key> is not a known key`
  - type errors: `workTypes must be an object`, `workTypes.<wt> must be an object`, `minProcess must be solo, lean or full`, `<key> must be true or false`.

A config cannot add a work type; it can only tighten the six.

### 3. The four crew errors

`workTypeErrors(plan, crew, profiles, {unattended})` (`bin/worktypes.ts:54-65`) returns these messages:

1. `<slug>: workType must be one of feature, bugfix, migration, dependency, docs or refactor`
2. `<slug>: workType is required in an unattended run`
3. `<slug>: process <p> is below the <wt> minimum <min>`. An absent or unknown `process` counts as `full`, matching ADR-0031 Decision 1.
4. `<slug>: <wt> requires red`, when the profile has `red: true` and the crew's `red` is not `true`.

A crew without `workType` gets no error outside an unattended run. A run is unattended when `<truss dir>/unattended.json` exists (`bin/factory/plan.ts` `cmdPlanCheck`).

### 4. Where the rules apply

- `plan-check` loads the repo's profiles (`bin/factory/plan.ts` `cmdPlanCheck`), adds each `workTypeErrors` message once per crew (`bin/factory/plan.ts` `cmdPlanCheck`) and adds the config's `profilesOf` errors too (`bin/factory/plan.ts` `cmdPlanCheck`). A malformed `.claude/truss.json` is a usage error there, never a silent fall back to the built-ins (`bin/factory/plan.ts` `cmdPlanCheck`). In an unattended run, a crew on a plan below version 4 that has no `workType` is refused with a message that says unattended runs need a version 4 plan (`bin/factory/plan.ts` `cmdPlanCheck`).
- The crew entry that `start` and its resume path hand to `stage.js` (`crewEntry`, called at `bin/factory/start.ts` and `:2094`) switches the stress test on when the profile says `stressTest: true`, whatever the goal file's `## Stress test` section says. A profile can turn the stress test on, never off (`bin/factory/start.ts` `crewEntry`).
- `plan-args` hands the profiles to `plan.js` as `workTypes` (`cmdPlanArgs`, `bin/factory/plan.ts`), so the plan design engineer sees them when it sizes crews.

### 5. `factory worktypes` and the sizing engineer

`factory.ts worktypes --repo R` prints `profilesOf` of the repo's config as one JSON object `{profiles, errors}` (`bin/worktypes.ts:67-69`). The sizing engineer has no Bash, so it cannot run this. The PM runs it and passes the output to the sizing engineer with the goal. Contract-025 section 5 assigns that prompt text to the D1 and D2 crews.

The PM and sizing-engineer prompt lines that pass `factory worktypes` output are owned by D1 and D2.

## Consequences

- An unattended run cannot merge a bug fix without a red test, or a migration without the full process and a stress test, unless the plan lies about the work type.
- Attended runs are unchanged: a v4 plan without `workType` still passes `plan-check` (`tests/worktypes.check.ts:111`).
- **Mislabelled work types.** The floor trusts the label. A behaviour change labelled `refactor` or `docs` gets the `solo` floor, and only the checking engineer can catch the wrong label (contract-025 section 9, risk 11).
- **A full-process bugfix crew counts as red.** `bugfix` requires `red: true` on the crew, but ADR-0031 Decision 1 allows `red` only on a lean crew (`bin/factory/plan.ts` `cmdPlanCheck`), and a full crew always runs a red check. `workTypeErrors` (`bin/worktypes.ts:63`) therefore does not ask for `red` when the process is `full` (or absent, which counts as `full`). A lean bugfix crew still needs `red: true`. The case is in 'worktypes: bugfix requires red' (`tests/worktypes.check.ts:56`).
- The work-type list lives in two places: `WORK_TYPES` in `bin/factory/plan.ts` and the keys of the built-ins in `bin/worktypes.ts:10-17`. Adding a work type means changing both, and the message text in `bin/worktypes.ts:58`.
- Tests: `tests/worktypes.check.ts` covers each built-in rule, each loosening refusal, unknown keys and work types, `factory worktypes`, the R-62 example and its unattended pair.
