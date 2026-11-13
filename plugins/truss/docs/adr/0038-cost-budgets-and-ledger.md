# ADR-0038: the cost meter, budgets and the merge ledger

Status: accepted, 2026-11-10
Decided by: client brief and contract-025 revision 2 (R-58, R-59, R-63), as the approved-scope rows of the b-cost goal record
Relates to: ADR-0015 (admission gains a budget hold), ADR-0041 (a work type can carry its own crew budget)
Amended 2026-11-11 (goal cost-budgets): `sessionUsd` holds every crew's admit, attended runs included, and `factory cost` reports a busy lock instead of failing. See the amendment at the end.

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

`sweep(dir)` in `bin/cost.ts` reads every transcript of the session under the lock `D/locks/usage`, where `D` is the session's truss dir, and returns `{rows, files, bad, found}`.

- `transcriptsOf` (`bin/store.ts:400`) finds the main transcript and walks `<sid>/subagents` for every `agent-*.jsonl`, Workflow agents included, reading each `.meta.json` beside it.
- Each file is read from its cursor offset in 4 MiB chunks, and each chunk is cut at its last newline (`CHUNK` and the read loop in `sweep`, `cost.ts`). A torn last line stays unread until it is whole. The offsets live in `D/usage-cursor.json`, keyed by path; on win32 the keys are lowercased (`keyOf` in `sweep`). A file shorter than its cursor is read again from the start (`sweep`).
- Only `type: "assistant"` lines with `message.usage` become rows. A row whose token fields are all zero is skipped, which drops `<synthetic>` lines (`rowOf`, `cost.ts`). A line that doesn't parse adds to `bad`.
- **Dedupe.** The sweep loads every `msgId` already in `D/usage.jsonl` once, before it reads, and skips any row whose id it has seen (`sweep`, `cost.ts`). Because the check is against the usage file, not the cursor, a deleted cursor or a path-case mismatch can't add a row twice. The sweep appends rows first and writes the cursor second, so a crash between the two is repaired by the same id set (the append and `writeJsonAtomic` of the cursor at the end of `sweep`).
- **Row shape:** `{v: 1, ts, sid, agentId|null, model, speed, msgId, in, out, think, cr, cw5m, cw1h, web}` (`rowOf`, `cost.ts`). `cw5m` and `cw1h` come from `usage.cache_creation` when the line has it, and otherwise all cache-write tokens count as `cw5m` (`rowOf`).
- **Torn rows.** A writer that dies mid-row leaves `usage.jsonl` with an unterminated last line. A read skips that line, and any other line that doesn't parse (`readJsonl`, `store.ts`). Before it appends, the sweep checks the file's last byte (`endsTorn`, `cost.ts`) and writes a newline first when the tail is torn, so new rows start on their own line and none is glued to the torn one (the append in `sweep`).
- **Cross-check.** The sweep keeps the newest `cost-state` estimate in the cursor as `ccEstimate` (`sweep`, `cost.ts`). `factory cost` reports it as `claudeCodeEstimateUsd`.

When the lock stays busy, a caller that needs a verdict (`budgetVerdict`, `crewCost`) reads `usage.jsonl` as it stands and counts `found` from the transcripts (`sweepOrRead`, `cost.ts`). A held lock never blocks a verdict. A busy lock means `usage.jsonl` may lag the transcripts (before a first sweep, with no `usage-cursor.json`, it is missing or partial). `crewCost` returns `usd: null` (`usage sweep busy`) on any busy lock, with or without a cursor, instead of writing a too-low cost into the append-only ledger. Only verdicts accept the lag: `budgetVerdict` follows contract-025 section 4 and does not hold on a busy lock, it reads `usage.jsonl` as it stands, so until the first sweep lands a budget is not enforced. The first sweep of a real session takes seconds, and holding on it BLOCKED 3 of 4 crews started together with spend far below the limit. After a first sweep, a busy read may lag by rows not yet swept and is accepted.

### 2. Attribution at read time

Rows store `agentId`, not a crew. The crew is resolved each time the rows are read (`attributor`, `cost.ts`), so a meta written after its transcript is picked up on a later read. The order:

1. A row with no `agentId` comes from the main transcript and is `main`.
2. A Workflow agent's meta `description` (the Workflow label) whose `parseLabel` slug is a plan slug. Plan labels such as `truss-designer` parse to `truss`, which is no crew, so planning agents fall through.
3. An `events.jsonl` `spawn` event with the same `agentId`.
4. A meta `worktreePath` equal to the crew worktree `<repo>/.claude/worktrees/truss-<slug>`, compared after flattening to `/` and, on win32, lowercasing.
5. An Agent-tool meta `description` whose parsed slug is a plan slug. For a direct crew the program manager (PM) sets `description: <slug>-<role>`.
6. Otherwise `unattributed`.

Contract-025 lists `main` fifth; the code tests it first. The result is the same, because only main-transcript rows have a null `agentId`.

### 3. Pricing

Prices come only from `pricing` in the client's `.claude/truss.json`. Each entry holds `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWrite5mPerMTok` and `cacheWrite1hPerMTok`, and may hold a `fast` entry of the same shape (`RATES`, `ratesFor`, `cost.ts`).

- A model's price is the **longest** `pricing` key that is a prefix of its id (`ratesFor`).
- A row with `speed: "fast"` uses the entry's `fast` prices.
- (0.29.0, ADR-0046) An entry may hold `longContext` with `abovePromptTokens` and the five rates. A standard-speed request whose prompt (input, cache read and both cache writes) is over that count is priced wholly at the `longContext` rates; a fast row ignores it (`cost.ts` `ratesFor`).
- **No price means `usd: null`, never 0.** If any row in a sum has no price, the whole sum is `null` and the model is listed in `unpriced`, with `(fast)` appended for a fast row (`sumOf`, `cost.ts`).
- `out` is priced alone; thinking is assumed to be inside it. `think` and `web` are counted in `tokens` but not priced (`sumOf`).
- No price is written in plugin code, prose or fixtures. `tests/cost.check.ts:404` scans `bin/cost.ts`, `tests/fixtures/cost/**` and this ADR for price literals, after it has caught a planted example of each kind.

### 4. `factory cost`

`factory cost --dir D --repo R [--crew s]` sweeps, then prints:

```
{run: {since, usd|null, tokens}, session: {usd|null}, crews: [{crew, usd|null, why?, tokens}],
 unpriced: [models], notRecorded: [slugs], claudeCodeEstimateUsd|null, sweep}
```

- **Run spend** is the rows with `ts >= plan.approvedAt`. With no plan, or no `approvedAt`, `run.since` and `run.usd` are null (`costOf`, `cost.ts`).
- **Crew spend** is the rows attributed to that crew. A crew with no rows gets `usd: null, why: "not recorded"` and is listed in `notRecorded` (`costOf`).
- **Session spend** is every row of the session, planning agents and the main thread included.

`factory cost` runs on a session dir with no `plan.json`.

When the usage lock stays busy past the default wait, `factory cost` reads `usage.jsonl` as it stands through `sweepOrRead` (called from `costOf`, `cost.ts`) and prints `sweep.busy: true`, instead of failing with `store busy`. If no `usage.jsonl` and no `usage-cursor.json` exist yet, there is no reading to fall back on: `run.usd` and `session.usd` are null and `session.why` is `usage sweep busy and no earlier reading exists` (`costOf`).

### 5. Budgets

`budgetVerdict(dir, repo, plan|null, slug|null)` (`cost.ts`) returns `{held: false}` or `{held: true, scope, spentUsd|null, limitUsd, why}`. It reads `budget` from `.claude/truss.json`; with no `budget` it returns `{held: false}` and doesn't sweep. It sweeps only when a check applies, with a 1 s lock wait.

The checks, in order, first hold wins:

1. `sessionUsd`, at every crew's admit and at queue-next (`slug` null), attended or not (`budgetVerdict`). It counts every row of the session. A held session verdict carries `ref: budget:<sid>:session:session` (`budgetVerdict`), so every crew's escalation and queue-next's share one ref, and one typed raise lifts the hold for all of them.
2. `runUsd`, against run spend, only when the plan has `approvedAt`.
3. The crew check: the lower of `crewUsd` and `workTypes[<the crew's workType>].crewUsd`. The scope is `workType` when the work-type limit is the lower one, and `crew` otherwise.

Each limit is the configured value plus the sum of `raiseUsd` from `budgetRaises(repo, sid)` (`bin/inbox.ts:21`) whose `ref` is `budget:<sid>:<scope>:<slug|run|session>`. A client raise of 3 on a crew limit of 5 gives a limit of 8.

The verdict holds when:

- the budget is set but the sweep found no transcripts: `why: "budget: no transcripts found for session …"`;
- the spend can't be priced: `why: "budget: … spend not priced: <models>"`;
- the spend has reached the limit (`>=`): `why: "budget: … spent <usd> USD, which reached the limit of <limit> USD"`.

Every `why` starts with `budget:`.

**Where it is checked.** `holdOf` (`factory.ts`) runs inside `admission`, which `factory start` calls for each crew and `factory admit` calls before each member spawn (`admit` in `workflows-src/stage/crew.js`). It runs after the blocking-inbox check and only when `truss.json` has a `budget`. A held verdict appends one `budget-hold` event and raises one blocking `budget` escalation with the ref above. If `escalate` throws, the hold still stands and the error rides on the answer as `escalateError`. `admit --wait-ms` doesn't wait on a budget hold: it refuses at once (`factory admit`), so the stage stops the crew.

### 6. The merge ledger

`ledgerAppend(repo, row)` (`bin/ledger.ts:9`) appends one JSON line to `<git common dir>/truss/shared/ledger.jsonl` (`store.ts:131`) under the store lock `ledger`, through `appendJsonl` (`store.ts:360`). There is no update and no delete: no `track` command and no `settleDays`. Earlier rows are never rewritten.

`mergeCrew` writes one row per merge, through `finish` or `land`, after the merge is final (`factory/finish.ts`):

```
{v: 1, ts, kind: "merge", session, crew, goal, workType|null, process, qc, red, target, base, head, costUsd|null, costWhy?}
```

`costUsd` comes from `crewCost` (`cost.ts`). It is null, never 0, with a `costWhy` (`not recorded`, or `not priced: …`) when the crew's spend can't be priced. A ledger failure is written as a decision line and never refuses the merge, because the merge has already happened.

### 7. Limits

These hold by design, and readers of a budget or a ledger row must allow for them.

- **Budgets are checked only at member start.** `admit` checks before each spawn, not during one. A crew can go over its limit by up to one member's spend, and a run by as much as every member running at once.
- **Planning spend is excluded** from run and crew budgets. Plan-mode agents parse to `truss`, not a crew, and the main thread is `main`. `sessionUsd` counts them on purpose: it caps the whole session's spend. Planning and intake spend count against it at the next admit of any crew and at queue-next, not mid-plan: `workflows/plan.js` makes no admit call, so a plan in progress can run past the cap until the next check. Without `sessionUsd`, planning spend is uncapped; the approved-scope row of 00:07 accepted that as a long-term cost.
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

## Amendment 2026-11-11: `sessionUsd` holds attended runs too

Decided by: the PM as product owner, on the design engineer's recommendation, with the client away (decision 23:53 of the 0.26.0 run, item 6 ruling). Source: goal cost-budgets, items 5, 6 and 15. The cases are in `tests/cost-026.check.ts`.

Until this amendment `budgetVerdict` checked `sessionUsd` only when `slug` was null, so only queue-next saw it. A setting named `sessionUsd` that did not cap an attended run was fail-open. The PM ruled to enforce it.

- `sessionUsd` is checked at every crew's admit and at queue-next (Decision 5, check 1). Planning and intake spend count against it at those points; nothing checks it mid-plan (Decision 7).
- A held session verdict carries `ref: budget:<sid>:session:session`, and `holdOf` (`factory.ts`) escalates with the verdict's ref when it has one. Every crew held by the session cap gets the same ref, so one typed raise lifts the hold for all crews.
- `factory cost` reports a busy usage lock as `sweep.busy: true`, with `usd: null` and a reason before any reading exists (Decision 4).
- A torn last row of `usage.jsonl` no longer swallows the next swept row (Decision 1).

Long-term cost, accepted by the ruling: an attended session at its cap stops at the next member start and needs a typed raise to go on, and the spend accumulates over every run in a long session, so a long attended session reaches the cap sooner than any one run would.

## Amendment 2026-11-11: a busy usage lock with no reading never admits

Decided by: the PM, on the checking engineer's review of the review-fixes round (decision 12:58, checker-7 item 2). The case is in `tests/cost-026.check.ts`.

Until this amendment, `budgetVerdict` returned `held: false` when the usage lock stayed busy for its 1000 ms wait and no `usage.jsonl` existed. That let a crew in with unknown spend, a fail-open that parallel admits can reach. Now the verdict sweeps once more with the store's default wait (5 s, under the 120 s stale age), and if the lock is still busy it throws `StoreBusy` (exit 2, `store busy: usage`). It never returns a hold, because a hold raises a budget escalation that needs a typed raise. Exit 2 is never an admit: `admit` and `queue-next` exit 2 (`stage.js` retries `admit` once, then stops BLOCKED), and `start` lists the crew in `held` with that `why`. When `usage.jsonl` exists, a busy lock still reads it as it stands, and the lag is accepted (Decision 4).

## Amendment 2026-11-13: a resumed run sweeps every session that ran it

Decided by: the program manager, on item 9 of the 0.31.0 speed goal. The cases are in `tests/cost-sessions-031.check.ts`.

Until this amendment `sweep` read only the transcripts of the session its run dir is named after. Wave 4 was started by one PM session and finished by a second one, and none of the second session's usage reached `usage.jsonl`. Its cost, budget checks and timing were all too low.

- A session that runs a state-changing factory command on a run dir named after another session is recorded in `D/sessions/<sid>.json` (`attach` in `bin/factory.ts`, `recordSession` and `ATTACH_COMMANDS` in `bin/cost.ts`). The session id comes from `CLAUDE_CODE_SESSION_ID`, which Claude Code sets in a Bash call's environment; a subagent or Workflow run inherits the parent session's id. The record is created once and never rewritten. A read such as `factory cost` never attaches.
- `sweep` reads the union of the transcripts of the session D is named after and every recorded one (`sessionsOf`). The cursor stays keyed by transcript path, so each session keeps its own offsets; the msgId dedupe, the lock and the busy and StoreBusy rules are unchanged. Each row keeps the `sid` of its transcript.
- The Claude Code estimate is kept per session in the cursor's `ccEstimates`, and `ccEstimate` is their sum.
- Crew attribution reads the agent metadata of every recorded session, so a Workflow crew that the resuming session started is attributed to its crew.

Long-term cost, accepted: a resuming session's whole transcript counts toward the run, including work it did before it attached. The session cap (`sessionUsd`) of a resumed run therefore counts both sessions. A run that a session resumed before 0.31.0 has no record; it can be added by hand as `D/sessions/<sid>.json` with `{v: 1, sid, ts, by}`.
