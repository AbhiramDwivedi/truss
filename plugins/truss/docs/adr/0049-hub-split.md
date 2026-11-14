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

The selection counts after the split, from the diagnostics of `tests/hub-split-032.check.ts` test "the selection count for each new module", out of 166 test files:

| Changed file | Tests selected |
| --- | --- |
| `bin/store.ts` (barrel) | 6 |
| `bin/factory/shared.ts` (barrel) | 1 |
| `bin/factory/resources.ts` (barrel) | 1 |
| `bin/factory.ts` | 104 |
| `bin/core.ts` | 105 |
| `bin/lock.ts` | 110 |
| `bin/transcripts.ts` | 105 |
| `bin/factory/cli.ts` | 104 |
| `bin/factory/plan-file.ts` | 102 |
| `bin/factory/settings.ts` | 102 |
| `bin/factory/log.ts` | 102 |
| `bin/factory/roles.ts` | 56 |
| `bin/factory/slot.ts` | 104 |
| `bin/factory/admit.ts` | 84 |
| `bin/factory/reap.ts` | 104 |

- The barrels select few tests only because nothing imports them now. The three tests that pin "at most 50 test files" for the old hub paths pass for that reason. They do not show that a change to the moved code selects fewer tests.
- Most leaves still select about as many tests as the hubs did. About 104 of 166 tests reach `bin/factory.ts`, and the dispatcher reaches most leaves through its command modules, so those leaves stay near that count. Only `roles.ts` (56) and `admit.ts` (84) dropped. R-139 is met for those two leaves only. Cutting the other counts needs a split of the dispatcher's load graph, not of the hubs. `tests/hub-split-032.check.ts` test "a change to bin/factory.ts still selects more than 50 test files, so the measure is live" pins that this measure still tells a hub from a leaf.
- The plan expected the stage-1 crews' targeted runs to fall to at most 50 files. That holds for a change to a barrel, and not for a change to most leaves.
- Text that pins the lock constants reads `bin/lock.ts`: `release-026.check.ts` and `hygiene-029.check.ts` look for `OWNERLESS_MS` and `STALE_AGE_MS` there.
- A test that stubs one seam of a moved name stubs the leaf, not the barrel. `tests/fixtures/inbox/proof-plugin.ts` now replaces `bin/transcripts.ts`.
- Until the barrels go, a name has two import paths. The barrel rule in `hub-split-032.check.ts` keeps `bin/` and `resources/` off the old one.
