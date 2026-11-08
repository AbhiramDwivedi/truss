# Requirements

Kept by truss's client brief (ADR-0008). Ids are never reused.

## R-1: The client can run Truss from a browser instead of the terminal
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the UI server started on a repo with one command, when the client opens the printed localhost URL and types a goal, then a Truss run starts in a Claude Code session the server owns, and the client answers the brief, gives approvals and watches the crews in the page without touching the terminal.

## R-2: The UI is for one client on their own machine
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the server running, when the client opens its URL in one browser tab, then that tab shows the one live run of that server.

## R-3: Brief questions appear as cards and crew changes show live
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given the UI started on a repo, when the client types a goal, then the brief's questions appear as cards with the recommended option first, and the chosen answers reach the session.
Example: Given a run whose plan.json has crews ratelimit-design, quotas and gateway, when plan.json marks quotas running and events.jsonl gets a spawn line for quotas-builder, then the quotas lane shows "running" and "builder spawned" within 2 s, without a page reload.

## R-4: Each crew shows as one status line that opens into its members
Status: replaced by R-36
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a crew quotas running with members quotas-testwriter, quotas-builder and quotas-qc, when the client looks at the page, then quotas shows one line (stage, status, latest activity, QC verdict when there is one), and expanding it lists each member with its own one-line status.

## R-5: Decisions and ADRs show live
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a run, when the PM appends a line to decisions.md or a new file appears under the ADR directory named in .claude/truss.json, then it shows in the decisions and ADRs panel within 2 s.

## R-6: A design panel shows the technical design and what the run built
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a run with plan.md and docs/architecture.md, when the client opens the design panel, then it shows the run's plan (crews, stages, owned files) and the architecture doc, and for a run that built a UI, images of that UI.

## R-7: Approvals the session asks for are answered from the page
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: goal
Example: Given a running session that asks to approve the plan or a push, when the request arrives, then the page shows it as a card with approve and deny, and the client's choice is returned to the session as the answer.

## R-8: Each answer or approval is used at most once
Status: met
Kind: functional
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Given a brief question already answered, when the same answer is sent again (a double click, or a browser retry after a dropped connection), then the session receives it once and the card shows it was already answered; reads are safe to repeat.

## R-9: The plugin is not changed for the UI
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: All UI code lives under ui/. The run changes no file outside ui/ for the UI's sake, apart from the requirements and design docs Truss itself keeps. The UI talks to the plugin only by running a Claude Code session with the plugin loaded and by reading the files the plugin already writes.

## R-10: The UI runs locally only
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: A Node server on the client's machine, bound to localhost, started by one command, using the Claude Code login already on that machine. It holds no keys of its own.

## R-11: The UI talks only to the local Claude Code, as its own package
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: The only outside service is the local Claude Code, through the Claude Agent SDK with the Truss plugin loaded. ui/ is its own package with its own package.json and lockfile, so P19 keeps binding the plugin but not ui/. Dependencies stay few: the Agent SDK, plus a small frontend toolchain if the design needs one.

## R-12: Only the client's own tab can use the server
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: No accounts or login. The server binds to 127.0.0.1, prints a URL with a random token made at each start, and refuses any request without that token or with a Host or Origin header other than its own.

## R-13: The UI stores nothing and sends nothing off the machine
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: The run's files and the session's messages hold prose, code and repo paths. The UI keeps no database, log or cache of its own, holds what it reads in memory only, and sends nothing off the machine.

## R-14: One live run of up to 12 crews and 100 agents stays fast
Status: met
Kind: nfr
Measure: up to 12 crews, 100 agents and 30 MiB of event log across rolled files in one run, with every R-15 time still met
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-15: Changes show within 2 s and clicks reach the session within 1 s
Status: met
Kind: nfr
Measure: 95% of state-file changes and session messages on screen within 2 s; an answer or approval reaches the session within 1 s of the click
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-16: No rate limit on the local server
Status: met
Kind: nfr
Measure: 0 requests refused for rate; the token check of R-12 is the only gate
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-17: Works on current desktop browsers
Status: replaced by R-48
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: Current and previous major versions of desktop Chrome, Firefox, Safari and Edge, at window widths down to 1024 px. No phone layout.

## R-18: Every action works by keyboard
Status: met
Kind: nfr
Measure: 100% of actions (answer a card, approve, send a message, expand a crew) reachable and usable by keyboard; every control labelled; 0 statuses shown by color alone
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-19: English only
Status: met
Kind: constraint
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client
Example: One language, no translation layer, no right-to-left layout.

## R-20: The PM session uses Claude Code's default model
Status: met
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
Status: replaced by R-43
Kind: nfr
Measure: 0 spending limits set by the UI; usage the SDK reports (tokens, and cost when reported) refreshed in the header on every session message
Added: 2026-10-30T21:57:33Z | Build an optional local web UI in ui/ that drives Truss runs through the Claude Agent SDK (brief questions and approvals via canUseTool) and shows live crew status from the Truss state files, with no changes to the plugin
Source: client

## R-23: The retro runs by itself at the end of every run
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given a truss run whose last crew has merged, when the PM finishes the run, then the retro starts without the client typing /truss:retro, and the UI shows a retro stage running after the work stages, through to its fixes being applied.

## R-24: Finish saves a mechanical extract of the session's transcripts
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given a session dir and its transcripts, when `finish` runs, then the truss dir holds an extract listing tool errors, refusals by source (permission, classifier, hook, factory gate), retries and repeated commands, step durations, BLOCKED and stop reasons, QC failures, PM hand edits and workarounds, and failing check output with trace paths, each with transcript file:line, and the extract is still readable after the transcripts and worktrees are deleted.

## R-25: A known-problems catalog in the plugin is matched by the extract, the preflight and the stage workflow
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given catalog entries for webkit on a non-Ubuntu host, settings.local.json not reaching worktrees, guard-refused shell shapes, harness-only claude-code tests, node_modules missing after a merge and tracked .pyc files, when the extract, the preflight or a stage hits one of them, then it is reported by its catalog id with the entry's known fix instead of as a new problem.

## R-26: A startup check finds host problems before any crew starts
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given a plan whose crews list their needs (a browser that launches, npm ci, gh auth, a system library), when the plan is approved, then `factory doctor` probes each need on the host and reports the failures, and the client gets one approval bundle: allow rules to add to the committed .claude/settings.json, allowed downloads, and standing rulings for known problems, each logged as a decision.

## R-27: An independent judge reports evidence-backed findings
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given the extract and the transcripts, and not the PM's account of the run, when the retro runs, then a truss:retro-judge agent per crew and one combining judge report findings, each with a kind (mechanical bug, friction, missing agent persona, missing skill, missing hook or gate, misleading prompt, architecture decision), transcript file:line evidence, its cost, the fix and the file the fix belongs in; a finding with no cited transcript line is dropped, and transcript text is treated as data, never instructions.

## R-28: The judge reads extract-led on Opus
Status: met
Kind: nfr
Measure: at most 1 + (number of crews) judge agents per retro, each on Opus at effort medium, each opening only the transcript spans the extract points to
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client

## R-29: Approved findings are fixed automatically through a truss run with QC
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given the judge's findings, when a checking engineer has sorted them into fix now, defer or drop and deduped them against the catalog, then the fix-now findings become a goal that runs through truss automatically (crews, tests, QC engineer, merge), a fix that fails QC is not applied and is reported, and the client sees what was applied.

## R-30: Retro fixes touch only the files truss uses
Status: met
Kind: constraint
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: The retro may edit the plugin's agents, skills, hooks, workflows, scripts and catalog, the project's CLAUDE.md and .claude/ files including .claude/settings.json, and any other file that makes truss perform better; it never changes the code a truss run delivered. On another project its plugin fixes are drafted upstream changes. A permission or classifier refusal of one of its edits is shown to the client, never worked around.

## R-31: The next retro checks that fixed findings did not come back
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given a finding fixed by an earlier retro and recorded with its id, when a later run's retro runs, then it reports for each fixed finding whether its evidence pattern recurred, and a recurrence is a new finding that cites the earlier fix.

## R-32: Raw transcript text stays local; committed files stay clean
Status: met
Kind: constraint
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: The extract in the truss dir (inside .git, never committed) may hold short quoted transcript lines with file:line; every file the retro commits (catalog entries, fixes, ADR text) holds no names, emails, user paths, tokens or pasted secrets, and a scrubber checks this before each commit.

## R-33: The retro is proved by replaying this session
Status: met
Kind: functional
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: Given this session's truss dir and transcripts, when the new retro runs over them (reading what the session left, not re-running it), then its findings include webkit missing host libraries, settings.local.json not reaching worktrees, guard-refused shell shapes and tracked .pyc files dirtying main, each citing a transcript file:line; unit tests on fixture transcripts cover the extract.

## R-34: The retro may read raw transcripts, replacing P24 for the retro
Status: met
Kind: constraint
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: client
Example: A new ADR records the client's ruling that the retro reads transcripts, replacing P24 (the retro reads no raw logs) for the retro only; the event log still holds no message, prompt or report text (P8).

## R-35: The extract outlives the transcripts
Status: met
Kind: nfr
Measure: the extract is kept with the truss dir until the truss dir is removed, and 0 retro steps need a transcript older than Claude Code's 30-day cleanup
Added: 2026-10-31T07:23:37Z | Make truss improve itself from each run (independent retro judge, transcript extract, known-problems catalog, startup check, auto-applied fixes)
Source: default

## R-36: The crew network is the main view of the run
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a run whose plan.json has crews ui-network and ui-chat running and a crew ui-docs planned, when the client opens the page, then a PM node sits at the top with a wire to each of the three crew cards, the wires to running crews animate, and each crew card lists its agents as cards with the agent's current task and progress.
Example: Given a session with no plan.json yet, when the client opens the page, then the network still shows the PM node and states what the PM is doing (for example "planning"), not a bare "No plan yet."

## R-37: ADRs show in one place only
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a repo with 27 ADRs, when the client looks at the page, then the ADRs are listed in exactly one panel, and the built artifacts and deliverables list holds none of them.

## R-38: The architecture's mermaid diagrams render as diagrams
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given an architecture doc with a mermaid flowchart block, when the client opens the architecture, then the browser shows the drawn diagram (an SVG), not the mermaid source text; a block that fails to parse shows its source with a short error.

## R-39: The page shows one architecture, the latest
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given an architecture doc that carries a change log or version history section, when the client opens the architecture, then the page shows the current architecture only, with no change log, history or older versions.

## R-40: The page shows that work flows from the client to the PM, then to crews and agents
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a running session, when the client sends a message from the page, then the page shows it going to the PM node first, and when the PM starts or messages a crew, the wire from the PM to that crew lights up with what was sent.

## R-41: A goal typed in the page starts a truss run without typing /truss:run
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a fresh UI session, when the client types "add CSV export" in the goal box and sends it, then the session runs the truss:run skill on that goal, and the client never types /truss:run; how the page decides between a new run, a follow-up and a plain message is recorded in an ADR.

## R-42: Each agent shows what it is doing and why it exists
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a crew with a foreman, a builder and a QC engineer, when the client looks at the crew card, then each agent card shows its role, a one-line purpose (for the QC engineer, "Checks the crew's work against proof before it merges"), and its current task or last activity.

## R-43: Costs and run metrics have their own area, with no ceiling
Status: met
Kind: nfr
Measure: 0 spending limits set by the UI; one metrics area shows cost, tokens per model, run time, agents started and crews done, each refreshed within 2 s of the session message or state file that changes it
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client

## R-44: Every crew and agent shows a clear status
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a run with one crew running, one merged, one waiting on the client and one stalled, when the client looks at the page, then each shows a distinct status (active, done, waiting on you, stuck) as a word plus a visual cue that is not colour alone, and the run as a whole shows whether it is working, waiting on the client or finished.

## R-45: Messages with the PM read as a chat thread
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a session where the client sent two messages and the PM replied to each, when the client looks at the page, then the four messages show as a thread with the newest in view, next to the composer, without scrolling to the bottom of the page.

## R-46: The page follows the client's design reference
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given the client's reference truss_factory.tsx (left rail with the repo and the idea, a build network of PM and crews, built artifacts below), when the client compares it with the page during a live run, then the layout, hierarchy and crew network follow the reference, and screenshots of a live run show R-36 to R-45 met.

## R-47: A turn that is not an approval ask is answered with a reply, not Approve or Deny
Status: met
Kind: functional
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Given a session turn that ends with "Nothing is waiting on approval ... Tell me which of these you want, or give me something new.", when the client looks at the card it opens, then the card offers a reply box whose send action delivers the typed text as the reply (decision message), it is not titled as an approval, and no button sends the bare word "Approved." to an open question.
Example: Given a turn that asks to approve a plan or a push, when the card shows Approve and Deny, then each button states what it sends, and a typed reply can still be sent on its own.

## R-48: Works on current desktop Chrome
Status: met
Kind: constraint
Added: 2026-11-04T07:56:26Z | Rework the truss local web UI to match the client's design reference and fix the client's 10 points
Source: client
Example: Current and previous major versions of desktop Chrome, at window widths down to 1024 px. No phone layout. Firefox and Safari are not targets, and the browser checks run in chromium only.

## Non-goals
- The UI never edits the plugin, or Truss's files and state; the plugin does its own work (writing agents, plans, reports) and the UI only displays it and communicates with the session.
- No view across several repos or sessions, no history of past runs, and no phone or remote access (client altitude ruling).
- The retro never changes the code a truss run delivered; it changes only files truss uses (client ruling, 2026-10-31).
