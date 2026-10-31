---
name: retro
description: Counts what a truss session recorded (escalations, checking engineer recommendations and overrules, stalls, spawns by model and effort, QC engineer rejections, decision timing, the plan) and proposes changes to .claude/truss.json and the prompt-override files from them. Use when the person runs /truss:retro, or asks how a truss run went, what to change in truss's setup, or why crews stalled or got rejected.
---

# truss retro

You report what a truss session dir recorded and propose setup changes from it. A script does the counting; you QC engineer. You never read the raw logs (P24) and you never print message, prompt or report text, except the QC engineer files' `VERDICT:` and finding lines that section 3 quotes as evidence.

The person who ran `/truss:retro` is the client.

## 1. Find the dir and run the script

The session's truss dir is `<repo>/.git/truss/<session id>/`. Use the current session's, or the one the client names. Resolve `<repo>` with `git rev-parse --git-common-dir`, which also works from a worktree.

Find the script: `${CLAUDE_PLUGIN_ROOT}/scripts/retro.py` when that variable is set, else `scripts/retro.py` two directories above this skill's own folder. Then run:

```
python <plugin root>/scripts/retro.py <truss dir>
```

Exit 2 with `retro: NO_TRUSS_DIR:` means the dir is wrong: say so, show the path, ask the client for the right one, and stop. Any other failure: show the error and stop.

For the counts, read only the JSON it prints. Section 3 adds a few bounded reads of its own.

## 2. Report the counts

Per run (`runs`), then the dir-wide keys. Be brief; a table or short list per run.

- **Escalations** (`escalations`): QUESTION, BLOCKED, PROPOSAL. A foreman crew's come from its tagged messages to the PM; a Workflow crew's from the stops `factory.ts finish --result` records from the stage result, one per crew and run (ADR-0009 "finish, escalation lines"). A Workflow run that never went through `finish --result` records none.
- **Checking engineer** (`recommendations`): answer, defer, pass. With `decisions.overruled`, say how often the PM overruled.
- **Stalls** (`stalls`): agent and idle-foreman.
- **Spawns** (`spawns`): total, and `byModelEffort`. `unset` means the call named no model or effort.
- **Client interruptions**: `escalations.QUESTION` and `escalations.BLOCKED` are what foremen sent the PM that could reach the client; the PM took only some to the client, so call these an upper bound. `messages` counts foreman-to-foreman messages, not client interruptions; report it separately as crew collisions.
- **QC rejections**: `qcs.fail` per run, and `qcFiles` for the whole dir (its files can't be split by run).
- **Spent allowances** (`allowancesSpent`, per run): how many distinct crews spent their rework allowance. `"not recorded"` means the log can't back a number, as on a pre-0.5.0 log or a run that spent none; say so and never write 0. `retro` stays 1.
- **Fetches** (`fetches`, per run): `total` and `perAgent`, the web fetches and searches the agents logged (0.8.0 and later logs). `"not recorded"` means the run is not placed in the event log, or the whole log has no fetch line, as on a pre-0.8.0 log; say so and never write 0. A log with fetch lines but none in this run gives `total` 0.
- **Extend passes** (`extendPasses`, per run): commits in the run's window (from its start to the next run's start) whose subject starts `docs(arch): extend ` or is `docs(arch): adopt learned items`. 0 means git was read and none matched. `"not recorded"` means the dir isn't `<repo>/.git/truss/<session>`, git couldn't run, or the run has no parsed start.
- **Default decisions** (`defaultDecisions`): how many ADRs in the `adr` dir of `.claude/truss.json` still hold the line `Decided by: default`. It is the repo's state now, so every run shows the same number. `"not recorded"` means no repo root, no readable config, no `adr` key, or no such dir.
- **Open client actions** (`openClientActions`): how many `- [ ] ` lines sit under a `Client actions` heading in the file named by the `architecture` key. Also the repo's state now. `"not recorded"` means no repo root, config, key or file. Report the four keys above as counts and propose no rule deletion from them; what evidence justifies deleting a domain rule is still open (truss ADR-0005, Consequences, "Open: pruning evidence").
- **Opus-high share**: the share of the run's spawns on Opus at `high` or `xhigh`. The numerator is the sum of the `byModelEffort` counts whose model contains `opus` (case-folded) and whose effort is `high` or `xhigh`; the denominator is `spawns.total`. The target is 0, unless a line in `decisions.md` records the client's call for `high` or `xhigh`. Report any other non-zero share as over target. The script prints no key for it; you compute it.
- **Decision timing** (`decisions`): `clock`, `dateOnly`, `notRecorded`. Also `freeform` lines the script couldn't read as decisions.
- **Leftovers** (`leftovers`): this session's agents whose `worktree-agent-<id>` branch or `.claude/worktrees/agent-<id>` folder is still present, read from git and the disk. Report `count` and the names. `"not recorded"` means the dir isn't `<git common dir>/truss/<session>`, there's no event log, or git couldn't run; say so and never write 0.
- **Leftover details** (`leftoverDetails`): one entry per leftover. Per entry, report its `id`, `head`, `dirty`, `inMain` and `skip`; write a `null` value as none. When the key is `"not recorded"`, say "not recorded".
- **Plan** (`plan`): crews, stages, the `estAgents` total, and `status` counts. `agentCap` is retired (0.7.0); an old plan.json may still carry it, and when it does not the script says "not recorded". Mention it only if it is a number. It describes the last run only.
- **Goals** (`goals`, only when present): report one row per goal with its crews, `estAgents`, status counts and decisions. A goal with crews but 0 decisions is reported as is. It is not an anomaly and gets no `CAUSE:` line.

Wherever the JSON says `"not recorded"`, write "not recorded". Never turn it into zero, and never guess a number. If `split` is `"not recorded"`, say the dir couldn't be split into runs: the counts are for the whole dir, and the event-derived ones (spawns, stalls, escalations, QC engineers) weren't recorded. If `eventsSkipped` is above 0, say how many event lines were skipped; `eventsOutsideRuns` events fell before the first run heading.

## 3. Find the causes

Give each anomaly one line, exactly `CAUSE: <anomaly> | <evidence> | <fix location>`. There are five kinds. `<anomaly>` starts with the kind's name, then names the item, for example `leftover a0123456789abcdef` or `QC engineer fail auth-qc-2`.

- `leftover`: each `leftoverDetails` entry.
- `QC engineer fail`: each QC engineer file (`reports/<crew>/<name>-qc.md` or `<name>-qc-<n>.md` in the truss dir) whose first line starts `VERDICT: FAIL`.
- `stall`: per run, a non-zero `stalls.agent` or `stalls.idleForeman`.
- `overrule`: per run, a non-zero `decisions.overruled`.
- `spent allowance`: per run, a non-zero `allowancesSpent`.

Spawns over estAgents are not an anomaly; give them no CAUSE line.

`<evidence>` is a fact from an allowed source, such as the entry's `skip` string or a QC engineer finding line (a line under the QC engineer file's `## Findings` heading that starts `- `). `<fix location>` is a file and a key, line or section. When the allowed sources don't show a cause, write `CAUSE: <anomaly> | not found | none`. Don't guess.

Its only sources are git, the disk, decisions.md, the QC engineer files' VERDICT: and finding lines, and the plugin's own files. It never reads message, prompt or report bodies (P24). The QC engineer files' `VERDICT:` and finding lines are the only report text it reads. Use at most 3 reads per anomaly; a git command, a file read and a grep each count as one.

A leftover whose `skip` is `passes every check retro can see` may still be kept by a check retro can't see: the session's own checkout, an agent that hasn't stopped, a crew member still running, or the checkout the last merge ran in. Say so in the evidence; don't pick one.

When the fix belongs in a file of the truss plugin, not of the project, start `<fix location>` with `plugin: `. Plugin-level causes go to the client as plugin findings and are never written (ADR-0005 section 1). Only project files (`.claude/truss.json`, prompt-override files) can become section 4 proposals.

## 4. Propose changes

Propose a change only when a count or a section 3 `CAUSE:` line supports it, and say which. Each proposal names a file and a key or path, the current value (read the file; it is the client's config, not a log), the new value, and why.

- `.claude/truss.json`: `roles` (a job's agent type, for example a job whose QC engineer rejections or stalls cluster on one model), `deploy`, `writingSkill`, `promptOverrides`. Keep to keys the schema declares (`truss-config.schema.json`).
- `.claude/truss/prompts/<role>.md` for the roles `foreman`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`: a line a role keeps missing, and the `promptOverrides` entry that points to the file. A prompt file adds to the role's prompt; it never replaces it.

Retro may propose removing a rule, and each proposed rule names the rule it replaces, or says `none`. A removal needs a count or `CAUSE:` line like any other proposal.

If the counts support nothing, say so and stop. Don't invent changes.

## 5. Write only what the client approves

Show the proposals as a list. Write only the ones the client approves, keep every key and value already in the file, and don't edit anything else. Then show what changed.

Repeated work the counts point to, such as the same command sequence or the same brief written again, is `kit:revise`'s job. When `kit:revise` is in the skills list, hand it the finding through the Skill tool. Otherwise say `kit:revise` isn't installed.
