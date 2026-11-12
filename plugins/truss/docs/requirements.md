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
Example: Given a crew with a project manager, a builder and a QC engineer, when the client looks at the crew card, then each agent card shows its role, a one-line purpose (for the QC engineer, "Checks the crew's work against proof before it merges"), and its current task or last activity.

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

## R-49: The PM sizes each piece of work, from one agent to a full crew
Status: met
Kind: functional
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client
Example: Given a goal that is a docs fix, a config change and a new factory feature, when the PM plans it, then the docs fix and the config change each go to one agent with no project manager, planner, tester or QC engineer, and the feature gets a full crew (planner through QC engineer). The size is the PM's own call, logged with a one-line reason.

## R-50: A one-agent task needs no red-then-green test and no QC engineer
Status: met
Kind: functional
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client
Example: Given a one-agent task to fix stale statuses in requirements.md, when the agent reports, then the PM reviews the diff and the agent's own proof (for example the checker's OK line), merges the branch and logs it, and no hook or merge gate asks for an acceptance test proved red or a QC engineer's PASS.

## R-51: A small crew is one or two members, and the PM picks its proof
Status: met
Kind: functional
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client
Example: Given a bug fix sized as a small crew of one builder and one tester, when it runs, then the PM decides whether it gets a QC engineer and a red-then-green acceptance test, logs that choice, and the merge gate follows the logged choice.

## R-52: A sizing agent can recommend the tasks and crew sizes
Status: met
Kind: functional
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client
Example: Given a goal the PM can't size at a glance, when the PM starts the sizing agent, then it returns the work split into tasks, each with a recommended size (one agent, small crew or full crew) and a one-line reason; the PM decides and may overrule it with a logged reason. A goal whose tasks are all one-agent tasks skips the plan design engineer, the checking engineer's plan review and plan approval.

## R-53: The tests for sizing are cheap
Status: met
Kind: nfr
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client
Measure: the new tests start 0 agents and make 0 model calls, and add under 10 s to the root npm test.

## R-54: Sizing works on Linux, macOS and Windows
Status: met
Kind: constraint
Added: 2026-11-08T08:40:52Z | Right-size the process per crew
Source: client

## R-55: An unattended run stops only on the exception list, through a shared inbox
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given an unattended run where one crew needs a client answer, when the PM runs `factory escalate --kind client-question --crew c1 --blocking`, then an item lands in `<common>/truss/shared/inbox.jsonl`, crew c1 is held at `start` and `admit` with `awaiting client: E-...`, every other crew keeps running, and the configured `notify` command gets the row on stdin.

## R-56: An agent cannot forge a client approval
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given an open long-term-cost item, when an agent runs `factory resolve <id> --decision approve --by client --code <code>` with no human-typed prompt naming the id, decision and code in the main transcript, then it exits 1; after the human types `/truss:inbox approve <id> <code>`, the same call succeeds and stores the prompt as `quote`.

## R-57: Nothing that costs the client later merges without the client
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given a solo crew whose diff adds a runtime dependency to a manifest, when `land` runs, then it refuses with `long-term-cost: E-...` until the client approves that item; a QC `LONG-TERM-COST: ... | reversal: cheap` line is only logged.

## R-58: Spend is metered from transcripts and budgets hold crews
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given `budget.crewUsd` 5 and a crew whose deduplicated transcript usage prices at 5.20 USD, when `admit` runs for its next member, then it exits 1 in under 1 s with `budget: ...`, opens one budget escalation, and an approved resolve with `--raise-usd 3` lets it continue; an unpriced model gives `usd: null`, never 0.

## R-59: The meter agrees with Claude Code's own estimate
Status: open
Kind: nfr
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Measure: `factory cost` on one real session lands within 5% of `claudeCodeEstimateUsd` with a client-supplied price table; the result is recorded in ADR-0038.

## R-60: `/truss:run --next` runs one queued item with no human present
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given one `new` item in the queue and `/loop 30m /truss:run --next`, when it fires, then the PM claims the item, gates it through the sizing and checking engineers, writes the brief with defaults and non-blocking client-question items, plans, approves `--by auto`, runs the crews, merges locally, escalates `push-pr`, and an AskUserQuestion call during the run is refused by the hook.

## R-61: Work enters through an intake queue from a markdown file or GitHub issues
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given `docs/queue.md` with `- [ ] add a --json flag to status` and an open `truss`-labelled issue by a non-collaborator, when `factory intake` runs, then the first becomes a `new` item, the issue becomes a `triage` item with an `intake-triage` escalation, and two processes racing `queue-next` claim the new item exactly once.

## R-62: A crew can carry a work type that sets its minimum process
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given a v4 plan with a crew `workType: "bugfix"` and `process: "solo"`, when `plan-check` runs, then it fails with `<slug>: process solo is below the bugfix minimum lean`; the same plan without workType passes outside an unattended run, and fails with `workType is required in an unattended run` inside one.

## R-63: Every merge is logged in an append-only ledger
Status: open
Kind: functional
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal
Example: Given a crew merged by `finish` or `land`, when the merge completes, then one row `{kind: "merge", session, crew, goal, workType, process, qc, red, target, base, head, costUsd}` is appended to `<common>/truss/shared/ledger.jsonl`, with `costUsd: null` and a `costWhy` when spend was not recorded.

## R-64: Wave 2 works on Linux, macOS and Windows
Status: open
Kind: constraint
Added: 2026-11-10T04:32:43Z | truss 0.25.0 wave 2 (contract-025)
Source: goal

## R-65: Only verified client proof can lift an inbox block
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given a blocking inbox item, when a process appends a `resolve` row to inbox.jsonl without verified client proof, then the guard and inbox folds keep the item open and the crew stays held; a `--note` that differs from the typed answer, a `local-command-stdout` line, a task-notification line with no origin, and a transcript root taken from the caller's environment are each refused.

## R-66: The long-term cost guard fails closed and sees its missed triggers
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given a crew whose `git diff` fails or exceeds 1 MB, or a plan with no ltc-plan.json, when the guard runs, then the merge or plan gate blocks with a clear message; a devDependencies to dependencies move and a git-quoted odd file name each raise a trigger.

## R-67: A crash cannot lose an escalation code or strand a queue item
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given an escalate that dies after its append, when the client next reads the inbox, then the item's code is recoverable; given a `--next` session that crashed, when a later session claims work, then the stale `running` item is released by the stale-running rule.

## R-68: Cost readings and budget keys tell the truth
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given a torn usage.jsonl row or a slow first sweep, when `factory cost` runs, then it skips the torn row or reports busy rather than failing; `sessionUsd` is either enforced in attended runs or documented as not enforced; intake and planning spend counts against it; `inbox --unapplied` can filter by session.

## R-69: The wave-2 plugin and process gaps are closed
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given a crew that needs one more owned file, when the program manager runs the new factory command, then owns grows without a hand edit of plan.json; a suite run on main reads nothing under .claude/worktrees.

## R-70: The wave-2 doc leftovers are corrected
Status: open
Kind: functional
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal
Example: Given ADR-0039 and the version-pin test, when they are read after this release, then the two wrong ADR sentences are gone and the test takes the version from plugin.json.

## R-71: Every 0.26.0 fix carries a regression test and works on Linux, macOS and Windows
Status: open
Kind: constraint
Added: 2026-11-11T04:09:40Z | truss 0.26.0 wave-2 fixes
Source: goal

## R-72: The crew lead is the project manager agent, with the old crew-lead name kept as an alias for one release
Status: replaced by R-78
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal
Example: Given a plan and a run started after the rename, when the program manager starts a crew lead, then it starts `truss:project-manager`; and when a 0.26.0 plan or brief names the old agent type, then that type still resolves and the CHANGELOG says in which release the alias goes.

## R-73: Role and config keys that name the old crew lead have new names, and the old names still parse
Status: replaced by R-79
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal
Example: Given a roles.json or .claude/truss.json that uses an old crew-lead key (for example the old prompt override key), when factory reads it, then it is read as the new project-manager key, and a test covers each such alias.

## R-74: Labels, slugs and transcripts written before the rename keep parsing
Status: replaced by R-80
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal
Example: Given a Workflow transcript or crew report from 0.26.0 whose labels or event fields name the old crew lead, when finish, the retro or the cost meter reads it, then it parses and counts it as it did before the rename.

## R-75: Docs, skills, agent prompts and tests use the new role names, and the rename is recorded in an ADR
Status: open
Kind: constraint
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal

## R-76: Prose names the project manager and the program manager in full; a file that keeps PM defines it
Status: open
Kind: constraint
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal

## R-77: Only alias code, alias tests, the CHANGELOG and historical ADRs still use the old crew-lead name
Status: replaced by R-81
Kind: nfr
Measure: 0 lines naming the old crew lead over plugins/truss, docs and checks outside alias code, alias tests, the CHANGELOG and historical ADRs, with the plugin suite and root checks at exit 0
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: goal

## R-78: The crew lead is the project manager agent, and the old crew-lead agent type is gone
Status: open
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: client
Example: Given a run after the rename, when the program manager starts a crew lead, then it starts `truss:project-manager`, the hooks gate it as a crew lead, and no agent file or type under the old name exists, so a start under the old type is not treated as a crew lead.

## R-79: Role and config keys that named the old crew lead are renamed, with no alias
Status: open
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: client
Example: Given a .claude/truss.json whose `promptOverrides` sets `project-manager`, when it is validated against the config schema, then it passes; and the old key is no longer a property, so a config that still sets it fails validation.

## R-80: Stored and printed names that carried the old crew-lead name are renamed, with no dual reader
Status: open
Kind: functional
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: client
Example: Given a run after the rename, when the hooks record an idle crew lead, then the stall event kind is `idle-project-manager` and the retro counts it under `stalls.idleProjectManager`; labels and slugs that never held the old name keep parsing as before.

## R-81: No file in the plugin, docs or checks names the old crew lead
Status: open
Kind: nfr
Measure: 0 lines naming the old crew lead (any case) in every file `git ls-files plugins/truss docs checks` lists, historical ADRs, CHANGELOG, fixtures and eval inputs included, with the plugin suite and root checks at exit 0
Added: 2026-11-11T19:18:05Z | truss 0.27.0 crew-lead rename
Source: client

## Non-goals
- The UI never edits the plugin, or Truss's files and state; the plugin does its own work (writing agents, plans, reports) and the UI only displays it and communicates with the session.
- No view across several repos or sessions, no history of past runs, and no phone or remote access (client altitude ruling).
- The retro never changes the code a truss run delivered; it changes only files truss uses (client ruling, 2026-10-31).
- No measurement of sizing against an earlier run (client ruling, 2026-11-08).
- Full crews keep today's process: planner, builders and testers, red-then-green acceptance test, QC engineer, stress test where it applies.
- No auto-push or autoLand, no cloud Routines, no daemon, no resume across sessions, no inbox or cost UI, no fetched prices, no ci intake adapter, and no prod deploy from an unattended run (contract-025 section 10).
