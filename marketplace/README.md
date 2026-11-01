# truss

truss is a Claude Code plugin that runs a large coding goal as several crews of agents working in parallel, each in its own git worktree, with an independent QC engineer that must pass each crew's work before it merges.

## Install

```
claude plugin marketplace add AbhiramDwivedi/truss
claude plugin install truss@truss
```

Then run `/truss:run <goal>` in your project.

## What installs

This branch holds only the catalog, `.claude-plugin/marketplace.json`, and this page. The first command adds the catalog `truss`. The second installs the plugin `truss` from the `plugins/truss` directory of the `main` branch. Nothing else in the repo installs: a plugin-only install gets no `ui/`.

## Read the manual

The manual, the code and the optional local web UI live on the `main` branch:

- Manual: https://github.com/AbhiramDwivedi/truss/blob/main/plugins/truss/README.md
- Release notes: https://github.com/AbhiramDwivedi/truss/blob/main/plugins/truss/CHANGELOG.md
- Local web UI: https://github.com/AbhiramDwivedi/truss/blob/main/ui/README.md
- Code: https://github.com/AbhiramDwivedi/truss/tree/main

To work on truss, clone `main`: `git clone -b main https://github.com/AbhiramDwivedi/truss.git`.
