# ADR-0038: the cost meter, budgets and the merge ledger

Status: accepted, 2026-11-10
Decided by: client brief and contract-025 revision 2 (R-58, R-59, R-63), as the approved-scope rows of the b-cost goal record
Relates to: ADR-0015 (admission gains a budget hold), ADR-0041 (a work type can carry its own crew budget)

## Context

An unattended run (wave 2 of level-4 autonomy, contract-025) has nobody watching the spend. R-58 asks truss to meter spend from the transcripts and hold a crew that has spent its budget. R-59 asks that the meter agree with Claude Code's own estimate. R-63 asks for an append-only log of every merge.

Claude Code exposes no spend API to a plugin. What it does write is transcripts. The contract's probe of Claude Code 2.1.316 to 2.1.319 found these shapes, and the meter is built on them:

- The main thread is `<projects>/<cwd-key>/<sid>.jsonl`. An Agent-tool subagent is `<sid>/subagents/agent-<id>.jsonl`. A Workflow agent is `<sid>/subagents/workflows/<wf>/agent-<id>.jsonl`. Each agent transcript has a `.meta.json` next to it with `agentType`, `description`, `model` and, sometimes, `worktreePath`, but no name and no effort.
- An assistant line carries `message.id`, `message.model` and `message.usage`. One API message is written once per content block, each copy with the same usage: the probe counted 313 lines for 179 ids.
- `<synthetic>` model lines have zero usage.
- A `type: "cost-state"` line holds Claude Code's cumulative estimate for the session.
- Hooks don't see Workflow agents, and `register.ts` writes no `spawn` event for a main-thread Agent call that has no crew. A hook can't meter, so the meter is a factory sweep.

## Decision Drivers

- Spend that can't be counted must never show as 0. A 0 reads as "free" and lets a budget pass.
- Several factory processes admit members at once, so the meter must count each API message exactly once under concurrency, a lost cursor and a Windows path-case mismatch.
- No price goes into plugin code, prose or committed fixtures. Prices change, and the client owns them.
- The same code must run on Linux, macOS and Windows (R-64).
- A budget hold must stop a crew at once, not after a memory-style wait.

## Considered Options

1. **A hook that counts usage as it happens.** Rejected: hooks don't see Workflow agents, which do most of a crew's work.
2. **Trust Claude Code's `cost-state` estimate.** Rejected as the meter: it is one number for the whole session, with no per-crew split, and some transcripts carry no `cost-state` line at all (the first candidate session for the probe below had none). It stays as a cross-check.
3. **Sweep the transcripts into a deduplicated usage file, price the rows from client config, and attribute rows to crews when read.** Chosen.

## Decision

### 1. The sweep

`sweep(dir)` in `bin/cost.ts:57` reads every transcript of the session under the lock `D/locks/usage`, where `D` is the session's truss dir, and returns `{rows, files, bad, found}`.

- `transcriptsOf` (`bin/store.ts:400`) finds the main transcript and walks `<sid>/subagents` for every `agent-*.jsonl`, Workflow agents included, reading each `.meta.json` beside it.
- Each file is read from its cursor offset in 4 MiB chunks, and each chunk is cut at its last newline (`cost.ts:16`, `:136-147`). A torn last line stays unread until it is whole. The offsets live in `D/usage-cursor.json`, keyed by path; on win32 the keys are lowercased (`cost.ts:60`). A file shorter than its cursor is read again from the start (`cost.ts:132`).
- Only `type: "assistant"` lines with `message.usage` become rows. A row whose token fields are all zero is skipped, which drops `<synthetic>` lines (`cost.ts:50`). A line that doesn't parse adds to `bad`.
- **Dedupe.** The sweep loads every `msgId` already in `D/usage.jsonl` once, before it reads, and skips any row whose id it has seen (`cost.ts:68-69`, `:116`). Because the check is against the usage file, not the cursor, a deleted cursor or a path-case mismatch can't add a row twice. The sweep appends rows first and writes the cursor second, so a crash between the two is repaired by the same id set (`cost.ts:154-156`).
- **Row shape:** `{v: 1, ts, sid, agentId|null, model, speed, msgId, in, out, think, cr, cw5m, cw1h, web}` (`cost.ts:34-49`). `cw5m` and `cw1h` come from `usage.cache_creation` when the line has it, and otherwise all cache-write tokens count as `cw5m` (`cost.ts:46-47`).
- **Cross-check.** The sweep keeps the newest `cost-state` estimate in the cursor as `ccEstimate` (`cost.ts:104-108`, `:156`). `factory cost` reports it as `claudeCodeEstimateUsd`.

When the lock stays busy, a caller that needs a verdict (`budgetVerdict`, `crewCost`) reads `usage.jsonl` as it stands and counts `found` from the transcripts (`sweepOrRead`, `cost.ts:163-175`). A held lock never blocks a verdict. Until a first sweep has finished (no `usage-cursor.json`), `usage.jsonl` is missing or partial, so a busy lock there is unknown spend: `budgetVerdict` holds and `crewCost` returns `usd: null` (`usage sweep still running`) instead of writing a too-low cost into the append-only ledger. After a first sweep, a busy read may lag by rows not yet swept and is accepted.

### 2. Attribution at read time

Rows store `agentId`, not a crew. The crew is resolved each time the rows are read (`attributor`, `cost.ts:192-225`), so a meta written after its transcript is picked up on a later read. The order:

1. A row with no `agentId` comes from the main transcript and is `main`.
2. A Workflow agent's meta `description` (the Workflow label) whose `parseLabel` slug is a plan slug. Plan labels such as `truss-designer` parse to `truss`, which is no crew, so planning agents fall through.
3. An `events.jsonl` `spawn` event with the same `agentId`.
4. A meta `worktreePath` equal to the crew worktree `<repo>/.claude/worktrees/truss-<slug>`, compared after flattening to `/` and, on win32, lowercasing.
5. An Agent-tool meta `description` whose parsed slug is a plan slug. For a direct crew the PM sets `description: <slug>-<role>`.
6. Otherwise `unattributed`.

Contract-025 lists `main` fifth; the code tests it first. The result is the same, because only main-transcript rows have a null `agentId`.

### 3. Pricing

Prices come only from `pricing` in the client's `.claude/truss.json`. Each entry holds `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWrite5mPerMTok` and `cacheWrite1hPerMTok`, and may hold a `fast` entry of the same shape (`cost.ts:229-241`).

- A model's price is the **longest** `pricing` key that is a prefix of its id (`cost.ts:236`).
- A row with `speed: "fast"` uses the entry's `fast` prices.
- **No price means `usd: null`, never 0.** If any row in a sum has no price, the whole sum is `null` and the model is listed in `unpriced`, with `(fast)` appended for a fast row (`cost.ts:252-258`).
- `out` is priced alone; thinking is assumed to be inside it. `think` and `web` are counted in `tokens` but not priced (`cost.ts:249`, `:256`).
- No price is written in plugin code, prose or fixtures. `tests/cost.check.ts:404` scans `bin/cost.ts`, `tests/fixtures/cost/**` and this ADR for price literals, after it has caught a planted example of each kind.

### 4. `factory cost`

`factory cost --dir D --repo R [--crew s]` sweeps, then prints:

```
{run: {since, usd|null, tokens}, session: {usd|null}, crews: [{crew, usd|null, why?, tokens}],
 unpriced: [models], notRecorded: [slugs], claudeCodeEstimateUsd|null, sweep}
```

- **Run spend** is the rows with `ts >= plan.approvedAt`. With no plan, or no `approvedAt`, `run.since` and `run.usd` are null (`cost.ts:347-349`, `:372`).
- **Crew spend** is the rows attributed to that crew. A crew with no rows gets `usd: null, why: "not recorded"` and is listed in `notRecorded` (`cost.ts:356-359`).
- **Session spend** is every row of the session, planning agents and the main thread included.

`factory cost` runs on a session dir with no `plan.json`.

### 5. Budgets

`budgetVerdict(dir, repo, plan|null, slug|null)` (`cost.ts:270-310`) returns `{held: false}` or `{held: true, scope, spentUsd|null, limitUsd, why}`. It reads `budget` from `.claude/truss.json`; with no `budget` it returns `{held: false}` and doesn't sweep. It sweeps only when a check applies, with a 1 s lock wait.

The checks, in order, first hold wins:

1. `sessionUsd`, only when `slug` is null. This is queue-next's check: the ceiling for a `/loop` of runs.
2. `runUsd`, against run spend, only when the plan has `approvedAt`.
3. The crew check: the lower of `crewUsd` and `workTypes[<the crew's workType>].crewUsd`. The scope is `workType` when the work-type limit is the lower one, and `crew` otherwise.

Each limit is the configured value plus the sum of `raiseUsd` from `budgetRaises(repo, sid)` (`bin/inbox.ts:21`) whose `ref` is `budget:<sid>:<scope>:<slug|run|session>`. A client raise of 3 on a crew limit of 5 gives a limit of 8.

The verdict holds when:

- the budget is set but the sweep found no transcripts: `why: "budget: no transcripts found for session …"`;
- the spend can't be priced: `why: "budget: … spend not priced: <models>"`;
- the spend has reached the limit (`>=`): `why: "budget: … spent <usd> USD, which reached the limit of <limit> USD"`.

Every `why` starts with `budget:`.

**Where it is checked.** `holdOf` (`factory.ts:2229-2244`) runs inside `admission`, which `factory start` calls for each crew (`factory.ts:2042`) and `factory admit` calls before each member spawn (`factory.ts:2285`; `workflows/stage.js:391-402`). It runs after the blocking-inbox check and only when `truss.json` has a `budget`. A held verdict appends one `budget-hold` event and raises one blocking `budget` escalation with the ref above. If `escalate` throws, the hold still stands and the error rides on the answer as `escalateError`. `admit --wait-ms` doesn't wait on a budget hold: it refuses at once (`factory.ts:2289-2294`), so the stage stops the crew.

### 6. The merge ledger

`ledgerAppend(repo, row)` (`bin/ledger.ts:9`) appends one JSON line to `<git common dir>/truss/shared/ledger.jsonl` (`store.ts:131`) under the store lock `ledger`, through `appendJsonl` (`store.ts:360`). There is no update and no delete: no `track` command and no `settleDays`. Earlier rows are never rewritten.

`mergeCrew` writes one row per merge, through `finish` or `land`, after the merge is final (`factory.ts:2998-3004`):

```
{v: 1, ts, kind: "merge", session, crew, goal, workType|null, process, qc, red, target, base, head, costUsd|null, costWhy?}
```

`costUsd` comes from `crewCost` (`cost.ts:325`). It is null, never 0, with a `costWhy` (`not recorded`, or `not priced: …`) when the crew's spend can't be priced. A ledger failure is written as a decision line and never refuses the merge, because the merge has already happened.

### 7. Limits

These hold by design, and readers of a budget or a ledger row must allow for them.

- **Budgets are checked only at member start.** `admit` checks before each spawn, not during one. A crew can go over its limit by up to one member's spend, and a run by as much as every member running at once.
- **Planning spend is excluded** from run and crew budgets. Plan-mode agents parse to `truss`, not a crew, and the main thread is `main`. `sessionUsd` counts them on purpose: it is the `/loop` ceiling. Planning spend per run is otherwise uncapped; the approved-scope row of 00:07 accepted that as a long-term cost.
- **Long-context pricing is not modelled.** A row is priced at the base rate whatever its input length.
- **The meter rests on undocumented transcript internals:** the directory layout, the duplicated content-block lines, the usage field names and meta `description`. If Claude Code changes any of them, spend is mis-counted without an error. What catches it: the `bad` and `found` counts in `sweep`, `null` in place of 0 for anything not recorded or not priced, and the `cost-state` cross-check.
- Thinking and web-search requests are counted but not priced (Decision 3).
- A budget plus a missing price holds every crew, by the rule that unpriced spend holds.
- The ledger and `usage.jsonl` grow without bound.

### 8. The probe

Contract-025 section 1 leaves four items unverified:

1. whether `out` already includes thinking;
2. advisor-model tokens;
3. fast pricing;
4. long-context pricing, which isn't modelled.

The probe runs `factory cost` on one real finished session with a client price table and compares session spend with the newest `cost-state` estimate. A gap within 5% is the pass mark. One aggregate number can't tell the four items apart: a small gap says their combined effect on that session is small, not that each one is settled. They stay unverified.

**The price table** is `/home/abd/Projects/truss/.git/truss/739d34ab-c391-4f99-92b8-66e3bb3d6025/pricing.json`. The PM supplied it for the client, and it stays outside the repo. Its `_source` line, quoted with one rate figure elided as `[...]`:

> "PM, for the client, from the claude-api skill price table cached 2026-11-03. Client to verify. UNVERIFIED: cacheWrite1hPerMTok (assumed 2x input) on all rows, cacheReadPerMTok on haiku (assumed 0.1x input), cacheWrite5mPerMTok (1.25x input). Haiku rises to [...] above 100K input tokens; this table holds the base rate only."

**The session.** The goal named `b65f0d34-e28f-4fdd-a691-f8531d485fe8` as a candidate. Its transcript has no `cost-state` line (`grep -c '"cost-state"'` gives 0), so the probe printed `claudeCodeEstimateUsd: null` and gave no gap. The session used is `7026b2da-719e-4cc8-bb4c-7ce94042aeb5`, chosen by rule before the probe ran: the most recently modified session of this repo, other than the live one, whose newest `cost-state` is at least 1 USD and that has agent transcripts. Its transcript was last written on 2026-11-09. The sweep found 137 transcripts in it, the main one and 136 agents. The probe was run once, on crew head `62c0639`, with `node plugins/truss/tests/fixtures/cost/probe.ts <sid> <table>`, and printed:

```
{"usd":53.05584079500003,"claudeCodeEstimateUsd":54.485232095000065,"gap":2.6234472076906235,"found":137}
```

Cost probe: session 7026b2da-719e-4cc8-bb4c-7ce94042aeb5 | table /home/abd/Projects/truss/.git/truss/739d34ab-c391-4f99-92b8-66e3bb3d6025/pricing.json | factory 53.0558 | claudeCodeEstimateUsd 54.4852 | gap 2.62%

The meter comes in 2.62% under Claude Code's estimate, inside the 5% mark. The cause of the gap is not known. Unpriced web search, base-rate pricing of long-context rows and, if `out` excludes thinking, unpriced thinking would each push the meter low. The table's unverified cache rates could move it either way. None has been checked one by one.

## Consequences

- Spend is metered for every crew, Workflow agents included, without a hook. Each API message is counted once, through concurrent admits, a deleted cursor and a held lock.
- A budget stops a crew at its next member start and raises a blocking escalation the client can answer with a raise. An unpriced model or a missing transcript holds too. That fails closed, and it can stop a run the client meant to keep going.
- The client keeps the prices current. Truss ships no price, so `factory cost` with no `pricing` gives `usd: null` with a reason.
- Every merge leaves one ledger row with its gates and cost. Every later reader is bound to the row shape, and changing it means migrating the history; the approved-scope row of 00:07 accepted that cost.
- The meter breaks quietly if Claude Code changes its transcript layout. Watch the `cost-state` gap and the `bad` count for drift.
