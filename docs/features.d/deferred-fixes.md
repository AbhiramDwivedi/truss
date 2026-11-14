## Run target (plan.json target)

- What: an optional top-level string `target` in `plan.json` names the branch this run's crews land on. It wins over the `target` in `.claude/truss.json` wherever a command knows the run's truss dir: `settings --dir`, `start` (its `truss.target`), `land`, `finish`, `check`, `goal-check`, `knowledge-lint`, `knowledge-config-gate`, `gated-merge` and the crew commands. With no truss dir known, or no `target` in the plan, the config target stands. `plan-check` refuses a `target` that is not a valid git branch name, with an error that names `target`. `settings` prints `source: plan.json` when the plan target and a config merge mode are both set.
- Entry points: `plugins/truss/bin/factory/settings.ts` (`settingsOf`, `settingsFor`, `planTargetOf`, `validBranchName`), `plugins/truss/bin/factory/plan.ts` (`cmdPlanCheck`), `plugins/truss/docs/plan.schema.json`; tests `plugins/truss/tests/deferred-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [ADR-0053](../plugins/truss/docs/adr/0053-run-target.md); `plugins/truss/skills/run/SKILL.md`.

## Session scripts dir default

- What: `plan-args` and `start` copy `plan.js` or `stage.js` to `<dir of the session transcript>/<session id>/workflows/scripts/truss-<script>` and print that as `scriptPath`, so the Workflow tool accepts it; the session id is the path segment under `<git common dir>/truss/` of the truss dir. `--scripts-dir` overrides and its failure stays an error; with no session found, `scriptPath` stays the plugin's own file. Since 0.32.0, when the session folder refuses the copy (the macOS sandbox gives EPERM, a regular file in the way gives ENOTDIR), the copy goes to `<truss dir>/scripts/truss-<script>`, then to `<os.tmpdir()>/truss-scripts/truss-<script>`, and only then does `scriptPath` fall back to the plugin's own file.
- Entry points: `plugins/truss/bin/factory/roles.ts` (`sessionScriptsDir`, `scriptPathFor`, `scriptPathAuto`), `plugins/truss/bin/factory/plan.ts` (`cmdPlanArgs`), `plugins/truss/bin/factory/start.ts` (`cmdStart`), `plugins/truss/tests/lifecycle-029.check.ts`, `plugins/truss/tests/deferred-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: `plugins/truss/skills/run/SKILL.md` sections 4 and 6; [architecture](../plugins/truss/docs/architecture.md) ("Workflow calls (ADR-0009)").

## Newer-than-session warnings measure the named session

- What: the warnings `start` prints, that an agent file changed after the session loaded its agents, measure from the session that `--transcript` names, not from the process that ran the command. The session start is the first timestamp in the session's main transcript, `<transcripts root>/<project>/<session id>.jsonl`, found from the run dir `<transcripts root>/<project>/<session id>/workflows/<run id>`. Without `--transcript`, or when that file cannot be read, the `CLAUDE_PID` process start stands, and `TRUSS_SESSION_START` still wins over both. A transcript start can only be too early, so a `--continue` session may get one warning too many (git and the warned-hash record drop an unchanged or repeated one), but a real change is never hidden.
- Entry points: `plugins/truss/bin/factory/warnings.ts` (`transcriptSessionStart`, `useTranscriptStart`, `sessionStartOnce`), `plugins/truss/bin/factory/start.ts` (`cmdStart`); tests `plugins/truss/tests/warnings-session-032.check.ts`.
- Owner: `truss-plugin-node`.
- Docs: [architecture](../plugins/truss/docs/architecture.md) ("Deferred fixes (0.32.0)").
