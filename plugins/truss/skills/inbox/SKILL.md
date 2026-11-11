---
name: inbox
description: Lists the open truss inbox items, or resolves one as the client with /truss:inbox <approve|reject|answer|done|dismiss> <E-id> <code> [raise <usd>] [note]. Only the human can start it; resolve --by client accepts only a decision the human typed in this session.
disable-model-invocation: true
---

# truss inbox

The human typed this command, so you act for the client here, and only for the decision they typed. Never pick a decision, an id or a code yourself, and never resolve an item they didn't name.

Arguments: `$ARGUMENTS`

`<plugin>` is two levels above this skill's base directory (`<plugin>/skills/inbox`). `<truss dir>` comes from the `[truss] dir: <path>` note the plugin adds at session start, or from the `Truss dir:` line `/truss` prints; don't derive it yourself. If neither is there, tell the human the truss plugin isn't loaded and stop. `<repo>` is the repo root of this session.

## List the open items

With no arguments, run:

```
node <plugin>/bin/factory.ts inbox --open --repo <repo> --dir <truss dir>
```

It prints one JSON line, `{items, open}`. Show each item on its own line: its `id`, `kind`, `title`, the `crews` it holds with their `session`, and whether it is `blocking`. `open` is the total of open items whatever the filters. When `open` is 0, say the inbox is empty.

The list carries no codes: the inbox stores only a hash of each one. Tell the human that an item's code is in the escalation message, the PM's message or the notify row, and that they use the code of the item's first escalation: a deduped escalation prints `code: null` and makes no new code. They resolve an item by typing `/truss:inbox <approve|reject|answer|done|dismiss> <E-id> <code> [raise <usd>] [note]`. Don't run a command to find a code, with one exception: when the client asks about an item whose code was lost (the escalation died before its code reached anyone), run `node <plugin>/bin/factory.ts inbox --recover-codes --repo <repo>`. It prints `{codes: [{id, code, session}]}` for open items only. Give the client the code of the item they asked about, and no other. Never resolve an item with a recovered code the client has not typed themselves.

An item the list shows with `reopened` was resolved once, but the typed line that backed that resolve can no longer be found (its transcript is gone, or the row never had one). Tell the human the `reopened.reason`, and who, when and what the old row said (`by`, `ts`, `decision`): the item blocks again until they type the decision. A resolved item's `note` is the text the human typed after the code, read from their typed line, never the note stored in the row. `noteUnbound` marks an item whose stored note differed from that typed text: tell the human the stored note was not theirs and was not used.

## Resolve an item

With arguments, read them as `<decision> <E-id> <code> [raise <usd>] [note…]`. The decision is one of `approve`, `reject`, `answer`, `done` or `dismiss` (`done` is for push-pr and prod-deploy items). If the decision isn't one of those, or the id or the code is missing, show the usage line above and stop. `raise <usd>` is for approving a budget item: the human types the amount, and only that amount goes to `--raise-usd`.

1. If there is a note, write it with the Write tool to `<truss dir>/inbox-note-<E-id>.txt`. The note is the human's text, exactly what they typed after `<code>` (and after `raise <usd>`): it goes through that file and never onto the command line, and `resolve` refuses a note that differs from the typed line.
2. Run:

   ```
   node <plugin>/bin/factory.ts resolve <E-id> --decision <decision> --by client --code <code> --note-file <truss dir>/inbox-note-<E-id>.txt --raise-usd <usd> --repo <repo> --dir <truss dir>
   ```

   Leave out `--note-file` and its path when there is no note, and `--raise-usd <usd>` when the human typed no `raise <usd>`. `resolve` refuses an amount that differs from the typed one.
3. Read the one JSON line it prints.
   - Exit 0 prints `{id, state: "resolved", decision, quote}`. Tell the human the item is resolved, with the decision and the quote it stored.
   - Exit 1 whose `error` says no prompt typed by the client was found means the check found no line the human typed that holds the id, the decision word and the code. Ask the human to type the line again as a plain prompt, not a slash command: `<decision> <E-id> <code> [raise <usd>] [note]`. When they have, run the same command once more.
   - Any other refusal (a wrong code, an item already resolved): show its `error` to the human as it is, and stop. Don't retry with other values.

`resolve --by client` reads this session's transcript for the human's own line, newer than the item, holding the id, the decision word and the code, and stores that line as the quote. There is no flag that sets the quote, so only the human's typing can approve. A line the human typed while the agent was busy (queued) or through `claude -p` doesn't count; if the check refuses, ask the human to type it again once the agent is idle.
