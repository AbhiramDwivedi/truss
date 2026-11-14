---
paths:
  - "plugins/truss/tests/**/*.ts"
sources:
  - plugins/truss/tests/wiring-025.check.ts
  - plugins/truss/tests/store.check.ts
  - plugins/truss/tests/workflows.check.ts
  - plugins/truss/bin/store.ts
  - plugins/truss/bin/lock.ts
  - plugins/truss/bin/transcripts.ts
  - plugins/truss/tests/hub-split-032.check.ts
  - plugins/truss/tests/inbox.check.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/bin/factory/audit.ts
  - plugins/truss/bin/factory/check.ts
  - plugins/truss/bin/factory/finish.ts
  - plugins/truss/bin/factory/gates.ts
  - plugins/truss/bin/factory/plan.ts
  - plugins/truss/tests/gate-trussfile.check.ts
  - plugins/truss/tests/unattended.check.ts
  - plugins/truss/tests/fixtures/ltc/harness.ts
  - plugins/truss/tests/fixtures/inbox/proof-plugin.ts
  - plugins/truss/tests/trust-026.check.ts
  - plugins/truss/tests/gates-026.check.ts
  - plugins/truss/tests/gates-026-regress.check.ts
  - plugins/truss/tests/fixes-026.check.ts
  - plugins/truss/tests/gaps-029.check.ts
  - plugins/truss/tests/resume-029.check.ts
  - plugins/truss/tests/release-026.check.ts
  - plugins/truss/tests/doc-citations-031.check.ts
  - plugins/truss/tests/hygiene-029.check.ts
  - plugins/truss/tests/lifecycle-029.check.ts
  - plugins/truss/tests/fixtures/citations/line-citations.ts
  - plugins/truss/tests/retro-generic-fixture.check.ts
  - plugins/truss/bin/factory/consolidate.ts
  - plugins/truss/tests/factory-split-031.check.ts
  - plugins/truss/bin/factory/heavy.ts
  - plugins/truss/bin/factory/slot.ts
  - plugins/truss/resources/index.ts
  - plugins/truss/tests/heavy-slots-032.check.ts
  - plugins/truss/tests/heavy-slots-stage-032.cases.ts
  - plugins/truss/tests/heavy-slots-stress-032.check.ts
  - plugins/truss/tests/heavy-slots-stress-stage-032.check.ts
  - plugins/truss/tests/heavy-031.check.ts
  - plugins/truss/bin/fragments.ts
  - plugins/truss/bin/factory/decide.ts
  - plugins/truss/workflows-src/stage/check.js
  - plugins/truss/tests/heavy-slots-fullcheck-032.check.ts
  - plugins/truss/tests/retro-cause.check.ts
  - plugins/truss/tests/retro-skill.check.ts
  - plugins/truss/tests/run-survival-qc-032.check.ts
  - plugins/truss/bin/factory/runs.ts
  - plugins/truss/bin/build-stage.ts
  - plugins/truss/bin/testmap.ts
  - plugins/truss/tests/stage-steps-032.check.ts
  - plugins/truss/tests/stage-step-ruling.check.ts
verified: 74c281bc49ea45c17441df95d17172e2de14c530
---

- Stub one seam of the plugin without knowing the real module's exports: in a private copy, move `bin/X.ts` to `bin/X-real.ts` and write `bin/X.ts` as `export * from './X-real.ts'` plus the local overrides. A local export shadows the star re-export, so only the named seam changes (`stubbedPlugin()`, `wiring-025.check.ts` `stubbedPlugin`). Copy the plugin with `pluginCopy()` into your own tmp dir (`cpSync(pluginCopy(), d, {recursive: true})`); never write inside the shared copy.
- `store.ts` test seam, pinned by `store.check.ts`: `withLock(dir, name, fn, {waitMs, platform, fs, host, now})`, `writeJsonAtomic`/`createExclusive(p, obj, {fs})`, `transcriptsOf(sid, env)`. The `fs` option holds `node:fs`-named sync functions; an omitted one falls back to `node:fs`. The lock is `<dir>/locks/<name>.lock/owner.json` with a millisecond-number `since`. A stale lock is removed only by one breaker at a time, which holds the mutex dir `<name>.lock.break` (an abandoned one, over `OWNERLESS_MS` = 3 s old, is cleared) and removes the lock only if its owner token is still the one judged stale; a lock is never renamed aside; an ownerless lock's age is re-checked under that mutex (`store.ts` `takeOver`). `StoreBusy` is a `CliError` with code 2 and body `{error: 'store busy: <name>'}`.
- A lock race needs one stale lock seen by several waiters, too narrow for one run. Test many rounds, each planting a fresh stale lock, plus a read-modify-write counter under `withLock` so an overlap loses an increment (`store.check.ts` test "store: 8 waiters racing to take over one stale lock never overlap and none is lost", `fixtures/store/worker.ts` counter mode). Prove the test by mutating the code (drop the token re-check and the `.break` mutex) and seeing it fail. A lease race (`resume-029.check.ts` `RACE_WORKER`): keep every worker alive until all finish, since an exited holder's same-host lease is dead-pid stale and `takeLease` rightly lets another process take it, which looks like a double grant; spawned worker scripts read args from `process.argv.slice(2)` (`slice(1)` self-imports and hangs on top-level await); give the case a `{ timeout }` so a worker failure fails it instead of hanging the stage.
- Assert workflow prompt content on the prompts the stubbed `agent()` received (`call(r, label).prompt` in `workflows.check.ts`), never on script source text. A nested `node --test` child inherits `NODE_TEST_CONTEXT` and ignores `--test-name-pattern` unless it is unset (`wiring-025.check.ts` test "wiring 025: qcPrompt and checkerPrompt carry the long-term cost paragraph"). Most `Stop('BLOCKED',...)` texts in `stage.js` do not repeat the kind (the Stop's `kind` carries it); assert the text the code actually has, and do not reword a stop text the PM or the retro parses (`heavy slot busy:` is pinned by `gates-026.check.ts` test "gates-026: the heavy re-wait stops at its bound and blocks the crew"). The eval runner takes only the `qc` and `checker` roles (`evals/case.schema.json`), so no golden exercises the design-engineer; pin its prompt rules by prose tests. `workflows.check.ts` resolves agent labels with `Object.hasOwn(labels, label)`, so a `Proxy` with `has`/`get`/`getOwnPropertyDescriptor` traps can route stubs by role regex (`workflows.check.ts` `poLabels`). `checkSpawns()` knows only `ROLE_NAMES`: product-owner labels (`truss-po*`) need `exec()` with `args.truss.personas['product-owner']`, not `runPlan()`.
- `workflows/stage.js` is generated: edit the modules in `workflows-src/stage/`, then run `npm run build:stage` and commit both. `stage-bundle.check.ts` fails when the committed `stage.js` differs from a rebuild. Tests still exec the bundle with a stubbed `agent()`, so assert on the prompts it received, never on module or bundle source text. A new module goes into `STAGE_MODULES` in `bin/build-stage.ts`, in the place its code runs, and starts with a `// stage.js module:` line.
- Test a session-scoped CLI command (`inbox.check.ts` `mkInbox`/`fx`): make the session dir `<repo>/.git/truss/<sid>`, not a loose tmp dir, so `path.basename(dir)` is the session and `<common>/truss/shared/inbox.jsonl` is the real shared file. Call `runCli(factory(), cmd, ['--repo', R, '--dir', D, ...])` with `TRUSS_TRANSCRIPTS_ROOT` (spend, queue) and, for proof, `TRUSS_TEST_PROOF_ROOT` in the extra env; the real plugin ignores the latter (see the `proofPlugin()` item). Put positionals (`resolve <id>`) before value-less flags: `positionalsToFlags` lets a boolean flag swallow the next bare word.
- A change to proof-check behaviour in `bin/inbox.ts` needs `docs/features.md` and `docs/knowledge/store.md` updated too; they sit outside a builder's file list, so the stage or knowledge member owns them. Docs cite code by symbol, never by line number: `bin/store.ts` `withLock`, a test title, or a markdown section heading. `doc-citations-031.check.ts` fails on any `file.ts:<N>`, bare `:<N>-<M>` follow-on or `#L<N>` anchor in the plugin docs (ADRs included), `docs/` and the rule files, so a line-count change in a module never breaks a doc.
- Reach `sessionAudit` through `factory finish` with a second run of plan labels next to the stage run (`auditOf`, `wiring-025.check.ts`). `mkRun` makes the transcripts the audit passes over: `model: '<synthetic>'` for an outage, and `model: ''`, `noResult: true`, `mtimeMs: Date.now()` for a live agent still in progress (an old `mtimeMs` makes it a dead agent that still stands; `finish.cases.ts` "session audit" cases). An unparsable label starting a `truss:` agent type is flagged. Run `stage.js`'s split step with stubs (`gaps-029.check.ts` `stageSplit()`): planner labels `a-planner`, `a-planner-2`; a runner returning `{exit:0, stdout:<one JSON object with the ok/head/admitted/reaped/merged keys>}`; BLOCKED for every other member. Count planner spawns to see if `validateTasks` took the first plan.
- Run a registered hook handler under plain node: import `hooks/register.ts`, call `register(on)` with a fake `on` that captures the handler whose tool filter matches (`a[1].tool`, a string or an array) and returns a chain with a stub `.catch`. Call it with a fake `$` (`process.run`, `session.cwd` and `id`, `env`, `clock`, `ui`, `fs`, `state`) and a `next` that records its calls (`gate-trussfile.check.ts` `drive()`, `unattended.check.ts`).
- Test a crew's merge gate through the real CLI (`fixtures/ltc/harness.ts` `crewWorld`, `clientResolves`): a solo or lean crew merges through `land` (plan v4, crew `process`, `owns: ['**']` so the owns-check never masks the gate); a full crew through `finish --transcript <mkRun dir> --result <file>`. Assert the refusal text matches the gate's pattern, not only exit 1.
- A client resolve in a test is the typed line `/truss:inbox approve <id> <code>` in `<troot>/<proj>/<sid>.jsonl`, ts one second after the `open` op; read the code from the notify recorder's stdin row. With `--raise-usd`, `typedProof` needs `<decision> <id> <code> raise <usd>`, so the helper types the amount (`harness.ts` `world`). A proof item for `approve --by client` is `cli(w,'escalate',['--kind','client-trigger','--title','approve the plan','--ref','run'])`, `clientResolves(w,id,'approve')`, then `approve --by client --item <id>` (`ltc-guard.check.ts` `approveClient`). To test plan-write versus resolve order without sleeping, set `plan.json`'s mtime with `fs.utimesSync` (+60 s or -60 s): `approvalProof` compares `floor(mtime)` with the resolve row's `ts` (`approve-029.check.ts` `planMtime`). Only `mkWorld` worlds (session dir under `.git/truss/<sid>`, notify recorder) can host it, not `mkEnv`/`mkTrussDir`. Resolves are re-proved at every read: append typed prompts (chained `parentUuid`), never overwrite the transcript (`trust-026.check.ts`).
- Proof tests use `proofPlugin()` (`fixtures/inbox/proof-plugin.ts`): a private plugin copy whose `store.ts` stubs `proofTranscriptRoot` (env `TRUSS_TEST_PROOF_ROOT`) and `readProofFile` (logs to `TRUSS_TEST_READ_LOG`); the vars exist only in the stub, the real `bin` fails closed. Prove the data first: point the stub at the old code's root and run on old code; give each refusal case a positive control (`trust-026.check.ts` `liftCase`). To force a real `ENOBUFS` from `git diff --name-status`: build a tree with a private `GIT_INDEX_FILE`, `update-index --add -z --index-info`, `write-tree`, `commit-tree`; about 16000 sixty-character paths suffice (`trust-026.check.ts` `commitEntries`).
- A temp checkout reproducing a run-model or evals leak needs a tracked file under `.claude` (copy `.claude/rules/plugin-tests.md`); else `git status` shows `?? .claude/` and "checkout status changed" fails first, for another cause (`gates-026.check.ts` `leakCheckout()`). Prove a guard test red by mutating the checkout copy (`mkEnv`/`pluginCopy`): `git checkout <fix>^ -- <files>`, run, `git checkout HEAD -- <files>`. In an in-progress merge `HEAD` is the pre-merge file; undo a mutation with `git checkout <merged-branch> -- <file>`. A lock-guarded read-modify-write test: create `<dir>/locks/plan.lock/owner.json` (live `pid`, `host`, `token`, fresh `since`), start the CLI async with `TRUSS_TEST_PLAN_WRITE_GATE=<dir>` (a test-only sync point in `cmdPlanWrite`: it writes `<dir>/checked` after the unlocked first check, then waits for `<dir>/go`, failing closed after 30 s), wait for `checked`, change `plan.json`, create `go`, remove the lock (`gates-026-regress.check.ts`, the plan-write plan-lock test; the plan's crew is `done`, so only the `seen` guard can refuse). A fixed sleep must never decide pass or fail of a child-process race: wait on a real signal.
- CLI test seams in `fixes-026.check.ts`, none touching `bin/`: collide a random draw by spawning with `NODE_OPTIONS=--import=<file url>` of a preload that patches `require('node:crypto').randomBytes` and calls `syncBuiltinESMExports()`; prove a process tree dead without sleeping by giving parent and `detached: true` grandchild (the portable setsid) the inherited write end of a pipe, whose `close` fires only when every holder exited; stub `gh` as a node-shebang file `gh` (chmod 755) plus a `gh.cmd` shim first on PATH via `runCli` `extraEnv`, logging argv to a file the test counts (`ghStub()`).
- Importing `release-026.check.ts` from another test runs all its cases too (`hygiene-029.check.ts` `ROOT` does); a shared citation helper belongs in its own module. Skills are outside the line-citation lint: a fix that needs exact lines in a skill gets its own case that reads them, as `hygiene-029.check.ts` does for retro `SKILL.md` (`bin/inbox.ts` `typedText`, `OUTPUT_TAG`). A factory subcommand that `stage.js` runs through a runner (`inbox`, `escalate`; a resumed crew makes two `inbox` calls before its first member, `pendingCall`/`restoreCalls`) needs a default reply in every stage-test runner stub, or the crew throws `unscripted label`: the command regex in `workflows.check.ts`, `stage-fixes2.check.ts`, `stage-briefs.check.ts`, `pm-calls-029.check.ts` (their `factory.ts\s+(admit|...)` regex), and the `p.cmd === 'inbox'` reply in `gates-026.check.ts`. A resolved inbox item has no taken marker: `restoreCalls` re-reads every resolved item on each resume, so a test of a later resume must include a resolved item the crew already logged as a decision (`workflows-src/stage/replies.js` `restoreCalls`, `takeCall`).
- `factory check` runs the targeted and full test commands through `bashRun`, which drops `NODE_TEST_CONTEXT` from the child's env: without that, a `node --test` started from inside a test skips every file and exits 0. Since 0.31.0 a green check is followed by one `check ... --full` call after a QC PASS (`workflows-src/stage/green.js` `fullSuite`); a stage test that counts green re-runs must leave out commands matching `/\s--full\b/` (`crew-knowledge.check.ts` `greens`, `retro-fixes2-stage.check.ts` `greenChecks`), and a spawn cap counts that call. Test the heavy background job without a 540 s wait by setting `TRUSS_HEAVY_ATTACH_MS` low (`heavy-031.check.ts`). Prove a `stage.js` change red by pointing `TRUSS_CONTRACT_ROOT` at a copy of the old plugin (`stage-tests-031.check.ts`). The `heavy run still going` stop text, like `heavy slot busy:`, is pinned by a test.
- Tests build their own fixtures in a mkdtemp dir and never depend on sibling checkouts (claude-ops), home-directory paths, the network or installed CLIs such as `claude`; the default suite needs only node and git. A run of the real CLI goes in an opt-in file outside the `*.check.ts` glob (`checks/real-cli-install.e2e.ts`), which fails with a clear message when a prerequisite is missing. A git fixture that is cloned or served right after a commit needs `maintenance.auto=false` and `gc.auto=0`, or a detached auto-maintenance repacks its objects mid-read.
- Since 0.31.0 `bin/factory.ts` is only the dispatcher; each command group lives in `bin/factory/<group>.ts` (architecture.md, "Factory modules"). The `stubbedPlugin()` seam still works: the modules import `../store.ts`, `../inbox.ts` and the other `bin/X.ts` files, so a stubbed `bin/X.ts` reaches them. A test that reads command source text reads the module, not `factory.ts` (`crew-decisions.check.ts` reads `bin/factory/decisions.ts`). No module imports `factory.ts`: its top-level await would make an import cycle (`factory-split-031.check.ts`); a module that needs `main` takes it as an argument (`gatesRun`).

## Closeout test rules (0.32.0)

- A new inbox kind goes into `KINDS` in `bin/inbox.ts`, the `escalate` kind enum in `docs/events.schema.json` and `$defs.inboxKind` in `docs/state.schema.json`; `validateEvent` in `tests/fixtures/workflow-run/harness.ts` validates a real escalate event (`closeout-review-node-032.check.ts`).
- Prove a `stage.js` case red against an older bundle: write `git show <rev>:plugins/truss/workflows/stage.js` to a file and point `TRUSS_STAGE_UNDER_TEST` at it (`closeout-review-stage-032.check.ts`, `STAGE`). `1d95d43` has the `pendingCall` only `runTask` read; `be2128b` has the question-or-answer heuristic.
- `doc-citations-031.check.ts` also scans `docs/goals`. Cite code by symbol or section heading there, never `file:<N>`.
- A skipped `node:test` case prints `ok N - <title> # SKIP`, and `passes()` in `closeout-032.check.ts` accepts it, so a doc row can cite a case that never ran. Cite only titles that run by default.
- A test that reads an out-of-repo dir through an env var skips with a message when the var is unset, via `test(name, {skip}, fn)`, so the title stays pinned and the full suite stays green (`closeout-032.check.ts`, `WAVE4_SKIP`).
- A timing limit in a test that runs under parallel heavy slots measures `process.cpuUsage`, not wall time (`trust-026.check.ts`, the "20 resolved items" case).

## Deferred fixes test rules (0.32.0)

- Prove a tree kill with a pipe the test holds, not a pid poll and not a margin: `inbox.check.ts` runs `bin/notify-run.ts` with `TRUSS_TEST_NOTIFY_STDERR=inherit` and waits for the child's `close`, which fires only when notify-run, the command and its detached grandchild (`fixtures/inbox/spawn-sleeper-pipe.ts`) have all exited.
- Prove a test failing-first against old code once, from a scratch dir and outside the suite: build the old tree in a mkdtemp dir with a private `GIT_INDEX_FILE`, `git read-tree <rev>:plugins/truss` and `git checkout-index -a -f --prefix=<dir>/`, then write the new test files over its tests. Give the old code's hang a short limit through its own env (`TRUSS_GOALCHECK_TIMEOUT_MS`) so no process outlives the run, and run the same titles on the current checkout as a control. Paste the output as evidence with its date, head and command (`tests/fixtures/deferred-031/goalcheck-proof-evidence.txt`), and give the ledger entry a reason line pointing at it. Never keep the proof as a suite test: it rebuilds the old commit on every run and fails in any clone without that commit, so no permanent test may depend on git history.
- Before deleting a fixture under `tests/fixtures/`, grep every test for it: a second test may share it. Removing `fixtures/inbox/spawn-sleeper.ts` broke `trust-026.check.ts`, so it stays and the new tree-kill test uses `spawn-sleeper-pipe.ts`.
- A test that makes the session scripts dir unwritable makes `<transcripts root>/<project>/<sid>/workflows` a regular file, which fails the same way on macOS, Linux and Windows (`deferred-032.check.ts`, `blockedWorld`).

## Heavy job seams (0.32.0)

- Drive the win32 heavy job on any host in process: call `heavyJobMain(['--dir', D, '--job', key], sys)` with `sys = { platform: 'win32', spawn }`, where `spawn` records each call and delegates to the real `child_process.spawn`, after writing `D/resources/jobs/<key>/job.json` as `startJob` does. Assert `windowsHide: true` on every recorded spawn, then read `result.json` and `out.txt` (`heavy-slots-032.check.ts` "a heavy background job on win32 runs, reports its result and releases its slot"). `heavyMain` takes the same `HeavySys` but uses only its `spawn`. A stubbed run is never proof of a real Windows run; say so in the doc or report.
- `resources/index.ts` takes the platform and a `spawnSync` stand-in as trailing parameters (`takeHeavySlot`, `killGroup`, `treeKill`), and `cmdReap` takes the platform as its second argument.
- Test the run limit with real processes by setting `TRUSS_HEAVY_RUN_MS` low (1500) through `runCli`'s extra env, with `TRUSS_HEAVY_ATTACH_MS` low on the first call so it returns `pending` and high on the second so it collects `heavy.timedOut` (`runMsOf` reads the variable; "a heavy job that is a real sleeping child process past its limit is stopped and its slot released").
- Test the `until` takeover without waiting for a run limit: plant `D/resources/heavy.lock/owner.json` whose `pid` is a live detached sleeper and whose `until` is `Date.now() + 1500`, then run `heavy` and wait on the sleeper's `exit` event ("a second real check process takes the slot a hung real job held once the limit passes"). Wait on a real signal, never a fixed sleep.
- A `node:test` `{ timeout }` cannot interrupt a case blocked in `runCli` (`spawnSync`). Bound such a case with the command's own wait and attach env (`TRUSS_HEAVY_WAIT_MS`, `TRUSS_HEAVY_ATTACH_MS`) so a red run fails fast, and kill any real sleeper the case spawned in a `finally` block (`heavy-slots-032.check.ts` cases 4 and 5).
- A real-CLI heavy test uses `mkEnv({useRealPlugin:true})`, scrubs `GIT_*` and `NODE_TEST_CONTEXT` from the env, and sets `TRUSS_HEAVY_ATTACH_MS`, `TRUSS_HEAVY_WAIT_MS` and `TRUSS_HEAVY_RUN_MS` (`heavy-slots-stress-032.check.ts` `world`, `cleanEnv`). The `heavy-031.check.ts` case "a heavy run longer than the attach budget..." asserts the slot lock exists 300 ms after the caller returns, so a loaded host can fail it; re-run it alone before suspecting a code change.
- A test that drives `factory check` through `factory heavy` passes `--expect green` (or `red`) with `--full`, or the check exits 2 with `missing --expect` before it runs the suite (`heavy-slots-fullcheck-032.check.ts` `world`).
- `bashRun` in `bin/factory/check.ts` takes an optional `group` (`{dir, label, slug}`) that only a direct full-suite check passes (`suiteRun`): the suite then runs detached as its own process group, recorded under `resources/groups` with `heavyPid` set to the check's pid and `direct: true`, so the `until` takeover stops the suite and (`stopHolder` in `resources/index.ts`, only for that mark) spares the check process, which records the stop. A `factory heavy` wrapper's record has no mark, so the wrapper is stopped too. Under `factory heavy` (env `TRUSS_HEAVY_JOB`) no record is made, because the wrapper's group already holds the suite. A test of that path needs a real second process; see "a second real check process takes the slot a hung real job held once the limit passes".
- A goal-check the run limit stops must still clean up: `cmdGoalCheckJob` (`bin/factory/decide.ts`) may be SIGKILLed by the wrapper before its own cleanup, so it records its temp worktree and `goalCheckMain` (`collectGoalCheck`) removes the worktree and temp dir and logs the decision line, and the body carries `timedOut` (`heavy-slots-stress2-032.check.ts` "heavy stress 3"; `heavy-grace-leak-032.check.ts` for a check that outlives the 2 s grace). A run limit of 2^31 ms or more is clamped to the longest `setTimeout` delay (2147483647 ms) in `heavyJobMain` ("heavy stress 4"). Node fires a longer delay after 1 ms, so clamp any user-set duration before it reaches `setTimeout`.
- A stage-bundle behavior can be a standalone `.check.ts` that drives `loadStageBundle` with a `gatesAware` stub agent and parses runner prompts for `factory.ts <cmd>` (`heavy-slots-stress-stage-032.check.ts` `drive`, `parseRunner`).
- A doc fragment starts with its shallowest heading: `fragmentSections` (`bin/fragments.ts`) drops text before the first shallowest heading, so a `###` section placed first is lost. Put a `###` under a `##` that comes first.
- A file named `*.cases.ts` holds tests that one `*.check.ts` imports for its side effect (`import './heavy-slots-stage-032.cases.ts'`), so the case titles run under that check and the acceptance test can match them. The default suite globs only `*.check.ts`, so the cases run once.

## Leaf modules (0.32.0, ADR-0049)

- Import from the leaf (`bin/core.ts`, `bin/lock.ts`, `bin/transcripts.ts`, and the `bin/factory/` leaves `cli`, `plan-file`, `settings`, `log`, `roles`, `slot`, `admit` and `reap`), never from the barrels `bin/store.ts`, `bin/factory/shared.ts` or `bin/factory/resources.ts`. `hub-split-032.check.ts` fails on a barrel import under `bin/` and `resources/`; for tests it is a convention no check enforces. This supersedes the `stubbedPlugin()` bullet that says modules import `../store.ts`. Stub the leaf in a private copy too: modules no longer load `bin/store.ts`, so a stubbed `store.ts` reaches nothing (`proof-plugin.ts` replaces `bin/transcripts.ts`). Text that pins the lock constants (`OWNERLESS_MS`, `STALE_AGE_MS`) reads `bin/lock.ts` (`release-026.check.ts`, `hygiene-029.check.ts` `storeLine`).
- The `store.ts` test seam bullet and the `proofPlugin()` bullet name `bin/store.ts`: since 0.32.0 the lock code (`withLock`, `takeOver`, `OWNERLESS_MS`) is in `bin/lock.ts` and the stubbed proof seams (`proofTranscriptRoot`, `readProofFile`) are in `bin/transcripts.ts`; `bin/store.ts` is a barrel.
- Adding import lines to `bin/inbox.ts` shifts the lines retro `SKILL.md` cites for `typedText` and `OUTPUT_TAG`; `hygiene-029.check.ts` test "retro SKILL.md cites typedText and OUTPUT_TAG at the lines they have in bin/inbox.ts" fails until the skill is updated.
- `run-procedure.check.ts` cases "parses and carries merge sequential and target main" and "settings --repo prints target main" read the checkout's own `.claude/truss.json`, which a run sets to its release branch, so they fail in a checkout whose target is not main.

## Importing `release-026.check.ts` from another test runs all its cases too

- Importing `release-026.check.ts` from another test runs all its cases too (`hygiene-029.check.ts` `ROOT` does); a shared citation helper belongs in its own module. The line-citation lint also covers the retro skill and the planning engineer: `fixtures/citations/line-citations.ts` `CITATION_DOC_FILES` lists them, `citationDocs` appends each one that exists, and they are not in `CITATION_DOC_ROOTS`, because every root must select the citation checks through `.claude/truss.json` targetedTests.map. A skill or agent doc cites code by symbol (`bin/inbox.ts` `typedText`, `OUTPUT_TAG`), never by line; the `hygiene-029.check.ts` case "retro SKILL.md cites typedText and OUTPUT_TAG by symbol, and the lint finds no line citation in CITATION_DOC_FILES" lints both files in a targeted run.

## The two P24 pins differ on purpose

- `retro-cause.check.ts` `P24` pins the retro `SKILL.md` section 3 sentence. `retro-skill.check.ts` `P24_NEW` pins the intro sentence. The wordings differ, so edit one sentence and rerun both files.

## A scrubbed fixture uses `sid-NNNN` fake ids

- A fake id shaped like a uuid fails the no-uuid check in `retro-generic-fixture.check.ts`. Use `sid-NNNN` ids and run `retro/cli.ts scrub` on the fixture files before you commit. The fixtures are in `fixtures/retro-generic/` (see `docs/knowledge/retro.md`).

## A doc fragment cannot add to a doc preamble

- `stitchDoc` in `bin/fragments.ts` returns a fragment's text before its first heading as a `preamble` (`fragmentSections`) and `applySection` replaces sections only by matching depth and title, so text before the H1-level list of `architecture.md` (the ADR summary list) cannot come from a fragment. Put a crew's ADR summary in a `###` section it replaces, or leave it for the PM at stitch time.

## Factory module list

`factory-split-031.check.ts` pins the files in `bin/factory/` with `MODULES`: a `.ts` file it does not list fails the test. Put a new `cmd*` function into a module already listed, such as `runs.ts` (`cmdFindRun`), unless the tester adds the new module to `MODULES` and to architecture.md.

## Pinning a doc's case numbers

To pin the case numbers a doc cites, parse the doc's `- Tests:` line and map each number to the Nth top-level `test(` title of the cited check file. Strip backtick spans first, or the `032` in the file name counts as a case number (`run-survival-qc-032.check.ts`, the test titled "run-survival doc: the case numbers it cites...").

## Stage result shape (0.32.0, stage-events)

- Only `workflows.check.ts` `stopped()` and `passedShape()` (with `stepEndsShape`) pin the exact key set of a `stage.js` crew result, `stepEnds` included. Other tests write hand-made results as fixtures, so adding a result key needs no change there.
- `audit.ts` `recordRun` and `recordEscalations` stamp spawn, report, restart, tag, allowance-spent and knowledge events with transcript times via `stamp()`; a step with no readable transcript time keeps the finish-time `ts`.

## Single-step stage tests (0.32.0, ADR-0050)

- A new stage test drives one step: `loadStageStep(<module path>, stubs)` from `bin/build-stage.ts`, as `stage-step-ruling.check.ts` does. Name the module by a relative literal (`'../workflows-src/stage/ruling.js'`): `bin/testmap.ts` resolves it to that one file, so only a change to that module selects the test. A bare `'ruling.js'` links to every file of that name.
- Never name `stage.js` in the test, not even in a test title or a quoted word in a comment: any literal whose file name is `stage.js` links the test to the bundle and so to every module. A test that calls `loadStageBundle` is linked to every module by that name (`testmap.ts` `stageBundles`); keep it for a check that needs the whole bundle, such as `stage-steps-032.check.ts` test "a single step driven alone returns the same result as the same step inside the stage.js bundle".
- Stub every free name the step reaches (`agent`, `args`, `log`, runner calls such as `integrate`). A missing one throws a ReferenceError when reached, which shows what the step needs. Read the step's functions from the returned `scope`; only names declared at column 0 are in it (`declaredNames`).
