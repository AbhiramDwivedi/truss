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
  - plugins/truss/tests/gates-026.check.ts
  - plugins/truss/tests/gates-026-regress.check.ts
verified: 41c678ac46b15ffa2dcf0c5eb12eadfea5ade93e
---

- Stub one seam of the plugin without knowing the real module's exports: in a private copy, move `bin/X.ts` to `bin/X-real.ts` and write `bin/X.ts` as `export * from './X-real.ts'` plus the local overrides. A local export shadows the star re-export, so only the named seam changes (`stubbedPlugin()`, `wiring-025.check.ts:28`).
- Copy the plugin with `pluginCopy()` into your own tmp dir (`cpSync(pluginCopy(), d, {recursive: true})`); never write inside the shared copy.
- `store.ts` test seam, pinned by `store.check.ts`: `withLock(dir, name, fn, {waitMs, platform, fs, host, now})`, `writeJsonAtomic`/`createExclusive(p, obj, {fs})`, `transcriptsOf(sid, env)`. The `fs` option holds `node:fs`-named sync functions; an omitted one falls back to `node:fs`. The lock is `<dir>/locks/<name>.lock/owner.json` with a millisecond-number `since`. A stale lock is removed only by one breaker at a time, which holds the mutex dir `<name>.lock.break` (a stale one, over 10 s old, is cleared) and removes the lock only if its owner token is still the one judged stale; a lock is never renamed aside; an ownerless lock's age is re-checked under that mutex (`store.ts:204-211`). `StoreBusy` is a `CliError` with code 2 and body `{error: 'store busy: <name>'}`.
- A lock race needs one stale lock seen by several waiters, too narrow for one run. Test many rounds, each planting a fresh stale lock, plus a read-modify-write counter under `withLock` so an overlap loses an increment (`store.check.ts:85`, `fixtures/store/worker.ts` counter mode). Prove the test by mutating the code (drop the token re-check and the `.break` mutex) and seeing it fail.
- Assert workflow prompt content on the prompts the stubbed `agent()` received (`call(r, label).prompt` in `workflows.check.ts`), never on script source text. A nested `node --test` child inherits `NODE_TEST_CONTEXT` and ignores `--test-name-pattern` unless it is unset (`wiring-025.check.ts:266`). A `Stop('BLOCKED', ...)` text in `stage.js` starts with `BLOCKED: `; tests assert `startsWith` (exception: `heavy slot busy:`, `gates-026.check.ts:194`).
- `workflows.check.ts` resolves agent labels with `Object.hasOwn(labels, label)`, so a `Proxy` with `has`/`get`/`getOwnPropertyDescriptor` traps can route stubs by role regex (`workflows.check.ts:1532`). `checkSpawns()` knows only `ROLE_NAMES`: product-owner labels (`truss-po*`) need `exec()` with `args.truss.personas['product-owner']`, not `runPlan()`.
- Test a session-scoped CLI command (`inbox.check.ts` `mkInbox`/`fx`): make the session dir `<repo>/.git/truss/<sid>`, not a loose tmp dir, so `path.basename(dir)` is the session and `<common>/truss/shared/inbox.jsonl` is the real shared file. Call `runCli(factory(), cmd, ['--repo', R, '--dir', D, ...])` with `TRUSS_TRANSCRIPTS_ROOT` (spend, queue) and, for proof, `TRUSS_TEST_PROOF_ROOT` in the extra env; the real plugin ignores the latter (see the `proofPlugin()` item). Put positionals (`resolve <id>`) before value-less flags: `positionalsToFlags` lets a boolean flag swallow the next bare word.
- A change to proof-check behaviour in `bin/inbox.ts` needs `docs/features.md` and `docs/knowledge/store.md` updated too; they sit outside a builder's file list, so the stage or knowledge member owns them.
- Reach `sessionAudit` through `factory finish` with a second run of plan labels next to the stage run (`auditOf`, `wiring-025.check.ts:319`). An unparsable label starting a `truss:` agent type is flagged.
- Run a registered hook handler under plain node: import `hooks/register.ts`, call `register(on)` with a fake `on` that captures the handler whose tool filter matches (`a[1].tool`, a string or an array) and returns a chain with a stub `.catch`. Call it with a fake `$` (`process.run`, `session.cwd` and `id`, `env`, `clock`, `ui`, `fs`, `state`) and a `next` that records its calls (`gate-trussfile.check.ts:256` `drive()`, `unattended.check.ts`).
- Test a crew's merge gate through the real CLI (`fixtures/ltc/harness.ts` `crewWorld`, `clientResolves`): a solo or lean crew merges through `land` (plan v4, crew `process`, `owns: ['**']` so the owns-check never masks the gate); a full crew through `finish --transcript <mkRun dir> --result <file>`. Assert the refusal text matches the gate's pattern, not only exit 1.
- A client resolve in a test is the typed line `/truss:inbox approve <id> <code>` in `<troot>/<proj>/<sid>.jsonl`, ts one second after the `open` op; read the code from the notify recorder's stdin row. With `--raise-usd`, `typedProof` needs `<decision> <id> <code> raise <usd>`, so the helper types the amount (`harness.ts:81`). Resolves are re-proved at every read: append typed prompts (chained `parentUuid`), never overwrite the transcript (`trust-026.check.ts`).
- Proof tests use `proofPlugin()` (`fixtures/inbox/proof-plugin.ts`): a private plugin copy whose `store.ts` stubs `proofTranscriptRoot` (env `TRUSS_TEST_PROOF_ROOT`) and `readProofFile` (logs to `TRUSS_TEST_READ_LOG`); the vars exist only in the stub, the real `bin` fails closed. Prove the data first: point the stub at the old code's root and run on old code; give each refusal case a positive control (`trust-026.check.ts` `liftCase`).
- To force a real `ENOBUFS` from `git diff --name-status`: build a tree with a private `GIT_INDEX_FILE`, `update-index --add -z --index-info`, `write-tree`, `commit-tree`; about 16000 sixty-character paths suffice (`trust-026.check.ts` `commitEntries`).
- A temp checkout reproducing a run-model or evals leak needs a tracked file under `.claude` (copy `.claude/rules/plugin-tests.md`); else `git status` shows `?? .claude/` and "checkout status changed" fails first, for another cause (`gates-026.check.ts` `leakCheckout()`).
- Prove a guard test red by mutating the checkout copy (`mkEnv`/`pluginCopy`): `git checkout <fix>^ -- <files>`, run, `git checkout HEAD -- <files>`. A lock-guarded read-modify-write test: create `<dir>/locks/plan.lock/owner.json` (live `pid`, `host`, `token`, fresh `since`), start the CLI async, change `plan.json`, remove the lock; no sleep decides (`gates-026-regress.check.ts:60`).
- The eval runner takes only the `qc` and `checker` roles (`evals/case.schema.json`), so no golden exercises the design-engineer; pin its prompt rules by prose tests.
- During an in-progress merge, `git checkout HEAD -- <file>` restores the pre-merge file; to undo a temporary mutation use `git checkout <merged-branch> -- <file>`.
