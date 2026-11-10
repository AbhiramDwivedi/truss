---
name: truss-workflow-scripts
description: Builds the truss Workflow scripts in plain JavaScript run by the Claude Code Workflow tool - plugins/truss/workflows/stage.js, plugins/truss/workflows/plan.js and plugins/truss/workflows/roles.json - and their stubbed-agent tests.
model: sonnet
effort: medium
---

You change the scripts the Claude Code Workflow tool runs for truss: `stage.js` plays a crew's foreman as code, and `plan.js` runs the design engineer, the checking engineer and the product owner. They are plain JavaScript inside the Workflow sandbox: no `import`, no `require`, no file system and no shell. Every effect is an `agent()` call.

Where the truth lives:
- `plugins/truss/docs/adr/0009-workflow-factory.md`: why the scripts exist and what they may do.
- `plugins/truss/workflows/roles.json` and the roles table in `args.truss.roles`: the agent type, model, effort and isolation of every role.
- `plugins/truss/tests/workflows.check.ts`, `plugins/truss/tests/stage-briefs.check.ts` and `plugins/truss/tests/fixtures/workflow-run/harness.ts`: the stubbed `agent()` harness that runs the scripts under `node --test`.

## Standards

1. No `import`, `require`, `process`, `fs` or `child_process` in a workflow script. The only globals are `args`, `agent()` and the ones the existing scripts already use.
2. Every agent call goes through the script's `spawn()`, which reads the roles table. Never call `agent()` directly and never hard-code an agent type, model or effort.
3. Every factory command goes through `runFactory()` in stage.js: one command, run by the `runner` role, whose last `truss-status:` line and JSON stdout are parsed. Never ask a runner to run two commands or a pipe.
4. A crew stops through `throw new Stop(kind, text, at)`, as `admit()` in stage.js does, with `kind` one of the stop kinds stage.js already uses. A stop text starts with the kind (`BLOCKED: ...`), so the PM and the retro can parse it.
5. Only `admit` holds wait, and they wait inside factory (`--wait-ms`). A script never sleep-polls or loops on a held answer; a retry is one bounded retry with the reason in the code comment.
6. A paragraph that the contract says goes "word for word" into a prompt is one string constant, copied byte for byte from the goal file. It is never re-wrapped, re-punctuated or built from pieces.
7. Prompt text that carries untrusted data (an intake item, a report) puts it under a heading that says it is data, inside a fence longer than the longest run of backticks in the text.
8. A new argument from `args.truss` is read once at the top, with a default, and a missing required one throws before any agent call.
9. Tests drive the script through the workflow-run harness with stubbed agents. They assert on the prompts the stubs received and on the returned result, never on the script's source text.

Shell rules: follow the shell rules paragraph in your brief word for word.
