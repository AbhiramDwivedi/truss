# ADR-0037: keep cross-session state in one shared store and route every client exception through an inbox

Status: accepted, 2026-11-10; amended 2026-11-11 (see the amendment at the end)
Decided by: program manager (PM) and product owner (review of contract-025 revision 2)

## Context

truss 0.25.0 wave 2 lets a run go on without the client watching (R-55). It stops only on a fixed list of exceptions, and each one has to wait somewhere the client can find it, from any session of the repo. Three facts force the shape of that place.

- **Session dirs are private.** Each session writes to `D = <common>/truss/<sid>/`, where `<common>` is `git rev-parse --path-format=absolute --git-common-dir` run in `--repo` (`bin/store.ts` `commonDir`). An inbox, a merge ledger and a work queue must outlive the session that wrote them, so they can't live in D.
- **Several processes write at once.** Crews, the PM and the intake hook run in parallel, on Linux, macOS and Windows (R-64). truss uses no npm dependency, so locking and atomic writes must come from Node built-ins.
- **Approvals could be forged.** Before this ADR an agent could resolve a client question by typing one flag. R-56 says an agent can't forge a client approval.

The design is contract-025 revision 2, sections 2 and 3. The shared layout and `bin/store.ts` are crew a0-foundation's code; the inbox, `bin/inbox.ts` and `bin/notify-run.ts` are crew a1-inbox's. The inbox cases in `tests/inbox.check.ts` pin the behaviour below.

## Decision Drivers

- No agent can approve on the client's behalf by typing a command (R-56).
- Works on Linux, macOS and Windows, with Node built-ins only (R-64).
- A crash mid-write never leaves a half-written file that a reader takes as real.
- A notify command the client owns can never hang or fail an escalation.
- Nothing the client or an agent typed is copied into `events.jsonl`, which retros and the UI read widely.

## Considered Options

| Option | Kept or rejected |
|---|---|
| Shared state in `S = <common>/truss/shared/` | Kept. A fixed name next to the session dirs means no code that walks session dirs needs a UUID filter (contract-025 §2). |
| Shared state in a dir named like a session | Rejected: every walker of session dirs would need to skip it. |
| One copy per session, merged on read | Rejected: two sessions could resolve the same item twice, and no session sees another's open items. |
| `flock` or `fs.watch` for coordination | Rejected: neither works the same on all three platforms; both are banned in code and prose (contract-025 §2). |
| A `mkdir` lock with an owner file | Kept. `mkdirSync` without `recursive` is atomic on ext4, APFS and NTFS (contract-025 §2). |
| Rewrite inbox items in place | Rejected: a crash mid-rewrite loses items, and the history of who decided what is gone. |
| Append-only op rows, folded in file order | Kept, at the long-term cost stated under Consequences. |
| `resolve --by client --quote <text>` | Rejected: the agent types the quote, so the proof is the forgery it should stop (contract-025 §3: "There is no `--quote` flag"). |
| Proof from a human-typed line in the session transcript | Kept, with the residual risk stated under Consequences. |
| Notify through `spawnSync` with no shell | Rejected for notify only: the client writes the command as a shell line, so notify is the one place a shell runs. |

## Decision

### The shared layout

We will keep two roots. D, the session dir, holds what belongs to one session: `usage.jsonl`, `usage-cursor.json`, `unattended.json` and `ltc-plan.json`. S, the shared dir, holds what every session of the repo shares:

| Path | What it holds | Written by | Rule |
|---|---|---|---|
| `S/inbox.jsonl` | inbox ops | escalate, resolve, mark-applied | append under lock `inbox` |
| `S/ledger.jsonl` | merge rows | the merge step | append under lock `ledger` |
| `S/queue/items/<Q-id>.json` | one queue item | intake, queue-next, queue-set | create with `createExclusive`, update with `writeJsonAtomic` under lock `queue` |
| `S/locks/<name>.lock/owner.json` | `{pid, host, token, since}` | `store.ts` | mkdir lock |

Outside a git repo every command that needs `<common>` exits 2 with `needs a git repo` (`bin/store.ts` `commonDir`).

`bin/store.ts` is the only code that locks files, writes shared state or sets a transcript root; `proofMain` in `bin/inbox.ts` walks the project dirs under the proof root (see the amendment). No new module imports `factory.ts`, because its top-level `await` would make an import cycle; `factory.ts` re-exports the helpers that moved to `store.ts`.

**The lock.** `withLock(dir, name, fn, {waitMs = 5000})` (`bin/store.ts` `withLock`) makes `<dir>/locks/<name>.lock` with `mkdirSync`, writes `owner.json`, runs `fn`, and removes the lock only if its token is still its own. A busy lock is retried every 25 ms. After `waitMs` it throws `StoreBusy`, exit 2 with `{error: "store busy: <name>"}` (`bin/store.ts`). A lock is stale when its owner pid is dead on the same host, when it has no readable owner file after 10 s, or when it is older than 120 s (`bin/store.ts` `STALE_AGE_MS`). A process never takes a second lock while it holds one.

The contract said to rename a stale lock aside. The code doesn't: a rename can move a lock that has just turned live. Instead one breaker at a time holds a `<name>.lock.break` mutex, re-reads the owner, and removes the lock only if it still carries the token judged stale (`bin/store.ts` `takeOver`). The cost is the age rule: a live owner that holds a lock past 120 s can lose it.

**Atomic writes.** `writeJsonAtomic` writes a tmp file and renames it over the target, retrying a rename refused with EPERM, EBUSY or EACCES 10 times, 20 ms apart (`bin/store.ts` `RETRY_RENAME`); Windows refuses a rename while a scanner holds the file.

**Exclusive create.** `createExclusive` writes a tmp file and hard-links it to the target, so the target appears whole or not at all; EEXIST returns false. A filesystem without hard links (EPERM, ENOTSUP) falls back to an exclusive open, and a reader treats an item it can't parse as absent (`bin/store.ts`).

**Append-only rows.** `appendJsonl` makes one `appendFileSync` call under the lock (`bin/store.ts`). `readJsonl` returns the rows and a count of bad lines, tolerates CRLF and a BOM, and skips a torn last line (`bin/store.ts`).

**Cross-platform rules**, for every piece of wave 2:

- Paths are normalised to `/`, and file names use only `[A-Za-z0-9._-]`.
- git calls use `--path-format=absolute` and `-c core.quotepath=off`.
- Child processes run as `spawnSync(cmd, args)` with `windowsHide` and no shell; notify is the only exception.
- Untrusted text never reaches a command line. It goes through a `--*-file` argument or stdin.
- No `/tmp`, no `flock`, no `fs.watch`, and no bash-only syntax in prose commands.
- Code that branches on `process.platform` takes the platform as a parameter, so a test can cover darwin and win32 on any machine.

### The inbox

We will route every exception that needs a decision through `S/inbox.jsonl`. Each kind has a resolver, `by`; a blocking item holds its linked crews at `factory start` and `factory admit` until it is resolved.

| Kind | Resolved by | Blocking |
|---|---|---|
| client-question | client | per call |
| scope-change, client-trigger, long-term-cost, budget, allowance-spent, doctor-bundle | client | yes |
| blocked, stall-unrecovered | pm or client | yes |
| push-pr, prod-deploy, intake-triage | client | no |

**Ops.** The file holds four kinds of row, and a reader folds them in file order:

- `open`: `{id, ts, kind, session, crews, ref, blocking, title, detail, codeHash}`. The id is `E-<yyyymmdd>-<6hex>`.
- `link`: another crew joins an open item. It can only turn `blocking` on.
- `resolve`: `{decision, by, note, quote, raiseUsd?}`, where the decision is `approve`, `reject`, `answer`, `done` or `dismiss`.
- `applied`: this session has acted on the resolution.

A crew is the pair (session, slug), so `crews` is always read with the op's `session`.

**Commands.** Each prints one JSON line and exits 0 for ok, 1 for a refusal, 2 for a usage error.

- `factory escalate --kind k (--title t | --title-file p) [--detail d | --detail-file p] [--crew s]... [--ref key] [--blocking]` prints `{id, kind, deduped, code, notified}`. On a dedupe `code` is null.
- `factory inbox [--open | --unapplied [--session sid]] [--kind k] [--crew s]` prints `{items, open}`. The filters narrow `items` only: `open` is the total of open items whatever the filters. `--unapplied` lists resolved items with no `applied` op from this session; with `--session sid` it lists only the items that session opened and reads `applied` for that session. An item whose resolve row did not count is open and carries `reopened`; a counted client row lists the proven typed text as its `note`, and carries `noteUnbound` when its stored note differed.
- `factory inbox --recover-codes` needs no `--dir` and prints `{codes: [{id, code, session}]}`, the surviving codes of open items.
- `factory resolve <id> --decision d --by client|pm --code c [--note-file f | --note t] [--raise-usd n]`. Untrusted note text goes through `--note-file`.
- `factory mark-applied <id>`.

**Dedupe.** When `ref` is not null and an open item with the same kind and ref exists, escalate appends a `link` instead of a second `open`, returns `deduped: true` with `code: null`, and sends no notify. The linked crew gets no new code; the client resolves with the code of the first `open`. A null ref never dedupes. Eight concurrent escalates with one ref leave one `open` and seven `link` rows (`tests/inbox.check.ts` test "inbox: 8 concurrent escalates with one kind and ref leave one open op and 7 links").

**The code.** Escalate makes a 6-character code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, which leaves out the look-alikes 0, O, 1, I and L. It prints the code once and stores `codeHash = sha256(id + code)` in the inbox file; the plain code stays only in a sidecar file until the item resolves (see the amendment). The code reaches the client in the PM's message and in the notify row. `factory inbox` shows no code of an open item, and only `--recover-codes` prints the code of one. In a resolved item's `quote`, `maskCode` in `bin/inbox.ts` replaces each whitespace-separated token that hashes to the item's code with `[code]`, because a resolve row that later stops counting makes that spent code live again. Known gap: a `/truss:inbox` slash line with no note ends `CODE</command-args>`, that token doesn't hash to the code, and the listing shows the code. The mask covers the listing only: the output of `resolve` and the row in `S/inbox.jsonl` keep the typed line. With a `budget` key and no `notify`, the budget hold's `why` (the held entry of `start`, the output of `admit`) carries the id and code for the PM to relay (`factory.ts` `holdOf`).

**Refusals.** `resolve` exits 1 on an item already resolved, on `--by pm` for a client kind, on `--raise-usd` for any kind but budget, on a wrong code, and on `--by client` with no human-typed proof (below) or with a note that differs from what the client typed after the code. `budgetRaises(repo, session)` returns the approved budget raises; `blockingFor(repo, session, slug)` returns the ids that hold a crew, and start and admit refuse it with `awaiting client: E-…`.

**Events carry ids and kinds only.** The `escalate`, `resolve` and `notify-error` events hold `id`, `kind`, `blocking`, `decision`, `by`, and an error text of at most 200 characters (`docs/events.schema.json` key `allOf.if`). The title, detail, note, quote and code stay in the inbox file. `tests/inbox.check.ts` test "inbox: events.jsonl carries ids and kinds only, never the quote, title, detail or note" pins this.

**Notify.** When the `notify` key of `.claude/truss.json` is set, a new `open` fires it once, after the lock is released:

1. factory runs `bin/notify-run.ts` with `spawnSync`, a 15 s timeout and `{repo, row}` on stdin (`tests/inbox.check.ts` `runNotify`).
2. notify-run starts the client's command with `spawn(cfg.notify, {shell: true, detached: true, windowsHide})`, writes the open row plus the code to its stdin, and waits up to 10 s.
3. On timeout it kills the whole process tree: a negative-pid SIGKILL of the group on POSIX, `taskkill /T /F /PID <pid>` on win32. The platform is a parameter (`tests/inbox.check.ts` test "inbox: the notify tree kill takes the platform as a parameter, taskkill on win32 and a group kill on darwin"), and a grandchild that sleeps dies within 11 s (`tests/inbox.check.ts` test "inbox: a notify grandchild that sleeps is killed within 11 s").
   - **Amendment 2026-11-11 (0.26.0).** A `setsid` descendant leaves the group, so the group kill alone misses it. On POSIX the kill first walks the descendants (from `/proc/<pid>/task/*/children` on linux, `pgrep -P` on macOS and other POSIX, through the `Ops` seam) and SIGKILLs each, then the group. A missing walk tool gives what was found so far; win32 is unchanged.
4. The command gets `TRUSS_INBOX_ID`, `TRUSS_INBOX_KIND` and `TRUSS_INBOX_REPO`. `TRUSS_INBOX_TITLE` is set only off win32, because cmd.exe expands `%VAR%` before it parses the line, so a title could inject a command.
5. Notify fails open. Any failure gives `notified: false` and a `notify-error` event, and the escalation still succeeds. With no `notify` key, `notified` is null.

`notify` is committed config. Anyone who can commit to `.claude/truss.json` picks a command that runs on every teammate's machine, with the same trust as the `deploy` key.

### The forged-approval fix

We will accept `resolve --by client` only with proof that the human typed the decision.

**The `/truss:inbox` skill.** `skills/inbox/SKILL.md` sets `disable-model-invocation: true`, so the model can't start it; only a human typing the slash command can. With no arguments it lists the open items. `/truss:inbox <approve|reject|answer|done|dismiss> <E-id> <code> [raise <usd>] [note…]` (a `--raise-usd` must equal the typed `raise <usd>`, else resolve refuses; `budgetRaises` keys a raise on the session its ref names) runs `factory resolve <E-id> --decision <d> --by client --code <code>`.

**What `resolve --by client` checks.** It reads the main transcript of this session, found by `proofMain` in `bin/inbox.ts` under `proofTranscriptRoot()` in `bin/store.ts`: `.claude/projects` in the OS user's home dir, never a root from the environment. It looks for a line with `type: "user"` that:

- is not `isMeta` and not `isSidechain`, and is not `isCompactSummary` or `isVisibleInTranscriptOnly`;
- has `origin.kind` `human` and `promptSource` `typed`, or is the `/truss:inbox` slash shape (`SLASH_SHAPE`) with `origin` absent or human and `promptSource` absent or typed; any other line with no `origin` is refused;
- is not command output or an agent's return: its text holds none of the `OUTPUT_TAG` tags (`bash-input`, `bash-stdout`, `bash-stderr`, `local-command-stdout`, `local-command-stderr`, `local-command-caveat`, `task-notification`), because the first `<command-args>` anywhere in such text would otherwise count;
- has a string `uuid`, a `sessionId` equal to the session, and a `parentUuid` that resolves to an earlier row of the same file; `parentUuid` may be null only when no user or assistant row comes before it (`chainOk`);
- is not a scheduled line: no `wakeupSource`, `scheduledTaskId` or `scheduledFireId`, and `turnOrigin` (if present) is `human` and `promptSource` (if present) is `typed` (a `/loop` wakeup line has no `origin` and no `isMeta`, and its text is the `prompt` the agent passed to ScheduleWakeup);
- has string content, or only text blocks and no `tool_result`;
- is newer than the item's `open` op;
- starts with `<decision> <E-id> <code>` in the `<command-args>` text (or in the prompt, without a leading `/truss:inbox`), where the code hashes to the item's `codeHash`, and with a raise goes on `raise <usd>` with the same amount (`proof` in `bin/inbox.ts`; `reject <id> <code> I do not approve this` is a reject; the word `approve` in the note doesn't make it an approve).

The text of that line, cut to 1000 characters, is stored as `quote`. There is no `--quote` flag, so an agent never types the quote. A retro can check each quote against the human-typed prompts of all the project's sessions.

Known limit: a `promptSource` other than `typed` is refused, so a plain-text `approve <id> <code>` the client typed while the agent was busy (`promptSource: "queued"`, `origin.kind` and `turnOrigin` human) is refused, and so is a `claude -p` prompt (`promptSource: "sdk"`). A line with no `promptSource` counts only in the slash shape. The client types the line again when the agent is idle.

**The probed slash-command shape.** The tester took the shape from real transcripts and recorded a scrubbed sample in `tests/fixtures/inbox/slash-command.jsonl`. A human slash command is a main-thread user line, `isSidechain: false` and no `isMeta`, whose content is one string:

```
<command-message>truss:inbox</command-message>
<command-name>/truss:inbox</command-name>
<command-args>approve E-… CODE go ahead</command-args>
```

That line holds the id, the decision word and the code, so it qualifies. The lines that follow it don't: the skill body arrives as an `isMeta` line with an `ARGUMENTS:` line, a tool result is a `tool_result` block, and the fixture's sidechain and meta copies of the plain command text are excluded by their flags. `tests/inbox.check.ts` test "inbox: the probed slash-command shape qualifies as a typed prompt" refuses those lines alone and accepts the set once the slash-command line is in it. When a future Claude Code drops the arguments from that line, the skill asks the human to type the decision line as a plain prompt, which qualifies on its own.

**The live check runs after release.** The fixture's shape comes from other truss slash commands in real transcripts (for example `<command-name>/truss:run</command-name>` lines in this repo's main transcripts), with the name changed to `/truss:inbox`. `/truss:inbox` itself exists only once this plugin version is installed, so the live `/truss:inbox` check can only run after release. The first real resolve after release confirms the shape still matches.

## Consequences

**Positive**

- An agent can no longer approve for the client by typing a flag; it needs the code that `escalate` prints only to the agent that raised the item, typed back in a line only the human writes (an agent that holds the code can't write that line).
- Every session of a repo sees the same inbox, ledger and queue, with no filter on session dirs.
- One file owns locking and atomic writes, so the cross-platform cases are fixed once.
- The notify command can't hang an escalation or leave a stray process.

**Negative**

- **Residual risk.** An agent with Bash, running as the same OS user, can write a transcript line that passes the proof, because every field the proof reads sits in a file that user can write. truss can't stop a same-user process. This fix raises the bar from typing one flag to deliberate tampering with Claude Code's files. A `resolve` row appended to `S/inbox.jsonl` with no such line no longer counts (see the amendment). What is left against a forged transcript line is a retro that checks each `quote` against the human-typed prompts.
- The proof rests on Claude Code's transcript layout, which is not a documented interface. A change to it makes every client resolve fail closed until truss follows, and because a resolve is proved again at every read, it also makes items already resolved block again. The plain-prompt fallback covers the case where the arguments move.
- **Append-only rows are a long-term cost.** `S/inbox.jsonl` and `S/ledger.jsonl` grow without bound, at about 1 KB per row (contract-025 §9). Every later reader is bound to the row shape, and changing it means migrating the history or reading both shapes forever.
- A live lock held past 120 s can be broken by a waiter.
- `notify` runs a shell line from committed config on every teammate's machine.

**Neutral**

- The events log stays small and free of client text; a reader who needs the text reads the inbox.
- The `/truss:inbox` skill with no arguments shows no code: it lists open items, and the inbox file holds only their hash. It runs `--recover-codes` only when the client asks about an item whose code was lost.

**What reversing touches.** Moving shared state back into session dirs touches `bin/store.ts` (`sharedDir`), every reader of `S/inbox.jsonl`, `S/ledger.jsonl` and `S/queue/`, the `blockingFor` call sites in `factory start` and `factory admit`, and the existing rows, which would need a migration. Dropping the transcript proof touches `resolve` and `verifiedItems` in `bin/inbox.ts`, `longTermItems` in `bin/guard.ts`, `skills/inbox/SKILL.md`, `tests/fixtures/inbox/`, the resolve cases of `tests/inbox.check.ts` and `tests/trust-026.check.ts`, and reopens R-56. Replacing the mkdir lock touches only `withLock` in `bin/store.ts` and `tests/store.check.ts`.

## Amendment 2026-11-11: a resolve row counts only with verified client proof

Decided by: the PM and the product owner, with the client away (decision 23:53 of the 0.26.0 run). Source: 0.26.0 goal item 1. The cases are in `tests/trust-026.check.ts`.

Until this amendment the proof guarded only `factory resolve`. Readers folded every row of `S/inbox.jsonl`, so any process with shell access could append a `resolve` row and lift a block.

**The verified fold.** `verifiedItems(repo)` in `bin/inbox.ts` is the one reading of the inbox. `blockingFor`, `budgetRaises`, the dedupe in `escalate`, `resolve`, `mark-applied`, `factory inbox` and `longTermItems` in `bin/guard.ts` all use it. It judges each resolve row in file order:

- For `blocked` and `stall-unrecovered`, the kinds a PM may resolve, a row that says `pm` or `client` counts with no proof.
- For every other kind, only a `by: client` row can count, and only when it is proved again, at read time, against the main transcript of the session the row names. Any session's fold verifies the same way.

The first row that counts wins. A row that does not count is absent, so a forged row can neither lift a block nor stop the real resolve, and its raise is not counted. The item stays open, and the listing carries `reopened: {reason, by, ts, decision}` for the first row that failed.

**What the proof requires.** The read-time proof uses the same `typedText`, `chainOk` and `proof` as `resolve`, so a row counts only with a typed transcript line that meets every condition listed under "What `resolve --by client` checks". The row's own decision and `raiseUsd` must match that line, and a row that stores a `quote` must have a typed line that starts with it. A proof replayed from another item fails on the id and the code. A swapped decision word fails the word check.

**The note.** `resolve` refuses a `--note` or `--note-file` that differs from the rest of the typed line after `<decision> <id> <code> [raise <usd>]`, whitespace normalised, and a note given as empty when words were typed. At read time the note does not decide whether the row counts, because the client typed the decision and the code. For a client row that counts by proof, the folded row's note is always the proven typed text (`verifiedItems` in `bin/inbox.ts`), never the stored note, so the listing, `--unapplied` and every step that reads the fold see only what the client typed. A counted row whose stored note does not match keeps its decision and carries `noteUnbound` in the listing, which marks that the stored note differed. The kinds that any party may resolve (`blocked`, `stall-unrecovered`) always count a `by: client` row, but take the same proof: a proven row lists the typed text, and an unproven one with a stored note keeps counting and carries `noteUnbound`, so its note is never presented as the client's words. A `by: pm` row on those kinds keeps its note as the pm's.

**The slash shape is inferred.** No real `/truss:inbox` row was found in any transcript when this was planned. `typedText` accepts the shape of its sibling commands: `origin.kind` human with no `promptSource`, and no `origin` at all, each only as `SLASH_SHAPE`, and neither needs a `promptId`. `tests/fixtures/inbox/slash-origin-human.jsonl` and `slash-no-origin.jsonl` hold those shapes. The first real `/truss:inbox` resolve tests the inference. When it does not match, `resolve` refuses, and the refusal tells the client what to type as a plain prompt.

**The proof-only root.** `proofTranscriptRoot()` in `bin/store.ts` is `.claude/projects` under `os.userInfo().homedir`. It reads no `TRUSS_TRANSCRIPTS_ROOT`, `CLAUDE_CONFIG_DIR` or `HOME`, so a caller can't point the proof at a file of its own. `transcriptsOf` keeps its environment-based root for reading spend and for the queue's stale rule, which grant no authority. The cost is a client on a non-default `CLAUDE_CONFIG_DIR`: the proof fails closed, so that client can't resolve any client item, budget raises included, and has no workaround. The refusal names `CLAUDE_CONFIG_DIR` and the root it looked in; the variable is read for that message only.

**The cost of proving at read time.** `scanFile` reads each transcript whole, searches its bytes for each item id, and parses only the lines that hold an id and `"type":"user"`. It keeps one scan per file per process, valid while the path, size, mtime, ctime and inode are the same and the ids it holds cover the ids asked for. Nothing is cached on disk, because a cache file would be no harder to forge than the row it vouches for.

The cost grows with history. Every client resolve stays in the file for good, so each process that folds the inbox reads every transcript named by a client resolve row. Its read time grows linearly with the total size of those transcripts, and its search time with that size times the number of resolved items per transcript. Every factory command is a new process, so the cache does not carry over between commands, and nothing prunes old rows. The cases pin two points on that curve: one admit over a 100 MB transcript stays within 2000 ms and reads the file once, and an admit over 20 resolved items in 5 transcripts of 4 MB each stays within 2000 ms and reads each file once. A transcript too large for a Buffer counts as unreadable, and its rows do not count.

**The escalate code survives a crash.** Inside the lock and before the append, `escalate` writes `D/escalate-code-<id>.json`, `{id, code}`, created with mode 0600. `resolve` removes it from the dir of the session that raised the item. `factory inbox --recover-codes` walks the session dirs under `<common>/truss/` and prints the code of each open item whose sidecar hash matches, so a later session that doesn't know the dead session's dir can recover it. A code alone lifts nothing, because a resolve still needs the typed line. The default listing carries no code of an open item.

**Rows written before 0.26.** They are not grandfathered by a version or a date, because both are fields a forger writes. They go through the same proof. A 0.25.0 row with a good proof counts, the listing shows the proven typed text as its note, `noteUnbound` marks a stored note that does not match, and its budget raise stays. A row whose transcript is gone counts as absent: the item reopens, its raise stops counting, and the listing carries the reason and the row's `by`, `ts` and decision, so the client sees why it came back.

**Raise and repo binding.** A row with no `raiseUsd` is never proved by a typed line that carries `raise <usd>`: the typed amount cannot be dropped by a row, so a forged plain approve neither lifts the block nor stops the real resolve. A typed line also proves a row only for the repo its session ran in: the transcript row's `cwd` must lie under the repo (worktrees included) or share its git common dir, so an open and resolve row copied from another repo's inbox is refused. A row with no `cwd`, or a `cwd` that no longer exists outside the repo, cannot be shown foreign and passes (real Claude Code rows carry `cwd`).

**Residual risks.**

- A process running as the same OS user can write a transcript line that passes these checks. It can read the code from the sidecar or from the agent's own output, and it can give the line a valid `uuid`, `sessionId` and `parentUuid`. The proof raises the cost of forging; it does not end it.
- A deleted or rotated transcript makes an item block again (fail closed), and its budget raise stops counting. The same happens to every resolved item if Claude Code changes the undocumented `uuid`, `parentUuid` or `sessionId` fields. The client resolves the item again by typing the decision with its code. `--recover-codes` can't supply that code, because the first resolve removed the sidecar; it is in the client's original message and in the old row's `quote` in `S/inbox.jsonl`.
- A `by: pm` row for `blocked` or `stall-unrecovered` needs no proof, so any process that can append to the inbox can lift those two kinds. That is the kinds' rule, not a gap in the proof.
