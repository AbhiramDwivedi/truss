# ADR-0029: the UI on real data

Status: proposed, 2026-11-06. Written by the design crew `real-data-design` (stage 0 of the goal `real-data`, plan approved at 2026-11-06T15:01:34Z). It becomes accepted when the PM merges this crew. The crews `real-data-server`, `real-data-network`, `real-data-page` and `arch-current` build from it; it changes no code itself.

Decided by: the client's goal at 23:02 (the five real-data defects, superseding ADR-0023 gap h) and the client's ruling at 09:45, "Yes, read them" (the UI may read Claude Code's workflow transcripts read-only, first brief line only, under a `--claude-dir` flag); checker-8's fixes at 09:45 and checker-9's at 09:56, which the plan carries; and this crew for what those leave free.

Amends: [ADR-0028](0028-ui-rework.md) sections 4, 6, 8 and 9. Supersedes the `Pause build` bullet of [ADR-0023](0023-factory-floor-ui.md) gap h. Amends how R-9 reads, in the architecture doc's "Local web UI" section.

## Context

ADR-0028's page passed its fixtures, but screenshots of a copy of this run's truss dir show five defects:

1. Foreman cards of done crews read Waiting on you or BLOCKED, with a "model unknown" badge.
2. Members read "No activity yet" and show no task.
3. Cost and run time are empty.
4. `Pause build` shows its placeholder hint.
5. The architecture doc reads as version history.

The plan maps them to requirements: defect 1 to `R-44` and `R-42` (the status and the model badge), defect 2 to `R-42` (the task line), defect 3 to `R-43` (run time, Cost and the header summary), defect 5 to `R-39` (the latest architecture only). Defect 4 serves no R-id of its own; it traces to the client's point (4).

Three facts of the real dir cause them:

- `workflow-crew` foremen `tag` BLOCKED and never `report`. The reducer keeps the tag as the member's `detail` (`ui/server/state/reduce.ts:210-215`), and the client's `agentStatus` reads that as `waiting` (`ui/app/views/status/status.ts:38-43`).
- Members started inside a Workflow crew carry an `agentId` but no session task, because their task descriptions never reach the PM's stream. ADR-0028 section 6 left this as a `TODO:`. Claude Code writes each such agent's transcript to `~/.claude/projects/<projectKey>/<session id>/subagents/workflows/<wf id>/agent-<agentId>.jsonl`, next to a `.meta.json`.
- A truss dir watched with no hosted session has no transcript and no usage. Run time reads the transcript (`ui/app/views/metrics/RunMetrics.tsx:25-26`), and Cost reads `usage.costUsd` and otherwise says "No usage yet" (`RunMetrics.tsx:48-49`).

Reading the transcripts goes past what the architecture doc allowed: the UI showed the run "from Truss's own files" and never changed the plugin (`R-9`). checker-8 flagged that, and the client ruled at 09:45 that the UI may read them, read-only, first brief line only, under a `--claude-dir` flag.

## Decision

### 1. Status (defect 1; R-44, R-42)

- An agent of a crew whose `status` is `merged` or `dropped` is `done`, whatever its last `tag`.
- The rule lives in the client's `agentStatus` (`ui/app/views/status/status.ts:38`), not in the reducer, so the event log still shows the tag.
- An agent of a running crew that tagged BLOCKED still reads Waiting on you.
- A null model shows no model badge. `modelKey`'s `model unknown` (`ui/app/views/crews/format.ts:89`) goes.

This amends ADR-0028 section 9's agent column.

### 2. Task from the transcript (defect 2; R-42, R-9)

When the session has no task for an `agentId`, ui-state fills `Member.task` from that agent's Claude Code transcript.

- **Where.** The file is `agent-<agentId>.jsonl` under `<claudeDir>/projects/<projectKey>/<session id>/subagents/`. ui-state looks in `workflows/<wf id>/` when the spawn line's `by` is `workflow:<wf id>`, and at the top level otherwise.
- **Keys.** `projectKey` is the repo path with every character other than a letter or digit turned into `-` (`~/.claude/projects` holds `-home-abd-Projects-truss` for `/home/abd/Projects/truss`). The session id is the truss dir's basename (`architecture.md` "On disk": `<git common dir>/truss/<session id>/`).
- **What.** The task is the first non-empty line of the brief after the `[Workflow harness — computed task]` preamble, which ends `The computed task text follows:`. That line is dedented and cut to 200 characters.
- **Bounds.** Only the first line of the file is read, with a byte cap. The result is cached per `agentId`. Nothing is ever written. No read reaches outside `<claudeDir>/projects/<projectKey>/<session id>/`.
- **Absence.** A missing file gives null. The session's task wins over the transcript's.
- **Config.** `ui/server/main.ts` gains `--claude-dir <path>`, defaulting to `CLAUDE_CONFIG_DIR` and then `~/.claude`. Only `main.ts` resolves the default. `createStore` (`ui/server/state/index.ts:73`) gains an optional `claudeDir` and reads no transcripts when it gets none (core rule 10), so a test that leaves it out never reads the host's `~/.claude`. Today `main.ts` takes `--repo`, `--plugin`, `--truss-dir` and `--port` and exits 2 on any other flag (`ui/server/main.ts:6`, `:22`).
- **`by` stays internal to ui-state.** ui-state reads it from the spawn line inside the server and does not add it to the snapshot, so `ui/app/store/types.ts` and `ui/contract/state.schema.json` don't change.

**How R-9 reads now.** The UI reads the files the plugin writes, plus this run's Claude Code workflow transcripts, read-only, first brief line only, bounded. It still never changes the plugin and never writes to the truss dir, the repo or the Claude dir. The architecture doc's "Local web UI" intro, ui-state row, ui-server row, UI Seams and the service-pack config row say so.

This replaces ADR-0028 section 6's `TODO:` on Workflow members. The ui-session match on `task_id` stays; the transcript is the fallback when it finds nothing.

### 3. The client task chain (checker-8, accepted)

The card's task line is the first of these that holds:

1. `task`;
2. the crew `goal`, for a foreman;
3. a `detail` that isn't a marker;
4. `Reported` with its marker, for a reported agent.

"No activity yet" shows only for a spawned agent with none of these. This replaces ADR-0028 section 6's fallback bullet.

### 4. Run time and cost (defect 3; R-43)

- **Run time.** When the transcript is empty, run time starts at the RFC 3339 start of the first `decisions[].run` heading. It ends at now while the run works, and at the latest foreman or member `ts` once the run is finished or no session is hosted.
- **Cost.** Cost reads "Not recorded" when a run exists and there is neither session usage (`usage.costUsd` is null) nor a transcript. First use with no run keeps "No usage yet".
- **Banner summary.** The header summary agrees with Cost: it shows no `$0.00` when Cost reads "Not recorded" (for example, it shows only the run time).

This amends ADR-0028 section 8's run-time and cost bullets. Still no limit, budget or ceiling anywhere.

### 5. Pause (defect 4)

`Pause build` and its Hint go from the Run region (`ui/app/views/rail/RunContext.tsx:43-55`). This supersedes ADR-0023 gap h's `Pause build` bullet (`0023-factory-floor-ui.md:81`). No pause endpoint is added.

### 6. Architecture doc (defect 5; R-39)

The architecture doc states the current design only. It is rewritten, not filtered: no "Foundry 0.x.0 adds" history prose and no `(0.x.0)` heading suffixes. ADR-0028 section 4's design-panel filter stays, and section 4 gets a note pointing here. Crew `arch-current` does the rewrite, keeps every heading and this ADR's link, and keeps at least 90% of the doc's words.

## Contract

The stage-0 test-writer adds, and later crews turn green:

- `ui/contract/rework/real-data.check.ts`: node cases titled `real-data 2: ` (the server task derivation, run with `createStore({ ..., claudeDir })` over the raw fixture, including `real-data 2: a missing transcript gives null` and `real-data 2: the session's task wins`, and that `main.ts` takes `--claude-dir`) and `real-data 5: ` (the doc, including `real-data 5: no Truss version marker remains`, `real-data 5: every pre-build heading is still present` and `real-data 5: three Seams headings remain`).
- `ui/contract/rework/real-data.spec.ts`: Playwright cases `real-data 1: ` to `real-data 4: ` in the rework project, over the snapshot.
- `ui/contract/fixtures/real-data/`: a raw truss dir plus a fake Claude dir, scrubbed of user paths, and `arch-headings.txt`, the doc's heading list as stage 0 leaves it.
- `ui/contract/fixtures/rework/real-data/state.json`: the snapshot the server would make of it, added to ADR-0028's `Rework fixture states:` line.

Every harness that starts `ui/server/main.ts` passes the Claude dir as `CLAUDE_CONFIG_DIR` in the child's env, since pre-build `main.ts` exits 2 on the flag. No test reads the host's `~/.claude`.

## Consequences

- `R-42` holds for Workflow members on a real dir, and `R-44` for done crews whose foremen only tagged.
- `R-9` is wider by one bounded, read-only source. A user who keeps Claude Code's config elsewhere sets `--claude-dir` or `CLAUDE_CONFIG_DIR`. When the transcript is missing or moved, the card falls back down the task chain.
- The transcript's first-line shape is Claude Code's, not Truss's. If the harness preamble changes, the task line falls back to the chain and the `real-data 2: ` cases go red.
- `Member`, the schema and `types.ts` gain no field; `by` never leaves the server.
- A run watched without a hosted session shows a run time and "Not recorded" in place of empty tiles and a `$0.00` header.
- There is no Pause control until a pause endpoint exists.
