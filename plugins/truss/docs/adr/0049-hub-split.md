# ADR-0049: split the hub modules into leaves

Status: accepted, 2026-11-13
Decided by: program manager (auto): the approved 0.32.0 plan, section "Item 8 goes first, in stage 0", resting on goal item 8 ("Sharper test selection by structure") and requirement R-139 "A one-line change to a leaf module selects far fewer tests"

## Context

`factory check --expect green` runs only the tests a crew's diff reaches (`selectTests` in `bin/testmap.ts`, the core of `selectForCheckout`). Three modules sat in the middle of the import graph, so a one-line change to any of them selected most of the suite. The plan measured them with `selectTests` on a one-file change, out of 163 test files:

| Changed file | Tests selected |
| --- | --- |
| `bin/factory/shared.ts` | 95 |
| `bin/factory/resources.ts` | 95 |
| `bin/store.ts` | 103 |

The measure is `selectTests` on `git ls-files`, with a one-file diff, config `{}` and the `scripts.test` of `package.json` (`selected()` in `tests/hub-split-032.check.ts`). A count is valid only when the result's `mode` is `targeted`: a full selection returns zero files. At the crew base the same measure gave `bin/store.ts` 103, `bin/factory/shared.ts` 95, `bin/factory/resources.ts` 95 and `bin/factory.ts` 95, of 164 test files.

Each hub held unrelated code. `bin/store.ts` held the CLI error helpers, the git roots, the lock, the leases, the atomic writes, the JSONL helpers and the transcript roots. `bin/factory/shared.ts` held flag parsing, the plan file, settings, the event log and the roles table. `bin/factory/resources.ts` held the heavy slot, admission and reaping. A test that needed one of these parts loaded all of them, so a change to any part selected that test.

## Decision

1. **Split each hub along its callers.** The code moves without changing behaviour.

   | Old hub | Leaf | What it holds |
   | --- | --- | --- |
   | `bin/store.ts` | `bin/core.ts` | `CliError`, `usage`, `refuse`, the flag and JSON helpers (`str`, `need`, `listOf`, `readText`, `readJson`, `isObj`, `flat`), `parseLabel`, `configOf`, `repoPathOf`, `packageName`, `declares`, and the git roots `git`, `commonDir` and `sharedDir` |
   | `bin/store.ts` | `bin/lock.ts` | the fs seam (`FsLike`, `fn`), `StoreBusy`, `takeOver`, `withLock`, `writeJsonAtomic`, `createExclusive`, the leases (`takeLease`, `refreshLease`, `releaseLease`, `LEASE_STALE_MS`, `LEASE_REFRESH_MS`), `appendJsonl` and `readJsonl`; also the unexported `STALE_AGE_MS` and `OWNERLESS_MS` |
   | `bin/store.ts` | `bin/transcripts.ts` | `transcriptsOf`, `proofTranscriptRoot` and `readProofFile` |
   | `bin/factory/shared.ts` | `bin/factory/cli.ts` | `PLUGIN`, `FACTORY`, `parseFlags`, `run`, `gitOrFail`, `repoOf`, `startDirOf`, `dirOf`, `intOr`, `crewWorktree`, `baseOf` and `archPath` |
   | `bin/factory/shared.ts` | `bin/factory/plan-file.ts` | `loadPlan`, `savePlan` and `patchPlan` |
   | `bin/factory/shared.ts` | `bin/factory/settings.ts` | `settingsOf`, `docKeysOf`, `knowledgeCfgOf`, `knowledgeCfgFrom` and `knowledgeArgsOf` |
   | `bin/factory/shared.ts` | `bin/factory/log.ts` | `appendEvent`, `appendDecision` and `appendDecisionLine` |
   | `bin/factory/shared.ts` | `bin/factory/roles.ts` | `readRoles`, `roleDefaults`, `rolesWithTypes`, `modelsOf`, `scriptPathFor` and `sessionScriptsDir` |
   | `bin/factory/resources.ts` | `bin/factory/slot.ts` | `HEAVY_WAIT_MS`, `HEAVY_WAIT_MAX_MS`, `explicitWaitMs`, `heavyWaitMs`, `slotWaitMs`, `recordHeavyTime`, `acquireSlot`, `slotsAt`, `heavySlotsOf`, `sleepSync`, `pidAlive` and `GROUPS` |
   | `bin/factory/resources.ts` | `bin/factory/admit.ts` | `admission`, `cmdAdmit` and `heldOnBusy`; also the unexported `holdOf` and `effectiveParallelism` |
   | `bin/factory/resources.ts` | `bin/factory/reap.ts` | `cmdReap` |

2. **The old hubs stay as barrels for one release.** `bin/store.ts`, `bin/factory/shared.ts` and `bin/factory/resources.ts` now hold only `export *` lines for their leaves. A sibling crew of the same run that adds an import from an old hub still resolves at merge. A later goal deletes the barrels. The barrels use `export *` rather than named re-exports, because type-only names cannot be re-exported by name under node's type stripping.
3. **New code imports the leaf, never a barrel.** Every module under `bin/` and `resources/` already does. `tests/hub-split-032.check.ts` enforces it: its test "no module under bin/ or resources/ imports a barrel; each loads the leaf it uses" fails on any relative import of a barrel from those dirs. The tests also import the leaves, but no check enforces that for `tests/`.
4. **The split runs first, in stage 0.** The stage-1 crews change code that sat in the hubs, so they build on the final layout and nobody moves their code twice. `goalCheck` measures again on the final tree, so running first still measures the final code.

Code: `bin/core.ts`, `bin/lock.ts`, `bin/transcripts.ts`, and `bin/factory/` `cli.ts`, `plan-file.ts`, `settings.ts`, `log.ts`, `roles.ts`, `slot.ts`, `admit.ts` and `reap.ts`. Tests: `tests/hub-split-032.check.ts` (the counts, the exports and the barrel rule) and `tests/factory-split-031.check.ts` (the layout).

## Alternatives

**Run item 8 last, after the stage-1 crews.** That would split the final code only once. It was rejected because it adds a stage whose only job is to serialise merges, and it gives this run none of the selection gain.

## Consequences

R-139's target of at most 50 selected test files per changed leaf was not met. The PM filled that default; the client did not rule on it. It measures the load graph of `bin/factory.ts`, not the hub split. About 104 tests run the factory CLI, and its load path reaches `parseFlags`, `withLock` and `CliError`. A change to any leaf that holds one of those names selects all of those tests, however the hub is cut.

The selection counts below come from the diagnostics of `tests/hub-split-032.check.ts` test "hub-split 032: the selection count for each new module (logged for the builders report)", out of 176 test files. At the crew base, a change to `bin/store.ts` selected 103 files, a change to `bin/factory/shared.ts` selected 95 and a change to `bin/factory/resources.ts` selected 95.

| Changed file | Tests selected |
| --- | --- |
| `bin/store.ts` (barrel) | 7 |
| `bin/factory/shared.ts` (barrel) | 1 |
| `bin/factory/resources.ts` (barrel) | 1 |
| `bin/factory.ts` | 111 |
| `bin/core.ts` | 112 |
| `bin/lock.ts` | 117 |
| `bin/transcripts.ts` | 112 |
| `bin/factory/cli.ts` | 111 |
| `bin/factory/plan-file.ts` | 109 |
| `bin/factory/settings.ts` | 109 |
| `bin/factory/log.ts` | 109 |
| `bin/factory/roles.ts` | 59 |
| `bin/factory/slot.ts` | 111 |
| `bin/factory/admit.ts` | 89 |
| `bin/factory/reap.ts` | 111 |

- The barrels select few tests only because nothing imports them now. That does not show that a change to the moved code selects fewer tests.
- The split did not cut the worst count for any hub. Its worst leaves select 111 (`shared.ts`), 111 (`resources.ts`) and 117 (`store.ts`) files, against 95, 95 and 103 of 164 before. The counts rose because the leaves are now loaded by every module that imported a hub, and the suite grew from 164 to 176 test files. Only `roles.ts` (59) and `admit.ts` (89) are well below the hub counts.
- Cutting the counts needs per-command dispatch in `bin/factory.ts`, so that a test of one command loads only that command's modules. Lazy imports in `bin/factory.ts` were rejected because they hide references from the selector without changing what an edit to `parseFlags` or `withLock` can break. The release report records R-139 as not met and proposes that dispatch work as a follow-up goal.
- `tests/hub-split-032.check.ts` pins the live measure with "a change to bin/factory.ts still selects more than 50 test files, so the measure is live".
- Text that pins the lock constants reads `bin/lock.ts`: `release-026.check.ts` and `hygiene-029.check.ts` look for `OWNERLESS_MS` and `STALE_AGE_MS` there.
- A test that stubs one seam of a moved name stubs the leaf, not the barrel. `tests/fixtures/inbox/proof-plugin.ts` now replaces `bin/transcripts.ts`.
- ADR-0037 Decision says "`bin/store.ts` is the only code that locks files, writes shared state or sets a transcript root", and ADR-0048 cites `bin/store.ts` for the lease code. That code now lives in `bin/lock.ts` (the lock, the leases and the writes) and `bin/transcripts.ts` (the transcript roots); `bin/store.ts` only re-exports it. This ADR amends the wording of those citations and nothing else: the single-locker rule holds, now in `bin/lock.ts`. Read every `bin/store.ts` citation in ADR-0037 and ADR-0048 as the leaf that holds the named symbol.
- `fn`, the fs-seam helper in `bin/lock.ts`, is exported for `bin/transcripts.ts`, so `export *` makes `bin/store.ts` export it too. It is internal. Nothing outside `bin/lock.ts` and `bin/transcripts.ts` should import it, and the barrel goes in a later goal.
- Until the barrels go, a name has two import paths. The barrel rule in `hub-split-032.check.ts` keeps `bin/` and `resources/` off the old one.
