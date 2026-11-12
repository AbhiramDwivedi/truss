# ADR-0028: the UI rework to the client's design reference

Status: proposed, 2026-11-04. Written by the design crew `rework-design` (stage 0 of the UI rework goal, plan approved by the client at 2026-11-04T15:31:12.385Z). It becomes accepted when the program manager (PM) merges this crew. The crews `rework-server`, `rework-network`, `rework-chat`, `rework-docs` and `rework-page` build from it; it changes no code itself.

Decided by: the client, who asked for R-36 to R-47 in the brief and accepted, at 10:30, that this goal breaks frontend rule 14 "Mermaid isn't added" and the P19 dependency list; the approved plan's "What rework-design decides" (`plan.md`, points 1 to 12); the UX engineer's direction for this crew (report `rework-design-ux`), which keeps the D2 tokens; and this crew for what those leave free.

Amends: [ADR-0023](0023-factory-floor-ui.md) section 4 (the regions and the Run tabs) and its empty states, and [ADR-0011](0011-local-web-ui.md) section 2 (what the session sends for a message intent), its reply card, and section 7 (no mermaid). Everything else in both stays, including the D2 tokens, the routes and the SSE wire. Every new state field is optional, so a client that ignores it still works.

## Context

The client rejected today's page against the reference `truss_factory.tsx` and listed ten points, now R-36 to R-47. Five of them need facts the page doesn't carry yet: the PM's hand-offs (R-40), how a typed goal starts a run (R-41), what each agent is doing and why (R-42), whether a turn asks for approval (R-47), and a drawn diagram under the page's CSP (R-38). The rest are layout and wording calls this ADR fixes so five crews can build in parallel.

## Decision

### 1. A typed goal starts a run (R-41)

The Agent SDK runs a skill when the user message starts with `/<name>`, and the `system/init` message lists the commands the session can run (Agent SDK docs, "Slash commands"). The recorded stream's `init` lists `truss:run` in `slash_commands` (`ui/contract/fixtures/sdk-stream.jsonl:3`). `live.check.ts` does not send `/truss:run` today, so the live case below is new.

ui-session routes in code (ai rule 9). It adds no system prompt (ai rule 12), and the transcript keeps the client's text as typed. `createSession` gains one injected function, `hasPlan(): boolean`, which `main.ts` wires to the state store: true when `run !== null && run.version !== null` (`ui/server/state/index.ts:163`, `reduce.ts:333`).

| Intent | Condition | Session input |
| --- | --- | --- |
| `goal` | `hasPlan()` is false and no earlier `goal` message this session | `/truss:run <text>` |
| `goal` | otherwise | `INTENT_LINES.goal`, a blank line, then the text (mid-run intake, [ADR-0010](0010-mid-run-intake.md)) |
| `add` | any | `INTENT_LINES.add`, a blank line, then the text (a follow-up) |
| none | any | the text |

The second `goal` row covers a goal sent while the PM is still planning: the run skill is already running, so a second `/truss:run` would start a run inside a run. `INTENT_LINES` keep their wording (`ui/server/session/session.ts:18-21`), so `ui/contract/gaps.check.ts` keeps its `add` case and changes its first `goal` case to expect `/truss:run <text>`; rework-server updates `ui/test/session/gaps.test.ts` to match.

The composer, in code: with no plan, intent `goal`, label "Start run", textarea label "Your goal". With a plan or a sent goal, no intent and "Send to PM", with a "Message / New goal" choice; "New goal" sends `goal` and relabels the button "Add as new goal". The client knows a goal was sent from a transcript user entry whose `intent` is `goal` (`ui/app/store/types.ts:86`).

### 2. The reply card (R-47)

`ReplyRequest` gains `approvalAsk?: boolean`. ui-session sets it when the reply opens (`ui/server/session/reply.ts`), in code, from the turn's text: true only when the last non-empty paragraph contains `approve` or `approval` as a word and ends with `?`, and the text has no `nothing` or `no` before `approval` in the same sentence. Absent or false means not an approval ask. When unsure, the rule says false, so the card shows the reply form.

- `approvalAsk` false: title and accessible name "The PM replied" (`cardName()`, `ui/app/views/move/format.ts:86`), a "Your reply" box and the primary button "Send reply", which posts `{decision: 'message', message}` (`ui/server/session/registry.ts:92-97`). No Approve, no Deny.
- `approvalAsk` true: title "Approval needed"; "Approve" with the hint "Sends: Approved." and "Deny" with "Sends: Not approved." (the texts `registry.ts` sends); "Send reply" is still there and becomes primary when the box holds text.

The rail item (`ui/app/views/rail/Timeline.tsx:40`) uses the same two titles. The F5 fixture is the bug note's turn ("Nothing is waiting on approval ... give me something new."), which must give false.

### 3. ADRs live in one place (R-37)

The rail's "Decisions and ADRs" timeline is the one list (`views/rail/Timeline.tsx`). It takes the status strip and filter from `views/decisions/AdrSection.tsx`. The ADR items in Deliverables (`Deliverables.tsx:43-54`), the Decisions tab and `RunTabs` go. Opening a timeline ADR shows its fields (title, status, number, date, decided by, links, summary; `types.ts:237-247`) in the deliverable preview. That is reading, not a second list. No body field is added.

### 4. Only the latest architecture (R-39)

The design panel drops each Markdown section whose heading text matches `/\b(change ?log|history|versions?)\b/i`, from that heading up to the next heading of the same or a higher level. It drops nothing else. The page already shows one file, `design.architecture` (`types.ts`), so no older version is listed.

Amended by [ADR-0029](0029-real-data.md) section 6: the architecture doc itself states the current design only.

### 5. Mermaid (R-38)

- Dependency: `mermaid` at exactly `12.2.0` in `ui/package.json` `dependencies`, with no range. `12.3.0` was published on 2026-11-03, one day before this ADR, and `13.0.0-alpha.0` is a prerelease (`npm view mermaid time`). The pin is the newest release at least seven days old.
- Loading: `import('mermaid')` in `ui/app/views/design/DesignPanel.tsx` only, on the first architecture open with a mermaid block. No other file imports it.
- Settings: `initialize({ startOnLoad: false, securityLevel: 'strict', htmlLabels: false, suppressErrorRendering: true })`. Each block is checked with `parse` before `render`, and rendered with the id `truss-mmd-<n>`.
- Failure: a block that fails `parse` shows its source in a `pre`, under "This diagram couldn't be drawn: <first line of the error>". If the chunk fails to load, every block shows its source with "Diagrams couldn't load, so their source is shown."
- Accessibility: the SVG sits in a focusable `figure` labelled "Diagram n of m", with `role="img"` and a "Show source" disclosure.

**CSP: no change.** The page CSP is `default-src 'self'` with no `style-src` (`ui/server/http/static.ts:8`), so inline `<style>` elements and `style` attributes are blocked. Mermaid 12.2.0 inserts a `<style>` element into each SVG while it renders (`mermaid.core.mjs:1361-1363`), and its diagrams write `style` attributes. The CSP doesn't block CSSOM writes such as `element.style.setProperty` (MDN, `style-src`). The ruling is to restyle:

1. The app's own stylesheet themes `svg[id^="truss-mmd-"]` with the D2 tokens: fills, strokes, text and fonts. Mermaid measures text in the live document, where this rule already applies, so the layout and the shown font agree.
2. Before inserting the returned SVG, DesignPanel parses it with `DOMParser`, removes every `<style>`, and moves each `style` attribute into `style.setProperty` calls on the inserted node.
3. No `'unsafe-inline'`, nonce or hash is added. A nonce would need a per-response nonce in `static.ts` and could not cover style attributes.

The gate is `docs.spec.ts`, which runs F7 against the real server and its CSP. If rework-docs can't get a correct drawing this way, it raises a `QUESTION:`, and nobody adds `'unsafe-inline'` without the client (core rule 10).

### 6. Agent task and purpose (R-42)

The task comes from matching IDs. Each SDK `task_started` and `task_progress` message carries a `task_id` and a `description` (`sdk-stream.jsonl:64`, `:71`). The real truss dir `361b2630-…` has 1,888 spawn lines, and 1,807 of them carry an `agentId` of the same form, `a` plus 16 hex digits. The other 81 are factory crew lines with `agentId: null` and type `workflow-crew`. The subagent's own messages carry `agent_id` equal to that `task_id` (`sdk-stream.jsonl`, subagent lines).

New optional `Member` fields (`types.ts:145-153`):

```ts
agentId?: string | null  // the spawn line's agentId
purpose?: string | null  // see below
task?: string | null     // see below
```

- `agentId`: ui-state keeps it from the spawn line (`reduce.ts:192-197`).
- `task`: ui-session keeps the latest `description` per `task_id` from `task_started` and `task_progress`, at most 500 entries. ui-server sets `Member.task` when it builds the snapshot, where `task_id === agentId`. It is null when nothing matches. TODO: no recording shows whether the tasks of members started inside a Workflow crew reach the PM's stream; rework-server's `R-42:` case must record one, or this falls back.
- Fallback, in the client: the crew's `goal` for the project manager; otherwise the member's latest activity (its `detail`, for example the report marker); otherwise "No activity yet".
- `purpose`: the first sentence of the `description:` line in `<pluginPath>/agents/<name>.md`. The name is the member's `type` with `truss:` stripped. Type `workflow-crew`, and the crew's project manager, map to `project-manager`. Unknown types, and `general-purpose` (1,566 of the real dir's spawns), get null, and the card shows the type only. ui-state reads the files once at start; it writes nothing (R-9).
- Progress: three steps, Spawned, Working and Reported. Spawned is a spawn line with no later activity. Reported is `state === 'reported'`. Everything else is Working. There is no percentage.

Amended by [ADR-0029](0029-real-data.md) sections 2 and 3: the transcript task for Workflow members, and the client task chain.

### 7. The flow (R-40)

`Session` gains `flow?: FlowEntry[]`, oldest first, holding at most the last 200 entries:

```ts
interface FlowEntry {
  at: string                                   // ISO time the tool call was seen
  tool: 'Agent' | 'SendMessage' | 'Workflow'
  to: string | null                            // a crew slug, or null
  summary: string                              // at most 200 characters
}
```

ui-session folds these from the PM's own top-level assistant `tool_use` blocks, so not subagent lines (`fold.ts:220`). It keeps only blocks named `Agent`, `SendMessage` or `Workflow`. `summary` is the input's `description` for Agent and Workflow, and the first line of `message` for SendMessage. `to` is the longest crew slug that appears as a whole word in, in order, SendMessage's `to`, then `description`, then `prompt`. The crew slugs come from a second injected function, `crewSlugs(): string[]`. The recorded Agent call has `description` and `prompt` (`sdk-stream.jsonl:61`). TODO: no recording holds a SendMessage or Workflow call; rework-server's `R-40:` case records one and confirms the input key names before relying on them.

The network lights the wire whose `data-crew` equals `to` for 10 s after `at`. The crew card shows "From PM <time>: <summary>". The thread shows "PM → crew <slug>: <summary>" as a system line.

### 8. Metrics (R-43)

One section, h2 "Run metrics", `#run-metrics`, at the end of main. Every value is derived in the client (frontend rule 4):

- cost: `session.usage.costUsd`;
- tokens per model: a table of `usage.models` (in, out, cache read, cache write);
- run time: from the first transcript entry's `ts` to now, or to the last entry's `ts` once the run is finished;
- agents started: the count of project managers and members across `run.crews`;
- crews done: merged crews "n of m".

There is no limit, budget, ceiling or "of $X" anywhere. The UI sets no spending limit (`live.check.ts:22` keeps none).

Amended by [ADR-0029](0029-real-data.md) section 4: run time with no transcript, Cost "Not recorded", and the header summary.

### 9. Status vocabulary (R-44)

`ui/app/views/status/` holds `StatusBadge` and `RunStatusBadge`, owned by rework-network and used by every view. Every status shows a word and an icon, never colour alone.

| Status | Word | Crew when | Agent when |
| --- | --- | --- | --- |
| `active` | Active | `running`, none of the below | any other state |
| `done` | Done | `merged`, or `dropped` (the card adds "Dropped") | `reported` |
| `waiting` | Waiting on you | `running` and the project manager's latest `detail` is `QUESTION`, `BLOCKED` or `PROPOSAL` | latest `detail` is one of those |
| `stuck` | Stuck | `stuck` is non-null | `stalled` or `allowance-spent` |
| `planned` | Planned | `planned`, or null with no members | — |

Run status (`RunStatusBadge`):

- `not-started` ("Not started"): no transcript entries and `run === null`;
- `waiting` ("Waiting on you"): an open request, or `session.status === 'waiting'`;
- `finished` ("Finished"): every crew merged or dropped, and the session isn't running;
- `working` ("Working"): otherwise.

Amended by [ADR-0029](0029-real-data.md) section 1: an agent of a merged or dropped crew is `done`, and a null model shows no badge.

### 10. Layout, thread and design (R-36, R-45, R-46)

This follows the UX direction.

- There are two columns. The 400 px left rail holds the header, Target repository, the conversation (thread then composer) and Decisions and ADRs. Main holds Your move (when open), Build network, Built artifacts and deliverables, and Run metrics. There are no Crews, Decisions or Design tabs.
- The network is the first view in main (R-36). The PM node is at the top, with a wire to each crew card. Crews sit in stage rows, and each crew lists its agents as cards. With no plan, the PM node reads "Waiting for your goal", or "Planning the run" once a goal is sent, above a dashed card: "Crews appear here once the PM has a plan." The text "No plan yet." (ADR-0023) goes.
- The thread is a `role="log"` scroll region in the rail, with the newest message in view (R-45).
- The D2 tokens stay. There are no per-crew colours. Sentence case throughout, and the PM badge reads "PM" (R-46).

**Partial crew.** `Crew` gains `eventsUnread?: number`: the count of the crew's event lines that ui-state skipped for `version` (`reduce.ts:169`). Such lines parse, so the crew is known. A `json` skip names no crew and stays only in `run.skipped`. When the count is above 0, the card shows "Couldn't read this crew's events" and the last known agents.

### 11. Contract, fixtures and tests

- **Fields.** The fields in sections 2, 6, 7 and 10 go into `ui/contract/state.schema.json` and `ui/app/store/types.ts`, all optional.
- **Server cases.** `ui/contract/rework/server.check.ts` has cases titled `R-40: `, `R-41: ` and `R-42: `. They fail until rework-server lands.
- **Area specs.** There is one Playwright spec per area, with `R-<n>: ` case titles:
  - `network.spec.ts`: R-36, R-40, R-42, R-44;
  - `chat.spec.ts`: R-41, R-45, R-47;
  - `docs.spec.ts`: R-37, R-38, R-39;
  - `page.spec.ts`: R-43, R-46, and every placement and layout case.
- Each stage-1 spec must pass with today's App.tsx layout plus its own area. A `rework` project in `ui/playwright.config.ts` runs them.
- **Fixtures.** Fixtures go in `ui/contract/fixtures/rework/<state>/`. `real-12` is trimmed from the real truss dir `361b2630-4123-451d-98e0-e36681a3c70c` (3,905 event lines) to 12 crews and at most 100 agents. `partial` adds a crew with a `v: 2` line, and `finished` has every crew merged.

Rework fixture states: no-run, planning, live, real-12, reply-open, approval-ask, architecture, long, thread, partial, finished, real-data

rework-design rewrites the existing specs this ADR changes, in `ui/e2e/**`, `ui/contract/redesign/**` and `ui/contract/e2e/**`:

| Old expectation | New |
| --- | --- |
| "No plan yet." | the PM node and the dashed card |
| `mermaid diagram (source)` (`DesignPanel.tsx:18`) | an SVG figure, or the source with an error line |
| "Reply needed" with Approve and Deny | "The PM replied" or "Approval needed" |
| ADRs in Deliverables, a Decisions tab | the rail timeline only |
| Run tabs | none |

Those specs stay red until rework-page's full e2e run. The combined tests in `ui/app/views/test/` move unchanged into `crews/crews.test.ts`, `move/move.test.ts`, `rail/rail.test.ts` and `shell/shell.test.ts`.

### 12. Shared files

- **rework-page only:** `App.tsx`, the store, the styles, `components/ui` and the page shell.
- **A stage-1 crew** that needs a new primitive or keyframes keeps it inside its own area directory, and rework-page may promote it.
- **rework-design only:** `ui/package.json` and the lockfile.

## Consequences

- The UI gains one runtime dependency, `mermaid` 12.2.0 (122,322,316 bytes unpacked, 23 direct dependencies; ADR-0011 section 7). It loads only when the architecture is opened.
- ui-state now reads `agents/*.md`. A renamed agent file makes `purpose` null, not an error.
- The `approvalAsk` rule is a heuristic. A missed approval ask still has "Send reply", so the client can type "approve".
- The CSP stays as it is. The mermaid render logs CSP violation reports for the `<style>` element it inserts, and the specs filter only those (`style-src-elem` blocked on `truss-mmd-` SVGs).
- Two TODOs (sections 6 and 7) wait on recordings that rework-server makes.
