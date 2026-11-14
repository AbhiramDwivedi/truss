---
sources:
  - plugins/truss/bin/factory.ts
  - plugins/truss/workflows-src/stage/crew.js
  - plugins/truss/workflows-src/stage/runner.js
  - plugins/truss/docs/adr/0054-heavy-slot-run-limit.md
verified: dc6453a1f443e3944290e131c8fb72f0e6ca0bc4
---

## heavy-slots: the run limit stops a hung suite (R-145)

- Question: may a heavy job that runs past a limit be stopped, which loses a healthy suite longer than the default?
- Answer: yes. `TRUSS_HEAVY_RUN_MS` (default the slot wait) stops it, the stop message names `TRUSS_HEAVY_RUN_MS` and how to raise it, and the next default limit doubles the longest stopped run, so a long healthy suite is lost once.
- Reason: a hung command under a live wrapper held the slot for ever. See ADR-0054.
- Decided by: the client, 2026-11-14 (`decisions.md` 09:33), on condition that the message names the variable.
- Sources: `plugins/truss/docs/adr/0054-heavy-slot-run-limit.md`.

## heavy-slots: the folded admission waits only through the standalone re-check

- Question: should the admission folded onto the red check (`--admit-first`) wait for memory?
- Answer: it has no wait. A memory or parallelism hold carrying admit's own figures (`minFreeMB`) triggers the standalone `admit --wait-ms 90000` re-check in `admit` (`crew.js`); a budget or awaiting hold stops the crew at once. Whether this split is intended is unconfirmed: confirm it or send the fold `--admit-wait-ms`.
- Reason: the acceptance test needs a held `admittedFirst` to stop the crew without a waiting standalone admit.
- Decided by: crew heavy-slots builder, not yet confirmed by the product owner.
- Sources: `plugins/truss/workflows-src/stage/runner.js` (`noWait: true`), `plugins/truss/workflows-src/stage/crew.js` (`admit`).
