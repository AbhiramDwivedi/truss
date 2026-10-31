# ADR-0011: local web UI for Truss runs

Status: proposed, 2026-10-30. Written by the design crew `ui-design` (stage 0 of the UI run). It becomes accepted when the PM merges this crew.

VERDICT: change. Four new modules under `ui/`: ui-state, ui-session, ui-server and ui-web. Nothing in the repo hosts a Claude Code session or serves a browser; the plugin always runs inside a session. R-9 forbids changing the plugin, so the UI is a separate package that reads Truss's files and hosts the session through `@anthropic-ai/claude-agent-sdk`.

## Context

The client wants to run Truss from a browser on their own machine (R-1, R-2, R-10). Brief questions become cards and crew status updates live (R-3, R-4). Decisions, ADRs and the design show live too (R-5, R-6). Approvals are answered from the page, and each answer counts at most once (R-7, R-8). The tab is the only client the server accepts (R-12). The UI stores nothing and sends nothing off the machine (R-13). Requirements are in `docs/requirements.md`.

How Truss talks to the client today, from the code:

1. **Brief questions use `AskUserQuestion`.** The brief is the only part of Truss that calls it (`skills/brief/SKILL.md:8`). The first option is the recommended answer, with a label ending ` (Recommended)`, and the last is `Stop the client brief` (`skills/brief/SKILL.md:64`).
2. **Every other question is plain text.** The PM never calls `AskUserQuestion` while a crew runs; it asks in plain text (`skills/run/SKILL.md:22`). Plan approval is a table in assistant text, and the PM waits for the client's reply (`skills/run/SKILL.md:216-232`). So plan, push and PR approvals reach a host as a turn that ends with assistant text, not as a tool call.
3. **Tool permission prompts reach the host through `canUseTool`.** The spike below recorded five of them.
4. **The Truss dir is `<git common dir>/truss/<safeName(session id)>`**, or `$HOME/.claude/truss/<safeName(session id)>` outside git (`trussDir`, `hooks/register.ts:128-131`). The hooks tell the main session through a `[truss] dir:` note, added as `additionalContext` of `SessionStart` (`hooks/register.ts:2115-2120`). The PM must read the dir from that note and not derive it itself (`skills/run/SKILL.md:24`).
5. **The logs roll.** `appendLine` (`hooks/register.ts:1282-1297`) reads the whole live log. When it is 3 MiB or more (`ROLL_BYTES`, `:14`), it copies the log to the first free `events.<n>.jsonl` or `messages.<n>.jsonl` and starts the live file over. Each append rewrites the whole live file; there is no append call.

## Spike: four questions answered

The spike is `ui/spike/run.ts`. It ran one real SDK session in a fresh temp git repo (`/tmp/truss-spike-pkZDEP`), with the Truss plugin loaded from the repo root: `plugins: [{type: 'local', path: root}]`. It passed `canUseTool`, plus `PreToolUse`, `SubagentStart` and `SubagentStop` hooks that only record, and no `model`, `settingSources` or `permissionMode` (`ui/spike/run.ts:89-93`). It recorded every message, callback and reply into `ui/contract/fixtures/sdk-stream.jsonl`: 83 lines, one compact JSON object each. Records the spike wrote itself carry `_spike`. Line numbers below are lines of that file. Its four turns cost USD 0.5544791 in total (line 82).

### 1. Does the session load Truss, and can the UI find the Truss dir?

**Truss loads.** Every `system`/`init` message (lines 3, 51, 60, 80) lists the plugin `{"name":"truss","source":"truss@inline","version":"0.12.0"}` with the repo path. It lists the skills `truss:truss-plan`, `truss:truss-stage`, `truss:brief`, `truss:init`, `truss:principles`, `truss:retro` and `truss:run`, and the agents `truss:checking-engineer`, `truss:commissioning-engineer`, `truss:design-engineer`, `truss:foreman`, `truss:planning-engineer`, `truss:qc-engineer` and `truss:writer`. `slash_commands` ends with `truss`. That is the `/truss` command the hooks module registers in `session.start` (`hooks/register.ts:2122-2125`), so the hooks module loaded too. That last step is inferred from the command's name, not seen directly.

**The `[truss] dir:` note does not appear in the stream.** No line contains `[truss] dir:` or `additionalContext`. That is expected: the note is context added to the model's prompt, not an SDK message. Whether the note reached the model's context under the SDK host is **not confirmed** either way. It matters, because the PM is told not to work out the Truss dir itself (`skills/run/SKILL.md:24`). `ui/contract/live.check.ts` and the client's R-21 run must show that a run under the UI finds its dir.

**The UI can derive the Truss dir.** The init `session_id` (`5a1ed770-ec1a-4087-b90f-1cf4bb08183d`) equals the `session_id` in every hook input (for example line 62). `trussDir` builds the dir from that id and the git common dir (`hooks/register.ts:128-131`). So ui-state runs `git rev-parse --path-format=absolute --git-common-dir` in the repo, then appends `/truss/` and `safeName(session_id)`. The spike session wrote no Truss files, so a dir found this way was never seen on disk. ui-state copies `safeName` (`hooks/register.ts:117`) rather than importing it, because ui/ never imports the plugin (Decision 1).

### 2. The `AskUserQuestion` payload, and the answer the session accepts

Line 42 is the `canUseTool` call. `toolName` is `AskUserQuestion`. `input.questions` holds 2 questions with the headers `Outcome` and `Acceptance`. Each question has `question`, `header`, `options` (each option `{label, description}`) and `multiSelect: false`. The first options are `Node.js CLI (Recommended)` and `Bare semver, exit 0 (Recommended)`, and the last option is `Stop the client brief`. `options` has the keys `displayName`, `toolUseID`, `requestId` and `requiresUserInteraction` (`true`).

Line 43 is the reply the spike gave, and the session accepted it:

```
{"behavior": "allow", "updatedInput": {"questions": [<the questions, unchanged>], "answers": {"<question text>": "<chosen label>"}}}
```

Line 44 is the tool result the model saw: `Your questions have been answered: ... You can now continue with these answers in mind.`

Not tried in the spike, taken from the SDK docs (fetched, see below): a `multiSelect` answer joins the labels with `, `; a free-text answer puts the client's text as the value; a deny is `{behavior: "deny", message}`. ui-web offers multi-select and free text on that basis. `live.check.ts` covers single-select only.

### 3. Do `canUseTool` and the hooks fire for background agents and Workflow crews?

**Hooks: yes for a background subagent.** In turn 3 the model started a background `general-purpose` agent (line 62, `PreToolUse` for `Agent`; line 64, `task_started` with `is_backgrounded: true`). `SubagentStart` fired with `agent_id` and `agent_type` (line 65). `PreToolUse` fired for the subagent's own `Bash` call with the same `agent_id` (line 72). `SubagentStop` fired with `agent_transcript_path` and `last_assistant_message` (line 76). The stream also carries `system` messages for the task: `background_tasks_changed` (lines 63, 79), `task_progress` (71), `task_updated` (77) and `task_notification` with `status: completed` (78).

**`canUseTool` for a subagent: not confirmed.** The subagent's one tool call (`ls -la /tmp/truss-spike-pkZDEP`, line 72) needed no prompt, so no `canUseTool` call came from it. The SDK docs say `AskUserQuestion` isn't available in subagents.

**Workflow-engine crews and `truss:foreman` agents: not tried.** No Workflow run and no foreman ran in the spike.

**What the design does with that.** Crew status comes from the files only: `plan.json`, the event and message logs, `reports/`, `decisions.md` (Decision 4). The UI uses no hook for status. The session keeps one `PreToolUse` hook that does nothing (Decision 2), and shows the `background_tasks_changed` list in the header.

**A background agent can end a turn by itself.** Turn 3's `result` (line 69) came while the subagent still ran. When the subagent finished, the session started turn 4 by itself: a new `init` (line 80) and a `result` (line 82) with `origin: {"kind":"task-notification","producer":"session-task"}`. Decision 3 handles that.

### 4. Which prompts reach `canUseTool` under the default `settingSources`

These reached `canUseTool`, with `options.decisionReason`:

| Line | Tool and input | `decisionReason` (`decisionReasonType`) | Suggestions |
|---|---|---|---|
| 14 | `Bash`, a command with a shell variable (`P=...; ls $P/brief`) | `A variable in this command can't be checked before it runs` (`other`) | none |
| 22 | `Bash`, a read-only `git ls-files` in the spike repo | `This command requires approval` (`other`) | `addRules` to `localSettings` |
| 27 | `Read` of a file outside the session's cwd | `Path is outside allowed working directories` (`workingDir`) | `addRules` to `session` |
| 42 | `AskUserQuestion` | none | none |
| 54 | `Bash`, `mkdir` of a new dir in the spike repo | has `blockedPath` | `addRules`, `addDirectories`, `setMode` `acceptEdits` |

These ran with no prompt: `Skill` (line 6), `ls -la` (line 18), `Read` inside the cwd (line 35), and the subagent's `ls -la` (line 72). The spike denied line 14 (line 15) and allowed the rest.

Not confirmed: which prompts a repo's own `.claude/settings*.json` allow rules remove. The spike repo had none.

## Options

- **A. A separate package `ui/` with its own server process that hosts the session through the Agent SDK (chosen).** It meets R-9 and R-11, and the SDK hands every prompt to `canUseTool`.
- **B. A Truss hooks feature that serves the page from inside the terminal session.** Rejected: it changes the plugin (R-9), and hooks can't answer `AskUserQuestion` for the client.
- **C. Wrap the `claude` CLI in a pseudo-terminal and scrape its output.** Rejected: no structured prompts, no answer shape, and it breaks on every CLI release.
- **D. Read the session's transcript files for status.** Rejected: transcript formats are internal and change between releases. The Truss files have schemas (`docs/events.schema.json`, `docs/plan.schema.json`).

## Decision

### 1. One package, one process, four modules

`ui/` is its own npm package, `truss-ui` (`ui/package.json`). One Node process runs on `127.0.0.1`. It holds:

| Module | Path | Does |
|---|---|---|
| ui-state | `ui/server/state/index.ts` | Reads the Truss dir, `.claude/truss.json`, the architecture doc, the ADR dir and git into one state in memory; emits snapshots and deltas. |
| ui-session | `ui/server/session/index.ts` | The only module that imports the SDK. Hosts the session, turns `canUseTool` calls and turn ends into requests, and answers them. |
| ui-server | `ui/server/http/index.ts`, `ui/server/main.ts` | HTTP and SSE, the token, Host and Origin guard, static files. `main.ts` wires the modules together. |
| ui-web | `ui/web/**` | Static HTML, CSS and plain ES modules. No bundler, no build step. |

Rules:

- Node 24 runs the server's TypeScript as is, so it stays erasable TypeScript (`engines: node >=24` in `ui/package.json`).
- No file under `ui/` imports from the plugin (`hooks/`, `bin/`, `scripts/` and the rest). The plugin never imports from `ui/`. Where ui-state needs one of the hooks' rules (`safeName`, `isQcFile`, `latestQc`), it re-implements it and names the source line in a comment.
- The UI never writes to the Truss dir, the repo or the plugin. It reads files and talks to the session.
- Nothing reads `docs/ui-whiteboard.jpg` by name. The design panel shows only images a crew added (Decision 7).

### 2. Host the session with the defaults

`ui-session` calls `query()` with a streaming prompt: an async generator that yields `{type: 'user', message: {role: 'user', content: text}, parent_tool_use_id: null}` for each message the client sends (as `ui/spike/run.ts:53` does). Options:

- `cwd`: the repo.
- `plugins: [{type: 'local', path: <plugin path>}]`.
- `canUseTool`: Decision 3.
- `hooks: {PreToolUse: [{hooks: [async () => ({})]}]}`, a hook that does nothing. The SDK docs' Python example calls a dummy hook a "required workaround" that keeps the stream open for `can_use_tool`. The spike ran with hooks set, so the UI keeps one.
- Nothing else. No `model` (R-20): the header shows the `model` of the latest `init` (line 3: `claude-opus-5-5`). No `maxBudgetUsd` or other ceiling (R-22). No `permissionMode` (`init` shows `default`). The default `settingSources`.

The session starts when the client sends the first message, not when the server starts. It runs until the generator ends or the server stops. `close()` calls `interrupt()` and ends the generator.

**Turns.** The spike sent each message only after the previous top-level `result` (`ui/spike/run.ts:105-112`). ui-session does the same. A message the client sends while a turn runs waits in a queue and goes out after the next top-level `result`. Sending into a running turn was not tried, so the queue is the safe rule.

**Status**, shown in the header:

| `status` | When |
|---|---|
| `idle` | No session yet. |
| `running` | A message was sent, or an `init` arrived, and no `result` since. |
| `waiting` | The latest top-level `result` came and no turn runs. |
| `ended` | The message stream finished. |
| `error` | The stream threw. The first line of the error shows. |

**Usage (R-22).** The header shows the latest `result`'s `total_cost_usd` and `modelUsage`. In the recording both are session totals: `total_cost_usd` goes 0.3758393, 0.3979601, 0.4237553, 0.5544791 over lines 49, 58, 69 and 82. So the latest `result` replaces the earlier one, and nothing is summed. Line 82's `modelUsage` names two models, `claude-opus-5-5` and `claude-haiku-5-5`.

**Transcript.** The text blocks of top-level `assistant` messages (no `parent_tool_use_id`, no `agent_id`), and each message the client sent. Only the last 500 entries stay in memory.

### 3. Three kinds of request card, one registry

Every prompt the client answers is a **request**: an id (`crypto.randomUUID()`), a kind, and a status (`open`, `answered` or `cancelled`). The wire shape is `request` in `ui/contract/state.schema.json`.

**Question card (`kind: "question"`).** `canUseTool` with `toolName === "AskUserQuestion"`. The card shows each question's header, text and options in the order sent. It marks an option `recommended` when its label ends with ` (Recommended)`, and offers a free-text answer. The client's answers `{<question text>: <label or text>}` go back as `{behavior: "allow", updatedInput: {questions: input.questions, answers}}`. For a `multiSelect` question the labels are joined with `, `.

**Approval card (`kind: "permission"`).** `canUseTool` with any other tool. The card shows the tool name and a title: `options.description`, else `input.description`, else the tool name. It shows a summary: `input.command` for `Bash`, `input.file_path` for `Read`, `Write`, `Edit` and `NotebookEdit`, else the input as JSON. It also shows `decisionReason` and `blockedPath` when present. Approve sends `{behavior: "allow", updatedInput: input}`. Deny sends `{behavior: "deny", message}`, where `message` is the client's text, or `Denied by the client in the Truss UI.` when they gave none. The card has no "always allow": the UI never writes settings, so `updatedPermissions` is never sent.

**Reply-needed card (`kind: "reply"`).** This is the answer to R-7 for plan, push and PR approvals. Those reach the host as a turn that ends with assistant text (Context, items 1-2).

- **How the UI spots such a turn.** Every top-level `result` message opens one reply card. The card shows the result's `result` text and `is_error`. The UI does not guess from the text whether the PM asked something. A guess would miss approvals worded in a new way. After a `result` the session always waits for the client, so the card is always true.
- **Approve** sends `Approved.` into the streaming input. **Deny** sends `Not approved.` Either may carry the client's text, added after a blank line. A message typed in the chat box while a reply card is open answers that card (`decision: "message"`).
- **Superseded.** When an `init` arrives and the client sent nothing since the card opened, the session started a turn by itself (Spike, question 3). The card is cancelled with `cancelReason: "superseded"`. The next `result` opens a new card.
- The card shows how many background tasks ran when the turn ended (the latest `background_tasks_changed`). Above 0, the session may start a turn by itself.

**The pending-request registry (R-8).** ui-session keeps every request in memory, in one registry:

- `open(card)` adds a request and returns its id and a promise. For a `canUseTool` request, that promise is what `canUseTool` returns. The SDK docs say the callback may stay pending without limit, so there is no timeout.
- `answer(id, body)` checks the body against the kind and settles the promise once. It returns `{ok: true, request}`. A second answer to the same id returns `{ok: false, error: "answered", request}` and sends nothing to the session. An unknown id gives `unknown`, a cancelled request `cancelled`, and a body that doesn't fit the kind `answer`.
- `cancel(id, reason)` settles an open request with no answer. `aborted`: the `canUseTool` `signal` fired, and the promise resolves to a deny with message `aborted`. `superseded`: above. `ended`: the session ended with the request open.
- Answers that arrive out of order are fine: each settles only its own id.
- The server keeps the last 200 requests for the page and drops older settled ones. An open request is never dropped.

### 4. ui-state: files in, one state out

**Sources.** All paths are relative to the Truss dir unless they say otherwise.

| Source | Gives |
|---|---|
| `plan.json` | goal, version, approval, `approvedAt`, crews in plan order with stage, verdict, status, goal id and owns |
| `events.<n>.jsonl` by n, then `events.jsonl` | members by crew, the latest activity, `run.skipped` |
| `messages.<n>.jsonl` by n, then `messages.jsonl` | the latest activity (`<from> to <to>: <summary>`) |
| `reports/<crew>/` | the crew's QC verdict |
| `decisions.md` | decision entries under `## Run` headings |
| `plan.md` | the design panel's plan |
| `<repo>/.claude/truss.json` | the architecture doc and ADR dir paths |
| the architecture doc, the ADR dir | the design panel, the ADR list |
| `git` in the repo | images crews added (Decision 7) |

**Reading.** ui-state polls every 500 ms; `fs.watch` events only trigger a read sooner. The poll is the source of truth, because `fs.watch` can miss events. It keeps a byte offset per jsonl file and reads from it to the last `\n`. A last line without its newline waits for the next read. A line that is not a JSON object, or an events line whose `v` isn't 1, is skipped and recorded in `run.skipped` (file, line, reason; at most 100). The fixture `tests/fixtures/retro-040/events.jsonl` has one of each, at lines 10 and 11. Message lines carry no `v`, so a message line is skipped for version only when it has a `v` other than 1.

**Rolling.** The hooks rewrite the whole live file on each append and roll by copying (Context, item 5). So:

- A new `events.<n>.jsonl` holds what the live file held. ui-state carries the live file's offset over to it, reads it from there, and reads the live file from 0.
- A live file that shrank with no new rolled file is a torn rewrite. ui-state waits for the next poll and doesn't reset.
- A rolled file whose content equals the newest older rolled file is a duplicate copy, which `appendLine` can leave (`hooks/register.ts:1279-1281`). ui-state skips it.

**Reduce.**

- **Crews.** The `plan.json` crews, then crews named only in event lines, in order of first appearance. Crew `main` is never a crew.
- **Foreman and members.** The foreman is the agent whose name equals the crew slug. Members are the other agents the crew's event lines name. Each member line shows type, model and effort from its latest spawn, and a state from its latest event: `spawned`, `stalled`, `tagged`, `reported`, `allowance-spent` or `fetched`.
- **Latest activity.** One line per crew, from the newest event or message by `ts`, in the words the schema's `activity.text` gives (for example `auth-builder stalled 15 min`). A message line belongs to the crew of its `from` agent, else of its `to` agent.
- **QC verdict.** The crew's newest QC file under `reports/<crew>/`, by the hooks' own rule. Only `<crew>-qc.md` and `<crew>-qc-<k>.md` count (`isQcFile`, `hooks/register.ts:772-777`). That leaves out `auth-qc-2.interim.md`. The newest by mtime wins, and on a tie the higher k (`latestQc`, `:513-520`), without the run filter. The verdict is `PASS` or `FAIL` from a first non-empty line `VERDICT: <v>`.
- **Decisions, ADRs and design.** As `decisions`, `adrs` and `design` in the schema.

**No Truss dir yet.** Until the session's `init` arrives, the Truss dir is unknown. Once known, it may not exist until the hooks write it. `run` is then `null` and a notice says so. A missing `.claude/truss.json`, or a missing `architecture` or `adr` key (neither has a default, `skills/run/SKILL.md:79`), gives `design.architecture: null` or an empty ADR list, and a notice.

**git.** Each git child process has a 10 s timeout. ui-state runs git again every 5 s, not on every poll. A failure gives the notice `git-error` and keeps the last good images.

### 5. The wire: one snapshot, then deltas, over SSE

`ui/contract/state.schema.json` is the wire contract. ui-state produces it, ui-server carries it, and ui-web applies it.

- **Messages.** A `snapshot` carries the whole state, `v: 1`. A `delta` carries `set` (state keys to replace whole) and/or `append.transcript` (new transcript entries). Lists such as `run` and `requests` are replaced whole, which keeps the browser's apply step trivial.
- **Sequence.** Each server process picks an `instance`: 16 random lowercase hex characters. Deltas are numbered `seq` 1, 2, 3 … with no gaps. A snapshot carries the `seq` of the last delta it includes.
- **SSE ids.** Every SSE event has `id: <instance>:<seq>`, `event: snapshot` or `event: delta`, and the message as compact JSON in one `data:` line. The stream opens with `retry: 1000` and sends a `: ping` comment every 15 s.
- **Replay ring.** ui-state keeps the last 1024 deltas in memory. A reconnect with `Last-Event-ID: <instance>:<seq>` of this instance, where every delta after `seq` is still in the ring, gets those deltas, in order. Any other Last-Event-ID (another instance, too old, malformed, ahead) gets a fresh snapshot. No Last-Event-ID gets a snapshot.
- **No gap between snapshot and deltas.** ui-server subscribes to the store before it reads the snapshot, then drops queued deltas whose `seq` the snapshot already includes.
- **Versioning.** `v` stays 1 while fields are only added as optional. A renamed, retyped or removed field makes it 2, and the page then reloads.

### 6. HTTP: token, Host, Origin, routes

The server listens on `127.0.0.1` only. `main.ts` passes port 0 by default, so the OS picks a free port.

**Token (R-12).** At start the server makes a token: 32 random bytes, base64url. `main.ts` prints the URL with it once. The browser sends the token as `?token=<token>` on the first request. The server then sets the cookie `truss-ui-<port>=<token>` (`HttpOnly`, `SameSite=Strict`, `Path=/`) and redirects (303) to the same path without the query, so the token doesn't stay in the address bar. The cookie name carries the port because cookies aren't scoped by port. The server compares tokens with `crypto.timingSafeEqual`.

**Checks, in this order, on every request:**

1. **Host** must be exactly `127.0.0.1:<port>` or `localhost:<port>`. Else `403 {"error":"host"}`. This stops DNS rebinding: a rebound name sends its own Host.
2. **Origin**, when present, must be `http://127.0.0.1:<port>` or `http://localhost:<port>`. A POST must carry it. Else `403 {"error":"origin"}`.
3. **Token**, from the query or the cookie, must match. Else `401 {"error":"token"}`.

There is no rate limit (R-16).

**Routes:**

| Method and path | Does |
|---|---|
| `GET /` and other paths | Static files from `ui/web/`. `/` is `index.html`. No path outside `ui/web/`. |
| `GET /vendor/marked.js` | `ui/node_modules/marked/lib/marked.esm.js` (Decision 7) |
| `GET /api/events` | The SSE stream (Decision 5) |
| `POST /api/message` | `{"text": "<non-empty>"}`. `202`; with a reply card open, it answers that card. `400 {"error":"text"}`, `409 {"error":"ended"}` after the session ended. |
| `POST /api/requests/<id>/answer` | Question: `{"answers": {"<question>": "<answer>"}}`. Permission and reply: `{"decision": "allow" or "deny", "message": "<optional text>"}`. `200 {"ok":true,"request":…}`. A repeat gives `409 {"error":"answered","request":…}`; the session gets the answer once, so a retried POST leaves the same state (idempotent). `404 {"error":"unknown"}`, `409 {"error":"cancelled"}`, `400 {"error":"answer"}`. |
| `GET /api/image?ref=<ref>&path=<path>` | `git show <ref>:<path>`, only for a pair in `design.images`. Else `404`. |

A POST body must be `application/json` (else `415`), at most 1 MiB (else `413`), and valid JSON (else `400 {"error":"json"}`). Unknown API paths give `404`, wrong methods `405`. Every response carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. The page carries `Content-Security-Policy: default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. An SVG image also gets `Content-Security-Policy: sandbox`.

### 7. The design panel (R-6): `marked`, mermaid as source, images from git

**Markdown: `marked` 18.1.2.** `npm view marked@18.1.2` gives `module: ./lib/marked.esm.js`, no dependencies, 533,908 bytes unpacked, `engines: node >=20`, MIT. The browser imports the ESM file as is, so it needs no bundler. ui-web loads it with `import('/vendor/marked.js')` the first time the client opens the design panel, so the first screen doesn't wait for it (frontend rule 14). ui-web escapes raw HTML in the markdown instead of passing it through, and the CSP blocks inline script either way.

**Mermaid: none.** `npm view mermaid@12.2.0` gives 122,322,316 bytes unpacked and 23 direct dependencies. That is too much for one diagram type on a local tool. A mermaid code block shows as its source, labelled `mermaid diagram (source)`.

**Images.** "Images of that UI" means image files the run's crews added, read through git. ui-state lists them:

- On the target branch: `git log --since=<approvedAt> --diff-filter=A --name-only --format= <target>`.
- On each crew branch `truss-<slug>` that exists: `git diff --diff-filter=A --name-only <target>...truss-<slug>`.
- Only `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` and `.svg` count.

`truss-<slug>` is the branch name on the Workflow path (`bin/factory.ts:541`). TODO: the branch name of a foreman-path crew isn't fixed in the code; until it is, those crews' images show only once merged into the target.

### 8. `ui/server/main.ts`

```
node ui/server/main.ts [--repo <path>] [--plugin <path>] [--truss-dir <path>] [--port <n>]
npm --prefix ui start -- [same flags]
```

- `--repo`: the repo the session runs in. Default `$INIT_CWD` when set, else the cwd. (`npm --prefix ui run env` shows `PWD` as `ui/` and `INIT_CWD` as the directory npm ran from.)
- `--plugin`: the Truss plugin root. Default: the directory that holds `ui/`. It must contain `.claude-plugin/plugin.json`, else exit 2.
- `--truss-dir`: use this Truss dir instead of deriving it from the session id. For tests on a copy of real files.
- `--port`: default 0.

On success it prints one line to stdout and nothing else there: `truss-ui listening on http://127.0.0.1:<port>/?token=<token>`. Bad flags exit 2 with a usage line on stderr. A failed listen exits 1. `SIGINT` and `SIGTERM` close the session and the server and exit 0.

`main.ts` builds the store and the session. It forwards `session.subscribe` to `store.setSession`. When an `init` gives a session id, it calls `store.setTrussDir(await trussDirFor(repo, sessionId))`, unless `--truss-dir` was given. It passes both to `createServer`.

### 9. Module interfaces

Types are in the schema where it has them (`State`, `Request`, …). Each module exports only from its `index.ts` (core rule 1).

**`ui/server/state/index.ts`:**

```ts
export interface StateSource {
  snapshot(): Snapshot                                  // schema $defs/snapshot
  since(seq: number): Delta[] | null                    // deltas after seq; null when the ring can't serve it
  subscribe(fn: (d: Delta) => void): () => void         // returns unsubscribe
  readImage(ref: string, path: string): Promise<Buffer | null>  // null unless the pair is in design.images
}
export interface Store extends StateSource {
  ready: Promise<void>                                  // first full read done
  setTrussDir(path: string | null): void
  setSession(view: SessionView): void                   // replaces session, requests, transcript
  close(): void
}
export function createStore(opts: { repo: string; trussDir?: string; pollMs?: number }): Store  // pollMs default 500
export function trussDirFor(repo: string, sessionId: string): Promise<string | null>
```

**`ui/server/session/index.ts`:**

```ts
export interface SessionView { session: SessionState; requests: Request[]; transcript: TranscriptEntry[] }
export type AnswerResult =
  | { ok: true; request: Request }
  | { ok: false; error: 'unknown' | 'answered' | 'cancelled' | 'answer'; request?: Request }
export interface SessionControl {
  send(text: string): { ok: true } | { ok: false; error: 'text' | 'ended' }
  answer(id: string, body: unknown): AnswerResult
}
export interface Session extends SessionControl {
  view(): SessionView
  subscribe(fn: (v: SessionView) => void): () => void
  close(): Promise<void>
}
export function createSession(opts: { repo: string; pluginPath: string }): Session

// pure parts, which session.check.ts runs against the recorded stream
export function initialView(): SessionView
export function foldMessage(view: SessionView, msg: unknown): SessionView
export function questionCard(input: unknown): QuestionRequest          // from canUseTool input
export function questionAnswer(input: unknown, answers: Record<string, string>): { behavior: 'allow'; updatedInput: unknown }
export function permissionCard(toolName: string, input: Record<string, unknown>, options: unknown): PermissionRequest
export function createRegistry(): Registry
export interface Registry {
  open(card: NewRequest): { id: string; settled: Promise<unknown> }
  answer(id: string, body: unknown): AnswerResult
  cancel(id: string, reason: 'aborted' | 'superseded' | 'ended'): void
  list(): Request[]
}
```

`SessionState` is the schema's `session` object. `SessionView` is the slice `store.setSession` takes; ui-state imports it as a type only.

**`ui/server/http/index.ts`:**

```ts
export function createServer(opts: { state: StateSource; session: SessionControl; webDir: string }): {
  listen(port: number): Promise<{ port: number; token: string; url: string }>
  close(): Promise<void>
}
```

ui-server takes `state` and `session` as interfaces. So `http.check.ts` passes its own small implementations of them, not a fake Claude session.

## Consequences

- Stage-1 crews build against Decision 9 and the schema. `ui/contract/{state,session,http}.check.ts` import `ui/server/<module>` and fail with `producer missing: ui/server/<module>` until it exists.
- `ui/package.json` needs `marked` 18.1.2 as a dependency, and `@axe-core/playwright` 4.14.0 as a dev dependency (frontend rule 12, `docs/architecture.md`, "Local web UI"). `npm view @axe-core/playwright@4.14.0` gives the dependency `axe-core ~4.14.0` and the peer `playwright-core >=1.0.0`. Both are in `ui/package.json` and `ui/package-lock.json`.
- P19 (erasable TypeScript, Node built-ins only) keeps binding the plugin. It doesn't bind `ui/`, which has the runtime dependencies `@anthropic-ai/claude-agent-sdk` and `marked`.
- A reply card after every turn means the client also sees one after a turn that asked nothing. Writing in the chat box answers it, so it costs no extra click.

## Not confirmed

- That the `[truss] dir:` note reaches the PM's context when the SDK hosts the session (Spike, question 1). The run skill depends on it.
- That `canUseTool` fires for a subagent's tool call that needs a prompt, and that hooks fire inside Workflow-engine crews and `truss:foreman` agents (Spike, question 3). The design reads status from files, so neither blocks it.
- `multiSelect`, free-text and deny answers to `AskUserQuestion`. They come from the SDK docs; the spike tried single-select allow only.
- Sending a message while a turn runs. The design queues it instead.
- TODO: the branch name of a foreman-path crew, for its images (Decision 7).

## Fetched

- https://code.claude.com/docs/en/agent-sdk/user-input: the `canUseTool` signature and options, the allow and deny shapes, the `AskUserQuestion` answer format (multi-select, free text), that it isn't available in subagents, that the callback may stay pending, and the dummy-hook workaround.
- `npm view` for `marked`, `mermaid` and `@axe-core/playwright` (versions, sizes and dependencies above).

*Drafted with AI assistance and reviewed by the author.*
