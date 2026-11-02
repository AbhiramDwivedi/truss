# truss

truss is a Claude Code plugin that runs a large coding goal as several crews of agents working in parallel, each in its own git worktree, with an independent QC engineer that must pass each crew's work before it merges.

## Install

```
claude plugin marketplace add AbhiramDwivedi/claude-ops
claude plugin marketplace add AbhiramDwivedi/truss
claude plugin install truss@truss
```

Then run `/truss:run <goal>` in your project.

Without the claude-ops marketplace, truss fails to load. To fix it, run `claude plugin marketplace add AbhiramDwivedi/claude-ops`, then reinstall truss with `claude plugin install truss@truss`.

## What installs

This branch holds only the catalog, `.claude-plugin/marketplace.json`, and this page. The first command adds the catalog `claude-ops`, and the second the catalog `truss`. The third installs the plugin `truss` from the `plugins/truss` directory of the `main` branch, with its three dependencies from claude-ops: kit `^0.3.1`, worktrees `^0.8.4` and subagent-limits `^0.3.1`. The catalog allows them with `allowCrossMarketplaceDependenciesOn: ["claude-ops"]`. Nothing else in the repo installs: a plugin-only install gets no `ui/`.

## Read the manual

The manual, the code and the optional local web UI live on the `main` branch:

- Manual: https://github.com/AbhiramDwivedi/truss/blob/main/plugins/truss/README.md
- Release notes: https://github.com/AbhiramDwivedi/truss/blob/main/plugins/truss/CHANGELOG.md
- Local web UI: https://github.com/AbhiramDwivedi/truss/blob/main/ui/README.md
- Code: https://github.com/AbhiramDwivedi/truss/tree/main

To work on truss, clone `main`: `git clone -b main https://github.com/AbhiramDwivedi/truss.git`.
