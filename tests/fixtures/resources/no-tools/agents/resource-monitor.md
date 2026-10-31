---
name: resource-monitor
description: Negative-control stub for tests/monitor-contract.check.ts. It reads the host sample and recommends a parallelism, but its frontmatter has no tools line.
model: haiku
---

Stub only. This file is a negative control for the monitor contract and is never loaded as an agent.

Run `node <plugin>/resources/index.ts --worktrees <repo>/.claude/worktrees`, read `parallelism.json` and `plan.json`, and end with `RECOMMEND parallelism <n>`.
