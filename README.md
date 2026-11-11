# truss repo

This repo is the home of the truss Claude Code plugin and its optional local web UI. This page is for contributors. To use truss, read the plugin manual, [plugins/truss/README.md](plugins/truss/README.md).

## Install the plugin

```
claude plugin marketplace add AbhiramDwivedi/claude-ops
claude plugin marketplace add AbhiramDwivedi/truss
claude plugin install truss@truss
```

Add the claude-ops marketplace first. truss depends on three claude-ops plugins, kit `^0.4.0`, worktrees `>=0.8.4 <0.11.0` and subagent-limits `^0.3.2` (`plugins/truss/.claude-plugin/plugin.json`), and `claude plugin install truss@truss` installs them with it. The truss catalog allows those dependencies with `allowCrossMarketplaceDependenciesOn: ["claude-ops"]`.

Without the claude-ops marketplace, truss fails to load. To fix it, run `claude plugin marketplace add AbhiramDwivedi/claude-ops`, then reinstall truss with `claude plugin install truss@truss`. See [ADR-0021](plugins/truss/docs/adr/0021-plugin-dependencies.md).

The install fetches `plugins/truss/` from the `main` branch and nothing else, so a plugin-only install gets no `ui/`. The local web UI comes only from a clone: see [ui/README.md](ui/README.md).

## Clone the repo

```
git clone -b main https://github.com/AbhiramDwivedi/truss.git
```

Clone with `-b main`. ADR-0013 puts the catalog on its own `marketplace` branch and makes that branch the GitHub default branch, so a bare `git clone` lands on the catalog, not on the code.

## Repo layout

| Path | What it is |
|---|---|
| `plugins/truss/` | The plugin: agents, skills, hooks, workflows, `bin/`, `tests/`, `docs/` (the architecture doc and ADRs), its [README](plugins/truss/README.md) (the full manual) and [CHANGELOG](plugins/truss/CHANGELOG.md). `.claude-plugin/plugin.json` holds the version. |
| `ui/` | The optional local web UI, with its own `package.json`. The plugin never installs or starts it. See [ui/README.md](ui/README.md). |
| `marketplace/` | The catalog source: `.claude-plugin/marketplace.json` and `README.md`, the GitHub landing page. The maintainer publishes this directory as the `marketplace` branch with `git subtree split --prefix=marketplace main`. |
| `checks/` | The root contract, [checks/repo-home.check.ts](checks/repo-home.check.ts): layout, catalog, install and docs checks. |
| `package.json` | Test scripts only, with no dependencies. |
| `LICENSE` | MIT. `plugins/truss/LICENSE` is a copy. |

The catalog has one entry, `truss`, with a `git-subdir` source: url `https://github.com/AbhiramDwivedi/truss.git`, path `plugins/truss`, ref `main` ([marketplace.json](marketplace/.claude-plugin/marketplace.json)). The design is in [ADR-0013](plugins/truss/docs/adr/0013-plugin-layout.md), and the "Repo layout" section of [the architecture doc](plugins/truss/docs/architecture.md).

## Run the tests

Run these from the repo root.

```
npm test
```

This runs the plugin's Node tests (`plugins/truss/tests/*.check.ts` and `plugins/truss/tests/*/*.check.ts`), then the root contract (`checks/*.check.ts`). The contract's install suite runs the two install commands against a local copy of the repo served over HTTP, so it needs `claude` and `git` on your `PATH`.

```
npm run test:ui
```

This runs `npm --prefix ui test`, the UI's unit and contract tests. Install the UI's dependencies first with `npm --prefix ui ci`. [ui/README.md](ui/README.md) covers the browser tests and the live check.

## Load the plugin from your clone

Point Claude Code at the plugin directory, not the repo root:

```
claude --plugin-dir <repo>/plugins/truss
```

A `--plugin-dir` load doesn't install truss's dependencies, so load kit, worktrees and subagent-limits too: install them from the claude-ops marketplace, or pass each one's directory with its own `--plugin-dir` (ADR-0021). PM gate 1 records whether truss loads alone by `--plugin-dir`. TODO: confirm what truss does when it is loaded by `--plugin-dir` without the three; no run on this branch has checked it.

Since 0.15.0 the repo root has no `.claude-plugin/`. A session started with `--plugin-dir <repo>` before the move restarts on `--plugin-dir <repo>/plugins/truss`.

## Open a pull request

Open pull requests against `main`, for example `gh pr create --base main`. Under ADR-0013 the GitHub default branch is the catalog branch, not `main`, so a pull request without `--base main` targets the wrong branch.

After a change to `marketplace/`, the maintainer re-publishes the `marketplace` branch from `main:marketplace/` (ADR-0013, "Ship steps").
