# ADR-0015: resource-aware crews: a sampler, admission at each start, one heavy slot, group reaping and a Haiku monitor

Status: proposed, 2026-10-31. Written by the design crew `resource-design` (stage 0 of goal `resource-aware`). It becomes accepted when the PM merges this crew. The goal's approval is `auto`. It is a PO fix under the client's 05:05 product-owner ruling, triaged by checker-20, and its plan is revision 4 (`plan-resource-aware.md` in the truss dir). This is truss's ADR-0015. It is not [claude-ops ADR-0015](claude-ops/0015-agent-worktree-cleanup.md), the worktree-cleanup record that the architecture doc cites as "ADR-0015 item 9" and "item 11".

VERDICT: change. One new module, **resources** (`resources/index.ts`), samples the host and holds the cross-worktree heavy lock. Nothing in the repo does either today: `bin/factory.ts` spawns only git and bash (`bin/factory.ts:82`, `:510`), and the hooks module gates tool calls in-process. Two modules change. The **factory CLI** gains `admit`, `heavy` and `reap`, and `start` gains a `held` list; the `COMMANDS` table holds none of these today (`bin/factory.ts:1320-1323`). The **stage workflow** admits before each member, runs its checks through `heavy`, and reaps after each member; today `workflows/stage.js` names none of the three words. Two modules extend: **agents** gain `truss:resource-monitor`, and the **PM skill** (`skills/run/SKILL.md`) gains the monitor step. **ui docs** gain one README line.

Decided by: the client's (d) ruling, checker-20's approved scope, and checker-23, checker-24 and checker-25 as followed in plan revision 4. The PM settled the open (a) and (b) items there.

## Context

The horoscope test session (feedback 6) ran on a Windows 11 host with 15.6 GB of RAM. Several crew worktrees ran heavy verify and web builds at once, about 1.2 GB each. Free memory hit a critical level. Another session's background-shell reaper then killed the truss UI server, which ended the truss session. One build kept running after its parent agent was gone (`amend-brief-resource-aware.md`, "What happened").

Truss has no defence against this today:

- `start` counts free slots only against `maxParallelCrews`: `cap = intOr(plan.maxParallelCrews, 4, 1)` and `slots = cap - running` (`bin/factory.ts:897-898`). It breaks out of its loop when the slots run out (`:905`). It never looks at the host.
- `check` runs the acceptance test with `spawnSync('bash', ['-c', crew.acceptanceTest])` (`bin/factory.ts:510`). Every crew's check can run at the same moment, and nothing queues them.
- `stage.js` starts members straight away (`runMember`, `workflows/stage.js:274-285`; `runMembers`, `:323-343`, which runs independent tasks in parallel). Nothing cleans up after a member ends.

The approved scope (checker-20) has five parts: (a) a plain-code sampler; (b) admission control at the start seams; (c) heavy commands queued across worktrees, with the lock in the truss dir; (d) a Haiku monitor that reports to the PM, who sets an effective parallelism; and (e) orphan cleanup by recorded pid or process group, never `pkill -f` or `killall` (F-30). Three limits bind all of it: the cap stays a ceiling, a sampler error fails open, and proof covers Linux only.

## Decision 1: the sampler, `resources/index.ts`

A new module, **resources**, has one entry file, `resources/index.ts`. It imports only Node built-ins and relative files (P19). It owns no state of its own: the truss dir holds every file it reads or writes.

The words `pkill` and `killall` appear nowhere in `resources/`, not even in a comment. They also appear in no line that factory-resources adds to `bin/factory.ts` (F-30).

### Exports

- **`sample(opts?: { worktreesRoot?: string }): Sample`**, synchronous.
  - With `TRUSS_SAMPLE` unset, it reads the real host. `Sample` is `{ freeMB, totalMB, cpus, load1?, worktrees? }`.
  - `totalMB` is `Math.round(os.totalmem() / 2 ** 20)`. `freeMB` is `Math.round(os.freemem() / 2 ** 20)`. On this Linux host `os.freemem()` matches `/proc/meminfo`'s `MemAvailable` (probe below), so `freeMB` counts reclaimable cache as free.
  - `cpus` is `os.availableParallelism()`.
  - `load1` is `os.loadavg()[0]`. On Windows `os.loadavg()` is all zeros, so the sampler leaves `load1` out whenever all three values are 0, and admission there rests on memory alone.
  - `worktrees`, given `worktreesRoot`, lists `{ path, procs, rssMB }` per worktree dir under that root. On Linux it groups the processes whose `/proc/<pid>/cwd` lies inside a worktree and sums their `VmRSS` (the brief allows tying a process to a worktree by its cwd). It skips a process it can't read. On other platforms it returns `[]`. TODO: a per-worktree source for macOS and Windows; none is proven.
- **`minFreeMB(env = process.env): number`.** `TRUSS_MIN_FREE_MB`, when it is a whole number (`/^\d+$/`), else `DEFAULT_MIN_FREE_MB`.
- **`DEFAULT_MIN_FREE_MB = 2048`.** A chosen margin, not a measurement: on the horoscope host one heavy build took about 1.2 GB, so 2 GB free leaves room for one more.
- **`admits(s: Sample, min: number): boolean`.** `s.freeMB >= min`. Load doesn't hold a start; the monitor reads it (Decision 5).
- **The heavy-lock and group helpers** that `factory heavy` and `factory reap` call (Decision 3): `takeHeavySlot(dir, owner)`, `releaseHeavySlot(dir, token)`, `groupAlive(pgid)` and `killGroup(pgid, signal)`. factory-resources' contract pins their behaviour through the CLI, not these names, so resources-core may rename them if it tells factory-resources.

Run as a script, `node <plugin>/resources/index.ts [--worktrees <root>]` prints `sample()` as one JSON line. The monitor uses this (Decision 5).

### Test seams

- **`TRUSS_SAMPLE`** is a path to a JSON sample, or the word `error`, which forces a sampler error. A file must hold an object whose `freeMB` and `totalMB` are numbers of 0 or more. `sample()` returns that object. The word `error`, an unreadable file, or a file of the wrong shape makes `sample()` throw.
- **`TRUSS_MIN_FREE_MB`** overrides the threshold.
- **`TRUSS_CONTRACT_ROOT`** is the root each contract reads its producer from. The default is the repo root (G1). It is a test seam only; no producer reads it.

## Decision 2: admission, `factory admit` and `factory start`

`node <plugin>/bin/factory.ts admit --dir D --slug S` prints one JSON line and returns at once:

```json
{"admitted":false,"parallelism":2,"running":2,"freeMB":3100,"minFreeMB":4000,"why":"free memory 3100 MB is below 4000 MB"}
```

- It exits 0 when admitted and 1 when held, as ADR-0009 Decision 1 defines 1 ("a gate or an expectation refused"). A slug that isn't in the plan is a usage error: exit 2.
- **Memory.** `admits(sample(), minFreeMB())` from Decision 1.
- **Parallelism.** A `planned` crew is also held while the `running` crews already fill the effective parallelism. A `running` crew (the member case below) is checked on memory alone.
- **`why`** is present only when held. It names the threshold or the full parallelism.
- **Fail open (G7).** A sampler error admits the start. It prints `freeMB: null` and appends a `sampler-error` event to `D/events.jsonl`. The event name holds both words `sampler` and `error`:

  ```json
  {"v":1,"ts":"2026-10-31T12:00:00.000Z","event":"sampler-error","crew":"q","agent":"q","command":"admit","error":"TRUSS_SAMPLE=error"}
  ```

  `command` is the factory command that sampled (`admit`, `heavy` or `start`). `error` is the error's message, cut to 200 characters. The line is written through `appendEvent` (`bin/factory.ts:177-179`), which adds `v` and `ts`. The schema branch is additive (Seams to pin, section 3).

### The effective parallelism file

`D/resources/parallelism.json` holds `{"parallelism": n}`. A value counts only when `n` is an integer from 1 to `maxParallelCrews`. A missing or bad file means `maxParallelCrews`, and nothing ever goes above it. So `{"parallelism":9}` on a cap of 3, `0`, `garbage` and `{"parallelism":"2"}` all mean 3. `admit` prints the value it used as `parallelism`.

The plain-code admission hold stays the floor, whatever the file says: a file can lower the parallelism, but it can't admit a start that memory holds.

The PM writes the file (Decision 5). No factory command writes it.

### `start`

`start` applies the same admission to each crew it would start, on both engines (workflow and foreman), after its existing slot check:

1. The `maxParallelCrews` break at `bin/factory.ts:905` stays first, and stays silent, as today.
2. Then admission runs for the crew. A held crew goes under a new top-level key, `held: [{ "slug", "why" }]`. It stays `planned`, gets no worktree and no spawn line, and takes no slot.
3. A sampler error admits the crew and logs `sampler-error` with `command: "start"`.

With no parallelism file the effective parallelism equals `maxParallelCrews`, so step 1 fires before admission's parallelism rule can. Existing start cases see only `held: []`. `held` joins `OUTPUT_KEYS` (`tests/fixtures/workflow-run/start.cases.ts:42`), and the `--args-file` short output gains it too.

## Decision 3: one heavy slot, `factory heavy`

`node <plugin>/bin/factory.ts heavy --dir D --slug S --label L --cwd W -- <cmd...>` runs `<cmd...>` in `W` through the heavy queue.

**The heavy queue has one heavy slot unless a test seam says otherwise (G8).** This ADR adds no such seam, so there is always one heavy slot: a heavy run waits until no other heavy run, from any crew in the session, holds it.

### Argument split

`parseFlags` throws on any argument that doesn't start with `--` (`bin/factory.ts:53`), and a bare `--` would become the key `''`. So `heavy` splits its argv at the first `--` before it parses flags. It parses only the part before. The part after is the command, run as given, with no shell.

### The lock

- The lock is the directory `D/resources/heavy.lock/`, made with `mkdirSync` (atomic: one caller wins). The winner writes `owner.json`: `{ pid, token, label, slug, since }`.
- A waiting `heavy` retries about every 500 ms, for up to `HEAVY_WAIT_MS` = 240000 (4 minutes, a chosen bound). That leaves the rest of the Bash tool's 600000 ms foreground cap for the command itself.
- **Memory after the slot.** Once it holds the slot, `heavy` samples. If memory is below the threshold, it releases the slot and goes back to waiting; the wait counts against `HEAVY_WAIT_MS`. A sampler error runs the command and logs `sampler-error` with `command: "heavy"`.
- **Stale lock.** A lock is stale when its owner's pid is dead (`process.kill(pid, 0)` throws `ESRCH`), or when it has no `owner.json` and its mtime is more than 10 s old (an owner that died between `mkdir` and the write). A waiter takes a stale lock over by renaming it to a unique name, reading the renamed `owner.json` to check it took the stale owner's token, and renaming it back if it didn't. Then it removes the renamed dir and makes a fresh lock.
- **Accepted risks.** Two waiters can still race in the gap between the stale check and the rename, and a dead owner's pid can be reused. Either can let two heavy runs overlap once. Neither can kill anything.
- **Recovery by hand.** When no `heavy` runs, delete `D/resources/heavy.lock/`.

### The run and its record

- `heavy` starts the command with `spawn(..., { detached: true, cwd: W })`, so the command leads a new process group whose pgid is its pid. It must be the async `spawn`: the record below has to be on disk while the command runs, and `spawnSync` gives the pid only after the child ends. So `heavy` is the one async command; `main` (`bin/factory.ts:1326`) stays synchronous for the rest.
- Before it waits on the child, `heavy` writes `D/resources/groups/<pgid>.json`: `{ pgid, heavyPid, label, slug, since }`.
- The child's stdout and stderr go to two files in an `mkdtemp` scratch dir, as `check` does (`bin/factory.ts:505-516`), and `heavy` removes the dir when it ends.
- `heavy` ends when the group leader exits. It then releases the slot. It deletes the group record when the group has no live process left; otherwise the record stays until `reap` (G5-b).
- Every file `heavy` writes is under `D/resources/` or the scratch dir. It writes nothing in the repo or in `W` (G5-a).

### Output and exit

- When the child's stdout is one JSON object, `heavy` prints that object with one key added: `"heavy": { "label", "waitedMs", "exit" }`. So `check`'s `ok`, `head`, `env` and `catalog` keys reach `stage.js` unchanged.
- Otherwise it prints `{ "heavy": { "label", "waitedMs", "exit" }, "tail": "<last 40 lines>" }`.
- It exits with the child's exit code.
- When the wait passes `HEAVY_WAIT_MS`, it prints `{ "heavy": { "label", "ran": false, "why": "..." } }` and exits 1. The command never ran.

## Decision 4: orphan cleanup, `factory reap`

`node <plugin>/bin/factory.ts reap --dir D --slug S --label L` kills the recorded process groups of that label, and never an unrelated process.

For each record in `D/resources/groups/` whose `slug` and `label` match:

1. If `heavyPid` is alive, the run is still going. `reap` skips the record.
2. Otherwise, if the group is alive (`process.kill(-pgid, 0)` succeeds), it sends `SIGTERM` to `-pgid`. If the group is still alive after about 2 s, it sends `SIGKILL` to `-pgid`.
3. It deletes the record.

It prints `{"reaped": [<pgid>...], "skipped": [<pgid>...]}` and exits 0. It signals nothing but the recorded groups, so a process in another group, such as an unrelated `sleep`, survives. Probe on this host: `process.kill(-pgid, 'SIGTERM')` killed an orphan left in a detached leader's group after the leader had exited, and a `sleep` in another group survived (probe below).

- **Accepted risk.** A recorded pgid can be reused by a new, unrelated group after the old group dies. `heavy` deletes a record as soon as its group is empty, which keeps that window short, but `reap` can't rule it out.
- **Platforms.** Linux only is proven. TODO: group kill on macOS and Windows is unproven. Node's `process.kill` with a negative pid has no Windows meaning that this crew checked.

## Decision 5: who decides the parallelism, `truss:resource-monitor`

The monitor is `truss:resource-monitor`, in `agents/resource-monitor.md`. Its frontmatter has `model: haiku` and a one-line, capitalised tools list, `tools: Bash, Read` (G2: never empty, never a YAML list), with no Write, Edit, MultiEdit or NotebookEdit.

- **It is a PM `Agent` call, never a Workflow role.** Workflow roles allow only opus or sonnet (ADR-0009 Decision 2), and `finish`'s session audit blocks every merge on an agent of an in-scope run with any other model family ([ADR-0009](0009-workflow-factory.md), Decision 6, `:316`). (a) is settled: the PM probed a general-purpose haiku/low `Agent` call from the main session and it ran, so `hooks/register.ts` doesn't change. A live `truss:resource-monitor` call stays unproven until the session restarts and loads the new agent.
- **What it does.** It runs `node <plugin>/resources/index.ts --worktrees <repo>/.claude/worktrees`, reads `D/resources/parallelism.json` and `D/plan.json`, and writes nothing. Its last line is `RECOMMEND parallelism <n>`, with `n` from 1 to `maxParallelCrews`.
- **Its rule** (chosen, not measured). Start from the current effective parallelism. Go down one when `freeMB` is below twice `minFreeMB`, or when `load1` is above `cpus`. Go up one when `freeMB` is above four times `minFreeMB` and `load1`, where present, is below half of `cpus`. Otherwise keep it.
- **When the PM starts it.** At each stage start, and when a threshold crossing reaches the PM. Never on a loop.
- **How a crossing reaches the PM.** Through what factory already returns, with no hook wake: `start`'s `held` list, and a `stopped` entry in `finish`'s output whose `why` starts `held by admission:` (Decision 6). `finish` sets `why` to the stop text's first non-empty line (`bin/factory.ts:1250-1253`).
- **What the PM does with it.** The PM decides. It writes `D/resources/parallelism.json` with Write and logs a decision line. The truss dir is exempt from the main-thread edit gate (`hooks/register.ts:975`, ADR-0014 Decision 2), so the Write goes through. Then it re-runs `start`, or resumes a held crew with `start --slug <s> --resume answers`.

The monitor-wiring crew writes the agent and the `skills/run/SKILL.md` step. The run skill names `truss:resource-monitor`, `parallelism` and `held`.

## Decision 6: the stage chain, `workflows/stage.js`

The four open items from the plan are decided here.

### Admit before each member: through the runner

- Before every spawn of a role other than `runner`, `stage.js` runs `admit --slug <slug>` as its own runner call, through `runFactory` (`workflows/stage.js:148-166`) with key `admitted`. That covers testers, builders, writers, resolvers, fix members, a checkpoint's successor, the planner, rca, stress and QC. It is a pre-step in `ask` (`:120-122`), which every non-runner spawn goes through except QC's. The QC spawn calls `spawn` directly (`:691`), so it gets the same pre-step there.
- It is not the member's first step. A member that starts and then finds the host short has already loaded its context and spent tokens.
- **Held.** `stage.js` throws `Stop('BLOCKED', 'held by admission: <why>', at)`, with `at` the task's name or the crew's step. It doesn't retry: `admit` returns at once, and a script has no wait between runner calls, so a retry would see the same memory. The stop reaches the PM through `finish`, and the PM resumes the crew (Decision 5).
- A runner result that isn't JSON admits, the same fail-open rule as a sampler error.

### Checks through heavy: runner-run commands only

(b) is decided. Only runner-run commands are queued through `factory heavy`: the red and green `check` runs. A member's own builds and tests aren't queued. They are covered by admission at member start and by the effective parallelism. Nobody probes `factory heavy` from a worktree member. The members' unqueued heavy commands go to the plugin fix goal as a proven gap (checker-24 (b)). [ADR-0017](0017-member-heavy-commands.md) decides it: a member-side heavy path, not yet built.

- `check` (`workflows/stage.js:178`) becomes one runner call of this command:

  ```
  node <plugin>/bin/factory.ts heavy --dir D --repo R --slug S --label <slug>-check --cwd W -- node <plugin>/bin/factory.ts check --dir D --repo R --slug S --cwd W --expect red|green
  ```

  `runFactory` appends `--dir` and `--repo` after the whole command (`:149`), which would put them after the `--`. So `stage.js` builds this line with its own helper and passes both flags on each side.
- Its runner prompt adds: run it with a Bash timeout of 600000.
- `heavy` passes `check`'s JSON through (Decision 3), so `met` stays `parsed.ok === true`, and `envOf` and `knownOf` (`:169-176`) work as before.
- **Queue timeout.** A result with `heavy.ran === false` is a stop, `Stop('BLOCKED', 'heavy slot busy: <why>', step)`. It is never a red or a failing green, so it never gets a fix builder.

### Reap: its own runner call

- After each non-runner spawn ends, whatever its marker, `stage.js` runs `reap --slug <slug> --label <slug>-check` as its own runner call, with key `reaped` read as an array. It sits in the same two places as the admit pre-step: after the spawn in `ask`, and after the QC spawn. It also runs it once when the crew's chain ends, in `runCrew` (`:766-773`).
- It is not inside `integrate`. `integrate` runs only for a DONE member (`runTask`, `:313-320`), and the stopped and failed members are the ones most likely to leave a check group behind.
- What it catches: a check whose runner shell hit its timeout and killed `heavy`, leaving the detached check group alive. `reap` kills it before the next member works.
- What it doesn't catch: a member's own processes. They aren't recorded, because members' commands aren't queued (the gap above).
- A failed reap call is logged in the crew's proofs and doesn't stop the crew.

### Parsers that must change

`tests/factory-retro.check.ts` (`:336`), `tests/harness-banner.check.ts` (`:47-48`), `tests/workflows.check.ts` (`:74`) and `tests/stage-briefs.check.ts` (`:56`) accept only `check`, `integrate`, `owns-check`, `tests-check` and `sync` runner prompts (plan C5). stage-resources owns all four as tester files, and its testers add `admit`, `heavy` and `reap`. The regex they share, `/factory\.ts\s+(check|integrate|owns-check|tests-check|sync)\b([^\n`]*)/`, isn't anchored, so on a heavy line it matches the inner `factory.ts check` and reads that line as a plain check. The testers must match `heavy` first, or the parsers won't see that a check went through the queue.

### Stale lock and recovery

These are decided in Decision 3: a dead owner pid, or no owner file and an mtime older than 10 s.

## Out of scope

- Raising parallelism above `maxParallelCrews`. That needs the client.
- A detached UI server, or a `--detached` flag.
- The foreman path (`agents/foreman.md`) is out of scope, and this ADR says so. Foreman crews get `start`'s admission (Decision 2) and nothing else.
- macOS proof.
- Queuing members' own heavy commands. This goes to the plugin fix goal as a proven gap, decided in [ADR-0017](0017-member-heavy-commands.md).
- Carrying `resources/` under `plugins/truss` (C6, for the plugin-move goal).

## Seams to pin

Each contract reads its producer from `$TRUSS_CONTRACT_ROOT/<repo path>`, with the repo root as the default. With no producer, it prints `producer missing: <label>`, whether the variable is unset or set to the repo root.

| Seam | Producer | Consumer | Contract | Missing line |
|---|---|---|---|---|
| `sample`, `minFreeMB`, `admits` | resources-core, `resources/index.ts` | factory-resources | `tests/resources-contract.check.ts` (R) | `producer missing: resources` |
| `factory admit` | factory-resources, `bin/factory.ts` | stage-resources, PM | `tests/factory-resources-contract.check.ts` (F) | `producer missing: factory admit` |
| `factory heavy` | factory-resources | stage-resources | F | `producer missing: factory heavy` |
| `factory reap` | factory-resources | stage-resources | F | `producer missing: factory reap` |
| `start`'s `held` | factory-resources | PM | F | `producer missing: factory start held` |
| `D/resources/parallelism.json` | the PM | factory-resources | F | `producer missing: factory parallelism` |
| admit, heavy and reap calls | stage-resources, `workflows/stage.js` | factory | `tests/stage-resources-contract.check.ts` (S) | `producer missing: stage.js resources` |
| the monitor agent | monitor-wiring, `agents/resource-monitor.md` | PM | `tests/monitor-contract.check.ts` (M) | `producer missing: agents/resource-monitor.md` |
| the PM's monitor step | monitor-wiring, `skills/run/SKILL.md` | PM | M | `producer missing: skills/run resources` |

### 1. R, `tests/resources-contract.check.ts`

- `sample()` with `TRUSS_SAMPLE` unset returns `totalMB` within 1 of `Math.round(os.totalmem() / 2 ** 20)`, and `0 < freeMB <= totalMB`.
- `sample()` with `TRUSS_SAMPLE` set to a file returns that file's sample, and with `error` it throws.
- `case: holds below the threshold`: `admits` is false when `freeMB` is below the threshold and true at or above it.
- `case: TRUSS_MIN_FREE_MB sets the threshold`: `minFreeMB({ TRUSS_MIN_FREE_MB: '5000' })` is 5000, and unset gives `DEFAULT_MIN_FREE_MB`.

### 2. F, `tests/factory-resources-contract.check.ts`

It runs the real CLI in a temp truss dir with `TRUSS_SAMPLE` and `TRUSS_MIN_FREE_MB` set.

- `admit` holds below the threshold and admits above it; exit 1 and 0; `admitted` and `parallelism` printed.
- `TRUSS_SAMPLE=error` admits and appends a `sampler-error` line.
- `parallelism.json`: a good value is used; each bad value means `maxParallelCrews`.
- `heavy` serializes runs, keeps its records under `D/resources/`, and passes a JSON stdout through with `heavy` added.
- `reap` kills a recorded orphan group and leaves an unrelated process.
- `start` lists a held crew under `held` and leaves it `planned`, with no worktree.

### 3. `sampler-error` in `docs/events.schema.json`

The event enum gains `sampler-error`. Its `if`/`then` branch requires `command` (`admit`, `heavy` or `start`) and `error` (a string of 1 to 200 characters), and allows no other extra field, as the `incomplete` branch does (`docs/events.schema.json:41-51`). `v` stays 1: a new event kind isn't a renamed or retyped field.

### 4. S, `tests/stage-resources-contract.check.ts`

It runs the real `stage.js` under a fake `agent`, as `tests/factory-retro.check.ts` does.

- `case: check runs through factory heavy`: every red and green check prompt is a `factory.ts heavy ... -- node ... factory.ts check` command. Naming `heavy` only in a comment fails.
- `case: admit before each member`: every non-runner spawn follows an `admit --slug <slug>` runner call made after the previous non-runner spawn.
- `case: reap after each member`: every non-runner spawn is followed by a `reap --slug <slug> --label <slug>-check` runner call before the crew's next non-runner spawn or its result.

### 5. M, `tests/monitor-contract.check.ts`

- `case: tools line`: the agent's frontmatter has one line matching `^tools: *[A-Z][A-Za-z]*(, *[A-Z][A-Za-z]*)*$`, with no Write, Edit, MultiEdit or NotebookEdit.
- The agent has `model: haiku`.
- `skills/run/SKILL.md` names `truss:resource-monitor`, `parallelism` and `held`.

### 6. Negative controls

Six stub trees live under `tests/fixtures/resources/<dir>/`, each mirroring the repo paths. The acceptance test copies each tree into a fresh `mktemp -d`, runs its contract there with `TRUSS_CONTRACT_ROOT` pointed at the copy and `--test-reporter=tap`, and removes the copy.

| Stub dir | Producer stubbed | Contract | Test that must fail |
|---|---|---|---|
| `admit-constant` | `resources/index.ts`, always admits | R | `case: holds below the threshold` |
| `min-free-ignored` | `resources/index.ts`, fixed threshold | R | `case: TRUSS_MIN_FREE_MB sets the threshold` |
| `heavy-comment` | `workflows/stage.js`, names heavy only in a comment | S | `case: check runs through factory heavy` |
| `no-admit` | `workflows/stage.js`, spawns members with no admit | S | `case: admit before each member` |
| `no-reap` | `workflows/stage.js`, never reaps | S | `case: reap after each member` |
| `no-tools` | `agents/resource-monitor.md` with no tools line, plus `skills/run/SKILL.md` | M | `case: tools line` |

Each stage.js stub fails its own case and passes the other two, which it implements correctly.

## Staging

- Stage 1: resources-core, monitor-wiring and ui-readme. They need only these contracts.
- Stage 2: factory-resources, because `bin/factory.ts` imports `resources/index.ts`.
- Stage 3: stage-resources. factory runs `stage.js` from its own checkout (`PLUGIN`, `bin/factory.ts:45`), so a `stage.js` that called `admit` or `reap` before factory had them would fail every runner call.

Proof covers Linux only. Windows proof comes from the horoscope session, and macOS stays an open gap.

## Probes behind this ADR

Run on this host (Linux, Node v24.22.0) from the session scratchpad. Nothing in the repo changed.

- Memory: `{"node":"v24.22.0","totalMB":15845,"freememMB":7827,"memAvailableMB":7827,"memFreeMB":2550,"loadavg":[0.33,0.26,0.3],"availableParallelism":4}`. `os.freemem()` matches `MemAvailable`, not `MemFree`.
- Process groups: a detached `bash` leader left an orphan `sleep` in its group and exited. The group stayed alive. `process.kill(-leader, 'SIGTERM')` killed the orphan (`orphanAliveAfter:false`, `groupAliveAfter:false`), and an unrelated `sleep` in another group survived (`unrelatedAliveAfter:true`).
- `spawnSync` with `detached: true` gave the child a new pgid (`ownPgid 129968`, child `129976`; without it, `129968`). It still can't serve `heavy`, because it returns the pid only after the child ends.
- Worktree grouping from `/proc`: under `.claude/worktrees`, the probe read 109 of this user's processes and skipped 173 it couldn't read, and gave `{"wf_444a07ed-787-3":{"procs":2,"rssMB":57}}`.

## Documents this ADR amends

- `docs/architecture.md`: an intro paragraph, a "Resource-aware sizing (ADR-0015, proposed)" subsection in the Workflow path, three on-disk entries, the `sampler-error` event, and a failing-open note.
- [ADR-0009](0009-workflow-factory.md): a pointer in Decision 1 and in Seams to pin. Its decisions don't change; this ADR adds commands to its command set.
- `docs/events.schema.json`: the `sampler-error` kind (Seams, section 3).

## Consequences

- No crew start, member start or check run goes ahead while free memory is below the threshold, unless the sampler fails. Then it goes ahead and the event log says so.
- Checks across every crew of the session run one at a time. A stage with several crews at green takes longer, by the sum of their check times at worst.
- A member held by admission stops its crew as BLOCKED. The PM has to resume it, so a low-memory host costs PM turns, not crashed sessions.
- Members' own builds and tests still run unqueued. On a host like the horoscope one, admission and a lower parallelism are the only guard against them.
- Each member spawn costs two more runner calls, one `admit` and one `reap`.
- A live `truss:resource-monitor` call, and every macOS and Windows path, stay unproven.
