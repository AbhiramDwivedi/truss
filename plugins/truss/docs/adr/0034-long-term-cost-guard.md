# ADR-0034: hold a plan or a crew merge until the client approves each long-term cost

Status: accepted, 2026-11-10
Decided by: PM and product owner (review of contract-025 revision 2)

## Context

truss 0.25.0 wave 2 lets a run go on without the client watching. R-57 says nothing that costs the client later merges without the client. Some changes leave a cost behind after the run ends: a public interface or stored data shape that is costly to change, a new runtime dependency, a recurring money or operations cost. A crew that adds one can pass QC, because QC judges whether the work is right, not whether the client wants to carry it.

Two gaps in the obvious fix shaped this decision.

- **Not every crew has a QC.** Solo crews, `qc:false` crews and foreman crews can merge without a QC report, so a check that lives only in QC lets them through (finding #22).
- **A rejection must not outlive its plan.** If the client rejects a cost and the designer re-plans without it, the old rejection must stop blocking (finding #9).

The design is contract-025 revision 2, section 3, "Long-term cost guard". The code is crew a2-ltc-guard's `bin/guard.ts`; crew a0-foundation wired its call sites in `bin/factory.ts` and the workflow scripts. The cases in `tests/ltc-guard.check.ts` and `tests/ltc-paragraph.check.ts` pin the behaviour below. The inbox the guard escalates to is ADR-0037.

## Decision Drivers

- Nothing that costs the client later merges without the client (R-57).
- Every crew passes the guard, whatever its process: solo, `qc:false` and foreman crews included (finding #22).
- A re-plan clears an old rejection (finding #9).
- The guard fails closed: when it can't tell what a crew changed, the merge is refused.
- A long-term cost is never a QC FAIL. The work can be right and still need the client's yes.
- The client can tell whether the guard is worth its interruptions.

## Considered Options

| Option | Kept or rejected |
|---|---|
| Agents flag costs in their reports, as `LONG-TERM-COST` lines | Kept. Only an agent can judge "a decision an ADR would record". |
| Flag costs only from the QC report | Rejected: crews with no QC would merge unchecked (finding #22). |
| Deterministic triggers over the crew's diff, next to the agent lines | Kept. They need no agent, so they hold for every crew. |
| A plan item ref without the plan revision | Rejected: a rejected cost would block every later plan (finding #9). |
| A plan item ref that carries `sha12` of the designer's result | Kept. A re-plan gets new refs, so an old rejection stops counting. |
| Treat a long-term cost as a QC FAIL | Rejected: the paragraph says "A LONG-TERM-COST line is never a FAIL; the merge waits for the client." |

Contract-025 section 11 rejects none of the 37 review findings outright, and lists no rejected alternative specific to the guard.

## Decision

### The paragraph and the line format

We will give the same paragraph, word for word, to every agent that judges a plan or a crew's work:

> Long-term cost: when the change adds a cost the client carries after this run (a public interface or stored data shape that is costly to change, a new runtime dependency or service, a recurring money or operations cost, or a decision an ADR would record), write one line `LONG-TERM-COST: <what> | later: <the cost> | reversal: cheap|costly|irreversible`. Don't write one for code style, for "more code to maintain", or for a cost the approved scope already names. A LONG-TERM-COST line is never a FAIL; the merge waits for the client.

It lives in five places: the `LONG_TERM_COST` constants of `workflows/stage.js` (the QC prompt) and `workflows/plan.js` (the checker prompt), and `agents/design-engineer.md`, `agents/checking-engineer.md` and `agents/qc-engineer.md`. `tests/ltc-paragraph.check.ts` fails when any copy differs by a byte.

`ltcLines(text)` (`bin/guard.ts:20-38`) reads the lines that match `^\s*(?:-\s*)?LONG-TERM-COST:` (`bin/guard.ts:15`). It splits each on `|`: the first field is `what`, and the fields starting `later:` and `reversal:` fill the rest. A line with no valid reversal (not `cheap`, `costly` or `irreversible`) counts as `costly` (`bin/guard.ts:34`), so a sloppy line blocks rather than slips through. A line with an empty `what` is kept, with `what` set to `(unnamed cost)`: dropping it would let a costly or irreversible cost merge unseen.

`stage.js` `qc()` copies a passing QC's lines into its result as `longTermCosts` (`workflows/stage.js:2003`).

### The deterministic triggers

`ltcTriggers(repo, base, head)` (`bin/guard.ts:53-78`) runs `git diff --name-status base head` and returns a `costly` item for each of these:

- a dependency added to a `package.json`, in `dependencies`, `devDependencies`, `peerDependencies` or `optionalDependencies`. It compares the package names at `base` and `head`, normalised with `packageName` from `bin/store.ts` (`bin/guard.ts:40-50`, `65-69`). A `package.json` added outright counts every dependency it declares;
- a file added under a `migrations/` directory at any depth;
- a new `*.sql` file;
- a new `*.schema.json` file;
- a new `schema.*` file.

A new file counts once, under the first rule it matches, in the order above (`bin/guard.ts:72-75`). Only added files trigger, except `package.json`, which also triggers when modified. A failed `git diff` returns no triggers (`bin/guard.ts:55`); the merge step guards against that by refusing when it can't resolve `base` or `head` (below).

The contract named `declares()` for the dependency rule. The code reads the four dependency lists directly instead, because `declares()` (`bin/store.ts:101-115`) answers "does the nearest `package.json` declare this name", not "which names did this diff add". The effect is the same for `package.json`. Other ecosystems' manifests (`requirements.txt`, `go.mod`, `Cargo.toml` and the like) are not triggers in this version.

### The plan gate

`factory plan-write` collects the results of every `truss-designer*` and `truss-checker*` agent in the plan run and calls `ltcPlan` before it writes `plan.json`, so a guard that throws leaves no plan for `approve` to pass (`bin/factory.ts:454-462`). The revision `rev` is `sha12` of the designer's result text (`bin/factory.ts:428`, `462`). plan-write adds `longTermCosts: ids` to its output (`bin/factory.ts:467`).

`ltcPlan(repo, dir, texts, rev)` (`bin/guard.ts:118-136`):

1. Logs each `cheap` line once, as a line in `D/decisions.md` (`bin/guard.ts:124-128`). It writes the line itself (`bin/guard.ts:109-115`), because `appendDecisionLine` lives in `factory.ts` and no new module imports `factory.ts` (ADR-0037).
2. Escalates each `costly` and `irreversible` line as a blocking `long-term-cost` inbox item, with ref `ltc:<sid>:plan:<rev>:<sha12(what)>` (`bin/guard.ts:130`).
3. Writes `D/ltc-plan.json` as `{rev, ids}` (`bin/guard.ts:134`).

`ltcPlanGate(repo, dir)` (`bin/guard.ts:139-153`) returns the ids in `D/ltc-plan.json` whose item is open, rejected, or not in the inbox at all. `factory approve` refuses with `{error: "long-term cost awaiting the client", ids}` while it returns any id (`bin/factory.ts:675-676`). That check runs for both approvers, `--by client` and `--by auto`.

Because `rev` changes when the designer's result changes, a re-plan escalates under new refs and overwrites `D/ltc-plan.json`. The old, rejected ids are no longer in the file, so they no longer block (finding #9; case "a re-plan clears a rejection").

### The crew gate

`mergeCrew` runs the crew gate in step 1, for every crew it merges, through both `factory land` (`bin/factory.ts:3105`) and `factory finish` (`bin/factory.ts:3208`), at `bin/factory.ts:2965-2972`. It passes:

- `qcText`: the newest QC report of the crew since the run started, or `null` when there is none;
- `base`: `git merge-base refs/heads/<target> refs/heads/truss-<slug>`;
- `head`: `git rev-parse --verify refs/heads/truss-<slug>`.

When either git call fails or prints nothing, the merge is refused with `long-term cost gate: git … failed` (`bin/factory.ts:2967-2970`), rather than handing the gate an empty range and no triggers.

`ltcCrewGate(repo, dir, slug, {qcText, base, head})` (`bin/guard.ts:156-166`) takes the QC's `costly` and `irreversible` lines plus every trigger, and escalates each as a blocking item linked to the crew, with ref `ltc:<sid>:<slug>:<sha12(what)>`. It returns `{refused: "long-term-cost: E-…, E-…"}` until every one of those items is resolved `approve`, and `{}` after that. The merge step returns the refusal as the crew's outcome (`bin/factory.ts:2972`). A `cheap` QC line is dropped here: it neither blocks nor logs (case "a cheap QC line does not block").

### Reuse of an existing item

Both gates find their item through one helper, `raise` (`bin/guard.ts:100-107`), which looks for `long-term-cost` items with the same ref:

1. An approved item wins: the gate reuses its id and passes.
2. A rejected item is reused: the gate keeps refusing.
3. Otherwise it calls `escalate`. When an open item with the same ref exists, the inbox dedupes to it (ADR-0037), so a repeat gate call opens no second item (case "a repeat gate call opens no second inbox item").

A crew whose cost was rejected stays refused for as long as the same `what` comes back. It clears when the cost leaves the diff or the QC report, because the `what`, and so the ref, changes. For a trigger the `what` names the path or the dependency (`bin/guard.ts:68-75`).

### The flood check

The retro reports the approve rate of `long-term-cost` items. Above 90% over 10 or more items, it proposes tightening the paragraph: a guard the client nearly always waves through costs interruptions and buys nothing. The retro is prose only (contract-025 section 10), so this check belongs in the text of `skills/retro/SKILL.md`, which crew d2-product-prose owns, not in code. At the commit this ADR describes, the retro skill doesn't carry it yet.

## Consequences

**Long-term costs.**

- **The guard can stop autonomy.** The triggers escalate every new dependency, migration and schema file, and each one holds the crew until the client answers. That is the client's rule, and it is costly (contract-025 section 9, risk 4). The flood check is the only measure of whether it pays.
- **Item refs are part of the inbox history.** `ltc:<sid>:plan:<rev>:<sha12>` and `ltc:<sid>:<slug>:<sha12>` sit in the append-only `S/inbox.jsonl`. Changing their shape means every old row still carries the old one.
- **The paragraph has five copies.** A wording change means editing all five in one change; the byte-equality test enforces it.

**What the code does that the contract doesn't say.**

- A plan id with no matching inbox item counts as blocking (fail closed). An unreadable `D/ltc-plan.json` counts as no ids (`bin/guard.ts:142-148`); `writeJsonAtomic` makes a torn file unlikely, but a hand-edited one opens the plan gate.
- The two gates read a `dismiss` decision differently. `ltcPlanGate` passes an item that is resolved `dismiss`, `answer` or `done`, because it blocks only on open or rejected items. `ltcCrewGate` passes only `approve`, and `raise` escalates a fresh item for a ref whose only item was dismissed.
- The diff runs with `--no-renames`, so a rename is read as a delete plus an add and triggers like any added file. A `package.json` moved to a new path counts every dependency in it as added, because the new path has no earlier copy.

**Risks.**

- **Agent judgment varies.** Whether a change is "a decision an ADR would record" is the agent's call, and the paragraph tells it not to flag costs the approved scope already names. A cost no agent flags and no trigger matches merges.
- **The triggers cover npm only.** A dependency added to any other manifest needs an agent's line to be caught.
