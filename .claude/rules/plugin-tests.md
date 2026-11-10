---
paths:
  - "plugins/truss/tests/**/*.ts"
sources:
  - plugins/truss/tests/wiring-025.check.ts
  - plugins/truss/tests/store.check.ts
verified: 04fbf011de7bf0328fb21c2b2466befb131b3488
---

- Stub one seam of the plugin without knowing the real module's exports: in a private copy, move `bin/X.ts` to `bin/X-real.ts` and write `bin/X.ts` as `export * from './X-real.ts'` plus the local overrides. A local export shadows the star re-export, so only the named seam changes (`stubbedPlugin()`, `wiring-025.check.ts:28`).
- Copy the plugin with `pluginCopy()` into your own tmp dir (`cpSync(pluginCopy(), d, {recursive: true})`); never write inside the shared copy.
- `store.ts` test seam, pinned by `store.check.ts`: `withLock(dir, name, fn, {waitMs, platform, fs, host, now})`, `writeJsonAtomic`/`createExclusive(p, obj, {fs})`, `transcriptsOf(sid, env)`. The `fs` option holds `node:fs`-named sync functions; an omitted one falls back to `node:fs`. The lock is `<dir>/locks/<name>.lock/owner.json` with a millisecond-number `since`. A stale lock is removed only by one breaker at a time, which holds the mutex dir `<name>.lock.break` (a stale one, over 10 s old, is cleared) and removes the lock only if its owner token is still the one judged stale; a lock is never renamed aside. `StoreBusy` is a `CliError` with code 2 and body `{error: 'store busy: <name>'}`.
