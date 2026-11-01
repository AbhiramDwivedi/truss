# ADR-0004: scope-bounded claims, a bounded repair loop, a patch-bound head guard, and the hooks' half of the effort ladder

Status: accepted, 2026-10-28
Accepted on the client's approval of the foundry run-3 plan (`plan.json` `approvedAt` 2026-10-28T00:31:42Z). Proposed by run 3's design crew (stage 0), for foundry 0.5.0. The effort-ladder principle itself (who runs at which effort) is recorded in the repo's [ADR-0011](claude-ops/0011-agents-pin-their-model.md) amendment; this ADR records what Truss's hooks, prompts and retro do about it.

Amended 2026-10-28 by repo [ADR-0015](claude-ops/0015-agent-worktree-cleanup.md), item 11, accepted with the run-4 plan (`approvedAt` 2026-10-28T15:11:50Z), for foundry 0.6.0: foremen merge the target into the crew branch instead of rebasing, so `<base>` (section 6) is the target head last merged in, and the patch-id carry applies across that merge. The passages that said "rebase" now say so; the context below still describes 0.4.3 as it was.

## Context

Run 3's goal items 2, 3 and 7 (`plan.json` `goal`) need four things foundry 0.4.3 can't express:

- **Scope.** A foreman's report says what was checked, but nothing says what wasn't. A claim like "no other caller" or "every call site updated" passes the QC engineer with no record of where anyone looked.
- **A bounded repair loop.** After a QC engineer FAIL the foreman starts `<crew>-qc-2`, `-3` and so on with no limit (`agents/foreman.md:101-105`). Nothing stops a crew from looping, and nothing records that it ran out of tries.
- **The head a PASS belongs to.** The QC engineer states the SHA it ruled on somewhere in free text under `## Proof checked` (`agents/qc-engineer.md:72`, `agents/foreman.md:103`). No hook can read it. The PM (project manager) compares it by eye (`skills/run/SKILL.md:281`, `:288`). After a rebase the head always moves, so every rebase needs a fresh QC engineer (`agents/foreman.md:155`), even when the crew's change is byte-for-byte the same.
- **Calls with no model or effort from the main session.** `agentVerdict` and `effortVerdict` (`hooks/register.ts:232`, `:243`) return early outside a crew, so the design engineer, checking engineer, foreman and integration QC engineer the PM starts get their frontmatter's effort unless the call sets one.

The interfaces that can't take the work:

- `plan.schema.json` is closed (`additionalProperties: false`) and pins `version` to `const: 1` (`:18-20`), so a plan can't carry a rework allowance.
- The QC engineer's report has no fixed line a hook can parse for the head or the patch, which breaks repo P23 for any code that would read them.
- The foreman's report format (`agents/foreman.md:158-185`) and the foreman stop gate (`foremanStopPasses`, `register.ts:373`) know only the six sections.
- `.claude/truss.json` has no key for the allowance (`truss-config.schema.json`).
- retro's top-level and per-run keys are a pinned contract (`tests/test_contract_retro.py:23-24`), and it has no count of spent allowances.

There's also a fact about run scope. In this repo's session dir `40816bb1`, `reports/design/` holds `design-judge.md` to `design-judge-7.md`, and `reports/protocol/` holds `protocol-judge.md` to `-4.md`, all from earlier runs that used the same crew names (`ls` of that dir, 2026-10-27). Counting a crew's QC files by name alone would start run 3's `design` and `protocol` crews with their budgets already spent. "The highest-numbered QC file" would also name a stale file. ADR-0003 flagged this as open.

## Decision

### 1. Plan v2

`plan.schema.json` describes versions 1 and 2. A v1 plan is still valid, and the edeb6ef `plan.example.json` is valid byte for byte.

- `title` becomes `truss plan.json, versions 1 and 2`.
- `version` becomes `{"enum": [1, 2]}`. Its description: the plan file format version; it goes up whenever a field is added; readers gate on `version >= 2`, never `=== 2`, so a later version inherits every v2 rule.
- New top-level property `reworkAllowance`: `{"type": "integer", "minimum": 0}`. It is how many fresh QC engineers a crew may start after QC engineer FAILs in this run (section 5). The design engineer copies it from `.claude/truss.json` `reworkAllowance`, or writes 2 when the key is absent.
- `required` is unchanged: it still lists v1's eight keys. Two `allOf` entries are added:
  - `if {"properties": {"version": {"const": 2}}, "required": ["version"]} then {"required": ["reworkAllowance"]}`;
  - `if {"properties": {"version": {"const": 1}}, "required": ["version"]} then {"not": {"required": ["reworkAllowance"]}}`.
- **No per-crew override.** Nothing in this run sets different allowances per crew, so a crew field would have no caller (repo P11). The allowance is the same for every crew. A per-crew allowance, like readiness, waits for a later version.
- From 0.5.0 the design engineer writes `version: 2` with `reworkAllowance`. `plan.example.json` becomes a v2 plan with `"reworkAllowance": 2`. `tests/fixtures/contract-050/plan-v1.json` is a byte copy of `git show edeb6ef:docs/plan.example.json`.

**What the hooks read.** `Plan` (`register.ts:250`) gains two fields, `version: unknown` and `reworkAllowance: unknown`. `parsePlan` copies both unchecked from the parsed object, as it does the other fields. It accepts every value of `version`, missing included: v1, v2, v3 or a string. Every rule this ADR adds asks `planAtLeastV2` first (section 8). That helper is true only when `version` is an integer of 2 or more, so it holds for v3 plans, and v1 plans, plans with no version and plans with a non-integer version fail open to 0.4.3 behaviour. The 0.3.0 plan gates don't look at `version` at all.

### 2. `.claude/truss.json` gains `reworkAllowance`

`truss-config.schema.json` gets the property `reworkAllowance`: `{"type": "integer", "minimum": 0}`, with the description `How many fresh qcs a crew may start after qc FAILs in one run, copied into a v2 plan.json. Default 2.` The schema states defaults in descriptions, as it did for `agentCap` (retired in 0.7.0, see ADR-0001). The default is 2; it is written by the client, or by `truss:init` on approval, which proposes it with the 0.4.0 keys. A rejected value is reported and unset, as ADR-0002 rules for every key, so the design engineer falls back to 2.

### 3. The literals

Each literal below is written once, here. The prompts (`agents/qc-engineer.md`, `agents/foreman.md`, `skills/run/SKILL.md`) and the hooks use exactly these strings. `tests/gates.check.ts` asserts the prompts carry them, and `tests/contract-gates.test.ts` asserts the hooks' constants equal them. The constant name is the export from `hooks/register.ts`.

| Constant | Literal | Who writes it, and where |
| --- | --- | --- |
| `HEAD_LINE` | `Head: ` | The QC engineer, under `## Proof checked`: one line, the literal and then the 40 lowercase hex digits of `git rev-parse <crew branch>` at the head it ruled on. |
| `PATCH_LINE` | `Patch: ` | The QC engineer, under `## Proof checked`: one line, the literal and then the first field (40 lowercase hex digits) that `PATCH_COMMAND` prints. |
| `EXAMINED` | `## Examined` | The foreman, as a heading of its final report: what the crew checked, each item with its scope. |
| `NOT_EXAMINED` | `## Not examined` | The foreman, as a heading of its final report: what nobody checked, or `None.` |
| `UNSCOPED` | `- UNSCOPED: ` | The QC engineer, as a line under `## Findings`: an absence or completeness claim that states no scope. |
| `ALLOWANCE_BLOCKED` | `BLOCKED: rework allowance spent` | The foreman: the start of its message to `main` (and of its report) when the crew's allowance is spent. It starts with `BLOCKED:`, so the 0.4.0 tag rules apply to it unchanged. |
| `ALLOWANCE_SPENT_EVENT` | `allowance-spent` | The hooks: the `event` value of the `events.jsonl` line that records a spent allowance (section 5). retro counts these lines. |

`PATCH_COMMAND`, the one command both the QC engineer and the hooks use to compute a patch id:

```
git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable
```

`<base>` is the commit the crew's change is measured from: the target head last merged in: the base commit in the foreman's brief until the foreman first runs `git merge <target>` into the crew branch, then the target head of its latest such merge (amended 2026-10-28 by repo [ADR-0015](claude-ops/0015-agent-worktree-cleanup.md), item 11: foremen merge the target in and never rebase). Because the crew branch then contains `<base>`, `<base>...<head>` is the crew's net change on top of the target. The flags pin the diff text against the user's git config (colour, external diff tools, rename detection, `diff.noprefix`), so the QC engineer's shell and the hook's argv produce the same id. Each line is matched in full: the literal at column 0, then exactly 40 characters of `[0-9a-f]`, then nothing but spaces or tabs. A QC engineer that writes uppercase hex, a short SHA or a 64-digit SHA-256 id gets no match (section 6 says what follows).

### 4. Scope-bounded claims

- **Foreman.** On a v2 or later plan, the foreman's final report has two more sections, `EXAMINED` and `NOT_EXAMINED`, after `## Checks run` and before `## Open questions`. Under the first, each line is `- <what>: <scope>`, where the scope names the paths or globs and the command or search that covered it (for example `` - callers of planVerdict: `grep -rn planVerdict plugins/` ``). Under the second goes what no one checked, or `None.`.
- **QC engineer.** Every claim of absence or completeness ("no other caller", "all call sites updated", "nothing else reads it") in the foreman's report or a member's proof must state its scope, inside `EXAMINED` or beside the claim. One that doesn't gets a finding line made of `UNSCOPED`, then the claim and where it appears, and the verdict is FAIL. A PASS that carries such a finding is inconsistent, and the head guard (section 6) treats it as no PASS.
- **Hook: yes, the foreman stop gate checks both headings.** On a v2 or later plan, a foreman's untagged stop text that would pass by its `## Proof` section is sent back unless it has both headings. A heading counts only at the start of a line, matched in full: the literal, then nothing but spaces or tabs. The gate checks that the headings are present, not their content or order. Tagged stops (`CHECKPOINT:`, `BLOCKED:`, `QUESTION:`, `PROPOSAL:`) are exempt, as before.

### 5. The bounded repair loop

**What the allowance counts.** `reworkAllowance` is the number of fresh QC engineers a crew may start after QC engineer FAILs. A crew's FAIL count is the number of its **this-run QC files** whose first non-empty line starts `VERDICT: FAIL` (`qcRuling`, which strips a BOM and `\r` and then applies `markerOf`). A this-run QC file is one that meets all of these:

- it sits in `reports/<crew>/`, where `<crew>` is the hooks' crew name (the foreman's name, so a successor `auth-2` has its own folder and its own count);
- it is a QC file by `isQcFile` and isn't an interim file;
- its modification time is at or after the plan's `approvedAt` (`runStart`).

The time filter is what keeps the stale files from earlier runs (see Context) out of the count. Stress-test files (`<crew>-stress*`) never count.

The allowance is **spent** when the FAIL count is greater than `reworkAllowance`. With the default of 2: a FAIL, then `-qc-2` FAILs, then `-qc-3` may still start (2 FAILs, allowance 2); if it FAILs too, the allowance is spent. With 0, the first FAIL spends it. Run 3's own "one fresh QC engineer, then BLOCKED" corresponds to 1.

**The spawn gate.** On a v2 or later plan with a valid allowance, an `Agent` call from inside a crew whose `name` is a QC engineer name of the caller's crew (`isQcName`) is refused once the allowance is spent. A refused call appends no `spawn` line, as with every refusal (ADR-0003). A QC engineer started without a name isn't gated: its report lands on an id-named file, which is never a merge-gate file. A spent allowance never moves anyone up an effort level (ADR-0011 amendment).

**The spent-allowance record.** It is written in two places, and has two literals:

1. **events.jsonl, by the hooks.** When a QC engineer report is saved for a crew (`writeReport`, after its `report` line), on a v2 or later plan with a valid allowance, the hooks recount. If the report's marker is `VERDICT: FAIL` and the crew's FAIL count after the write leaves the allowance spent, they append one line:

   ```
   {"v": 1, "ts": "<ISO time>", "event": "<ALLOWANCE_SPENT_EVENT>", "crew": "<crew>", "agent": "<that QC engineer's spawn name>"}
   ```

   The line carries those five keys and no others. `v` stays 1, because ADR-0003 bumps `v` only for a renamed or retyped field, and this is a new event kind. `events.schema.json` adds the value to `event`'s enum, with an `if`/`then` branch whose `additionalProperties: false` allows only the five keys. A crew may get the line more than once: a later FAIL past the allowance, or the same report saved twice, would add another. Readers count distinct crews, not lines. A failed append behaves as in ADR-0003, section 1.
2. **The foreman's message to main.** Once the QC engineer's FAIL report leaves the allowance spent, the foreman starts no more QC engineers. It sends `main` a message that starts with `ALLOWANCE_BLOCKED`, followed by `: <crew>, <n> qc FAILs, reworkAllowance <b>`, then the last QC engineer's findings, and stops with the same text. The PM takes it to the client or re-plans (a successor foreman starts a fresh count, and the PM logs that decision). It never raises the QC engineer's effort to get past the limit.

retro counts only the events line (section 7), because events lines hold no report text (repo P8).

### 6. The head guard and a patch-bound PASS

**The QC engineer** writes `HEAD_LINE` and `PATCH_LINE` under `## Proof checked`, first in that section, on every ruling, in every merge mode, the integration QC engineer's included. `<base>` for `PATCH_COMMAND` comes from the foreman's brief. With an empty diff, `git patch-id` prints nothing, so there is no patch line, and the guard treats the ruling as having no head lines.

**The foreman's Branch line.** The first non-empty line under `## Branch` keeps the 0.4.3 form, `<crew branch> at <commit>, based on <base commit>.`. Each of the three may be wrapped in single backticks. `<base commit>` is the target head last merged in: the brief's base until the foreman first merges the target into the crew branch, then the target head of its latest `git merge <target>` (repo ADR-0015, item 11; it was "the target head the branch was rebased onto" before foremen stopped rebasing). `branchOf` reads the branch and the base from it. Neither may start with `-`, so neither can reach git as an option.

**The guard**, in the foreman stop gate, applies on a v2 or later plan to an untagged stop text that would pass by its `## Proof` section and has both of section 4's headings. It reads the crew's **latest this-run QC file** (`latestQc`: the newest modification time at or after `runStart`, ties going to the higher `-qc-<k>`) and parses it with `qcRuling`. When `branchOf` reads the foreman's Branch line, the hook runs, with `cwd` the session's working directory and `timeoutMs: 15_000` on each call:

- `git rev-parse --verify --quiet <branch>^{commit}` to get the head;
- only when that head differs from the QC engineer's `HEAD_LINE` value, the two halves of `PATCH_COMMAND` with `<head>` set to `<branch>`: `git diff …` with its stdout passed as `stdin` to `git patch-id --stable`, with `patchIdOf` taking the id.

A non-zero exit, a timeout or an unparsable output gives `undefined`. The verdict is `headVerdict`:

| Case | Result |
| --- | --- |
| no this-run QC file, its verdict isn't PASS, or it carries an `UNSCOPED` finding | sent back with `NO_PASS_REASON` |
| PASS without both a head line and a patch line | sent back with `NO_HEAD_REASON` |
| head unknown (no Branch line, or git failed) | goes through (fail open) |
| head equals the judged head | goes through |
| head moved, patch id unknown | goes through (fail open) |
| head moved, patch id equals the judged patch | goes through: the PASS survives the merge of the target |
| head moved, patch id differs | sent back with `headMovedReason(judged head, head)` |

These send-backs count in the same streak as `FOREMAN_STOP_REASON`, so after `FOREMAN_STOP_BLOCKS` (2) in a row the next stop goes through, as in 0.4.3. An unanswered tag doesn't excuse them: the text is a final report, not a question. If reading the QC engineer folder throws, or anything else in the step does, the step is skipped and the stop goes through (`safely`).

**A patch-bound PASS across a merge of the target.** (Amended 2026-10-28 by repo ADR-0015, item 11: foremen make a branch ready with `git merge <target>` into the crew branch, a real merge, never a rebase or cherry-pick, and the PM still runs `git merge --ff-only`.) The patch-id carry stays. The QC engineer's `PATCH_LINE` is computed with `<base>` from the Branch line it was given; after the foreman merges the target in, the Branch line's `<base>` is the new target head, and `PATCH_COMMAND` measures the crew's net change against it. A merge that touched none of the crew's hunks gives the same id. A PASS stands for the merged head when `PATCH_COMMAND` gives the same id the QC engineer wrote, and the checks from the brief pass again on the merged head, listed under `## Checks run`. Then no fresh QC engineer is needed. Otherwise the merged head needs a fresh QC engineer, as in 0.4.3. The hook can see the patch id but can't run checks, so the foreman (section 12 of its prompt) and the PM's merge gate both require the re-run. **The PM's merge gate** (`skills/run/SKILL.md`, merge section) uses the same file and the same rule. The file is the crew's newest QC file modified at or after `approvedAt`, which replaces "highest-numbered" and closes ADR-0003's open item for the gate. The ruling must be a PASS with no `UNSCOPED` line. Its `HEAD_LINE` value must equal `git rev-parse <crew branch>`, or its `PATCH_LINE` value must equal `PATCH_COMMAND`'s id with the foreman's checks re-run green after the merge of the target.

**The hand-back path.** A foreman's hand-back is saved as its report only if it passes `foremanStopPasses` and `examinedVerdict`. The head guard runs only in the stop gate, since it calls git. A hand-back the guard then sends back stays in the report file until the foreman's next stop overwrites it.

### 7. The hooks' half of the effort ladder

On a v2 or later plan, an `Agent` call from the main session (`callerId` undefined) whose `subagent_type` starts with `truss:` is refused when it sets no `model` (`MAIN_MODEL_REFUSAL`), or when `effort` isn't one of `low`, `medium`, `high`, `xhigh` (`MAIN_EFFORT_REFUSAL`; `max` included). The model check runs first. This check runs before the plan gates. With no Truss dir or no `plan.json` (the plan-mode design engineer starts before one exists, and so does init's design engineer), the call goes through, as with every v2 rule. Inside a crew, `agentVerdict` and `effortVerdict` are unchanged. The hooks don't refuse `high` or `xhigh` anywhere, because they can't see whether the client asked for it. That stays a prompt rule (ADR-0011 amendment), and retro measures it (section 8).

### 8. retro

- **`allowancesSpent`**, a new **per-run** key in `runs[]`, after `qcs`. Its value is the number of distinct `crew` values among the run's spent-allowance events (section 5), assigned to runs by `ts` like every other event. It is `"not recorded"` when the run's event-derived categories are `"not recorded"` (no `## Run` heading, or no `events*.jsonl`), and also when the run has no such line. A 0.4.x log and a 0.5.0 run that spent no allowance look the same in the log, so retro never claims a zero the log can't back up. It is never 0.
- **`retro` stays 1.** Adding a key isn't a rename or a retype; the same rule as events' `v`.
- **Event lines.** Spawn lines gain no keys. They stay `agent, agentId, by, crew, effort, event, model, ts, type, v` (`tests/events.test.ts:67`). The only new line is section 5's, with the keys `agent, crew, event, ts, v`.
- **Target share.** The retro skill computes the share of the run's spawns that ran on Opus at `high` or `xhigh`. The numerator is the sum of the `byModelEffort` counts whose model part contains `opus` (case-folded) and whose effort part is `high` or `xhigh`. The denominator is `spawns.total`. The target is 0, unless a decision line in `decisions.md` records the client's call for `high` or `xhigh`. The skill reports any other non-zero share as over target. retro's output gains no key for it.

### 9. Exported functions and constants

All are exported from `hooks/register.ts` and are pure: no I/O and no clock. The handlers do the reads, then call them. `tests/contract-gates.test.ts` imports these names; they are binding.

```ts
export type QcFile = { name: string; text: string; mtimeMs: number }
export type QcRuling = { verdict: 'PASS' | 'FAIL' | undefined; head: string | undefined; patch: string | undefined; unscoped: number }

// true when plan.version is an integer >= 2; false for undefined, v1, missing or non-integer versions
export function planAtLeastV2(plan: Plan | undefined): boolean
// plan.reworkAllowance when planAtLeastV2 and it is an integer >= 0; else undefined (no allowance rule)
export function reworkAllowanceOf(plan: Plan | undefined): number | undefined
// Date.parse(plan.approvedAt) when it is a string that parses to a finite number; else undefined
export function runStart(plan: Plan | undefined): number | undefined
// name is a non-empty string and isQcFile(crew, `${safeName(name)}.md`)
export function isQcName(crew: string, name: unknown): boolean
// files with isQcFile(crew, f.name), !isInterimFile(f.name), f.mtimeMs >= since, qcRuling(f.text).verdict === 'FAIL'
export function qcFails(crew: string, files: readonly QcFile[], since: number): number
// among files with isQcFile, not interim, mtimeMs >= since: the greatest mtimeMs, ties to the higher -qc-<k> (bare = 1)
export function latestQc(crew: string, files: readonly QcFile[], since: number): QcFile | undefined
// reworkAllowanceOf(plan) !== undefined && fails > reworkAllowanceOf(plan)
export function allowanceSpent(plan: Plan | undefined, fails: number): boolean
// { deny: allowanceRefusal(crew, fails, allowance) } when isQcName(crew, name) && allowanceSpent(plan, fails); else undefined
export function qcAllowanceVerdict(plan: Plan | undefined, crew: string, name: unknown, fails: number): { deny: string } | undefined
export function allowanceRefusal(crew: string, fails: number, allowance: number): string
// BOM and \r stripped. verdict from markerOf; head and patch: the first full-line match of HEAD_LINE / PATCH_LINE
// (section 3) between the "## Proof checked" line and the next line starting "## "; unscoped: lines starting
// UNSCOPED between the "## Findings" line and the next line starting "## "
export function qcRuling(text: string): QcRuling
// the first whitespace-separated field of the first line when it is 40 [0-9a-f]; else undefined
export function patchIdOf(stdout: string): string | undefined
// the first non-empty line under "## Branch", as section 6 reads it; undefined when it doesn't match
export function branchOf(report: string): { branch: string; base: string } | undefined
// { block: EXAMINED_REASON } on a v>=2 plan when the untagged text lacks either heading (section 4); else undefined
export function examinedVerdict(plan: Plan | undefined, text: string): { block: string } | undefined
// section 6's table; undefined (goes through) whenever !planAtLeastV2(plan)
export function headVerdict(plan: Plan | undefined, qc: QcRuling | undefined, head: string | undefined, patch: string | undefined): { block: string } | undefined
export function headMovedReason(judged: string, head: string): string
// section 7; undefined unless planAtLeastV2(plan), callerId === undefined and type is a string starting "truss:"
export function mainCallVerdict(plan: Plan | undefined, callerId: string | undefined, type: unknown, model: unknown, effort: unknown): { deny: string } | undefined
```

In `qcRuling`, a section heading line is matched after trailing spaces and tabs are trimmed. `examinedVerdict`'s untagged test is the same as `foremanStopPasses`'s tag list: the trimmed text starts with none of `CHECKPOINT:`, `BLOCKED:`, `QUESTION:`, `PROPOSAL:`. `branchOf`'s pattern, applied to the trimmed line:

```
^`?([^\s`-][^\s`]*)`? at `?[0-9a-f]{7,40}`?, based on `?([^\s`-][^\s`]*?)`?\.?$
```

The reasons and refusals. Constants are exact strings; functions are templates over the constants and their arguments:

```ts
export const PATCH_COMMAND = 'git diff --no-color --no-ext-diff --no-renames --src-prefix=a/ --dst-prefix=b/ <base>...<head> | git patch-id --stable'
export const ALLOWANCE_REFUSAL = `${MARK} Refused: rework allowance spent:`
// allowanceRefusal(crew, fails, allowance) =
//   `${ALLOWANCE_REFUSAL} ${crew} has ${fails} QC FAILs this run and reworkAllowance is ${allowance}. Start no more QCs: send main a message that starts with "${ALLOWANCE_BLOCKED}", with the last QC's findings.`
export const NO_PASS_REASON = `${MARK} Not done yet: the crew's latest QC file this run is not a clean VERDICT: PASS. Send your final report only after a QC's PASS with no UNSCOPED finding, or start your final message with BLOCKED: or CHECKPOINT:.`
export const NO_HEAD_REASON = `${MARK} Not done yet: the crew's latest QC PASS has no "${HEAD_LINE.trim()}" and "${PATCH_LINE.trim()}" lines under ## Proof checked, so no hook can tell which head it ruled on. Start a fresh QC under the next unused name.`
export const HEAD_MOVED = `${MARK} Not done yet: the head moved:`
// headMovedReason(judged, head) =
//   `${HEAD_MOVED} the QC ruled on ${judged}, the branch is at ${head}, and its patch id differs. Start a fresh QC under the next unused name on ${head}, and send your final report on its PASS.`
export const EXAMINED_REASON = `${MARK} Not done yet: on this plan your final report also needs the sections "${EXAMINED}" (what the crew checked, each with its scope) and "${NOT_EXAMINED}" (what nobody checked, or None.), each a heading of its own.`
export const MAIN_MODEL_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every truss:* Agent call from the main session sets \`model\`. Call Agent again with model set.`
export const MAIN_EFFORT_REFUSAL = `${MARK} Refused: on a version 2 or later plan, every truss:* Agent call from the main session sets \`effort\` to "low", "medium", "high" or "xhigh": "medium" by default, "high" or "xhigh" only on the client's call. Call Agent again with effort set.`
```

The `TrussEvent` union gains the spent-allowance member `{ event: typeof ALLOWANCE_SPENT_EVENT; crew: string; agent: string }`. Each refusal or send-back logs one debug line under `truss:` that names the rule and the crew or agent type, never report text (repo P7, P8).

## Seams

The contract tests read only `tests/fixtures/contract-050/**` or data built inline, and they import `tests/harness.ts`, which the design crew owns.

1. **The plan schema.** `ajv` (draft 2020, `ajv-formats`) validates `docs/plan.example.json` (v2, integer `reworkAllowance`) and `tests/fixtures/contract-050/plan-v1.json` (a byte copy of the edeb6ef example) against `docs/plan.schema.json`. A v1 plan with `reworkAllowance` and a v2 plan without it both fail.
2. **Pure gates**, in `tests/contract-gates.test.ts`, which imports the names in section 9:
   - Each literal constant in section 3 equals its string there.
   - `planAtLeastV2` is true for versions 2 and 3, and false for 1, a missing version and `"2"`. Each rule below returns `undefined` on a v1 plan built inline, and gives the same result on a v3 plan as on a v2 one.
   - `qcFails` and `latestQc` ignore files older than `since`, stress-test files and interim files. `allowanceSpent` is false at fails equal to the allowance and true at one more. `qcAllowanceVerdict` denies with `ALLOWANCE_REFUSAL` as its prefix only for a QC engineer name.
   - `qcRuling` reads the head and patch lines only under `## Proof checked`, and counts `UNSCOPED` lines only under `## Findings`.
   - `headVerdict` covers every row of section 6's table.
   - `examinedVerdict` blocks a final report missing either heading and passes tagged stops.
   - `mainCallVerdict` refuses a `truss:qc-engineer` call with no model or no effort from the main session, and lets the same call from inside a crew, a non-`truss:` type, or a call with no plan go through.
3. **Prompts**, in `tests/gates.check.ts`. `agents/qc-engineer.md` carries `HEAD_LINE`, `PATCH_LINE` and `UNSCOPED`. `agents/foreman.md` carries `EXAMINED`, `NOT_EXAMINED` and `ALLOWANCE_BLOCKED`. `skills/run/SKILL.md` carries the head and patch merge-gate rule. `agents/writer.md` pins a model and an effort of `low` or `medium`.
4. **retro**, in `tests/test_contract_retro_050.py`, on a fixture under `contract-050/` that has a `## Run` heading and spent-allowance lines for two crews, one of them twice. Its `allowancesSpent` is 2. A run with events but no such line gives `"not recorded"`. `tests/test_contract_retro.py` adds `allowancesSpent` to `RUN_KEYS`, and `retro` stays 1.
5. **Spawn line keys.** `tests/events.test.ts:67` is unchanged; this ADR adds no spawn key.

## Consequences

- One merge of the target no longer costs one QC engineer when the crew's patch doesn't change. A merge that resolves a conflict in the crew's hunks changes the patch id and still needs a fresh QC engineer. (Written for rebases in run 3; amended for real merges by repo ADR-0015.)
- A crew stops at `reworkAllowance + 1` FAILs and goes to the PM, instead of looping. A successor foreman gets a fresh count. The PM's decision to start one is the extra spend, and it is logged.
- The guard and the allowance trust file modification times against `approvedAt`. A re-approval that rewrites `approvedAt` mid-run resets every count. A clock that runs behind the file system would hide this run's files and fail open, not closed.
- The QC engineer's file can't prove the patch line was computed from the right base. The guard only compares ids. A QC engineer that used the wrong base gets a mismatch, and the foreman a send-back, never a wrong merge.
- Every main-session `truss:*` call on a v2 plan pays one `plan.json` read. A QC-named spawn inside a crew, and each foreman final report, pay one directory listing and the reads of this run's QC files. A foreman final report whose head moved also pays up to three git calls.
- `events.jsonl` gains a new event kind with `v` still 1. A 0.4.x retro reading a 0.5.0 log ignores the event kind it doesn't know.
- Open: hosts whose git uses SHA-256 object ids write 64-digit heads. The literals' 40-digit rule fails those, and the guard sends the foreman back twice and then lets it through. Not decided here.
