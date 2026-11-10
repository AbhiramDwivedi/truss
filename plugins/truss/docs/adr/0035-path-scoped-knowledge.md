# ADR-0035: path-scoped knowledge, lazy-loaded and linted

Status: accepted, 2026-11-09
Decided by: PM ruling on the 0.24.0 context goal (adopt the ideas of Capital One Context Specs, not the tool; use Claude Code's own lazy-loading files)
Amends: ADR-0033 (where the knowledge step writes, what it must cite, how QC checks it, and the home of crew product calls)

## Context

ADR-0033 made each crew record what it learned and made product calls at crew level. Three problems showed up in how it stored them:

- **Product calls were appended to an always-loaded file.** `productOwnerFile()` in `workflows/stage.js` returned the product-owner persona file (`.claude/agents/product-owner.md`). A persona file is loaded into every agent's system prompt, so each crew product call made every later agent's prompt longer, for every turn, whether or not the agent had any product question. This is a bug in 0.23.0, not a design choice.
- **Persona Standards were the only home for stack rules.** A rule that holds for one area of the code (the export UI, the billing module) had nowhere to live except a persona, which every agent of that persona loads wherever it works.
- **Nothing checked the knowledge step.** A rule could name a path that no longer exists, a doc could go stale after its sources changed, and a doc nobody linked was as hidden as code. QC saw a diff and a feature map, and caught none of this.

We looked at Capital One Context Specs. We did not adopt it: it is a competing harness (v0.2, no schema, no Windows support), and truss would have to bend its crews around a second tool. We took three of its ideas: eager and lazy context are different things; reconcile instead of accumulate; and "nothing to learn" is a normal outcome.

## Decision Drivers

- Load only what the files being edited need. Always-loaded files stay small and are budgeted.
- Use what Claude Code already does: `.claude/rules/*.md` with a `paths` frontmatter key loads when a matching file is read, and `CLAUDE.md` imports other files with `@`.
- Every claim in a knowledge file is checkable by a deterministic script, with no model in the loop.
- Works on Linux, macOS and Windows: git-based checks, `/`-separated paths, tolerance for CRLF, no shell-specific globbing.
- Keep ADR-0033's authority split and mechanics. This changes where things go, not who decides.

## Considered Options

| Option | Kept? | Why |
| --- | --- | --- |
| Adopt Capital One Context Specs as the knowledge layer | Rejected | A second harness at v0.2 with no schema and no Windows support. Its ideas are cheap to borrow; its tool is not. |
| Keep everything in persona files and `product-owner.md` (0.23.0) | Rejected | Always-loaded, so every product call and area rule costs every agent every turn. |
| Put all knowledge in `CLAUDE.md` | Rejected | Also always-loaded, and it is the client's file. |
| `.claude/rules/<area>.md` for area rules, `docs/knowledge/` for lazy docs, a pointer index in `AGENTS.md` | Kept | Rules load by path, docs on demand, and the index is small and fixed. |
| Lint the knowledge files with a script | Kept | Dead globs, missing sources, stale `verified` shas and orphan files are all decidable from git. |
| Ask QC (a model) to judge staleness | Rejected | Slow, and the answer varies between runs. QC still judges what a script cannot. |

## Decision

### A. Layout (every path configurable in `.claude/truss.json`)

| Path | Holds | Loaded |
| --- | --- | --- |
| `AGENTS.md` (`agentsIndex`) | An index: pointers only, 60 lines or fewer. `CLAUDE.md` imports it with `@AGENTS.md`. Init proposes this and never rewords existing text. | Always |
| `docs/features.md` (`featureMap`) | The feature map, unchanged. | On demand |
| `docs/knowledge/product-decisions.md` (`productDecisions`) | Crew product calls. | On demand |
| `docs/knowledge/<topic>.md` (`knowledgeDir`) | One topic per file. Frontmatter `sources: [paths]`, `verified: <sha>`. | On demand |
| `.claude/rules/<area>.md` (`rulesDir`) | Invariants, gotchas and where-X-lives for an area. Frontmatter `paths: [globs]` (native Claude Code), `sources`, `verified`. Lowercase ASCII kebab-case names. | When a matching file is read |
| `.claude/agents/<persona>.md` | Standards only. The product-owner persona keeps its judging rules and one pointer line to the decisions file. | Always, for that persona |

**Budgets** (`knowledgeBudgets` in `.claude/truss.json`, all line counts except `personaStandards`, which counts list items under `## Standards`): `agentsIndex` 60, `persona` 120, `personaStandards` 15, `rule` 40, `featureEntry` 6, `doc` 150. Over budget on an always-loaded file (agentsIndex, persona, personaStandards, rule) is a lint failure; featureEntry and doc are warnings.

### B. The product-calls fix

`productOwnerFile()` in `stage.js` returns the `productDecisions` stage arg (default `docs/knowledge/product-decisions.md`). The `Product call:` brief, the knowledge brief and the QC `Knowledge:` rule ("a crew product call missing") all read that file. `factory knowledge-migrate` moves the entries a 0.23.0 project already has in the persona to the decisions file, leaving one pointer line (`--apply` writes; without it, it prints the proposed moves and writes nothing; it never commits).

### C. Routing, reconcile and the writer's rules

The knowledge writer sends each item by this table:

| Item | Goes to |
| --- | --- |
| Area-scoped stack rule or invariant | `<rulesDir>/<area>.md`, with `paths` globs |
| Cross-cutting persona rule | persona `## Standards` |
| Capability | the feature map |
| Product call | `productDecisions` |
| Decision | an ADR |
| Anything else | nowhere |

And it follows these rules: every written fact cites its source path or hunk, or it is dropped; reconcile before adding (edit or delete a superseded entry, never append a duplicate); set `verified` to the crew head on every doc it edits; stay within the budgets; "nothing to record" is a valid outcome; a new knowledge or rule file is linked from the feature map or the agents index.

### D. The lint (`factory knowledge-lint [--base=<sha>]`)

All checks are deterministic and git-based (`git -c core.quotepath=off ls-files`, paths normalised to `/`): `dead-glob`, `missing-source`, `stale`, `unreachable`, `over-budget` and `persona-calls`. The output is `{ok, failures, warnings}` and the exit code is 0 even when `ok` is false. With `--base`, each finding carries `new: true|false`: false when the same `{check, path}` also fails against the tree at the base, so a crew is not failed for what it inherited.

`stage.js` runs it once before QC (again only if the head moved) through `runFactory` and puts the results in the QC brief. QC fails the crew on `new: true` failures only; a failure that predates the crew and every warning is listed in the crew result (`knowledgeLint`) for the main session. A lint that cannot run is logged and never stops the crew; QC is told "Knowledge lint did not run". It is skipped silently when the crew has no code tasks and the stage args name no knowledge file.

### E. Delivery to the members

`factory start` puts `rules` (`[{path, paths}]`), `productDecisions`, `agentsIndex`, `rulesDir` and `knowledgeDir` into the stage args, each omitted when its file or directory does not exist. A task whose files match a rule's globs gets one line, `Context for your files: <rule paths>. Read each one unless it is already in your context.`, and the planner reads the agents index and the rules index so a task's `reads` includes the matching rules. `stage.js` is a workflow script and cannot import factory code, so it carries its own matcher for the glob dialect (`**`, `*`, `?` and `/`-separated paths; no braces, no negation). That matcher and the factory's must both pass every vector in `tests/fixtures/glob-vectors.json`.

The knowledge commit's owns exemption grows to the rules dir, `<knowledgeDir>/**`, the agents index and the product decisions file, for `.md` files only. A persona's frontmatter is still never exempt.

### F. Cross-platform

Checks read git, not the filesystem tree, so symlinks and case do not change the answer; paths are `/`-separated everywhere; line counts tolerate CRLF; rule file names are lowercase ASCII so case-folding file systems agree; the lint and migrate commands write no file outside the repo.

### G. Left out

- Capital One Context Specs as a dependency or a file format.
- A model-judged staleness check.
- Brace and negation globs. The dialect is what both matchers can implement the same way.
- Rewriting the client's `CLAUDE.md` or an existing `AGENTS.md`. Init proposes; it never rewords.
- Auto-deleting a stale doc. The lint reports; a crew's writer or the client edits.

### H. Unverified

Two things are assumed, not proven, and need an eval before anyone relies on them:

- **Whether path-scoped rules load natively in member worktrees.** The `Context for your files` line is a belt-and-braces instruction that costs one line per task. It stays until an eval shows members get the rule without it; then it goes.
- **Whether Claude Code tolerates the extra frontmatter keys** (`sources`, `verified`) on a rule file. The documented key is `paths`. If a later Claude Code version rejects unknown keys, the lint's `sources` and `verified` checks have to move into a sidecar file or the file body.

## Consequences

**Positive**

- Crew product calls stop growing every agent's system prompt.
- A rule loads only for the files it describes, so an area's gotchas cost nothing elsewhere.
- Dead globs, missing sources, stale docs and unreachable files are caught by a script, and a crew is failed only for what its own diff caused.
- A project can move off 0.23.0 with `knowledge-migrate`, which proposes before it writes.

**Negative**

- More files and more config keys (five new keys in `.claude/truss.json`) for a client to learn.
- The `stale` check is a heuristic: a doc whose sources changed in an unrelated way still needs a new `verified` sha or a failure is reported. Writers will sometimes bump `verified` without re-reading the doc. QC and the budgets only partly cover that.
- Two glob matchers (the factory's and `stage.js`'s) can drift. The shared vector file is the only guard, and it covers the cases someone thought to write.
- The `Context for your files` line is redundant if native loading works, and it costs a runner call per crew for the lint.
- The lint runs for every crew with code tasks, even in a project with no knowledge files, so it still checks the feature map's paths and the persona for product calls.
- The budgets are blunt line counts. A dense 40-line rule can be worse than a sparse 60-line one.

**Neutral**

- The mechanics are in `workflows/stage.js` (`rulesFor`, `taskPrompt`, `knowledgePrompt`, `knowledgeLint`, `productOwnerFile`) and `bin/factory.ts` (`knowledge-lint`, `knowledge-migrate`, `rules-index`), built by separate crews from this prose.

**Reversing it** touches: the knowledge step, product-call and init prose in the run skill, the writer, QC, foreman, planning-engineer and design-engineer prompts and the init skill; the five `truss.json` keys and their schema; the lint and migrate commands; the rule-glob block, the context line and the lint step in `stage.js`; and `tests/knowledge-stage.check.ts`. Rule files and knowledge docs already written stay in the repo as ordinary docs.
