# Truss local web UI

`ui/` runs Truss from a browser tab. One Node process hosts a Claude Code session with the Truss plugin loaded, and serves a page that shows the run live: brief questions and approvals as cards, one line per crew, decisions and ADRs, and a design panel. The design is in [ADR-0011](../docs/adr/0011-local-web-ui.md) and the "Local web UI" section of [docs/architecture.md](../docs/architecture.md).

The commands below run from the Truss plugin root, the directory that holds `ui/`.

## Check the requirements

- Node 24 or later. `ui/package.json` sets `"engines": { "node": ">=24" }`, and `node` runs the server's `.ts` files as they are. On an older Node the server prints a one-line warning to stderr at startup and carries on.
- Claude Code, logged in. The UI drives your local Claude Code through `@anthropic-ai/claude-agent-sdk` on your existing login. It asks for no API key of its own.
- A git repo to run Truss in.

## Install the dependencies

```
npm --prefix ui ci
```

This installs the exact versions in `ui/package-lock.json` into `ui/node_modules`.

## Start the UI

1. Start the server, and point it at the repo you want Truss to work in. Run this from the plugin root:

   ```
   node ui/server/main.ts --repo /path/to/your/repo
   ```

   Or start it through npm:

   ```
   npm --prefix ui start -- --repo /path/to/your/repo
   ```

   On Windows, stopping an `npm start` task (for example closing the terminal or stopping a background task) can leave npm and the server running, because the server's parent is npm's cmd shell. Start with `node` directly to avoid it. If a later start reports the port is in use and a running truss UI is recorded for that port, the message names its pid. Stop it with `taskkill /PID <pid> /F` on Windows, or `kill <pid>` elsewhere.

   Start `node ui/server/main.ts` from your own terminal where you can. The server stops when any process that started it exits (ADR-0014), so detached launches such as PowerShell Start-Process or WMI end with their launching shell or host. Started from a Claude Code background shell, it stays up, but that shell's reaper can kill it under memory pressure, which ends the Truss session.

2. Wait for the one line the server prints:

   ```
   truss-ui listening on http://127.0.0.1:36581/?token=<token>
   ```

   The port and token differ on every start.

3. Open that whole URL, token included, in your browser. The server sets a cookie for the token and redirects to the same page without it, so the token doesn't stay in the address bar.

4. Type your goal in the message box and send it. The Claude Code session starts with your first message, not when the server starts.

### Flags

| Flag | Default | What it does |
|---|---|---|
| `--repo <path>` | `$INIT_CWD` when set, else the current directory | The repo the session runs in. `npm` sets `INIT_CWD` to the directory you ran `npm` from. With `node` directly, it is the current directory unless `INIT_CWD` is set. |
| `--plugin <path>` | The directory that holds `ui/` | The Truss plugin root. It must contain `.claude-plugin/plugin.json`, or the server exits with code 2. |
| `--truss-dir <path>` | Found from the session id | Read this Truss dir instead. Meant for tests on a copy of real Truss files. |
| `--port <n>` | `0` | The port to listen on, 0 to 65535. `0` lets the OS pick a free port. |

Every flag takes a value. An unknown flag or a missing value exits with code 2 and a usage line on stderr. A failed listen exits with code 1.

### What the UI does and doesn't do

- It listens on `127.0.0.1` only, so other machines can't reach it. Every request needs the token, from the URL or the cookie, and a `Host` of `127.0.0.1:<port>` or `localhost:<port>`.
- It stores nothing. The UI's own code writes no file: no database, log or cache. It reads Truss's files and git, and shows them. The Truss plugin's hooks in the session still write the Truss dir, as they do in a terminal.
- It sets no model and no spending limit. The session runs on Claude Code's default model, and the header shows the run's cost and usage with no ceiling.

## Stop the UI

Press Ctrl+C in the terminal that runs the server. On `SIGINT` or `SIGTERM` the server closes the Claude Code session and the HTTP server, then exits with code 0.

## Run the checks

Run these from the plugin root.

### Unit and contract tests

```
npm --prefix ui test
```

This runs `node --test` on `ui/contract/*.check.ts` (state, session, http) and `ui/test/*/*.test.ts`.

### Browser tests

1. Install the Playwright browsers once. The tests use Chromium, Firefox and WebKit (`ui/e2e/browsers.spec.ts`):

   ```
   npx --prefix ui playwright install chromium firefox webkit
   ```

2. Run the tests:

   ```
   npm --prefix ui run e2e
   ```

   This runs `playwright test` in `ui/`, with `ui/playwright.config.ts`: the contract spec in `ui/contract/e2e/` and the UI specs in `ui/e2e/`. Each spec starts its own server on port 0. Arguments after `--` go to Playwright, for example `npm --prefix ui run e2e -- --list` to list the tests.

   Use the `npm` script, not `npx --prefix ui playwright test` from the plugin root. `npx` runs in the current directory, so Playwright doesn't find `ui/playwright.config.ts` and picks up the plugin's own `tests/` instead.

### Live check on your login

```
npm --prefix ui run check:live
```

This starts the real `ui/server/main.ts` on a temp git repo with the real Agent SDK and your real Claude Code login, so its model turns count against your account. It passes no model, answers a question card and a permission card over HTTP, and checks that each answer reaches the session within 1 s. It is in no acceptance test, because it needs your login.
