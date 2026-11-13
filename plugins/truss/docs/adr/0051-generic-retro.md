# ADR-0051: count problems from structured files and keep findings of any category

Status: accepted, 2026-11-13
Decided by: client: long-term-cost item E-20261113-ef869e, approved by the client at 22:15:15Z (shared `inbox.jsonl`, `resolve` op, `by` `client`), and the plan approved after it (decisions.md, 17:15)
Amends: ADR-0012

## Context

Goal item 2 of `plugins/truss/docs/goals/0.32.0.md` asks for "a retro that finds every problem, generically". It must work on any project, rank problems by wall-clock and token cost, and give each finding "evidence (counted, never guessed), cost, proposed fix, target (plugin, project config, or project code as a goal for the client)". It names a starting checklist: time, code structure, tests, the quality loop, rules and gates, and cost. The client then ruled (2026-11-13), in the goal's words:

> **Open-ended (client ruling 2026-11-13):** that list is a starting checklist, not the scope. The retro agent's brief says plainly it is empowered, and expected, to find any other problem or optimization the evidence shows, reported in the same format, never dropped for fitting no category; it may name new categories. A test pins the wording, and judge/triage keep findings outside the known categories. It reads the structured events 0.31.0 records (step timings, test durations, slot waits, conflicts), not transcripts, and finishes in bounded time.

The requirements are R-128 (any project, ranked by cost), R-129 (open-ended, keeps findings outside the known categories), R-130 (structured events, no transcripts, under 300 s on a dir the size of 0.31.0's wave 4) and R-148 (timing bounds crew periods by agent activity), in `docs/requirements.md`.

The retro of ADR-0012 cannot meet them, for four reasons in the code:

- **Closed kinds.** A judged finding's `kind` must be one of seven: `retro/cli.ts` `judgedProblem` returns `kind is not one of the seven kinds` for any other, using `retro/catalog.ts` `KINDS`. `tests/retro-contract.check.ts` pins this with the case "a finding whose kind is not one of the seven is dropped".
- **Prose cost, transcript evidence.** `retro/cli.ts` `Judged` holds `cost`, `fix` and `target` as free strings and `evidence` as transcript `{file, line, quote?}`. `judgedProblem` checks each evidence line against the extract's files list, never against a count.
- **Transcripts as the source.** The judges read transcript spans that `<truss dir>/retro/extract.json` points to (ADR-0012 Decisions 1, 2 and 4; `agents/retro-judge.md`, section "How you read").
- **No ranking.** Nothing orders findings by cost. `retro/counts.ts` `retro` counts per-run events, decisions, QC files, the plan and leftovers, and finds no problem by itself.

Since 0.31.0 the run dir records what a generic retro needs, outside transcripts. `retro/timing.ts` `analyze` splits each crew's wall-clock from `events.jsonl`, `usage.jsonl`, runner and QC reports, and file mtimes, and it already bounds a period by the crew's first and last `usage.jsonl` row rather than by event stamps (its header comment; architecture.md, "Timing baseline (0.31.0, speed goal step 0)"). Each `usage.jsonl` row carries `ts`, `agentId`, `model` and token counts (`in`, `out`, `cr`, `cw5m`, `cw1h`), as the wave-4 run dir shows. Spawn events in `events.jsonl` carry `crew`, `agent`, `agentId`, `type`, `model` and `effort`.

The client approved the long-term cost of a new stored finding shape, which the judge, triage and the PM all read, as item E-20261113-ef869e. That item names the reversal as costly.

## Decision Drivers

- Every number in a finding is counted from a file, so a reader can check it.
- A finding outside the checklist is kept, never dropped for its category.
- Findings are ranked by measured cost, never by category order.
- The counting step finishes in bounded time and opens no transcript.
- The retro works on a project that is not a truss run.
- Product code is never auto-fixed.

## Considered Options

| Option | Kept or rejected |
| --- | --- |
| Widen `KINDS` with the six checklist names and keep the transcript extract | Rejected: still a closed list, so a new category is still dropped (R-129), and evidence is still a transcript line, not a count. |
| Let the judges read whole transcripts with a larger budget | Rejected: R-130 forbids transcripts, and the product owner measured the wave-4 session dir at about 8.5 MB of them across 9 files (plan.md, "What the acceptance titles prove"), so the time grows with the run. |
| A counting step over structured files that publishes named measures, and a judge whose evidence must quote those measures, with an open category | Kept: the evidence is checkable by code, the category is open, and the cost of reading is bounded by the structured files alone. |

## Decision

### 1. The counting step: `problems()`

We will add `problems(directory: string): Problems` to `retro/counts.ts` as the counting step. The analysis may live in new modules `retro/problems.ts` and `retro/problems-code.ts`, which `counts.ts` re-exports. `retro()` and the `counts` command output stay byte for byte unchanged. `Problems` is `{ retro: 2, dir, measures, findings }`:

```ts
type Problems = {
  retro: 2
  dir: string
  measures: Record<string, number>
  findings: Finding[]
}
```

`measures` is a flat object from a dotted key to a finite number counted from the files. Examples of keys are `time.slotWaitMs.<crew>` and `cost.tokens.<crew>.<role>`. No value is a guess, and a quantity the files cannot give has no key, never a zero.

`counts.ts` exports `CHECKLIST`, which holds `time`, `code structure`, `tests`, `quality loop`, `rules and gates` and `cost`. `CHECKLIST` is a starting list for the counting step and the judge. It is never a filter: no step drops or orders a finding by whether its category is in it.

### 2. The finding shape

A finding is `{ id, category, title, evidence, cost, fix, target }`:

- `id` is a string the code assigns.
- `category` is any non-empty string.
- `title` is a non-empty line.
- `evidence` is a non-empty array of `{ measure, value }`. `measure` is a key of `measures` and `value` equals `measures[measure]`.
- `cost` is `{ wallMs, tokens, usd }`. Each is a number or null, and at least one is not null.
- `fix` is a non-empty sentence.
- `target` is `{ kind: 'plugin' | 'project-config' | 'proposed-goal', path?: string }`.

This shape replaces `retro/cli.ts` `Judged` and `Finding` of ADR-0012 Decision 4, and its seven kinds. The stored record in `<truss dir>/retro/findings.json` is this finding plus the `judge` label that `findings` sets, as today, and `signature` when the judge gave one. `recur` findings take their catalog entry's `kind` as their `category`.

### 3. Ranking

Findings are ranked by `cost.wallMs` descending, with null last, then by `cost.tokens` descending, with null last, then by `id`. Category never orders them. `problems()` returns its findings in this order, and every reader that lists findings uses it.

### 4. Product code is a proposed goal

Product code is any file that is neither the truss plugin nor project config. Project config is `CLAUDE.md` and files under `.claude/`. A finding about product code has target kind `proposed-goal` and is never auto-fixed. This replaces ADR-0012 Decision 6's rule that triage drops such a finding as `out of scope (R-30)`: the finding is kept and shown to the client as a proposed goal.

### 5. What the counting step reads

The counting step reads only these:

- `decisions.md`;
- `events*.jsonl`;
- `usage.jsonl`;
- `plan.json`;
- `stage-result-*.json`;
- `checks/*.json`;
- the first line of QC reports;
- read-only git commands.

It never opens a transcript. It never calls `bin/cost.ts` `crewCost` or its `attributor`, because those read transcript metadata. Token measures map a `usage.jsonl` row to a crew through the spawn event that has the row's `agentId`. A row whose `agentId` is null belongs to the main session, as `bin/cost.ts` `MAIN` (`main`) does.

On a dir with no `plan.json`, a project that is not a truss run, it still emits findings from events, usage and git. Those findings have target kind `project-config` or `proposed-goal`, because there is no plugin file to fix.

`retro/timing.ts` keeps its behaviour. When the counting step reuses `timing.ts` `analyze` for the time measures, `analyze` also reads runner reports under `reports/<crew>/` (for `heavy.waitedMs`) and the mtimes of `answers/*.json`. Those are structured runner output and file metadata, not transcripts.

### 6. The command line and the judge's block

`retro/cli.ts` gains `problems <truss dir>`. It prints the `Problems` JSON and writes `<truss dir>/retro/problems.json`.

The judge's fenced `finding` block takes the finding shape without `id`, plus an optional `signature` list. `parseFindings(report, measures)` does three things:

- It keeps a finding whose category is outside `CHECKLIST`.
- It drops a finding whose evidence names a missing measure, or a value different from the measure's. The reason names the measure.
- It sets target kind `proposed-goal` on a finding whose target path is product code.

`findings <truss dir> <label> <report>` checks evidence against `retro/problems.json` instead of the extract. Its `KEPT:`, `DROPPED:` and `OK:` lines keep their form (ADR-0012 Decision 5).

### 7. Triage

`parseTriage(text, findings)` reads `TRIAGE: <finding id> | <fix now|defer|drop> | <reason>` lines. That sentence stays word for word, because `skills/run/SKILL.md` and its tests share it.

- Triage never drops a finding for its category.
- `fix now` on a proposed-goal finding becomes a proposed goal outside the fix goal.
- The fix goal takes only fix-now findings whose target kind is `plugin` or `project-config`.

The rest of ADR-0012 Decision 6 holds: the fix goal goes through amend, its approval rule, the scrub before each merge, and the catalog growing from a merged fix's `signature`.

### 8. The judge and the retro state

The retro judge reads `retro/problems.json` and the structured files, never transcripts. Its brief says it is empowered and expected to find problems outside the checklist, and that it may name a new category.

The retro state steps keep their five names: `extract`, `judges`, `triage`, `fixGoal` and `applied` (`retro/cli.ts` `STEPS`). The `extract` step now runs the counting step, so `docs/retro-state.schema.json` does not change. `retro/extract.ts`, and the transcript extract that `factory finish` writes, stay as they are, but no retro step reads them.

### 9. The quote audit stays

The quote audit in `skills/retro/SKILL.md` checks each client approval in the inbox against the client's typed prompts. It stays as it is. It is an approval audit, not the problem analysis, so the no-transcript rule of this ADR does not apply to it.

### 10. Grading the judge and triage

The judge and triage are LLM agents, so a rubric in code grades their output over a recording at `plugins/truss/retro/evals/wave4-judge.md` and `plugins/truss/retro/evals/wave4-triage.md`. The recording lives outside `tests/` because builders may not write under `tests/`. The rubric requires each finding to carry evidence that matches the counting step's measures, a cost, a fix and a target, and the ranking to follow cost. It must pass the recording and fail a doctored recording with an uncounted claim.

An opt-in live eval, `tests/retro-generic-live.e2e.ts`, runs the judge and triage again when `TRUSS_RETRO_LIVE_EVAL=1` is set. It is for the PM at release; the default suite never runs it.

## Seams

| Seam | Who calls it | Contract |
| --- | --- | --- |
| `retro/counts.ts` `problems(directory)` | `retro/cli.ts problems`, the `extract` step, tests | Returns `Problems` in rank order; reads only the files of Decision 5. |
| `retro/counts.ts` `CHECKLIST` | the judge brief, tests | The six starting categories; never a filter. |
| `retro/counts.ts` `retro`, `counts` | `retro/cli.ts counts`, the retro skill | Unchanged, byte for byte. |
| `node <plugin>/retro/cli.ts problems <truss dir>` | the PM, the retro skill's `extract` step | Prints the JSON and writes `<truss dir>/retro/problems.json`. |
| `retro/cli.ts` `parseFindings(report, measures)` | `findings` | Keeps any category; drops evidence that does not match a measure, naming it; marks product code `proposed-goal`. |
| `node <plugin>/retro/cli.ts findings <truss dir> <label> <report>` | the PM | Checks evidence against `retro/problems.json`. |
| `retro/cli.ts` `parseTriage(text, findings)` | the PM, tests | Reads `TRIAGE:` lines; never drops for category; splits fix-now into the fix goal and proposed goals. |
| `agents/retro-judge.md` | the PM | Reads `retro/problems.json` and structured files; the empowered sentence of Decision 8. |
| `agents/checking-engineer.md`, section "Retro triage" | the PM | The `TRIAGE:` sentence, word for word. |
| `retro/evals/wave4-judge.md`, `retro/evals/wave4-triage.md` | the rubric grader | The recorded judge and triage output. |
| `tests/retro-generic-live.e2e.ts`, `TRUSS_RETRO_LIVE_EVAL=1` | the PM at release | The opt-in live eval. |
| `retro/timing.ts` `analyze` | the counting step, `node retro/timing.ts` | Unchanged; its first-to-last agent activity bound is pinned by a test (R-148). |

## Consequences

Positive:

- Every number a finding states is checked by code against a count, so a judge cannot invent one.
- A finding of a new category reaches triage and the client.
- The retro ranks by what a problem cost, so the client sees the most expensive problem first.
- The counting step reads no transcript, so its time depends on the structured files alone (R-130).
- A project that is not a truss run gets findings too.

Negative:

- The stored finding shape changes, and the judge, triage, the retro skill and the PM all depend on it. Client item E-20261113-ef869e names the reversal as costly.
- `plugins/truss/docs/findings.schema.json` is outside this crew's owns. It still describes the old shape: the seven kinds, transcript evidence and string `cost` and `target`. Until it is updated it is wrong.
- The `out of scope (R-30)` drop in `skills/run/SKILL.md` (section on the retro after the sweep) contradicts Decision 4. That file is outside this crew's owns.
- `recur` reads the extract's `catalogHits` (`retro/cli.ts` `runRecur`). With no retro step reading the extract (Decision 8), the retro no longer checks R-31's recurrences unless `recur` gets a source outside the transcripts.
- `docs/retro-state.schema.json` describes the `extract` step as writing `extract.json`. Its shape is unchanged, but that description is now stale, and the file is outside this crew's owns.
- `tests/retro-contract.check.ts` pins the seven kinds and transcript evidence, so the crew must change those cases.
- A grade on a recording proves nothing about a fresh judge run. Only the opt-in live eval does, and only when the PM runs it.

Neutral:

- `retro/timing.ts` keeps its behaviour. Its bound of a crew period by the first and last agent activity is pinned by a test (R-148), not changed.
- `retro/extract.ts` and the extract `factory finish` writes stay, unread by the retro.
- The quote audit stays as an approval audit (Decision 9).
- The `TRIAGE:` sentence is unchanged, so `skills/run/SKILL.md` and its tests need no change for it.

Reversing this decision would touch `retro/counts.ts` (`problems`, `CHECKLIST`), `retro/problems.ts`, `retro/problems-code.ts`, `retro/cli.ts` (`problems`, `parseFindings`, `parseTriage`, `findings`), `agents/retro-judge.md`, `agents/checking-engineer.md`, `skills/retro/SKILL.md` section "6. The automatic retro (ADR-0012)", `retro/evals/`, the tests that pin them, and every `findings.json` written in the new shape.
