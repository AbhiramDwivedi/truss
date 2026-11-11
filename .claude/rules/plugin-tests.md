---
paths:
  - "plugins/truss/tests/**/*.ts"
sources:
  - plugins/truss/tests/wiring-025.check.ts
  - plugins/truss/tests/store.check.ts
  - plugins/truss/tests/workflows.check.ts
  - plugins/truss/bin/store.ts
  - plugins/truss/tests/inbox.check.ts
  - plugins/truss/bin/factory.ts
  - plugins/truss/tests/gate-trussfile.check.ts
  - plugins/truss/tests/unattended.check.ts
  - plugins/truss/tests/fixtures/ltc/harness.ts
  - plugins/truss/tests/fixtures/inbox/proof-plugin.ts
  - plugins/truss/tests/trust-026.check.ts
verified: 224b10c690b94353f504ada4b4fbf7ff1ddad349
---

- Stub one seam of the plugin without knowing the real module's exports: in a private copy, move `bin/X.ts` to `bin/X-real.ts` and write `bin/X.ts` as `export * from './X-real.ts'` plus the local overrides. A local export shadows the star re-export, so only the named seam changes (`stubbedPlugin()`, `wiring-025.check.ts:28`).
- Copy the plugin with `pluginCopy()` into your own tmp dir (`cpSync(pluginCopy(), d, {recursive: true})`); never write inside the shared copy.
- `store.ts` test seam, pinned by `store.check.ts`: `withLock(dir, name, fn, {waitMs, platform, fs, host, now})`, `writeJsonAtomic`/`createExclusive(p, obj, {fs})`, `transcriptsOf(sid, env)`. The `fs` option holds `node:fs`-named sync functions; an omitted one falls back to `node:fs`. The lock is `<dir>/locks/<name>.lock/owner.json` with a millisecond-number `since`. A stale lock is removed only by one breaker at a time, which holds the mutex dir `<name>.lock.break` (a stale one, over 10 s old, is cleared) and removes the lock only if its owner token is still the one judged stale; a lock is never renamed aside; an ownerless lock's age is re-checked under that mutex (`store.ts:204-211`). `StoreBusy` is a `CliError` with code 2 and body `{error: 'store busy: <name>'}`.
- A lock race needs one stale lock seen by several waiters, too narrow for one run. Test many rounds, each planting a fresh stale lock, plus a read-modify-write counter under `withLock` so an overlap loses an increment (`store.check.ts:85`, `fixtures/store/worker.ts` counter mode). Prove the test by mutating the code (drop the token re-check and the `.break` mutex) and seeing it fail.
- Assert workflow prompt content on the prompts the stubbed `agent()` received (`call(r, label).prompt` in `workflows.check.ts`), never on script source text. A nested `node --test` child inherits `NODE_TEST_CONTEXT` and ignores `--test-name-pattern` unless it is unset (`wiring-025.check.ts:266`).
- `workflows.check.ts` resolves agent labels with `Object.hasOwn(labels, label)`, so a `Proxy` with `has`/`get`/`getOwnPropertyDescriptor` traps can route stubs by role regex (`workflows.check.ts:1532`). `checkSpawns()` knows only `ROLE_NAMES`: product-owner labels (`truss-po*`) need `exec()` with `args.truss.personas['product-owner']`, not `runPlan()`.
- Test a session-scoped CLI command (`inbox.check.ts` `mkInbox`/`fx`): make the session dir `<repo>/.git/truss/<sid>`, not a loose tmp dir, so `path.basename(dir)` is the session and `<common>/truss/shared/inbox.jsonl` is the real shared file. Call `runCli(factory(), cmd, ['--repo', R, '--dir', D, ...])` with `TRUSS_TRANSCRIPTS_ROOT` (spend, queue) and, for proof, `TRUSS_TEST_PROOF_ROOT` in the extra env; the real plugin ignores the latter (see the `proofPlugin()` item). Put positionals (`resolve <id>`) before value-less flags: `positionalsToFlags` (`factory.ts:3630`) lets a boolean flag swallow the next bare word.
- A change to proof-check behaviour in `bin/inbox.ts` needs `docs/features.md` and `docs/knowledge/store.md` updated too; they sit outside a builder's file list, so the stage or knowledge member owns them.
- Reach `sessionAudit` (`factory.ts:2549`) through `factory finish` with a second run of plan labels next to the stage run (`auditOf`, `wiring-025.check.ts:319`). An unparsable label starting a `truss:` agent type is flagged.
- Run a registered hook handler under plain node: import `hooks/register.ts`, call `register(on)` with a fake `on` that captures the handler whose tool filter matches (`a[1].tool`, a string or an array) and returns a chain with a stub `.catch`. Call the handler with a fake `$` (`process.run`, `session.cwd` and `id`, `env`, `clock`, `ui`, `fs`, `state`) and a `next` that records its calls (`gate-trussfile.check.ts:256` `drive()`, `unattended.check.ts`).
- Test a crew's merge gate through the real CLI (`fixtures/ltc/harness.ts` `crewWorld`, `clientResolves`): a solo or lean crew merges through `land` (plan v4, crew `process`, `owns: ['**']` so the owns-check never masks the gate); a full crew through `finish --transcript <mkRun dir> --result <file>`. Assert the refusal text matches the gate's pattern, not only exit 1.
- A client resolve in a test is the typed line `/truss:inbox approve <id> <code>` in `<troot>/<proj>/<sid>.jsonl`, ts one second after the `open` op; read the code from the notify recorder's stdin row. With `--raise-usd`, `typedProof` (`inbox.ts:395`) needs `<decision> <id> <code> raise <usd>`, so the helper must type the amount (`harness.ts:81`).
- Proof tests use `proofPlugin()` (`tests/fixtures/inbox/proof-plugin.ts`): a per-process private plugin copy whose `store.ts` stubs `proofTranscriptRoot` (env `TRUSS_TEST_PROOF_ROOT`) and `readProofFile` (appends each path to the file `TRUSS_TEST_READ_LOG`); both vars exist only in the stub. Run its `bin/factory.ts` as a CLI, or import its `bin/inbox.ts`/`guard.ts`/`store.ts` in-process after setting the vars. The real `bin` reads `os.userInfo().homedir` and fails closed.
- Resolves are re-proved at every read: a test with several client resolves in one session appends the typed prompts to its transcript (chained `parentUuid`), never overwrites it (`inbox.check.ts:571-594`, `trust-026.check.ts`).
- Prove proof-test data before the build: point the stub's env at the old code's root (`TRUSS_TRANSCRIPTS_ROOT` = the test root) and run the new tests on old code. A refusal case passes vacuously when the code can't find the root, so give each one a positive control or a read-log assertion (`trust-026.check.ts` `liftCase`).
- To force a real `ENOBUFS` from `git diff --name-status` (1 MB `spawnSync` buffer): build a tree with a private `GIT_INDEX_FILE`, `update-index --add -z --index-info` (NUL-ended `100644 <blob>\t<path>` records), `write-tree`, `commit-tree`; about 16000 sixty-character paths suffice (`trust-026.check.ts:675` `commitEntries`).
- During an in-progress merge, `git checkout HEAD -- <file>` restores the pre-merge file. To undo a temporary mutation, use `git checkout <merged-branch> -- <file>` (seen as `not built: escalate` failures in `inbox.check.ts`).
