I ignored no PM account because the brief carried none. I judged from `retro/problems.json`, `decisions.md`, `events.jsonl`, `plan.json` and the plugin source in the truss-retro-generic worktree. I opened no transcript.

The counting step's own findings cover idle time, QC rounds, file churn, owns overlaps, refusals and per-role cost well, so I do not repeat them. I found eight problems it misses or misattributes. None of them is in the catalog.

Three of the counting step's findings point at the wrong fix, and the decision log shows why.

- The counting step blames the long crew idle times (`P-time-idle-*`) on the PM starting members late. The log says otherwise. A crew that stopped early kept its slot until the whole stage Workflow returned, and a crew that passed QC kept its slot through its roughly 30-minute finish suite (10:34 and 00:55 entries).
- The counting step sends the slot-busy stops (`P-gates-stops-*`) to the planning engineer. They actually come from the fixed 540-second heavy-slot wait (`HEAVY_WAIT_MS` in `plugins/truss/bin/factory/resources.ts`). Hygiene's 20-run load check took about 30 minutes, so that wait timed out every other crew at green.
- The 2 h 54 min idle gap (`P-time-idle-gaps`) was a client-ordered pause (17:08 and 18:25 entries). It is not a defect, and no change to `.claude/truss.json` would fix it.

Two problems I could not tie to any measure, so they have no finding block. The PM wrote decision lines with a Bash redirect at 07:40, and the hook did not refuse it. QC also missed two broken doc citations that a fix round introduced (02:18).

For the audit-waiver finding below, the only cost measure available is the crew's total ruling wait. That number is an upper bound on what the waiver cost.

```finding
{"category": "time", "title": "A crew that stopped or passed QC kept its parallelism slot until the whole stage or its finish suite ended, so queued crews waited on the slowest one", "evidence": [{"measure": "time.idleMs.resume-guard", "value": 41754484}, {"measure": "time.idleMs.approve-proof", "value": 60273635}, {"measure": "time.wallMs.resume-guard", "value": 127844410.43359375}], "cost": {"wallMs": 41754484, "tokens": null, "usd": null}, "fix": "Free a crew's slot the moment it stops or passes QC: run each crew as its own Workflow from the start and have admit stop counting a crew whose stop record is written, not only one whose finish has merged.", "target": {"kind": "plugin", "path": "plugins/truss/workflows/stage.js"}, "signature": ["crew\\(s\\) running already fill the parallelism", "stays running until the whole stage returns"]}
```

```finding
{"category": "rules and gates", "title": "One heavy slot with a fixed 540 s wait timed out every other crew at green while hygiene's 30-minute load check held the slot", "evidence": [{"measure": "rules.slotBusyStops.crew-decisions", "value": 2}, {"measure": "rules.slotBusyStops.approve-proof", "value": 1}, {"measure": "rules.slotBusyStops.hygiene", "value": 1}, {"measure": "time.waitRulingMs.hygiene", "value": 24705263}], "cost": {"wallMs": 24705263, "tokens": null, "usd": null}, "fix": "Queue a crew behind the heavy-slot holder, or size the wait from the holder's expected check time, instead of stopping the crew BLOCKED after a fixed HEAVY_WAIT_MS of 540000.", "target": {"kind": "plugin", "path": "plugins/truss/bin/factory/resources.ts"}, "signature": ["heavy slot busy 540 s", "BLOCKED at green \\(heavy slot"]}
```

```finding
{"category": "quality loop", "title": "A resume's answers file replaced the crew's earlier rulings, so approve-proof's QC failed again on a settled point and spent the rework allowance", "evidence": [{"measure": "quality.allowanceSpent.approve-proof", "value": 1}, {"measure": "quality.qcFail.approve-proof", "value": 5}, {"measure": "quality.qcFailTokens.approve-proof", "value": 7181995}, {"measure": "quality.qcFailMs.approve-proof", "value": 3803551}], "cost": {"wallMs": 3803551, "tokens": 7181995, "usd": null}, "fix": "Have start --resume carry every earlier answer for the crew forward and add the new one, or refuse a resume whose answers drop an unbuilt earlier ruling.", "target": {"kind": "plugin", "path": "plugins/truss/workflows/stage.js"}, "signature": ["answers held only the \\d\\d:\\d\\d text", "ruling was not carried on the .* resume"]}
```

```finding
{"category": "quality loop", "title": "A resume at qc that carried a PROPOSAL ruling spawned no fix builder and dropped a builder commit, so run-lifecycle failed QC again and spent its allowance", "evidence": [{"measure": "rules.allowanceStops.run-lifecycle", "value": 1}, {"measure": "quality.qcFail.run-lifecycle", "value": 3}, {"measure": "quality.qcFailTokens.run-lifecycle", "value": 4524746}, {"measure": "quality.qcFailMs.run-lifecycle", "value": 2497108}], "cost": {"wallMs": 2497108, "tokens": 4524746, "usd": null}, "fix": "When a resume at qc carries a ruling that needs a code change, start a fix builder before QC, and merge every member commit on the crew branch before QC reads the head.", "target": {"kind": "plugin", "path": "plugins/truss/workflows/stage.js"}, "signature": ["spawned no fix builder", "dropped unmerged"]}
```

```finding
{"category": "tests", "title": "inbox.check.ts holds a fixed 11 s wall-clock bound that fails under full-suite load, costing a finish rerun and a crew-decisions stage stop", "evidence": [{"measure": "time.stops.crew-decisions", "value": 9}, {"measure": "tests.lastRunMs.crew-decisions", "value": 960188.195385}], "cost": {"wallMs": 960188.195385, "tokens": null, "usd": null}, "fix": "Replace the fixed 11 s bound with one derived from a measured baseline, or assert the kill by signal and exit order instead of elapsed time; check whether hygiene's merged item 12 already did this.", "target": {"kind": "plugin", "path": "plugins/truss/tests/inbox.check.ts"}, "signature": ["a notify grandchild that sleeps is killed within 11 s", "inbox\\.check\\.ts:442"]}
```

```finding
{"category": "rules and gates", "title": "Finish's session audit blocked merges on runner transcripts that failed with API 403 and on other workflows' in-progress transcripts, holding crews for a client waiver", "evidence": [{"measure": "time.apiOutageStops.crew-decisions", "value": 1}, {"measure": "time.waitRulingMs.crew-decisions", "value": 10383645}], "cost": {"wallMs": 10383645, "tokens": null, "usd": null}, "fix": "Audit only the crew's own finished transcripts, and let finish pass a <synthetic> transcript with no tool calls as a no-work API failure instead of waiting on the client.", "target": {"kind": "plugin", "path": "plugins/truss/bin/factory.ts"}, "signature": ["the transcript model family is <synthetic>", "model family unknown"]}
```

```finding
{"category": "cost", "title": "The runner role is a general-purpose agent spawned 655 times, about 90K tokens each, and it is the largest or second-largest token line in every crew", "evidence": [{"measure": "cost.tokens.crew-decisions.runner", "value": 21066711}, {"measure": "cost.spawns.crew-decisions.runner", "value": 225}, {"measure": "cost.tokens.approve-proof.runner", "value": 12534932}, {"measure": "cost.tokens.run-lifecycle.runner", "value": 9016051}, {"measure": "cost.tokens.hygiene.runner", "value": 7273686}, {"measure": "cost.tokens.resume-guard.runner", "value": 5324193}, {"measure": "cost.tokens.factory-gaps.runner", "value": 5263370}], "cost": {"wallMs": null, "tokens": 21066711, "usd": null}, "fix": "Give the runner a dedicated Bash-only agent type with a minimal system prompt in roles.json, or batch consecutive factory commands into one runner call, so each spawn does not reload the full general-purpose tool set.", "target": {"kind": "plugin", "path": "plugins/truss/workflows/roles.json"}}
```

```finding
{"category": "plan", "title": "The plan put five of six crews on factory.ts in one stage, with shared docs and pre-numbered ADRs, forcing sync agents, conflict rework and ADR renumbering", "evidence": [{"measure": "code.crews.plugins_truss_bin_factory_ts", "value": 5}, {"measure": "code.commits.plugins_truss_bin_factory_ts", "value": 22}, {"measure": "cost.tokens.factory-gaps.resolver", "value": 1768916}, {"measure": "time.conflictMs.factory-gaps", "value": 103045}], "cost": {"wallMs": 103045, "tokens": 1768916, "usd": null}, "fix": "In plan mode, give a hot file one owning crew per stage and sequence the other crews behind it, and let crews take ADR numbers at merge time rather than in the plan.", "target": {"kind": "plugin", "path": "plugins/truss/agents/design-engineer.md"}}
```

```finding
{"category": "cost", "title": "QC spent more tokens than the builders in three crews, and the writer outspent the builders in hygiene", "evidence": [{"measure": "cost.tokens.approve-proof.qc", "value": 9055754}, {"measure": "cost.tokens.approve-proof.builder", "value": 8394335}, {"measure": "cost.tokens.factory-gaps.qc", "value": 4706383}, {"measure": "cost.tokens.factory-gaps.builder", "value": 3896791}, {"measure": "cost.tokens.hygiene.qc", "value": 3038496}, {"measure": "cost.tokens.hygiene.builder", "value": 2465428}, {"measure": "cost.tokens.hygiene.writer", "value": 8750194}], "cost": {"wallMs": null, "tokens": 9055754, "usd": null}, "fix": "Scope each repeat QC round to the previous round's findings and the diff since, and brief the knowledge writer with the crew's diff and touched docs only, not a full repo read.", "target": {"kind": "plugin", "path": "plugins/truss/workflows/stage.js"}}
```
