---
name: run
description: Negative-control stub for tests/monitor-contract.check.ts. Only the resource-monitor step of the PM skill is kept.
---

Stub only. This file is a negative control for the monitor contract.

## Resource monitor

At each stage start, start `truss:resource-monitor` as an `Agent` call. It recommends a parallelism. Write the PM's choice to `resources/parallelism.json` in the truss dir, then run `start` again. A crew that `start` returns under `held` stays planned until memory allows it.
