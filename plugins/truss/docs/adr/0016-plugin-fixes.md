# ADR-0016: plugin fixes: designer resumes refused, start warns and names a missing goal file, stricter env and test guards

Status: proposed, 2026-10-31. Written by the design crew `plugin-fixes-design` (stage 0 of goal `plugin-fixes`). It becomes accepted when the program manager (PM) merges this crew. The goal's approval is `auto`, and its plan is revision 2 (`plan-plugin-fixes.md` in the truss dir), sent back once by checker-28.

VERDICT: change. One module changes: the **factory CLI** (`bin/factory.ts`) gains a `warnings` key in `start`'s output, refuses a crew whose goal file is missing, and makes `envFailure` and `tests-check` stricter. The other modules extend: the **hooks** (`hooks/register.ts`) gain one SendMessage verdict, new refusal text and a JSON-string parse; **retro** (`retro/extract.ts`, `retro/cli.ts`, `retro/scrub.ts`) narrows three matches; **ui docs**, the **agents and skills**, the **stage workflow** and the **architecture doc** change text only. Item 5, members' own heavy commands, is left to a design slice in stage 2, ADR-0017.

Decided by: the client ruling of 11:33, the `[plugin-fixes]` lines of `decisions.md` (11:33 to 14:29), checker-27's sort and checker-28's send-back as followed in plan revision 2.

## Context

The client ruled at 11:33: "Don't just log a plugin bug, fix it." The plugin gaps this run proved became one goal, run through the factory after resource-aware merged (goal file `plugin-fixes-design.md`, Approved scope, 11:33 and 13:43).

The approved items, from `amend-brief-plugin-fixes.md`, with what main `315c33e` does today:

1. **Amend-route resume gap**. A `Mode: amend` design engineer resumed mid-draft with SendMessage hands back a plan the plan-amend hook never routes. Today the main-session branch of the SendMessage handler (`hooks/register.ts` the `tool.call` handler for `SendMessage`) calls `next(e)` with no designer check. The route map `state.planDesigners` (`register.ts` `State`) is filled at spawn (the `agent.spawn` handler, the `tool.call` handler for `Agent`) and read only at hand-back (the `tool.call` handler). The PM ruled at 14:16 that the refusal covers plan-mode designers too, through the shared `planDesigners` map, as within item 1's intent.
2. **`MAIN_MODEL_REFUSAL` text**. The text at `register.ts` says the model is "opus" or "sonnet", while `mainCallVerdict` (`register.ts`) accepts any non-empty model.
3. **Scrub and the plugin author**. The scrubber flags `.claude-plugin/plugin.json` key `author.name`, the published author name.
4. **Design engineer validation**. A design engineer ran a cached `ajv-cli` after the classifier refused `npx -y`. The prompt must say: validate with `factory.ts plan-check` only, and report a refused command, never retry it another way.
5. **Members' own heavy commands**. ADR-0015 queues only runner-run checks. Left to a design slice (Decision 8).
6. **A role added mid-session**. A role added to the plugin after the session loaded its agents, such as `truss:stress-engineer`, can't be spawned until restart. Today `start` (`bin/factory/start.ts` `crewState`) reads no agent file, and its output (`stageOut`, `bin/factory/start.ts`) has no key that can carry a notice.
7. **Missing goal file** (approved-scope line 12:15). Today `start` reads `''` for an absent goal file (`bin/factory/start.ts`; `crewEntry` does the same at), so `engineOf` returns `the goal file has no ## Engine section`  and the crew goes to the project manager path.
8. **Stale stress-test references**. Several files point at `agents/qc-engineer.md` "Stress-test mode", a section that is gone. They should point at `agents/stress-engineer.md`.
9. **False env verdicts**. `envFailure` (`bin/factory/check.ts`) tests each trimmed line against `ENV_PATTERNS`  and the `Cannot find package` match anywhere on the line, so a failing test that echoes an env string inside JSON or assert text stops the crew as an env failure.
10. **F-16**. The planning engineer never assigns a report, summary or findings `.md` as a member deliverable.
11. **F-21**. Today `tests-check` guards only the files of `Truss-Role: test-writer` commits (`bin/factory/crew.ts` `cmdTestsCheck`). A file the acceptance test names that a builder added is not guarded.
12. **F-29**. A crew's acceptance proof uses only files from earlier stages or the crew's own owned files.
13. **F-33**. `workflowCallVerdict` reads `args.truss` only when `args` is an object (`register.ts`), so a Truss script whose `args` is a JSON string is refused with "a truss Workflow needs args.truss".
14. **`ui/README.md` example token** (brief section "Start the UI"). A real-looking `?token=` value in the example launch line trips scrub. It becomes a placeholder such as `<token>`.
15. **Members and the acceptance script**. The worktree guard refuses an acceptance script that uses shell variables or multi-line shell. Members run plain single `node --test <files>` commands; the stage's green step runs the acceptance test.

The confirm-against-main list, as plan revision 2 settled it (`plan-plugin-fixes.md`):

| Item | Result |
|---|---|---|
| F-36, the brief skill's constraint example | include, prompts |
| F-42, `hitLines` matching quoted string-literal lines | include, narrow: skip a quoted literal line ending in `,` |
| F-43, the `toolError` quote and `handEdit` paths | include |
| F-44, the checking engineer's report path | include, prompts |
| P-2 | drop: the retro suites pass on main |
| P-3, no fallback when `truss:retro-judge` isn't loaded | include, prompts |
| P-5 | drop: not a bug |
| P-6 | drop: the transcript triage says "Why finish left no file is not shown"; no failing case |
| P-7 | drop: the producer was never traced |
| P-9 | drop: the miss is item 1 |
| item 2 text | drop: the doc already states the rule (`docs/architecture.md` section "Roles and who talks to whom") |

## Decision 1: the factory CLI, `bin/factory.ts` (change)

`start`'s output is a seam ADR-0009 pins, and today it has no key that can carry a non-blocking notice. So this goal changes the CLI, the same way [ADR-0015](0015-resource-aware.md) added `held`.

### `start` gains `warnings`

`start` gains the top-level key `warnings`, an array of strings. It is in:

- the full output;
- the resume output (`start --slug S --resume ...`);
- the `--args-file` pointer, after `unfinished`.

`warnings` holds one warning for each crew starting now whose goal file says `## Stress test` yes, when the stress role's agent file has an mtime later than the session's start. Warnings never hold or refuse a crew. A start with no stress crew warns about nothing.

TODO: plan revision 2 doesn't say which crews count as "starting now" on a `--resume` call; the factory-fixes crew decides and pins it.

**The stress role.** `start` reads the stress role from `roles.json` `stress.agentType`, which is `truss:stress-engineer` (`workflows/roles.json`). Its agent file is the plugin's `agents/stress-engineer.md`. Today `readRoles` reads `<plugin>/workflows/roles.json` (`bin/factory/shared.ts`).

**The session start.** `start` reads the session's start time this way:

1. `TRUSS_SESSION_START`, when set, in milliseconds since the epoch. It is a test override: nothing sets it in a real session.
2. Otherwise, the start time of the `CLAUDE_PID` process: field 22 of `/proc/<CLAUDE_PID>/stat` (`starttime`, in clock ticks since boot) divided by the tick rate (`CLK_TCK`), plus `btime` from `/proc/stat`.
3. It is never the `/proc/<pid>` inode mtime, and never the transcript's first record: `--continue` appends to the old transcript, so its first record is older than the process that loaded the agents.

   **Amendment, 2026-11-14, release 0.32.0 (crew deferred-fixes, PM rulings 01:52 and 02:03).** The start now comes first from `<truss dir>/session-start.json`. The main session's `classic.SessionStart` hook (`hooks/register.ts`) writes that record whole on the `startup`, `resume`, `clear` and `fork` sources, and never on `compact`. The record is `{"v":1,"ts":<ISO UTC>,"source":<source>,"session":<session id>}`. `factory start --dir D` measures from D's record when it parses with `v` 1 and a finite `ts` (`bin/factory/warnings.ts` `recordSessionStart`). Otherwise it falls back to the first timestamped record of the `--transcript` session's main transcript, and then to the `CLAUDE_PID` process start. `TRUSS_SESSION_START` still wins over all three.

   The reason is that the command's own process is the wrong clock. A `factory start` run from a Workflow or another shell reads a `CLAUDE_PID` that can be later or earlier than the session that loaded the agents, so it hid real changes and raised false warnings. The transcript alone is not a fix either. A `--continue` session's transcript starts hours before the process that resumed it, as this item said, and a fresh session's first timestamped record can come later than the process start, which hides a file changed in between. The hook fires when the session's agents load: a new process, a resume, and a `/clear` or fork, which start a new session id and reload them. A compact keeps the session and its agents, so it does not move the start. The record sits in the session's own truss dir, which is named by the session id, so a record never belongs to another session. The original rule above stays as the record of why the transcript was refused as the only source.
4. When neither source can be read, as on a host with no `/proc` or a session with no `CLAUDE_PID`, the warning says it "can't tell". `start` never stays silent then.

A crew whose source can be read gets either no warning or a definite one.

The plan's proof (`plan-plugin-fixes.md`), re-run for this ADR in this session:

```
$ printenv CLAUDE_PID
2829804
$ getconf CLK_TCK
100
$ node <scratchpad>/start.mjs   # a scratch script: /proc/$CLAUDE_PID/stat field 22, and btime from /proc/stat
{"pid":"2829804","starttime":68664743,"btime":1792722936,"start":"2026-10-31T01:19:43.430Z",...}
```

That is the instant `ps` showed for `claude --continue --plugin-dir <plugin dir>` in the plan's probe. The transcript's first record was `2026-10-30T20:08:12.992Z`, five hours earlier. The 14:29 PM probe showed the PM's own Bash carries `CLAUDE_PID=2829804`, which closed the one point the plan left unproved.

### Missing goal file

A crew whose `<truss dir>/goals/<slug>.md` doesn't exist goes in `refused`, with a reason that names that path and says the goal file is missing. It gets no worktree, is not under `projectManagers`, and its status stays `planned`. The rest of the reason's wording is the factory-fixes crew's.

### `envFailure` skips quoted echoes

An `ENV_PATTERNS` match, or a `Cannot find package` match, counts only when no `"`, `'` or backtick comes before it on the trimmed line.

The YAML `error:` key is the exception. A leading `error:` key and its one opening quote don't count, so TAP's `error: "<msg>"` still counts. On node v24.22.0, `node --test --test-reporter=tap` prints:

- a one-line error quoted, as `error: "browserType.launch: ..."` or `error: '...'`;
- a multi-line error as an `error: |-` block, whose message lines are not quoted.

A rule of "no quote before the match" alone would miss the quoted one-line form (`plan-plugin-fixes.md`). These still count: a TAP `error: |-` block line, a TAP single-line `error: "browserType.launch: ..."`, a real loader line and a real Playwright line.

### `tests-check` guards the acceptance files

The guarded files are the test-writer files plus every existing repo-relative path that the crew's `acceptanceTest` names. A builder or resolver commit that touches one fails `tests-check`, whoever added the file.

## Decision 2: the hooks, `hooks/register.ts` (extend)

- **Item 1, `designerResumeVerdict`.** One more `[truss] Refused:` verdict in the existing SendMessage gate's main-session branch (`register.ts` the `tool.call` handler for `SendMessage`). It uses `recipientsOf` (`register.ts`) and `state.planDesigners`, so it refuses a resume of a plan-mode or an amend-mode design engineer.
- **Item 2, `MAIN_MODEL_REFUSAL`.** The text names no model, to match `mainCallVerdict`, which accepts any non-empty model.
- **Item 13, `workflowCallVerdict`.** A JSON-string `args` is parsed before the existing checks run.

The exact signatures and rules are in "Seams to pin".

## Decision 3: retro, `retro/extract.ts`, `retro/cli.ts`, `retro/scrub.ts` (extend)

Narrower matches inside existing functions; the extract schema is unchanged (`plan-plugin-fixes.md`):

- F-42: `hitLines` skips a line that is a quoted string literal ending in `,`.
- F-43: the line after `Exit code N` joins the quote, and `handEdit` leaves out scratchpad and memory paths. Today it leaves out only paths holding `/.git/truss/` (`retro/extract.ts` `extractSession`).
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
| `MAIN_MODEL_REFUSAL` | `hooks/register.ts` | Names no model: it does not match `/opus\|sonnet/i`, and it says `model` must be set. `mainCallVerdict` accepts any non-empty model. The pins in `tests/contract-gates.test.ts` (test "section 9: reasons and refusals are the ADR strings", `mainModelRefusal`) and in ADR-0004 (`REPORT`) carry the new text exactly. |
| `workflowCallVerdict` | `hooks/register.ts` | A JSON-string `args` gets the same verdict as the parsed object, and an unparsable string is refused. |
| `factory start` output | `bin/factory.ts` | Gains the key `warnings` (array of strings) in the full output, in the resume output and in the `--args-file` pointer (after `unfinished`), by the rule in Decision 1. The factory contract has a `pf` case for a start with no `TRUSS_SESSION_START`. Warnings never hold or refuse a crew. |
| `factory start`, missing goal file | `bin/factory.ts` | A crew whose `<truss dir>/goals/<slug>.md` doesn't exist goes in `refused`, with a reason that names that path and says it is missing. It gets no worktree and is not under `projectManagers`, and its status stays `planned`. |
| `envFailure` | `bin/factory.ts` | An `ENV_PATTERNS` match, or a `Cannot find package` match, counts only when no `"`, `'` or backtick comes before it on the trimmed line. A leading YAML `error:` key and its one opening quote don't count, so TAP's `error: "<msg>"` still counts. Controls: a TAP `error: \|-` block line, a TAP single-line `error: "browserType.launch: ..."`, a real loader line and a real Playwright line all still count. |
| `factory tests-check` | `bin/factory.ts` | By "Amendment: tests-guard-fix": the guarded files are the test-writer files plus every existing repo-relative path the crew's `acceptanceTest` names that matches a test-file pattern. It reads `git log --cc --name-status -M`. A builder or resolver pure rename (`R100`) of a guarded file is no touch, and the guard follows the new path; a rename below `R100`, a later edit at the new path and a delete of a guarded path are touches. The output shape is unchanged. |

The factory-fixes crew also updates the two existing key pins: `OUTPUT_KEYS` in `tests/fixtures/workflow-run/start.cases.ts` and the pointer keys in `tests/factory-resources.check.ts` test "start --args-file short output carries held, after crews".

## Documents this ADR amends

- [ADR-0009](0009-workflow-factory.md), Decision 1: `start` gains `warnings` in its output and its `--args-file` pointer, and refuses a crew whose goal file is missing.
- [ADR-0004](0004-scope-repair-and-head-gates.md) :204: the `MAIN_MODEL_REFUSAL` text, changed by the hooks-fixes crew.
- `docs/architecture.md`: the ADR-0016 link and the Hooks section note.

## Consequences

- The PM learns before a stage, not at it, that a stress crew needs a role the session hasn't loaded. On a host with no `/proc`, or with no `CLAUDE_PID`, it gets a "can't tell" warning instead.
- A PM can no longer resume a design engineer by SendMessage; it starts a fresh one under the next unused name.
- A failing test that echoes an env string in quotes no longer stops a crew as an env failure. A real env failure in TAP output still does.
- A crew whose acceptance test names a builder's test file can no longer pass `tests-check` after a builder edits that file. Which named files count as test files, and how renames count, is set by "Amendment: tests-guard-fix" below.

## Amendment: tests-guard-fix

Written by the design crew `guard-design` (stage 0 of goal `tests-guard-fix`), at main df3dbba. It records the new `factory tests-check` guard rule that the build crew `tests-guard` (stage 1) builds. Where it differs from the sections above, the amendment wins. Every line number below is at df3dbba.

Decided by: checker-32's answer of 20:34 (`decisions.md`, followed), the client's standing ruling "Don't just log a plugin bug, fix it", and checker-35's delete control of 21:03, as plan revision 3 (`plan-tests-guard-fix.md`) settles them.

### Why the rule changes

Two gaps showed in goal `plugin-move` (`decisions.md`):

- The rule in "`tests-check` guards the acceptance files" (Decision 1) guards every existing path the `acceptanceTest` names. It can't tell a test file from a deliverable the test only inspects, with `cmp` or `grep`, so a builder commit to such a deliverable is refused.
- `cmdTestsCheck` reads `git log --cc --name-only` (`bin/factory/crew.ts`), which has no rename detection and shows only a rename's new path. Builder commit 77f5f09 renamed two test-writer files and edited them in the same commit (99% renames), and `tests-check` did not list it.

### The rule

1. **Guarded files.** The guarded files are:
   - every file a `Truss-Role: test-writer` commit in `<base>..HEAD` touched, whatever its name;
   - every existing repo-relative path the crew's `acceptanceTest` names that matches a test-file pattern below.

   A named path that matches no pattern is not guarded.
2. **Test-file patterns.** A path matches when its basename matches one of:
   - `.(test|spec|check).[cm]?[jt]sx?`, as a suffix (for example `a.spec.ts`, `b.test.mjs`, `c.check.tsx`);
   - `test_*.py`;
   - `*_test.py` or `*_test.go`;
   - `conftest.py`, exactly;

   or when one of its directory segments is `tests/`, `test/`, `__tests__/`, `spec/`, `checks/`, `e2e/` or `fixtures/`. A segment is a whole directory name, so `src/testdata/x.txt` does not match; nor do `latest.py`, `contest.py` or `a.spec.md`.
3. **Rename detection.** `tests-check` reads `git log --cc --name-status -M <base>..HEAD`, oldest commit first. A merge still counts only for the files its resolution changed (`--cc`).
4. **Pure rename.** A builder or resolver rename of a guarded file with similarity 100 (`R100`, as `git mv` gives) is no touch. The guard follows the new path: the new path is guarded from then on.
5. **Rename with an edit.** A builder or resolver rename of a guarded file below `R100` (any edit, such as 77f5f09's) is a touch.
6. **Later edit.** A later builder or resolver edit (`M`) at the new path of a renamed guarded file is a touch. This holds for a renamed test-writer file and for a renamed `acceptanceTest`-named file alike.
7. **Delete.** A builder or resolver delete (`D`) of a guarded path is a touch, as it is today under `--name-only`.
8. **Output.** The output shape does not change: `{"ok":true,"tests":[...]}`, or `{"ok":false,"touched":[{commit,role,files}],"tests":[...]}` with exit 1.

### What this supersedes

- **ADR-0016:102-104**, "`tests-check` guards the acceptance files" (Decision 1). Its rule, "the test-writer files plus every existing repo-relative path that the crew's `acceptanceTest` names", is replaced by rules 1 to 7 above: a named path is guarded only when it matches a test-file pattern, and renames count by rules 4 to 6. The seam row for `factory tests-check` in "Seams to pin" now states this rule.
- **ADR-0009:279**, the "Tests guard" prose under Decision 4 step 6. Its rule, that the acceptance-test files are the files a `Truss-Role: test-writer` commit touched, read with `git log --cc` and no rename detection, is replaced by rules 1 to 8 above. Its other rules stand: a merge counts only for the files its resolution changed, a touch stops the crew `BLOCKED:` at `tests`, and no fix builder runs. ADR-0009:279 and the `tests-check` row of ADR-0009 Decision 1 now point here.

The Context item 11 (F-21) stays as the history of the earlier fix.

### The QC engineer's step 8

`agents/qc-engineer.md` step 8 (section "How to QC engineer") states the same pure-rename rule: a pure rename (`R100`) of an acceptance-test file is no touch and the guard follows the new path, and a rename with any edit is a touch, so it is a FAIL for a builder or resolver. Crew `tests-guard` writes that sentence.

### Pins

The five pins `tg 1:` to `tg 5:` live in `tests/factory-fixes.check.ts`, next to `ff 9` and `ff 10`, as plan revision 3 places them. checker-32's answer named `tests/factory.check.ts`; the plan moved them next to the existing tests-check pins. Crew `tests-guard`'s test-writer writes them:

1. `tg 1`: a builder commit to a non-test file the `acceptanceTest` inspects with `cmp` passes (exit 0, `ok` true).
2. `tg 2`: a builder commit to a named `tests/*.check.ts` refuses (exit 1, `touched` names it).
3. `tg 3`: a builder pure rename (`git mv`, `R100`) of a test-writer file passes.
4. `tg 4`: a later builder edit at the renamed path refuses, naming the new path.
5. `tg 5`: a builder rename with an edit of a test-writer file refuses (the 77f5f09 shape).

On the base `bin/factory.ts`, `tg 1`, `tg 4` and `tg 5` fail and `tg 2` and `tg 3` hold. `ff 9` and `ff 10` keep passing.

### Known limit

This is a known limit, recorded and not fixed: a script the acceptance test runs whose name matches no pattern (for example `bash scripts/verify.sh`) loses its `tests-check` guard unless a test-writer commit wrote it. A builder can edit such a script and pass `tests-check`. QC step 8 still reads the history, so the QC engineer checks such scripts by hand.
