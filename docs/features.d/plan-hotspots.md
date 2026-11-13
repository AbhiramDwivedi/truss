## Owns extension

- What: `factory owns-extend --slug S --glob G --reason R` adds the glob to the crew's `owns` in `plan.json` under the `plan` lock (once; a glob already there is not added twice), whatever other crews own, and appends a decision line; it replaces hand-editing owns. Crews may share files ([ADR-0043](../plugins/truss/docs/adr/0043-crews-share-files.md)): `plan-check` has no rule-file ownership rule and never refuses on shared owns, but it warns (never refuses) when an exact `owns` path is owned by more than half of a goal's crews in a goal of 3 or more crews, and it always returns a `warnings` array (empty when none); `owns-check` still refuses a crew diff outside the crew's own `owns`, except `.md` doc paths any non-merge crew commit changed (ADR-0046 item 0: the crew owns the docs of its change). A bare-directory entry (`dir/`) means `dir/**` in `owns-check` (nested and dot files match, a sibling prefix `dir2/` does not, `\` separators are normalised); `plan-check` stays ok and warns on each such entry. `plan-write` takes the report's fenced `plan.md` block when the `planMd` field is a stub (shorter than the block and with no table); a full field still wins. `check --expect green` first runs `npm ci` (`installMissingDeps`, through one `npm ci` shell string on win32) in each directory with a tracked `package-lock.json` and no `node_modules` (a linked one counts as present); a failed install goes into the check text. Plan version 3 needs `goals` rows when a crew carries `goal`. Every `plan.json` writer (`patchPlan`, `owns-extend`, `plan-write`) takes the `plan` lock; `savePlan` writes atomically.
- Entry points: `plugins/truss/bin/factory/crew.ts` (`cmdOwnsExtend`, `cmdOwnsCheck`, `cmdPlanCheck`), `plugins/truss/agents/design-engineer.md` (crews rule 4), `plugins/truss/tests/gates-026.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Owns and trailers").

## Next goals after a run

- What: after the retro, the program manager proposes the next goals from the retro's findings. Each proposal cites the finding it answers as evidence and gives a cost estimate from the plan's own numbers, and the client sees them in the report. The PM starts none of them without the client's yes.
- Entry points: `plugins/truss/skills/run/SKILL.md` (section 10, "Next goals"), `plugins/truss/tests/hotspots-032.check.ts`.
- Owner: `truss-prompts`.
- Docs: [run skill](../plugins/truss/skills/run/SKILL.md).
