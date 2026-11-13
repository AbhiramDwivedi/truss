## Single-step stage tests

- What: a stage test loads one `workflows-src/stage/` step module with stubbed `agent()` and runner calls, without the `stage.js` bundle (`loadStageStep`), or loads the bundle without running it (`loadStageBundle`). The test selector maps a step module to the tests that load it alone, and maps a test that calls `loadStageBundle` to every module (R-140).
- Entry points: `plugins/truss/bin/build-stage.ts` (`loadStageStep`, `loadStageBundle`), `plugins/truss/bin/testmap.ts` (`stageBundles`), tests `plugins/truss/tests/stage-steps-032.check.ts`, `plugins/truss/tests/stage-step-ruling.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Stage step tests").
