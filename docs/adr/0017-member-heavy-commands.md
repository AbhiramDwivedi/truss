# ADR-0017: members' own heavy commands go through `factory heavy` as one plain command

Status: proposed, 2026-10-31. Written by the design crew `member-heavy-design` (stage 2 of goal `plugin-fixes`). It becomes accepted when the PM merges this crew. The goal's approval is `auto`, and its plan is revision 2 (`plan-plugin-fixes.md` in the truss dir). This goal builds none of it: if the PM takes the decision, it amends a build crew (plan module verdict, `plan-plugin-fixes.md:18`).

VERDICT: change, decided here and built later. It picks a member-side heavy path. The **stage workflow** (`workflows/stage.js`) would give each member one literal `factory heavy` line. The **factory CLI** (`bin/factory.ts`) and the **resources** module (`resources/index.ts`) don't change. The **hooks** (`hooks/register.ts`) don't change, and neither does how they treat the worktree guard.

Decided by: amend brief item 5 (`amend-brief-plugin-fixes.md:10`), the plan's module verdict for item 5 (`plan-plugin-fixes.md:18`), [ADR-0016](0016-plugin-fixes.md) Decision 8, and the probe below.

## Context

[ADR-0015](0015-resource-aware.md) Decision 6, "Checks through heavy: runner-run commands only" (`0015-resource-aware.md:159-172`), queues only runner-run commands through `factory heavy`: the red and green `check` runs. A member's own builds and tests aren't queued. Admission at member start and the effective parallelism are their only guard. ADR-0015 sent this to the plugin fix goal as a proven gap (checker-24 (b)), and lists it under Out of scope (`0015-resource-aware.md:196`).

The gap is still there in the code:

- `stage.js` builds the one `factory heavy` line in `heavyLine()` (`workflows/stage.js:209-215`). Only `check()` (`:217-222`) uses it, through a runner call.
- No member prompt holds the plugin path or the truss dir. `stage.js` reads `F.plugin`, `F.dir` and `F.repo` only for runner lines (`:177`, `:210-211`) and for QC report paths (`:681`). So a member can't call `factory heavy` today without guessing the paths.
- `reap` after each member (`workflows/stage.js:143-150`) kills only recorded groups with label `<slug>-check` (`bin/factory.ts:1118`). A member's own processes are never recorded (`0015-resource-aware.md:179`).

The plan says the worktree guard "refuses the multi-part shell a member would need to call `factory heavy` itself" (`plan-plugin-fixes.md:18`). The worktree guard is Claude Code's own, not a truss hook (`workflows/stage.js:16-17`). The member brief's `SHELL` rule (`workflows/stage.js:18`) lists the shapes it refuses: heredoc writes, `&&`, `;`, `cd`, for-loops, `$VAR` arguments, and inline scripts that name git. truss's hooks only classify a guard refusal by its text, through `refusalOf` and `WORKTREE_GUARD` (ADR-0012, `0012-self-improving-retro.md:61`). The open question was whether the guard lets through the one shape a member actually needs: a single plain command whose absolute paths (the plugin's `bin/factory.ts` and the truss dir) lie outside the worktree.

### The shape a member would run

From `heavyLine()` (`workflows/stage.js:209-215`) and `heavyMain()` (`bin/factory.ts:1137-1207`):

```
node <plugin>/bin/factory.ts heavy --dir D --repo R --slug S --label L --cwd W -- <cmd...>
```

- `heavy` splits its argv at the first `--` and parses flags only before it (`bin/factory.ts:1139-1141`). It needs `--dir`, `--slug`, `--label` and `--cwd` (`:1142-1145`), and a command after `--` (`:1146`).
- It runs the command with `spawn(cmd[0], cmd.slice(1), { cwd, detached: true })`, with no shell (`:1174`). A spawn error gives exit 127 (`:1175`).
- It records the group under `D/resources/groups/<pgid>.json` (`:1178-1179`) and deletes the record once the group is empty (`:1186`).
- A JSON stdout passes through with a `heavy` key added (`:1195`). Any other output comes back as `tail`, the last 40 lines of stdout then stderr (`:1196-1198`).
- It waits for the slot up to `HEAVY_WAIT_MS` = 240000 (`bin/factory.ts:1043`, `:1162-1163`), then prints `ran: false` and exits 1.
- `heavy` is the one async command. `main` refuses it (`bin/factory.ts:1570-1571`), and the entry point sends it to `heavyMain` (`:1597`).

Every argument in this line is a literal. It needs no `&&`, `;`, `cd` or `$VAR`, so it breaks none of the `SHELL` rule's shapes.

## Decision

**It picks a member-side heavy path.** A member runs its own heavy commands through `factory heavy`, as one plain Bash command with absolute literal paths. The worktree guard lets that shape through: the probe below ran it from a Workflow member's worktree, with the plugin path and the truss dir both outside the worktree, and nothing refused it. The gap is not a known limit, because the obstacle was never the guard. It was that no member brief carries the paths.

What a build crew would change, and nothing else:

1. **`workflows/stage.js`, member prompts.** A helper beside `heavyLine()` builds the member line from the same values: `F.plugin`, `F.dir`, `F.repo`, `crew.slug` and `crew.e.worktree`, each quoted through `sh()` (`workflows/stage.js:171-174`). Its label is `<slug>-check`, so the existing `reap` after each member (`:143-150`) also cleans up a member run's orphans, with no new reap call. `memberPrompt` (`:226`) adds one line next to `SHELL`. It gives the literal prefix, ending in ` -- `, and says:
   - run a build, a browser test or a whole test suite through it, as the program and its arguments after `--`, with no shell;
   - use a Bash timeout of 600000, because the slot wait counts against it;
   - a result with `"ran": false` means the slot was busy; report it, don't retry it another way.
2. **Seams to pin.** Before the change, a test-writer pins these in a new contract. The fake `agent` must tell member calls from runner calls by label, as `tests/stage-briefs.check.ts:55` does. The pins:
   - every member prompt holds a `factory.ts heavy` line;
   - that line's `--dir`, `--repo`, `--slug`, `--label` and `--cwd` equal the runner's `heavyLine()` values, with `--label <slug>-check`;
   - the line holds no `$`, `&&`, `;` or `cd`.
3. **Docs.** ADR-0015's Decision 6 and Out of scope, and the architecture doc's "One heavy slot" bullet, then say that member runs share the slot.

The path changes no hook. It doesn't change how hooks treat the worktree guard: the guard is Claude Code's, `refusalOf` keeps classifying its text as before, and the probe ran with the hooks as they are. So checker-28's trigger ("recheck client triggers if member-heavy-design changes worktree-guard hook handling", `plan-plugin-fixes.md:92`) does not fire.

## Out of scope

- Building any of it. This goal decides; the PM amends a build crew if it takes the decision (`plan-plugin-fixes.md:18`).
- Any change to `bin/factory.ts`, `resources/index.ts` or `hooks/register.ts`. `heavy` already takes any command after `--`.
- A shell after `--`. `heavy` spawns with no shell (`bin/factory.ts:1174`). A member that needs a pipeline puts it in a script file and runs that.
- Raising the one heavy slot, or a member-only slot. ADR-0015 Decision 3 keeps one slot (`0015-resource-aware.md:90`).
- The foreman path (`agents/foreman.md`). ADR-0015 already leaves it out (`0015-resource-aware.md:194`).
- macOS and Windows proof.

## Consequences

- A member's builds and heavy test runs share the one heavy slot with every crew's red and green checks, so they run one at a time across the session. On a host like the horoscope one, that guards against the memory spike ADR-0015 opened with.
- A long member run can make a waiting check stop. A runner check that waits past `HEAVY_WAIT_MS` (240000 ms) stops its crew `BLOCKED` with `heavy slot busy:` (`workflows/stage.js:220`). It never gets a fix builder, and the PM resumes it. A member build that holds the slot longer than 4 minutes can cause that.
- A member's own run waits too, and the wait counts against its Bash call's 600000 ms limit. So the brief must name the timeout.
- A member sees only the last 40 lines of a non-JSON output (`bin/factory.ts:1196-1198`). A member that needs the full log writes it to a file from a script run through `heavy`.
- `reap` with `--label <slug>-check` covers member runs too. It skips a record whose `heavy` process is still alive (`bin/factory.ts:1119-1121`), so a reap after one member can't kill a sibling member's live run.
- Proof covers Linux only, and only this session's permission settings. TODO: a project whose permission settings prompt for a `node` command outside the worktree is untested; the probe can't show that.

## Probes behind this ADR

Run from this crew's worktree, `<repo>/.claude/worktrees/<member worktree>`, on Linux with Node v24.22.0. The truss dir came from `mktemp -d`, never the live truss dir. Ports: none.

1. A temp truss dir:

   ```
   $ mktemp -d
   <tmp truss dir>
   ```

2. The member shape, one plain command, with the plugin's `bin/factory.ts` (`<plugin>`, the plugin dir) and the truss dir both outside the worktree, and a harmless inner command. Nothing refused it:

   ```
   $ node <plugin>/bin/factory.ts heavy --dir <tmp truss dir> --repo <repo>/.claude/worktrees/<member worktree> --slug member-heavy-design --label member-heavy-design-probe --cwd <repo>/.claude/worktrees/<member worktree> -- node --version
   {"heavy":{"label":"member-heavy-design-probe","waitedMs":0,"exit":0},"tail":"v24.22.0"}
   ```

3. What it left behind: the lock released and the group record deleted, as `heavyMain` does (`bin/factory.ts:1185-1186`, `:1200`):

   ```
   $ find <tmp truss dir>
   <tmp truss dir>
   <tmp truss dir>/resources
   <tmp truss dir>/resources/groups
   ```

What the worktree guard does refuse, seen once in this session: a git command redirected to the shared checkout. It was not part of the probe, and it was not retried.

```
$ git -C <repo> log -1 ...
This agent is isolated in the worktree <repo>/.claude/worktrees/<member worktree>, but this command redirects git to the shared checkout via -C. Refusing to run it — a worktree-isolated agent's git operations must target its own worktree. Run the equivalent from <repo>/.claude/worktrees/<member worktree> without the redirect.
```

So the guard refuses git aimed outside the worktree, and the shapes the `SHELL` rule lists. It let a plain `node` command that reads and writes paths outside the worktree go through. Because of that refusal, this crew didn't record which commit the plugin checkout was on. It has `heavyMain` (`grep -c heavyMain <plugin>/bin/factory.ts` gives `2`).

## Documents this ADR amends

- [ADR-0015](0015-resource-aware.md): a link at Decision 6 "Checks through heavy" and at Out of scope. Its text doesn't change until a build crew builds the path.
- `docs/architecture.md`: a link at the "One heavy slot" bullet.
