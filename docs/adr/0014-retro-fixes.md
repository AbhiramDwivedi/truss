# ADR-0014: retro fixes: a stress persona, a main-thread edit gate, the background-task reply rule, tester routing and the ancestor watch

Status: proposed, 2026-10-31. Written by the design crew `fixes-design` (stage 0 of goal `retro-fixes`). It becomes accepted when the PM (project manager) merges this crew. The goal's approval is `auto` (decisions.md, 08:54): it has no section-4 client trigger, P-8 is the client's own 04:26 ruling, and the `ui/` items are the client's 05:05 product-owner ruling.

VERDICT: change. One module changes: **hooks** gains a principle (while a run is active, the PM doesn't edit code, tests or docs itself) and a new seam, `mainEditVerdict`. Nothing in `hooks/register.ts` refuses a main-thread Edit or Write today: its only Write and Edit handler stamps the decision log's times (`hooks/register.ts:2110-2121`), and its gates are on SendMessage, Agent, Workflow and fetch (`:1884`, `:1928`, `:2005`, `:2125`). Every other module extends: **workflows** (`roles.json`, the `stage.js` briefs), **factory** (`roleAudit` replaces an inline check), **ui-session** (`replyStep` replaces an inline rule), **ui-web** (the page fixes), **ui-server** (the ancestor watch), **retro-skill** (one sentence) and **evals** (two `## Snippets` lines of ADR-0007).

Decided by: client (rulings 03:39, 04:26, 05:05 and 05:07 in decisions.md), through checker-17's triage (08:13) and checker-18's review (08:38), both followed by the PM.

## Context

The end-of-run retro of this session (ADR-0012) kept 17 findings to fix now (checker-17, 08:13): S-0, F-1, F-7, F-9, F-17, F-24, F-25, F-27, F-30, F-32, F-35, F-38, F-39, F-40, P-1, P-4 and P-8. The PM, acting as product owner by the client's 05:05 ruling, added fixes to `ui/` that the horoscope session and the end-of-run sweep found. Most of these are prompt or brief text and need no design. Five need one, because they add a seam, a role or a rule that other files must agree on:

- **F-25.** The stress test runs as `truss:qc-engineer` (`workflows/roles.json:10`, `agents/foreman.md:64`), whose tools are `Read, Grep, Glob, Bash` (`agents/qc-engineer.md:6`). It has no Write tool, so it falls back to heredocs and `node -e`, which the worktree guard refuses. One stress test also tried `/usr/bin/time`, which isn't installed (findings.json F-2: exit 127; on this host `ls /usr/bin/time` gives `No such file or directory`).
- **P-8.** The client asked whether the PM's role should be tightened so it never does the work itself, and ruled "yes, fix it through the retro at the end" (decisions.md, 04:22 and 04:26).
- **The false reply card.** Every top-level `result` opens a reply card (`ui/server/session/session.ts:99-115`), even while background tasks still run (horoscope feedback 4, decisions.md 07:59).
- **F-27.** A QC or stress finding that needs a test change goes to a builder. The builder's "Files you may change" is every file the crew owns (`workflows/stage.js:216-221`), but a builder commit that touches a tester's file is a sure QC FAIL (`workflows/stage.js:530-538`).
- **The Windows orphan.** `watchParent` watches only the direct parent (`ui/server/lifecycle.ts:32-45`). On Windows, `npm --prefix ui start` leaves `ui/server/main.ts` running when the task stops, because npm-cli and `cmd.exe` survive and the server's parent is `cmd.exe` (decisions.md, 06:00).

## Decision 1: the stress persona, `truss:stress-engineer` (F-25)

A new agent, `agents/stress-engineer.md`, named `truss:stress-engineer`, runs every stress test. It covers F-2, F-11 and F-20, which checker-17 dropped as duplicates of F-25.

- **What moves.** The stress-test section of `agents/qc-engineer.md` (`:78-90`, from `## Stress-test mode` to the line before `## Report`) moves to the new file. That includes the own-worktree check, which accepts `worktree-agent-` and `worktree-wf_` branches. `qc-engineer.md` either loses the section or keeps a one-line pointer to the new agent.
- **Tools.** Read, Grep, Glob, Bash, Write and Edit. The prompt limits Write and Edit to scratch and `mkdtemp` dirs and the agent's own worktree. It still never commits, never pushes, and resets and cleans its worktree before it reports, as today.
- **Timing.** The prompt times probes with `date +%s%N` or node, never `/usr/bin/time`.
- **QC stays read-only.** `qc-engineer.md` keeps `tools: Read, Grep, Glob, Bash`, and `skills/init/SKILL.md:71` still declares `truss:qc-engineer` and `truss:checking-engineer` read-only. `tests/contract.check.ts:39` pins that declaration.
- **Who names it.** `workflows/roles.json`'s `stress` row becomes `truss:stress-engineer` ([ADR-0009](0009-workflow-factory.md), Decision 2). `agents/foreman.md:64` names it on the foreman path, and the example plan row at `skills/run/SKILL.md:226` names it in place of "`truss:qc-engineer` in stress-test mode".
- **The audit, `roleAudit`.** A pure `roleAudit(role, agentType, toolNames)` in `bin/factory.ts` replaces the inline check at `bin/factory.ts:1002-1003`, and `recordRun` calls it. For `stress` it accepts `truss:stress-engineer` or `truss:qc-engineer`. A `qc` role that used Write or Edit stays flagged (Seams, section 2).
- **Session restart.** `factory.ts` is live as soon as it merges, but a session doesn't reload agent definitions (checker-18, C2). So once crew `stress-persona` merges, no stress test is started until the session restarts. The audit accepts `truss:qc-engineer` for `stress` so that a stress test started before the merge isn't flagged.

The stress test keeps its `Truss-Role: stress` value, its `<crew>-stress` name and its report format: the first line is `STRESSTEST: <n> findings`.

## Decision 2: the main-thread edit gate, `mainEditVerdict` (P-8)

A new PreToolUse gate in `hooks/register.ts` refuses the PM's own Edit, Write, MultiEdit and NotebookEdit calls on repo files while a run is active. The PM delegates the change to a crew or an agent instead. The verdict is a pure function, `mainEditVerdict` (Seams, section 1), and the handler only gathers its inputs.

- **Main thread only.** A call with an `agent_id` is a subagent's and is never gated.
- **Run active.** This session's `<truss dir>/plan.json` parses and holds a crew whose `status` is neither `merged` nor `dropped`. The truss dir comes from `trussDir()` (`hooks/register.ts:128`), the plan from `planPath()` and `parsePlan()` (`hooks/register.ts:365`, `:374`).
- **Exempt paths.** Each of these is allowed:
  - the truss dir;
  - the requirements path, `requirements.md` in the directory of `.claude/truss.json`'s `architecture` key (`docs/architecture.md` gives `docs/requirements.md`);
  - `<repo>/.claude/settings.json` (client ruling 05:07);
  - every path outside the repo and its worktrees, such as memory, the scratchpad and `~/.claude`.
- **Fails open.** No plan, a plan that doesn't parse, or any error in the handler lets the call through, as every truss hook does (see "Failing open" in the architecture doc).
- **Bash writes are not gated.** A shell redirect or `sed -i` from the main thread goes through this gate untouched. F-7's rule covers them: a refusal is never retried by another route, renamed or encoded. The gate isn't a sandbox; it makes the PM's own edits fail loudly, so the delegation rule in `skills/run/SKILL.md` (P-8, crew `pm-prompts`) is enforced where the tool call is plain.

The deny text starts with `[truss] Refused:` and tells the PM to delegate the change to a crew or agent. Crew `hook-gates` wires the handler and pins it with `tests/main-edit-gate.check.ts`. Once it merges, the gate is live for the PM of this run too, which is intended (plan-retro-fixes.md, "Note for the PM").

## Decision 3: the reply rule, `replyStep`

A pure `replyStep` in `ui/server/session/` decides when a reply-needed card opens. It replaces the inline rule in `onMessage` (`ui/server/session/session.ts:99-115`), where every top-level `result` opens one. This amends the reply-card bullet of [ADR-0011](0011-local-web-ui.md), Decision 3.

- A top-level `result` with background tasks above 0 opens no card and holds its text. The text stays readable, and the client can still answer it from the message box (R-7 kept: approvals arrive while crews run in the background).
- When the background tasks drop to 0 with no turn running and a text held, exactly one card opens with that text.
- A top-level `result` with 0 background tasks opens a card, as today.
- An `init` clears the held text, so a later drop to 0 opens nothing. A message the client sends starts a turn, and its `init` clears the held text the same way.
- A subagent `result` (`parent_tool_use_id` set) opens nothing.
- The queued-message path stays: when `replyStep` opens a card and a message is queued, the queued message answers that card and is dispatched, as at `session.ts:110-114`.
- Real `canUseTool` question and permission cards are unchanged.

The count is the session's `backgroundTasks` after `foldMessage`. There is no change to `ui/contract/state.schema.json` (checker-18, 08:38).

**The page (ui-web).** While `session.status` is `waiting` and `backgroundTasks.length` is N above 0, the header reads `working (N background tasks)`. With no open reply card in that state, the page shows "Agents still running; nothing needed from you", with no Approve or Deny button, and the message box stays enabled. The page derives all of this from the existing `waiting` status and `backgroundTasks`, and styles the notices by id. The other page fixes are in Seams, section 5: focus after a keyboard answer (R-18), status-worded notices, the auto-growing goal box, the open-request count in the tab title, and opt-in desktop notifications for question and permission requests only.

**`ui/contract/live.check.ts`.** On a timeout, its `waitFor` prints the transcript the state carries, beside the session status and requests it prints today (`live.check.ts:96`). Its wait for "the turn to end with a reply card" (`live.check.ts:182-191`) follows this rule: the card may open only once the turn's background tasks drop to 0.

## Decision 4: test-needing findings go to a tester (F-27)

A QC or stress finding that names a file a tester task owns goes to a tester fix member, labelled `<slug>-tester-<n>` by `nextLabel` (`workflows/stage.js:110-115`). Its commits carry `Truss-Role: test-writer`. Every other finding goes to a builder fix member, as today.

`fixPrompt`'s "Files you may change" (`workflows/stage.js:218`) leaves out the files of the crew's tester tasks, so a fix builder is never told it may change them. This covers F-4 and F-22, which checker-17 dropped as duplicates. Crew `stage-briefs` builds it and pins it in `tests/stage-briefs.check.ts`, which drives `fixPrompt` and `stressTestPrompt` through the workflows harness.

## Decision 5: the ancestor watch (the Windows orphan)

`watchParent` (`ui/server/lifecycle.ts:32`) watches the whole ancestor chain, not only the direct parent. When any ancestor dies, it calls `onGone` once and the server shuts down.

- **Interval.** The watch checks at the existing 1 s interval (`opts.intervalMs ?? 1000`, `lifecycle.ts:42`) on the same unref'd timer, and it is still skipped under ppid 1. The existing ppid-change check stays.
- **Where the chain is read from.** The chain is read once, at start, through an injected `ancestors()` that returns the pids from the parent upward. Each tick then checks every pid with the injected `alive()`, which defaults to the existing `pidAlive`, so no tick starts a child process. The default `ancestors()` per platform:
  - Linux: field 4 (ppid) of `/proc/<pid>/stat`, read after the last `)`, because the command name can hold spaces and parentheses.
  - Windows: one `Win32_Process` snapshot of `ProcessId`, `ParentProcessId` and `CreationDate`, from PowerShell's `Get-CimInstance`. The walk stops at a parent whose `CreationDate` is later than its child's, because Windows reuses pids and `ParentProcessId` can name a process that took the dead parent's pid ([Win32_Process](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process), `ParentProcessId`).
  - macOS: `ps -o ppid= -p <pid>` for each step.
  - The walk stops at pid 1 or below, at a pid already seen, at a pid that isn't alive, or when the read fails.
- **Fails safe.** When `ancestors()` fails or times out, the watch falls back to today's parent-only check. A child process for the read gets a 10 s timeout, the same as each git child process (architecture doc, Service pack rule 12).
- **Proof.** A test injects a simulated chain, shell to npm-cli to `cmd.exe`, and shows that the death of any one of them fires `onGone` once, that a live chain fires nothing, and that a failed `ancestors()` keeps the parent-only behaviour. The Windows proof on a real host is the horoscope session's (plan-retro-fixes.md, ui-lifecycle).

TODO: none of the default `ancestors()` commands above has run on Windows or macOS. The Linux field-4 read was checked on this host (`cat /proc/self/stat`). Crew `ui-lifecycle` confirms the Windows query on a real host through the horoscope session.

A dead ancestor's pid can be reused before the next tick. Then `pidAlive` reports the new process as alive and the watch misses the death. With a 1 s interval this is unlikely, and the "port in use" message (`lifecycle.ts:99`) still names the live server's pid.

## Decision 6: the retro's scope sentence (S-0)

On the truss repo, "code a truss run delivered" means product code outside the plugin, such as `ui/**`. A plugin file stays in scope even when a crew of this run changed it (checker-17, 08:13; client rulings 03:39 and 04:26). [ADR-0012](0012-self-improving-retro.md) section 6 and `skills/retro/SKILL.md` step 5 replace their old sentence with this one, word for word:

> A target that is product code a run delivered (on the truss repo, anything outside the plugin, such as ui/**) is never in scope; a plugin file stays in scope even when a crew of this run changed it (client rulings 03:39 and 04:26).

The reason sentence stays: triage drops an out-of-scope finding with the reason `out of scope (R-30)`. `tests/retro-skill.check.ts` pins the new sentence.

## Seams to pin

The fixes-design crew's test-writer writes the contract files. Each contract imports its producer by a path relative to its own file. When the import fails, or the export is missing, it throws the exact `producer missing:` line. Behaviour tests are named `case: ...`, and file-shape tests `file: ...`.

| Seam | Producer | Consumer | Contract | Missing line |
| --- | --- | --- | --- | --- |
| `mainEditVerdict` | `hooks/register.ts` | the PreToolUse handler for Edit, Write, MultiEdit and NotebookEdit | `tests/main-edit-gate-contract.check.ts` | `producer missing: hooks mainEditVerdict` |
| `roleAudit`, plus file shapes | `bin/factory.ts`, called from `recordRun`; `agents/stress-engineer.md`; `workflows/roles.json` | `factory.ts finish` | `tests/stress-engineer-contract.check.ts` | `producer missing: factory roleAudit`, `producer missing: agents/stress-engineer.md` |
| `replyStep` | `ui/server/session/index.ts` (a new file under `ui/server/session/`, exported from the index) | `onMessage` in `ui/server/session/session.ts` | `ui/contract/background-reply.check.ts` | `producer missing: ui/server/session replyStep` |
| The git-dir snippets | `agents/stress-engineer.md` | ADR-0007 `## Snippets` | `tests/contract-evals.check.ts`, `tests/speed-rules.check.ts` | `producer missing: agents/stress-engineer.md` |

### 1. `mainEditVerdict`

```ts
mainEditVerdict(
  call: { tool: string; filePath: unknown; agentId: string | undefined },
  ctx: { repoRoot: string; worktreeRoots: readonly string[]; trussDir: string | undefined; planText: string | undefined; architecture: string | undefined },
): { deny: string } | undefined
```

Run active: `planText` (this session's `<truss dir>/plan.json`) parses and has a crew whose status is neither `merged` nor `dropped`.

Refused (the deny text starts with `[truss] Refused:` and says to delegate to a crew or agent):

- a main-thread `Write` to `<repoRoot>/hooks/register.ts` while a run is active;
- the same through `Edit`;
- the same path inside a worktree root.

Allowed (returns undefined):

- `<trussDir>/decisions.md` and `<trussDir>/plan.json`;
- the requirements path: `requirements.md` in the architecture key's directory (`docs/architecture.md` gives `docs/requirements.md`);
- `<repoRoot>/.claude/settings.json`;
- any path outside the repo and its worktrees (memory, the scratchpad, `~/.claude`);
- any call when no run is active;
- any call with `agentId` present (a subagent);
- any call when `planText` is undefined or doesn't parse (fails open);
- a tool other than Edit, Write, MultiEdit or NotebookEdit.

Bash writes are not gated; F-7's rule covers them (Decision 2).

### 2. `roleAudit`, plus file shapes

```ts
roleAudit(role: string, agentType: string | undefined, toolNames: readonly string[]): string | undefined
```

Accepted (returns undefined):

- stress as `truss:stress-engineer`;
- stress as `truss:qc-engineer`;
- stress as `truss:stress-engineer` using Write and Edit;
- qc as `truss:qc-engineer` using Read;
- builder as `general-purpose` using Write.

Flagged (returns a reason): stress as `general-purpose`; qc as `truss:qc-engineer` using Write; qc as `truss:stress-engineer`.

File tests:

- `agents/stress-engineer.md`'s frontmatter tools include Write and Edit;
- `workflows/roles.json` maps `stress` to `truss:stress-engineer`;
- `agents/qc-engineer.md`'s tools are exactly `Read, Grep, Glob, Bash`;
- `agents/stress-engineer.md`'s worktree check accepts `worktree-wf_` branches.

### 3. `replyStep`

```ts
replyStep(
  state: { turnRunning: boolean; held: { text: string; isError: boolean } | null },
  msg: unknown,
  backgroundTasks: number,
): { state; open: { text: string; isError: boolean; backgroundTasks: number } | null }
```

`backgroundTasks` is the count after `foldMessage`. Cases:

- A top-level result with tasks above 0 opens no card and holds its text, so it stays readable and answerable (R-7).
- Tasks dropping to 0 with no turn running and a held text open exactly one card with that text.
- A result with 0 tasks opens a card.
- An init after a held result clears it, and a later drop to 0 opens nothing.
- A subagent result (`parent_tool_use_id` set) opens nothing.
- A drop to 0 with nothing held opens nothing.

Real `canUseTool` question and permission cards are unchanged.

### 4. `tests/contract-stubs.check.ts`

For each of the three contracts above:

1. It makes a `mkdtemp` tree and copies the contract file to the same relative path.
2. It writes a deny-all stub producer, whose export always refuses, flags or opens, and then an allow-all stub, which never does. For each stub it runs `node --test --test-name-pattern '^case:'`.
3. It requires a non-zero exit, at least one `not ok`, and no `producer missing` line.

So a constant answer can't pass any contract. This file is green from stage 0 on and stays in the full suite.

### 5. `ui/contract/e2e/page-fixes.spec.ts`

It is self-contained: it starts `createServer` (`ui/server/http/index.ts`) and `createRegistry` the way `ui/e2e/harness.ts` `startInterface` does, on port 0, and imports nothing from `ui/e2e/`. It has seven tests, and all seven fail on today's `ui/web`:

1. R-18: after a keyboard answer to a question card, `document.activeElement` is the next actionable element, never BODY.
2. While `status` is `waiting` and `backgroundTasks.length` is N above 0, the header reads `working (N background tasks)`.
3. With no open reply card in that state, the page shows "Agents still running; nothing needed from you" with no Approve or Deny button. The result text stays readable, and the message box is enabled and sends (R-7).
4. The goal box grows: after 10 typed lines it has no inner scroll, and it is resizable.
5. The `no-config` and `no-truss-dir` notices read as status, with the tag `Status:`, not `Notice:`.
6. The tab title is `(<open requests>) Truss`, and plain `Truss` at 0.
7. With a stubbed `Notification`, nothing is asked before a click on the enable control. After it, a question request and a permission request each raise one notification; a reply card and the background-task status raise none.

The spec holds no `test.skip`, `test.fixme` or `test.only`.

## Documents this ADR amends

- [ADR-0007](0007-behaviour-evals.md): the two git-dir lines of `## Snippets` name `agents/stress-engineer.md`, and section 6 and seam 6 name that file. The three `git diff --no-color` lines and `## Checks replaced` are unchanged.
- [ADR-0009](0009-workflow-factory.md), Decision 2: the `stress` row of the roles table is `truss:stress-engineer`.
- [ADR-0011](0011-local-web-ui.md), Decision 3: the reply-card bullet points here for `replyStep`.
- [ADR-0012](0012-self-improving-retro.md), section 6, and `skills/retro/SKILL.md` step 5: the S-0 sentence.
- `docs/architecture.md`: the agent list, the roles table and the in-crew diagram, the Workflow path's crew step, the Hooks section, the UI seams, the `lifecycle.ts` paragraph and the Service pack rule 5 row.

ADR-0009's record-step audit (Decision 1, "finish, record step") and its QC-never-the-builder row still say a `-stress` label must run as `truss:qc-engineer`. `roleAudit` in Decision 1 above replaces that rule.

## Consequences

- From stage 0 until crew `stress-persona` (stage 2) merges, the full suite is red on purpose. `tests/contract-evals.check.ts`, `tests/speed-rules.check.ts` and the three contracts fail with their `producer missing:` lines, and no stage-1 acceptance test runs them (plan-retro-fixes.md, "Proof notes").
- Once `hook-gates` merges, the PM's own Edit and Write calls on repo files are refused while a run is active. A PM that needs a hotfix takes the "factory broken" path in `skills/run/SKILL.md` (crew `pm-prompts`) and delegates it.
- A stress test can write its probe scripts with Write instead of shell heredocs, so the worktree guard no longer refuses them.
- A turn that ends while background tasks run no longer shows a false "Reply needed" card, and the client can still answer the result's text.
- A fix builder never sees tester files in its "Files you may change", so it can't make the QC FAIL that a builder commit to a test causes.
- The UI server exits when any ancestor dies, on any platform where `ancestors()` can read the chain. Where it can't, the watch behaves as before.
