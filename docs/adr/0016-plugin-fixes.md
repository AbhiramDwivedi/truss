# ADR-0016: plugin fixes: designer resumes refused, start warns and names a missing goal file, stricter env and test guards

Status: proposed, 2026-10-31. Written by the design crew `plugin-fixes-design` (stage 0 of goal `plugin-fixes`). It becomes accepted when the PM merges this crew. The goal's approval is `auto`, and its plan is revision 2 (`plan-plugin-fixes.md` in the truss dir), sent back once by checker-28.

VERDICT: change. One module changes: the **factory CLI** (`bin/factory.ts`) gains a `warnings` key in `start`'s output, refuses a crew whose goal file is missing, and makes `envFailure` and `tests-check` stricter. The other modules extend: the **hooks** (`hooks/register.ts`) gain one SendMessage verdict, new refusal text and a JSON-string parse; **retro** (`retro/extract.ts`, `retro/cli.ts`, `retro/scrub.ts`) narrows three matches; **ui docs**, the **agents and skills**, the **stage workflow** and the **architecture doc** change text only. Item 5, members' own heavy commands, is left to a design slice in stage 2, ADR-0017.

Decided by: the client ruling of 11:33, the `[plugin-fixes]` lines of `decisions.md` (11:33 to 14:29), checker-27's sort and checker-28's send-back as followed in plan revision 2.

## Context

The client ruled at 11:33: "Don't just log a plugin bug, fix it." The plugin gaps this run proved became one goal, run through the factory after resource-aware merged (goal file `plugin-fixes-design.md`, Approved scope, 11:33 and 13:43).

The approved items, from `amend-brief-plugin-fixes.md` (cited as "brief :N"), with what main `315c33e` does today:

1. **Amend-route resume gap** (brief :6). A `Mode: amend` design engineer resumed mid-draft with SendMessage hands back a plan the plan-amend hook never routes. Today the main-session branch of the SendMessage handler (`hooks/register.ts:1942-1952`) calls `next(e)` with no designer check. The route map `state.planDesigners` (`register.ts:1033`) is filled at spawn (`:1923`, `:2038`) and read only at hand-back (`:2144`). The PM ruled at 14:16 that the refusal covers plan-mode designers too, through the shared `planDesigners` map, as within item 1's intent.
2. **`MAIN_MODEL_REFUSAL` text** (brief :7). The text at `register.ts:550` says the model is "opus" or "sonnet", while `mainCallVerdict` (`register.ts:699-703`) accepts any non-empty model.
3. **Scrub and the plugin author** (brief :8). The scrubber flags `.claude-plugin/plugin.json:7`, the published author name.
4. **Design engineer validation** (brief :9). A design engineer ran a cached `ajv-cli` after the classifier refused `npx -y`. The prompt must say: validate with `factory.ts plan-check` only, and report a refused command, never retry it another way.
5. **Members' own heavy commands** (brief :10). ADR-0015 queues only runner-run checks. Left to a design slice (Decision 8).
6. **A role added mid-session** (brief :11). A role added to the plugin after the session loaded its agents, such as `truss:stress-engineer`, can't be spawned until restart. Today `start` (`bin/factory.ts:861-951`) reads no agent file, and its output (`stageOut`, `bin/factory.ts:740-745`) has no key that can carry a notice.
7. **Missing goal file** (brief :12; approved-scope line 12:15). Today `start` reads `''` for an absent goal file (`bin/factory.ts:913-914`; `crewEntry` does the same at `:731`), so `engineOf` returns `the goal file has no ## Engine section` (`:707`) and the crew goes to the foreman path.
8. **Stale stress-test references** (brief :16). Several files point at `agents/qc-engineer.md` "Stress-test mode", a section that is gone. They should point at `agents/stress-engineer.md`.
9. **False env verdicts** (brief :17). `envFailure` (`bin/factory.ts:485-494`) tests each trimmed line against `ENV_PATTERNS` (`:459-464`) and the `Cannot find package` match anywhere on the line, so a failing test that echoes an env string inside JSON or assert text stops the crew as an env failure.
10. **F-16** (brief :18). The planning engineer never assigns a report, summary or findings `.md` as a member deliverable.
11. **F-21** (brief :19). Today `tests-check` guards only the files of `Truss-Role: test-writer` commits (`bin/factory.ts:674`). A file the acceptance test names that a builder added is not guarded.
12. **F-29** (brief :20). A crew's acceptance proof uses only files from earlier stages or the crew's own owned files.
13. **F-33** (brief :21). `workflowCallVerdict` reads `args.truss` only when `args` is an object (`register.ts:743-745`), so a Truss script whose `args` is a JSON string is refused with "a truss Workflow needs args.truss".
14. **`ui/README.md` example token** (brief :22). A real-looking `?token=` value in the example launch line trips scrub. It becomes a placeholder such as `<token>`.
15. **Members and the acceptance script** (brief :23). The worktree guard refuses an acceptance script that uses shell variables or multi-line shell. Members run plain single `node --test <files>` commands; the stage's green step runs the acceptance test.

The confirm-against-main list (brief :24), as plan revision 2 settled it (`plan-plugin-fixes.md:95-109`):

| Item | Result | Plan line |
|---|---|---|
| F-36, the brief skill's constraint example | include, prompts | :99 |
| F-42, `hitLines` matching quoted string-literal lines | include, narrow: skip a quoted literal line ending in `,` | :100 |
| F-43, the `toolError` quote and `handEdit` paths | include | :101 |
| F-44, the checking engineer's report path | include, prompts | :102 |
| P-2 | drop: the retro suites pass on main | :103 |
| P-3, no fallback when `truss:retro-judge` isn't loaded | include, prompts | :104 |
| P-5 | drop: not a bug | :105 |
| P-6 | drop: the transcript triage says "Why finish left no file is not shown"; no failing case | :106 |
| P-7 | drop: the producer was never traced | :107 |
| P-9 | drop: the miss is item 1 | :108 |
| item 2 text in `docs/architecture.md` | drop: the doc already states the rule | :109 |

## Decision 1: the factory CLI, `bin/factory.ts` (change)

`start`'s output is a seam ADR-0009 pins, and today it has no key that can carry a non-blocking notice. So this goal changes the CLI, the same way [ADR-0015](0015-resource-aware.md) added `held`.

### `start` gains `warnings`

`start` gains the top-level key `warnings`, an array of strings. It is in:

- the full output;
- the resume output (`start --slug S --resume ...`);
- the `--args-file` pointer, after `unfinished`.

`warnings` holds one warning for each crew starting now whose goal file says `## Stress test` yes, when the stress role's agent file has an mtime later than the session's start. Warnings never hold or refuse a crew. A start with no stress crew warns about nothing.

TODO: plan revision 2 doesn't say which crews count as "starting now" on a `--resume` call; the factory-fixes crew decides and pins it.

**The stress role.** `start` reads the stress role from `roles.json` `stress.agentType`, which is `truss:stress-engineer` (`workflows/roles.json`). Its agent file is the plugin's `agents/stress-engineer.md`. Today `readRoles` reads `<plugin>/workflows/roles.json` (`bin/factory.ts:187-188`).

**The session start.** `start` reads the session's start time this way:

1. `TRUSS_SESSION_START`, when set, in milliseconds since the epoch. It is a test override: nothing sets it in a real session.
2. Otherwise, the start time of the `CLAUDE_PID` process: field 22 of `/proc/<CLAUDE_PID>/stat` (`starttime`, in clock ticks since boot) divided by the tick rate (`CLK_TCK`), plus `btime` from `/proc/stat`.
3. It is never the `/proc/<pid>` inode mtime, and never the transcript's first record: `--continue` appends to the old transcript, so its first record is older than the process that loaded the agents.
4. When neither source can be read, as on a host with no `/proc` or a session with no `CLAUDE_PID`, the warning says it "can't tell". `start` never stays silent then.

A crew whose source can be read gets either no warning or a definite one.

The plan's proof (`plan-plugin-fixes.md:49-55`), re-run for this ADR in this session:

```
$ printenv CLAUDE_PID
2829804
$ getconf CLK_TCK
100
$ node <scratchpad>/start.mjs   # a scratch script: /proc/$CLAUDE_PID/stat field 22, and btime from /proc/stat
{"pid":"2829804","starttime":68664743,"btime":1792722936,"start":"2026-10-31T01:19:43.430Z",...}
```

That is the instant `ps` showed for `claude --continue --plugin-dir /home/abd/Projects/truss` in the plan's probe. The transcript's first record was `2026-10-30T20:08:12.992Z`, five hours earlier. The 14:29 PM probe showed the PM's own Bash carries `CLAUDE_PID=2829804`, which closed the one point the plan left unproved.

### Missing goal file

A crew whose `<truss dir>/goals/<slug>.md` doesn't exist goes in `refused`, with a reason that names that path and says the goal file is missing. It gets no worktree, is not under `foremen`, and its status stays `planned`. The rest of the reason's wording is the factory-fixes crew's.

### `envFailure` skips quoted echoes

An `ENV_PATTERNS` match, or a `Cannot find package` match, counts only when no `"`, `'` or backtick comes before it on the trimmed line.

The YAML `error:` key is the exception. A leading `error:` key and its one opening quote don't count, so TAP's `error: "<msg>"` still counts. On node v24.22.0, `node --test --test-reporter=tap` prints:

- a one-line error quoted, as `error: "browserType.launch: ..."` or `error: '...'`;
- a multi-line error as an `error: |-` block, whose message lines are not quoted.

A rule of "no quote before the match" alone would miss the quoted one-line form (`plan-plugin-fixes.md:56`). These still count: a TAP `error: |-` block line, a TAP single-line `error: "browserType.launch: ..."`, a real loader line and a real Playwright line.

### `tests-check` guards the acceptance files

The guarded files are the test-writer files plus every existing repo-relative path that the crew's `acceptanceTest` names. A builder or resolver commit that touches one fails `tests-check`, whoever added the file.

## Decision 2: the hooks, `hooks/register.ts` (extend)

- **Item 1, `designerResumeVerdict`.** One more `[truss] Refused:` verdict in the existing SendMessage gate's main-session branch (`register.ts:1940`). It uses `recipientsOf` (`register.ts:306`) and `state.planDesigners`, so it refuses a resume of a plan-mode or an amend-mode design engineer.
- **Item 2, `MAIN_MODEL_REFUSAL`.** The text names no model, to match `mainCallVerdict`, which accepts any non-empty model.
- **Item 13, `workflowCallVerdict`.** A JSON-string `args` is parsed before the existing checks run.

The exact signatures and rules are in "Seams to pin".

## Decision 3: retro, `retro/extract.ts`, `retro/cli.ts`, `retro/scrub.ts` (extend)

Narrower matches inside existing functions; the extract schema is unchanged (`plan-plugin-fixes.md:13`):

- F-42: `hitLines` skips a line that is a quoted string literal ending in `,`.
- F-43: the line after `Exit code N` joins the quote, and `handEdit` leaves out scratchpad and memory paths. Today it leaves out only paths holding `/.git/truss/` (`retro/extract.ts:263`).
- Item 3: `runScrub` accepts the plugin manifest's `author.name` line and nothing wider.

## Decision 4: ui docs, `ui/README.md` (extend)

Item 14 replaces the example token with a placeholder.

## Decision 5: agents, the PM skill, the brief skill and the retro skill (extend)

Prompt text only: items 4, 8, 10, 12 and 15, F-36, F-44 and P-3.

## Decision 6: the stage workflow, `workflows/stage.js` (extend)

Member-brief text for item 15, and one stale comment for item 8. Control flow doesn't change.

## Decision 7: the architecture doc (extend)

The prompt-fixes crew repoints the stale stress-test rows (item 8). This crew adds the ADR-0016 link, and stage 2 adds the ADR-0017 link.

## Decision 8: members' heavy commands, item 5 (change, decided by a design slice)

ADR-0015 queues only runner-run checks: `factory heavy` from `stage.js`. A member's own heavy command bypasses the queue, and the worktree guard refuses the multi-part shell a member would need to call `factory heavy` itself. The stage-2 crew `member-heavy-design` writes ADR-0017. It decides whether a member-side heavy path can work under the guard, or else records the gap as a known limit. If it decides to build the path, the PM amends a build crew; this goal doesn't build it.

## Out of scope

- No crew edits `CHANGELOG.md`, `.claude-plugin/plugin.json`, `docs/requirements.md` or `.claude/settings.json`.
- The deferred items of brief :25: the hook-gates, stage-briefs and other stress-persona gaps; `ui/` items; F-6, F-10, F-19, F-28, F-31, F-34, F-41; the ADR-0014:86 TODO.

## Seams to pin

Stage 0 pins these seven seams in two contract files:

- `tests/plugin-fixes-hooks-contract.check.ts`, for the hooks seams;
- `tests/plugin-fixes-factory-contract.check.ts`, for the factory seams.

Every case that must fail on today's producers is named `pf <n>: ...`. Every case that holds today is named `control: ...`. On today's producers each file has 3 or more failing `pf` cases, no passing `pf` case and no failing `control:` case. The factory contract also has a passing `control:` case named for a TAP `error: |-` block line, a passing `control:` case named for a TAP single-line `error: "` line, and a failing `pf` case for a start with no `TRUSS_SESSION_START`.

| Seam | Producer | Rule |
|---|---|---|
| `designerResumeVerdict(to: unknown, agents: readonly Agent[], designers: ReadonlyMap<string, 'plan' \| 'amend'>): { deny: string } \| undefined` | `hooks/register.ts` | Denies when any `recipientsOf(to, agents)` id is in `designers`. The deny starts `[truss] Refused:`, names the mode, and says to start a fresh plan or amend design engineer under the next unused name. A non-string `to`, or one that isn't a designer, gives undefined. It is wired into the main-session branch of the SendMessage handler before `next(e)`, through `refuse()`, so `tests/refusals.check.ts` wiring holds. |
| `MAIN_MODEL_REFUSAL` | `hooks/register.ts` | Names no model: it does not match `/opus\|sonnet/i`, and it says `model` must be set. `mainCallVerdict` accepts any non-empty model. The pins in `tests/contract-gates.test.ts` (:70-71, :321, :490) and in ADR-0004 (:204) carry the new text exactly. |
| `workflowCallVerdict` | `hooks/register.ts` | A JSON-string `args` gets the same verdict as the parsed object, and an unparsable string is refused. |
| `factory start` output | `bin/factory.ts` | Gains the key `warnings` (array of strings) in the full output, in the resume output and in the `--args-file` pointer (after `unfinished`), by the rule in Decision 1. The factory contract has a `pf` case for a start with no `TRUSS_SESSION_START`. Warnings never hold or refuse a crew. |
| `factory start`, missing goal file | `bin/factory.ts` | A crew whose `<truss dir>/goals/<slug>.md` doesn't exist goes in `refused`, with a reason that names that path and says it is missing. It gets no worktree and is not under `foremen`, and its status stays `planned`. |
| `envFailure` | `bin/factory.ts` | An `ENV_PATTERNS` match, or a `Cannot find package` match, counts only when no `"`, `'` or backtick comes before it on the trimmed line. A leading YAML `error:` key and its one opening quote don't count, so TAP's `error: "<msg>"` still counts. Controls: a TAP `error: \|-` block line, a TAP single-line `error: "browserType.launch: ..."`, a real loader line and a real Playwright line all still count. |
| `factory tests-check` | `bin/factory.ts` | The guarded files are the test-writer files plus every existing repo-relative path that the crew's `acceptanceTest` names. |

The factory-fixes crew also updates the two existing key pins: `OUTPUT_KEYS` in `tests/fixtures/workflow-run/start.cases.ts:42` and the pointer keys in `tests/factory-resources.check.ts:248`.

## Documents this ADR amends

- [ADR-0009](0009-workflow-factory.md), Decision 1: `start` gains `warnings` in its output and its `--args-file` pointer, and refuses a crew whose goal file is missing.
- [ADR-0004](0004-scope-repair-and-head-gates.md) :204: the `MAIN_MODEL_REFUSAL` text, changed by the hooks-fixes crew.
- `docs/architecture.md`: the ADR-0016 link and the Hooks section note.

## Consequences

- The PM learns before a stage, not at it, that a stress crew needs a role the session hasn't loaded. On a host with no `/proc`, or with no `CLAUDE_PID`, it gets a "can't tell" warning instead.
- A PM can no longer resume a design engineer by SendMessage; it starts a fresh one under the next unused name.
- A failing test that echoes an env string in quotes no longer stops a crew as an env failure. A real env failure in TAP output still does.
- A crew whose acceptance test names a builder's file can no longer pass `tests-check` after a builder edits that file.
