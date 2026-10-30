# Requirements

Kept by truss's client brief (ADR-0008). Ids are never reused.

## R-1: The client can run Truss from a browser instead of the terminal
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the UI server started on a repo with one command, when the client opens the printed localhost URL and types a goal, then a Truss run starts in a Claude Code session the server owns, and the client answers the brief, gives approvals and watches the crews in the page without touching the terminal.

## R-2: The UI is for one client on their own machine
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the server running, when the client opens its URL in one browser tab, then that tab shows the one live run of that server.

## R-3: Brief questions appear as cards and crew changes show live
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the UI started on a repo, when the client types a goal, then the brief's questions appear as cards with the recommended option first, and the chosen answers reach the session.
Example: Given a run whose plan.json has crews ratelimit-design, quotas and gateway, when plan.json marks quotas running and events.jsonl gets a spawn line for quotas-builder, then the quotas lane shows "running" and "builder spawned" within 2 s, without a page reload.

## R-4: Each crew shows as one status line that opens into its members
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a crew quotas running with members quotas-testwriter, quotas-builder and quotas-qc, when the client looks at the page, then quotas shows one line (stage, status, latest activity, QC verdict when there is one), and expanding it lists each member with its own one-line status.

## R-5: Decisions and ADRs show live
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a run, when the PM appends a line to decisions.md or a new file appears under the ADR directory named in .claude/truss.json, then it shows in the decisions and ADRs panel within 2 s.

## R-6: A design panel shows the technical design and what the run built
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a run with plan.md and docs/architecture.md, when the client opens the design panel, then it shows the run's plan (crews, stages, owned files) and the architecture doc, and for a run that built a UI, images of that UI.

## R-7: Approvals the session asks for are answered from the page
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: goal
Example: Given a running session that asks to approve the plan or a push, when the request arrives, then the page shows it as a card with approve and deny, and the client's choice is returned to the session as the answer.

## R-8: Each answer or approval is used at most once
Status: open
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a brief question already answered, when the same answer is sent again (a double click, or a browser retry after a dropped connection), then the session receives it once and the card shows it was already answered; reads are safe to repeat.

## R-9: The plugin is not changed for the UI
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: All UI code lives under ui/. The run changes no file outside ui/ for the UI's sake, apart from the requirements and design docs Truss itself keeps. The UI talks to the plugin only by running a Claude Code session with the plugin loaded and by reading the files the plugin already writes.

## R-10: The UI runs locally only
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: A Node server on the client's machine, bound to localhost, started by one command, using the Claude Code login already on that machine. It holds no keys of its own.

## R-11: The UI talks only to the local Claude Code, as its own package
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: The only outside service is the local Claude Code, through the Claude Agent SDK with the Truss plugin loaded. ui/ is its own package with its own package.json and lockfile, so P19 keeps binding the plugin but not ui/. Dependencies stay few: the Agent SDK, plus a small frontend toolchain if the design needs one.

## R-12: Only the client's own tab can use the server
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: No accounts or login. The server binds to 127.0.0.1, prints a URL with a random token made at each start, and refuses any request without that token or with a Host or Origin header other than its own.

## R-13: The UI stores nothing and sends nothing off the machine
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: The run's files and the session's messages hold prose, code and repo paths. The UI keeps no database, log or cache of its own, holds what it reads in memory only, and sends nothing off the machine.

## R-14: One live run of up to 12 crews and 100 agents stays fast
Status: open
Kind: nfr
Measure: up to 12 crews, 100 agents and 30 MiB of event log across rolled files in one run, with every R-15 time still met
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-15: Changes show within 2 s and clicks reach the session within 1 s
Status: open
Kind: nfr
Measure: 95% of state-file changes and session messages on screen within 2 s; an answer or approval reaches the session within 1 s of the click
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-16: No rate limit on the local server
Status: open
Kind: nfr
Measure: 0 requests refused for rate; the token check of R-12 is the only gate
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-17: Works on current desktop browsers
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Current and previous major versions of desktop Chrome, Firefox, Safari and Edge, at window widths down to 1024 px. No phone layout.

## R-18: Every action works by keyboard
Status: open
Kind: nfr
Measure: 100% of actions (answer a card, approve, send a message, expand a crew) reachable and usable by keyboard; every control labelled; 0 statuses shown by color alone
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-19: English only
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: One language, no translation layer, no right-to-left layout.

## R-20: The PM session uses Claude Code's default model
Status: open
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: The UI passes no model, so the session uses this machine's Claude Code default, and the header shows that model. Truss's agents keep pinning their own models.

## R-21: The client proves it on the actual UI
Status: open
Kind: nfr
Measure: the client runs 1 real goal end to end through the actual UI once it is ready to test; no stub or fake-session tests are asked for
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-22: The header shows the run's usage, with no ceiling
Status: open
Kind: nfr
Measure: 0 spending limits set by the UI; usage the SDK reports (tokens, and cost when reported) refreshed in the header on every session message
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## Non-goals
- The UI never edits the plugin, or Truss's files and state; the plugin does its own work (writing agents, plans, reports) and the UI only displays it and communicates with the session.
- No view across several repos or sessions, no history of past runs, and no phone or remote access (client altitude ruling).
