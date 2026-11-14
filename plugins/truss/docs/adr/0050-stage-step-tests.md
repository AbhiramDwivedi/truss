# ADR-0050: drive one stage step in a test through loadStageStep

Status: accepted, 2026-11-13
Decided by: program manager (auto): the approved 0.32.0 plan (the goal's approved scope, 16:25, "size item8-test-structure full | splits hub modules shared.ts, resources.ts, store.ts and stage test harness"), resting on goal item 8 ("Sharper test selection by structure") and requirement R-140 "A stage test can drive one step without the whole stage.js bundle"

## Context

`workflows/stage.js` is generated from the step modules in `workflows-src/stage/` (architecture.md, "Workflow calls (ADR-0009)"). Every stage test ran the whole bundle with a stubbed `agent()`. `bin/testmap.ts` reads the bundle's generated header and treats `stage.js` as using every module, so a change to any one module selected every stage test. With the two tests this crew added left out of the tree, `selectTests` on a one-file change to each of the 28 modules selected 47 test files for every module (measured with a scratch script that calls `selectTests` from `bin/testmap.ts`, below).

R-140 asks for the opposite: "Given a test of one stage step, when it runs, then it loads that step's module and its stubs only, and a change to another step's module does not select it."

## Decision Drivers

- The bundle must stay one plain script. `start` copies it byte for byte, the Workflow gate knows it by its text, and a Workflow script may hold no import (architecture.md, "Workflow calls (ADR-0009)"; [ADR-0009](0009-workflow-factory.md)).
- The selector must see which module a test loads, from the test's text alone.
- A step tested alone must behave as it does inside the bundle.

## Considered Options

1. **Keep running the bundle.** Every module keeps selecting every stage test, so R-140 is not met.
2. **Make the modules ES modules and strip the imports in the build.** The selector would follow imports, but the modules would stop being plain script parts that share one top-level scope, and the build would have to rewrite code instead of joining text. Rejected for that cost and for the risk to the byte-for-byte bundle.
3. **Load one module's text with its free names passed in as stubs.** The modules stay plain script parts and the bundle is unchanged. Chosen.

## Decision

1. **`loadStageStep(file, stubs)` loads one step.** It lives in `bin/build-stage.ts`. It refuses a file that is not a `.js` file under `STAGE_SRC_DIR` and a file whose first line is not a `// stage.js module:` comment. It drops that line and every `export` keyword, and runs the rest as an AsyncFunction whose parameters are the stub names (`runBody`). It returns `{ loaded, scope }`: `loaded` holds the one module's path, and `scope` holds the names the module declares at column 0 with `function`, `class`, `const`, `let` or `var` (`declaredNames`).
2. **Stubs are parameters, so a missing stub fails loudly.** A free name the module neither declares nor receives throws a ReferenceError when the step reaches it. `tests/stage-steps-032.check.ts` test "a single-step stage test loads that step's module and its stubs only" pins this with `integrate` left out.
3. **A test names its module by a relative literal.** `bin/testmap.ts` resolves a string literal that starts with `.` against the test's own directory and links the test to that exact file (`usedBy`, `symbolGraph`). `tests/stage-step-ruling.check.ts` names `'../workflows-src/stage/ruling.js'`, so only a change to `ruling.js` selects it. A bare file name would link the test to every file of that name, and any literal whose file name is `stage.js` links it to the bundle and so to every module.
4. **`loadStageBundle(stubs)` loads the whole bundle without running it.** It reads the committed `workflows/stage.js`, cuts it before the top-level run line `const results = await Promise.all(F.crews.map(runCrew))`, and throws when that line is missing. When `stubs.args` is an object with no `truss` key, it adds `truss: { dir: '/', repo: '/' }`, because the bundle's load-time code needs an `args.truss` object. Its call names no path, so `bin/testmap.ts` adds the edge by name: a test-side file whose text matches `loadStageBundle` uses every generated `stage.js` (`stageBundles`), and through it every module.
5. **The two loaders agree.** `tests/stage-steps-032.check.ts` test "a single step driven alone returns the same result as the same step inside the stage.js bundle" runs `ruling.js` both ways with the same stubs.

Code: `bin/build-stage.ts` (`loadStageStep`, `loadStageBundle`, `runBody`, `declaredNames`), `bin/testmap.ts` (`stageBundles`). Tests: `tests/stage-steps-032.check.ts`, `tests/stage-step-ruling.check.ts`.

## Consequences

- The existing stage tests still load the bundle, so their reach does not change until each is rewritten to drive one step. After this change a one-file change to a stage module selects 48 test files, and 49 for `ruling.js`. The extra file for every module is `stage-steps-032.check.ts`, which calls `loadStageBundle` and so reaches every module. The extra one for `ruling.js` is `stage-step-ruling.check.ts`, the only single-step test so far. R-140 is met for that test; the targeted runs of crews that change stage modules do not shrink yet.
- A single-step test must stub every runner call its step reaches. That is more setup than the bundle tests need, and it shows exactly what the step depends on.
- `declaredNames` finds only declarations at column 0. A module written with indented top-level declarations would hide them from `scope`. The stage modules are formatted that way today; nothing checks it.
- The selector's edge for `loadStageBundle` is by name, so a test that only mentions the name in a comment is also linked to every module. That over-selects, which is safe.
