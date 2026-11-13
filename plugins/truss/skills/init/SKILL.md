---
name: init
description: Checks that the project has a truss architecture doc and, when it doesn't, has the truss:design-engineer agent write one (principles, module map, ADRs for decisions already in the code). Then builds on kit's manifest when the project has one, never setting kit up itself, and proposes the 0.4.0 keys of .claude/truss.json (roles, deploy, writingSkill, promptOverrides), writing only the ones the client approves. Also proposes a short PM section for the project's CLAUDE.md, and a narrow permissions allowlist for the project's .claude/settings.json that truss writes once the client approves it. Use when the person runs /truss:init, asks to set up truss or write the project's architecture doc, or when a truss run finds no architecture doc.
---

# truss init

You check whether this project has an architecture doc that truss can use. If it doesn't, you have the design engineer write one and show the client what it wrote. Then you read kit's manifest, propose the rest of `.claude/truss.json`, and write only what the client approves. You don't write the doc yourself and you don't edit source.

The person who ran `/truss:init`, or who started the run that called this skill, is the client.

The design is truss's ADR-0002 (`<this skill's base dir>/../../docs/adr/0002-kit-manifest-and-config.md`). Read it if a case here isn't clear.

## 1. Check for the architecture doc

1. Find the repo root: `git rev-parse --show-toplevel`, run in the session's working directory. Call it `<repo>`.
2. Read `<repo>/.claude/truss.json`.
3. The doc is **present** when that file exists and the `architecture` key it holds names a file that exists, read as a path relative to `<repo>`.
4. The doc is **missing** when there is no `<repo>/.claude/truss.json`, or the file it names doesn't exist.
5. If `truss.json` exists but isn't valid JSON, or has no `architecture` key, tell the client what's wrong with it and stop. The client may have added keys to it by hand (`maxParallelCrews`, `merge`, `target`, and from 0.4.0 the keys in step 6), so don't have it rewritten.

If the doc is present, tell the client: "Architecture doc: `<path>`, ADRs in `<adr>`, from `.claude/truss.json`." Then go to step 5.

## 2. Look for an architecture doc the repo already has

When the doc is missing, look for one the project already keeps, so the design engineer extends it instead of writing a second one. Search `<repo>` with Glob for files named like `ARCHITECTURE.md`, `architecture.md` or `docs/architecture*`, and for an ADR folder (`docs/adr`, `docs/decisions`, `adr`). Skip `node_modules`, vendored code and build output. If `truss.json` named a doc that no longer exists, note that too.

## 3. Start the design engineer in init mode

```
Agent({
  subagent_type: "truss:design-engineer",
  name: "designer-init",
  model: "opus",
  effort: "medium",
  description: "Write the project's architecture doc",
  prompt: "<the brief below>"
})
```

Run it in the foreground and wait for its hand-back. The design engineer runs outside every crew, so the plugin doesn't save its report.

The brief's first line is `Mode: init`. After it, the brief gives:

- the repo root, `<repo>`, as an absolute path;
- the existing architecture doc and ADR folder you found in step 2, or "none found";
- when the client ran `/truss:init` with a goal: the goal, word for word, and that the design engineer also adds a domain section for each domain the goal touches, so a repo with no code yet still gets a doc;
- when your args carry a `Greenfield: <path>` line (the run skill passes it after the client brief): that line word for word, and that the repo has no code, so the design engineer lists planned modules and cites the R-ids in the requirements file at that path;
- when `truss.json` exists and names a missing doc: that path, and that the file's other keys must stay as they are;
- the feature map: the design engineer creates `docs/features.md` from the code on day 0 (one entry per user-facing capability, with entry points, owning persona and doc pointers), unless the repo already has one. Crews and the planner read it before they scan code, and each crew's knowledge step keeps it current;
- the project's agents: list `<repo>/.claude/agents/*.md` (symlinks followed), sort them into personas (they can write) and judges (read-only), and pass the list. When the project has no persona, the brief says so, and that the design engineer proposes day-0 personas, one per stack and area it finds in the code plus a read-only `product-owner` judge, as its "init mode" outputs say;
- what to write: the architecture doc (principles, module map, ADRs for the decisions already in the code) and `<repo>/.claude/truss.json` with the keys `architecture` and `adr` only. An existing doc is extended, not replaced. With none, the doc goes to `docs/architecture.md` and the ADRs to `docs/adr/`.

## 4. Show the client what the design engineer wrote

1. Run `git status --porcelain` in `<repo>` to list the files the design engineer created or changed.
2. Show the client:
   - the architecture doc's path, and its list of principles and its module map;
   - each ADR's path and title;
   - the contents of `.claude/truss.json`;
   - anything the design engineer's hand-back flags as uncertain;
   - the feature map the design engineer created (its path and how many capabilities it lists);
   - the proposed personas, from its `PERSONA:` blocks: each one's name, stack and area, and its rules. When the project has no persona and the design engineer proposed none, tell the client and ask the design engineer once for them.
3. If the design engineer wrote no `.claude/truss.json`, or it fails step 1's checks, tell the client, do step 5, and then go to step 8.

## 5. Build on kit's manifest

kit is optional. Decide on the manifest first, and only then look at the skill list.

1. Read `<repo>/.claude/kit/manifest.json`. It is **unreadable** when it isn't JSON, its `version` isn't `1`, or it fails kit's schema, `docs/manifest.schema.json` in the kit plugin's folder. Find it from kit's root: when `kit:init` is listed, its base directory (the Skill tool prints it when it loads; the skill list may show its path) is `<kit root>/skills/init`, so the schema is `<kit root>/docs/manifest.schema.json`. Otherwise check each dir in `CLAUDE_CODE_PLUGIN_DIRS`, then Glob under `~/.claude/plugins`. Validate it with the ajv command in step 7, with that schema and without `--errors=json`. If you can't find kit's schema, check the manifest by hand against the parts you read: `version` is `1`, and `agents` is an array whose entries each have a string `name`, a boolean `readOnly` and a string `declaredBy`.
2. It **declares truss** when it is readable and its `agents` list has `truss:qc-engineer`, `truss:checking-engineer` and `truss:judge` (names compared without case), each with `readOnly: true`.
3. Then do the first of these that fits:
   - **Readable and declares truss:** use it for step 6. Say nothing about kit, whether or not `kit:init` is listed.
   - **Unreadable:** print `kit manifest unreadable, carrying on without it: <reason>` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest. Don't run `kit:init` over it, listed or not.
   - **Readable without the declarations, and `kit:init` is among the session's skills:** run it through the Skill tool, `Skill({ skill: "kit:init", args: "declare read-only: truss:qc-engineer, truss:checking-engineer, truss:judge" })`. The project already has kit, so kit only shows the client the declaration and writes it on approval. When it returns, read the manifest again. If it is now readable, use it for step 6, with or without the declarations; otherwise carry on without one. Don't run `kit:init` a second time.
   - **Missing, and `kit:init` is among the session's skills:** run it through the Skill tool, `Skill({ skill: "kit:init" })`. kit proposes its setup (conventions, gate hooks, a checklist) and writes only on the client's approval. When it returns, read the manifest again. If it is now readable, use it for step 6; otherwise carry on without one. Don't run `kit:init` a second time.
   - **`kit:init` isn't listed:** print `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest.
4. Whenever the manifest doesn't end up declaring `truss:qc-engineer`, `truss:checking-engineer` and `truss:judge` read-only, also tell the client: "worktrees still gives each QC engineer, checking engineer and judge its own worktree. To stop that, set worktrees' `noIsolateAgents` option to `truss:qc-engineer,truss:checking-engineer,truss:judge` in your own settings. worktrees reads it when the session starts, so it takes effect from the next session. Stress tests keep their worktree: the project manager starts them with an explicit `isolation: "worktree"`, which wins over the list." Never write that setting yourself, and declare nothing else read-only.

## 5b. Propose day-0 personas

Personas are day-0 functionality: a project with a known stack gets no generic builders and testers. When the project has no persona (step 3's list), propose them with the client's approval, in this order:

1. If step 5 ran `kit:init` (the manifest was missing), its setup proposal covered the personas. Don't run it again and don't propose them a second time.
2. Otherwise (kit was already set up, or kit isn't listed), use the design engineer's `PERSONA:` blocks from step 3: its day-0 personas and the `product-owner` judge. It loads `kit:persona` when the session lists it, and uses the persona rules in its prompt when it doesn't. Show them to the client for approval and install the approved ones, as below.

Always include a read-only `product-owner` judge, drafted from `docs/requirements.md`, the README and the domain in the code, when the project has none. Show each persona with its stack, area and rules, and let the client edit or drop any. Write the approved ones to a fresh directory outside the repo (the session scratchpad), then install them with `node <plugin>/bin/factory.ts persona-install --from <that dir> --repo <repo>`, which validates, copies them into `.claude/agents/` and commits them. Personas installed now load at the next session start; say so. Never write a persona the client didn't approve.

## 6. Propose the 0.4.0 keys

The keys are declared in `truss-config.schema.json`, at `<this skill's base dir>/../../docs/truss-config.schema.json`. Read it. Every key is optional, and leaving one out keeps 0.3.0 behaviour. Propose only values that match its patterns, and only paths the current `truss.json` doesn't have: never change or remove a key or value already there, at any depth, even one the schema rejects.

- `roles`: job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type. Take it from the manifest's `agents`, for example `build: kit:builder`, `test: kit:test-writer`, `review: kit:reviewer`, `search: kit:scout`. Map `docs` and `deploy` only to an agent that clearly does that job. Without a manifest, use only agent types the session lists that clearly fit. Never map `truss:qc-engineer`, `truss:checking-engineer`, `truss:project-manager` or `truss:design-engineer`. When kit is loaded, propose `build: kit:builder` and `test: kit:test-writer` even without a manifest; the run SKILL then passes them as the builder and tester types. This mapping is the fallback only for an area no persona covers (step 5b); a task with a persona runs as its persona whatever `roles` says.
- subagent-limits `nudgeAtK` and `stopAtK`: when `subagent-limits` is installed, propose `nudgeAtK` about 150 and `stopAtK` about 200 for the client to approve, and write them only on approval. They are subagent-limits' own options, not `truss.json` keys: they live in `/config`, or under `pluginConfigs` in `~/.claude/settings.json`, so tell the client where, and never write that file without approval.
- `deploy`: `{target, command, production}`, from what the repo shows (a deploy script, a `vercel.json`, `fly.toml`, a CI deploy job). Propose it only when the file has no `deploy` and the repo makes all three plain, and always as one unit: the client approves or declines all three fields together. `production` is `true` when the command deploys to production.
- `writingSkill`: a writing skill the session lists, such as `technical-writer`.
- `promptOverrides`: truss role (`project-manager`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`) to a file directly under `.claude/truss/prompts/`. Propose one only for a file that already exists there, such as `.claude/truss/prompts/qc-engineer.md`. The value is the path, never prompt text, and you don't create or edit the prompt files; they are the client's.
- `reworkAllowance`: an integer of 0 or more, the number of fresh QC engineers a crew may start after QC engineer FAILs in one run (default 2). The design engineer copies it into a v2 `plan.json`. Propose it only when the file has no `reworkAllowance`; offer 2 and say that leaving it out also means 2.
- `featureMap` and `adrDir`: where the crew knowledge step records what a crew learned: the feature map (default `docs/features.md`) and the directory for decision ADRs (default the `adr` key, else `docs/adr`). Propose `featureMap` only when the repo already has a feature or capability map at another path; propose `adrDir` only when the ADRs live somewhere other than `adr`. Each is a string path inside the repo (no leading `/`, drive letter, backslash or `..`). Leaving them out keeps the defaults.
- `testGlobs` (0.29.0, ADR-0046): repo-relative globs that name the project's test files, beside the names truss knows (JS and TS `*.test.*`, `*.spec.*`, `*.check.*`, `test_*.py`, `*_test.py`, `*_test.go`, `conftest.py`, and files under `tests/`, `test/`, `spec/`, `__tests__/`, `checks/`, `e2e/`, `fixtures/`). The green check of a stress-fix round uses them to see whether the round added a regression test. Detect the layout from the code, with Glob over tracked files (skip `node_modules`, vendored code and build output), and propose only the globs the repo already uses and truss's names miss, each with the files that matched: C# `**/*Tests.cs`, Kotlin and Java `**/*Test.kt`, `**/*Test.java`, `**/*Tests.kt`, `**/*Tests.java`, Ruby `**/*_spec.rb` outside `spec/`, Rust `src/**/*.rs` only for files holding `#[cfg(test)]` (Grep for it; name those files' directories, or the files, rather than all of `src/`), Swift `**/*Tests.swift`, and any other suffix the repo's test runner config names. JS and TS `*.test.*`/`*.spec.*`, Python `test_*.py` and Rust `tests/` need no glob. Propose nothing when every test file already matches a known name. Write the key only on the client's approval, like every key here. A project without the key, initialised before it existed, still runs: when no tracked file is a test file by either rule, the green check marks the list unknown and the stage logs a warning instead of blocking the crew.
- `productDecisions`, `knowledgeDir`, `rulesDir`, `agentsIndex` and `knowledgeBudgets` (ADR-0035): where path-scoped knowledge lives. Defaults: `docs/knowledge/product-decisions.md`, `docs/knowledge`, `.claude/rules`, `AGENTS.md`, and `{agentsIndex: 60, persona: 120, personaStandards: 15, rule: 40, featureEntry: 6, doc: 150}` (line counts; `personaStandards` counts the list items under `## Standards`). Propose a path key only when the repo already keeps that kind of file somewhere else (an existing `docs/ai/` folder, a differently named index), and a budget only when the client wants it tighter or looser. Each path is a string inside the repo, checked like `featureMap`. Leaving them out keeps the defaults. An always-loaded file over its budget (the agents index, a persona file, a rule file) fails `factory knowledge-lint`; a knowledge doc or a feature-map entry over its budget only warns.
- `pricing` (0.25.0): the client's price table, per model-id prefix, with `inputPerMTok`, `outputPerMTok`, `cacheReadPerMTok`, `cacheWrite5mPerMTok` and `cacheWrite1hPerMTok`, an optional `fast` set, and an optional `longContext` set with `abovePromptTokens` for a model priced higher on a long prompt (0.29.0). `factory cost` and the budgets price usage with it; a model with no price makes the sum unpriced (null), never 0. Ask the client for the values, or leave the key out. Init never writes a price itself: not from memory, not from a fetched page and not as an example. Propose the key empty and let the client fill it.
- `budget` (0.25.0): `{runUsd, crewUsd, sessionUsd, workTypes: {<work type>: {crewUsd}}}`, each above 0, checked when a member starts. Propose `budget` only after `pricing` is filled, since a budget holds a crew whose spend can't be priced. `sessionUsd` is the only limit that counts planning spend, so it is the ceiling for a `/loop` of `/truss:run --next`.
- `notify` (0.25.0): a shell command the client owns, run once for each new inbox item (one-way; a failure never stops the escalation). Propose it only when the client names one.
- `intake` (0.25.0): where `factory intake` reads work from: `sources` (`md`, `gh`), `queueFile` (default `docs/queue.md`), `ghLabel` (default `truss`) and `claimTtlHours` (default 24). Propose it only when the client wants the queue.
- `workTypes` (0.25.0): per work type, a profile that may only tighten the built-in one. `node <plugin>/bin/factory.ts worktypes --repo <repo>` prints the profiles and any error, such as a loosening.

Also propose the knowledge layout of ADR-0035, unless the repo already has it. Always-loaded files cost every agent on every turn, so product calls and area rules move out of them. Show the client each piece and write only the ones the client approves; never reword existing text.

- An `AGENTS.md` index of 60 lines or fewer: pointers only (the architecture doc, the feature map, `docs/knowledge/`, the rule files). Append the single line `@AGENTS.md` to `CLAUDE.md` so Claude Code imports it; create `CLAUDE.md` only if the client asks. When the repo already has an `AGENTS.md`, propose no rewrite: say if it is over 60 lines and let the client decide.
- `docs/knowledge/` with an empty `product-decisions.md`, where crew product calls will go, and `.claude/rules/` for area-scoped rule files (`paths` globs in the frontmatter).
- A project that ran truss 0.23.0 has its crew product calls in `.claude/agents/product-owner.md`, a file every agent loads. Run `node <plugin>/bin/factory.ts knowledge-migrate` (it prints the proposed moves and writes nothing), show the client the moves, and on approval run it again with `--apply`: it moves the entries to the product decisions file and leaves one pointer line in the persona. Never commit for the client. Until then `factory knowledge-lint` reports a `persona-calls` failure.

Also propose a program manager (PM) section for the project's `CLAUDE.md`, unless it already has one naming the PM. Show the client this text:

> ## Truss PM
> In a truss run the main session is the PM. It edits `plan.json`, `goals/` and `decisions.md` in the truss dir, writes check scripts there, and fast-forwards crew branches into the target. This describes the role. It pre-approves nothing a hook or the client refuses.

Append it to `CLAUDE.md` only if the client approves; never overwrite or reword existing text, and create the file only if the client asks.

Also propose a permissions allowlist for the project's `.claude/settings.json`. Crew members ask before each command no rule allows, and every refused call costs a turn. A truss session's own count (`refusals` in `/truss:retro`) was 195 refusals in one run: 168 from Claude Code's worktree guard, 27 from the auto-mode classifier (21 of them "no verdict" on Write and Edit), 2 from truss's Workflow gate and 0 plain permission denials. So:

- Propose rules only for the commands a crew runs every time: the project's tests and build, read-only git, and truss's own scripts (`factory.ts`, the retro CLI). Take the test and build commands from what the repo shows (`package.json` scripts, a `Makefile`, CI config). For example:

  ```json
  {
    "permissions": {
      "allow": [
        "Bash(node --test:*)",
        "Bash(npm test:*)",
        "Bash(npm --prefix ui test:*)",
        "Bash(git status:*)",
        "Bash(git log:*)",
        "Bash(git diff:*)",
        "Bash(git show:*)",
        "Bash(git rev-parse:*)",
        "Bash(node <plugin>/bin/factory.ts:*)",
        "Bash(node <plugin>/retro/cli.ts:*)"
      ]
    }
  }
  ```

  `<plugin>` is this plugin's root as an absolute path (two directories above this skill's own folder). Keep only the rules that fit this repo, and leave out any key the file already has.
- Each rule is narrow: a program and its subcommand or a fixed script. Never propose a wildcard over anything that runs code it is handed: no `Bash(*)`, `Bash(node:*)`, `Bash(python3:*)`, `Bash(bash:*)`, `Bash(sh:*)`, `Bash(npx:*)`, `Bash(env:*)`, `Bash(xargs:*)`, `Bash(git:*)` or the like.
- The rules go in `.claude/settings.json`, the committed file. `.claude/settings.local.json` is not checked in, so it never reaches the agents' worktrees, and a rule there helps only the main session.
- No allow rule reaches Claude Code's worktree guard, the source of most refusals. It is built into Claude Code, not truss. truss's stage prompts steer members past it (one plain command per Bash call, files written with Write and Edit). Say so, so the client doesn't expect the allowlist to fix it.
- The classifier's "no verdict" refusals on Write and Edit come from the classifier service, not from a rule. A retry usually passes. Propose no rule for them.

Show the client the proposed JSON and where each rule came from. Truss writes the approved rules into `.claude/settings.json`; when Claude Code's classifier refuses that write, truss shows the refusal and the client writes the rules, and the refusal is never worked around. If the client approves none, say so and carry on.

Show the client each proposed key with its value and where it came from, and ask which to write. Write only the approved ones. If there is nothing to propose, or the client approves nothing, say so and go to step 8.

## 7. Validate, then write

1. Find the truss dir from the `[truss] dir: <path>` note the plugin adds at session start, or the `Truss dir:` line `/truss` prints. Don't derive it. If neither is there, tell the client the truss plugin isn't loaded, write nothing, and go to step 8.
2. Build the candidate: the current `.claude/truss.json` with every key and value kept, plus the approved values. Keep the file's key order, put new keys at the end, and indent by two spaces. Write it to `<truss dir>/scratch/truss.candidate.json`. Write it with the Write tool. If the write is refused, whether by worktree isolation or by a declined approval, write nothing: say the write was refused, name the path, say init must run in the main session with that write allowed, and go to step 8. Never route around a refusal with another tool.
3. Validate it:

   ```
   npx -y -p ajv-cli@5 -p ajv-formats@3 ajv validate --spec=draft2020 -c ajv-formats --all-errors --errors=json -s <truss-config.schema.json> -d <truss dir>/scratch/truss.candidate.json
   ```

   If the validator can't run, tell the client, write nothing, and go to step 8.
4. Give each error a path: its `instancePath`, plus `/<params.additionalProperty>` for an `additionalProperties` error or `/<params.missingProperty>` for a `required` one. A hand-written `roles.qc-engineer` is `/roles/qc-engineer`; a `deploy` without `production` is `/deploy/production`.
5. The paths you write are the leaf paths you add in this run, such as `/roles/build` or `/writingSkill`. An approved `deploy` adds all three of `/deploy/target`, `/deploy/command` and `/deploy/production`. Each error falls under one of three rules:
   - **At a path you write:** write nothing. `.claude/truss.json` stays exactly as it was. Report the error with its path, and go to step 8.
   - **At a proper ancestor of a path you write** (the client's value there can't hold your key, such as `roles: "x"` when you'd add `/roles/build`): drop every path you planned under it, keep the client's value, and report both, as in `/roles: must be object; skipped /roles/build, /roles/test`. Build the candidate again without them and validate again from step 2. The root is an ancestor of every path, so a file that isn't a JSON object gets nothing written.
   - **Anywhere else:** it's the client's (an unrelated key, or a sibling of yours such as a hand-written `/roles/qc-engineer` next to your `/roles/build`). Report it once by path, for example `/merge: must be equal to one of the allowed values` or `/roles/qc-engineer: undeclared, ignored`, keep it unchanged, and carry on. Never delete, rewrite or "fix" what the client wrote.
6. When no errors are left but the client's, and you still have paths to write, copy the candidate over the file in one step: `cp <truss dir>/scratch/truss.candidate.json <repo>/.claude/truss.json`. If the copy is refused, apply the same rule: write nothing more, say it was refused, name `<repo>/.claude/truss.json`, say init must run in the main session with that write allowed, and go to step 8. Otherwise tell the client each path you wrote.

## 8. Tell the client where things stand, and stop

1. Run `git status --porcelain` in `<repo>` again and list what this run created or changed: the design engineer's files, what `kit:init` wrote, and `.claude/truss.json`.
2. Tell the client the files are not committed. Crews work in git worktrees, which see only committed files, so a truss run needs these files committed before its crews start.
3. Stop. Don't commit. When a truss run called this skill, the run skill says what happens next; otherwise don't start a run.

The client can then edit the doc, or add the optional keys to `.claude/truss.json` by hand. Each has a default: `maxParallelCrews` 4, `heavySlots` sized from the host (1 to 4), `merge` `sequential`, `target` the current branch. A 0.4.0 key left out keeps 0.3.0 behaviour.
