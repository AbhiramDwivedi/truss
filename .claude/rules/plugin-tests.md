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
verified: 610b551e155972405d1e2a0382a659df43c10a8b
---

- Stub one seam of the plugin without knowing the real module's exports: in a private copy, move `bin/X.ts` to `bin/X-real.ts` and write `bin/X.ts` as `export * from './X-real.ts'` plus the local overrides. A local export shadows the star re-export, so only the named seam changes (`stubbedPlugin()`, `wiring-025.check.ts:28`).
- Copy the plugin with `pluginCopy()` into your own tmp dir (`cpSync(pluginCopy(), d, {recursive: true})`); never write inside the shared copy.
- `store.ts` test seam, pinned by `store.check.ts`: `withLock(dir, name, fn, {waitMs, platform, fs, host, now})`, `writeJsonAtomic`/`createExclusive(p, obj, {fs})`, `transcriptsOf(sid, env)`. The `fs` option holds `node:fs`-named sync functions; an omitted one falls back to `node:fs`. The lock is `<dir>/locks/<name>.lock/owner.json` with a millisecond-number `since`. A stale lock is removed only by one breaker at a time, which holds the mutex dir `<name>.lock.break` (a stale one, over 10 s old, is cleared) and removes the lock only if its owner token is still the one judged stale; a lock is never renamed aside; an ownerless lock's age is re-checked under that mutex (`store.ts:204-211`). `StoreBusy` is a `CliError` with code 2 and body `{error: 'store busy: <name>'}`.
- A lock race needs one stale lock seen by several waiters, too narrow for one run. Test many rounds, each planting a fresh stale lock, plus a read-modify-write counter under `withLock` so an overlap loses an increment (`store.check.ts:85`, `fixtures/store/worker.ts` counter mode). Prove the test by mutating the code (drop the token re-check and the `.break` mutex) and seeing it fail.
- Assert workflow prompt content on the prompts the stubbed `agent()` received (`call(r, label).prompt` in `workflows.check.ts`), never on script source text. A nested `node --test` child inherits `NODE_TEST_CONTEXT` and ignores `--test-name-pattern` unless it is unset (`wiring-025.check.ts:266`).
- `workflows.check.ts` resolves agent labels with `Object.hasOwn(labels, label)`, so a `Proxy` with `has`/`get`/`getOwnPropertyDescriptor` traps can route stubs by role regex (`workflows.check.ts:1532`). `checkSpawns()` knows only `ROLE_NAMES`: product-owner labels (`truss-po*`) need `exec()` with `args.truss.personas['product-owner']`, not `runPlan()`.
- Test a session-scoped CLI command (`inbox.check.ts` `mkInbox`/`fx`): make the session dir `<repo>/.git/truss/<sid>`, not a loose tmp dir, so `path.basename(dir)` is the session and `<common>/truss/shared/inbox.jsonl` is the real shared file. Call `runCli(factory(), cmd, ['--repo', R, '--dir', D, ...])` with `TRUSS_TRANSCRIPTS_ROOT` in the extra env. Put positionals (`resolve <id>`) before value-less flags: `positionalsToFlags` (`factory.ts:3630`) lets a boolean flag swallow the next bare word.
- A change to proof-check behaviour in `bin/inbox.ts` needs `docs/features.md` and `docs/knowledge/store.md` updated too; they sit outside a builder's file list, so the stage or knowledge member owns them.
- Reach `sessionAudit` (`factory.ts:2549`) through `factory finish` with a second run of plan labels next to the stage run (`auditOf`, `wiring-025.check.ts:319`). An unparsable label starting a `truss:` agent type is flagged.
