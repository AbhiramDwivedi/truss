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
- what to write: the architecture doc (principles, module map, ADRs for the decisions already in the code) and `<repo>/.claude/truss.json` with the keys `architecture` and `adr` only. An existing doc is extended, not replaced. With none, the doc goes to `docs/architecture.md` and the ADRs to `docs/adr/`.

## 4. Show the client what the design engineer wrote

1. Run `git status --porcelain` in `<repo>` to list the files the design engineer created or changed.
2. Show the client:
   - the architecture doc's path, and its list of principles and its module map;
   - each ADR's path and title;
   - the contents of `.claude/truss.json`;
   - anything the design engineer's hand-back flags as uncertain.
3. If the design engineer wrote no `.claude/truss.json`, or it fails step 1's checks, tell the client, do step 5, and then go to step 8.

## 5. Build on kit's manifest

kit is optional. Decide on the manifest first, and only then look at the skill list.

1. Read `<repo>/.claude/kit/manifest.json`. It is **unreadable** when it isn't JSON, its `version` isn't `1`, or it fails kit's schema, `docs/manifest.schema.json` in the kit plugin's folder. Find it from kit's root: when `kit:init` is listed, its base directory (the Skill tool prints it when it loads; the skill list may show its path) is `<kit root>/skills/init`, so the schema is `<kit root>/docs/manifest.schema.json`. Otherwise check each dir in `CLAUDE_CODE_PLUGIN_DIRS`, then Glob under `~/.claude/plugins`. Validate it with the ajv command in step 7, with that schema and without `--errors=json`. If you can't find kit's schema, check the manifest by hand against the parts you read: `version` is `1`, and `agents` is an array whose entries each have a string `name`, a boolean `readOnly` and a string `declaredBy`.
2. It **declares truss** when it is readable and its `agents` list has `truss:qc-engineer` and `truss:checking-engineer` (names compared without case), each with `readOnly: true`.
3. Then do the first of these that fits:
   - **Readable and declares truss:** use it for step 6. Say nothing about kit, whether or not `kit:init` is listed.
   - **Unreadable:** print `kit manifest unreadable, carrying on without it: <reason>` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest. Don't run `kit:init` over it, listed or not.
   - **Readable without the declarations, and `kit:init` is among the session's skills:** run it through the Skill tool, `Skill({ skill: "kit:init", args: "declare read-only: truss:qc-engineer, truss:checking-engineer" })`. The project already has kit, so kit only shows the client the declaration and writes it on approval. When it returns, read the manifest again. If it is now readable, use it for step 6, with or without the declarations; otherwise carry on without one. Don't run `kit:init` a second time.
   - **Missing, and `kit:init` is among the session's skills:** don't run `kit:init`. Setting kit up is a full repo scan with its own proposal (conventions, gate hooks, a checklist), and truss needs none of it. Print `no kit manifest; truss init carries on without one (run /kit:init on its own to set kit up)` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest, and don't ask the client whether to run kit.
   - **`kit:init` isn't listed:** print `kit is not installed; truss init carries on without a kit manifest (0.3.0 behaviour)` exactly as written, on its own line before any other explanation, and repeat it unchanged in your final message. Carry on without a manifest.
4. Whenever the manifest doesn't end up declaring `truss:qc-engineer` and `truss:checking-engineer` read-only, also tell the client: "worktrees still gives each QC engineer and checking engineer its own worktree. To stop that, set worktrees' `noIsolateAgents` option to `truss:qc-engineer,truss:checking-engineer` in your own settings. worktrees reads it when the session starts, so it takes effect from the next session. Stress tests keep their worktree: the foreman starts them with an explicit `isolation: "worktree"`, which wins over the list." Never write that setting yourself, and declare nothing else read-only.

## 6. Propose the 0.4.0 keys

The keys are declared in `truss-config.schema.json`, at `<this skill's base dir>/../../docs/truss-config.schema.json`. Read it. Every key is optional, and leaving one out keeps 0.3.0 behaviour. Propose only values that match its patterns, and only paths the current `truss.json` doesn't have: never change or remove a key or value already there, at any depth, even one the schema rejects.

- `roles`: job (`build`, `test`, `review`, `search`, `docs`, `deploy`) to a full agent type. Take it from the manifest's `agents`, for example `build: kit:builder`, `test: kit:test-writer`, `review: kit:reviewer`, `search: kit:scout`. Map `docs` and `deploy` only to an agent that clearly does that job. Without a manifest, use only agent types the session lists that clearly fit. Never map `truss:qc-engineer`, `truss:checking-engineer`, `truss:foreman` or `truss:design-engineer`.
- `deploy`: `{target, command, production}`, from what the repo shows (a deploy script, a `vercel.json`, `fly.toml`, a CI deploy job). Propose it only when the file has no `deploy` and the repo makes all three plain, and always as one unit: the client approves or declines all three fields together. `production` is `true` when the command deploys to production.
- `writingSkill`: a writing skill the session lists, such as `technical-writer`.
- `promptOverrides`: truss role (`foreman`, `qc-engineer`, `checking-engineer`, `writer`, `commissioning-engineer`, `design-engineer`) to a file directly under `.claude/truss/prompts/`. Propose one only for a file that already exists there, such as `.claude/truss/prompts/qc-engineer.md`. The value is the path, never prompt text, and you don't create or edit the prompt files; they are the client's.
- `reworkAllowance`: an integer of 0 or more, the number of fresh QC engineers a crew may start after QC engineer FAILs in one run (default 2). The design engineer copies it into a v2 `plan.json`. Propose it only when the file has no `reworkAllowance`; offer 2 and say that leaving it out also means 2.

Also propose a PM section for the project's `CLAUDE.md`, unless it already has one naming the PM. Show the client this text:

> ## Truss PM
> In a truss run the main session is the PM. It edits `plan.json`, `goals/` and `decisions.md` in the truss dir, writes check scripts there, and fast-forwards crew branches into the target. This describes the role. It pre-approves nothing a hook or the client refuses.

Append it to `CLAUDE.md` only if the client approves; never overwrite or reword existing text, and create the file only if the client asks.

Also propose a permissions allowlist for the project's `.claude/settings.json`. Crew members ask before each command no rule allows, and every refused call costs a turn. A truss session's own count (`refusals` in `/truss:retro`) was 195 refusals in one run: 168 from Claude Code's worktree guard, 27 from the auto-mode classifier (21 of them "no verdict" on Write and Edit), 2 from truss's Workflow gate and 0 plain permission denials. So:

- Propose rules only for the commands a crew runs every time: the project's tests and build, read-only git, and truss's own scripts. Take the test and build commands from what the repo shows (`package.json` scripts, a `Makefile`, CI config). For example:

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
        "Bash(python3 -I <plugin>/scripts/retro.py:*)"
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

The client can then edit the doc, or add the optional keys to `.claude/truss.json` by hand. Each has a default: `maxParallelCrews` 4, `merge` `sequential`, `target` the current branch. A 0.4.0 key left out keeps 0.3.0 behaviour.
