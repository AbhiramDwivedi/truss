## Closeout gap check (0.32.0)

`plugins/truss/tests/closeout-032.check.ts` (`waveGaps`) derives the wave-4 gaps from the dir in `TRUSS_WAVE4_DIR`: the `stage-result-run-lifecycle-*` and `crew-decisions-*.json` files, which hold array-like objects `{"0":{text,unrecorded}}`. A key is `<file>#<line index>` for a text line matching `/GAP|[Dd]efer/`, or `<file>#unrecorded[<n>]`. The rule finds 10 keys, and `plugins/truss/docs/goals/0.32.0-closeout.md` must hold one row per key, each fixed by a named test or deferred with a reason.
