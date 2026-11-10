---
name: inbox
description: Lists the open truss inbox items, or resolves one as the client with /truss:inbox <approve|reject|answer|dismiss> <E-id> <code> [note]. Only the human can start it; resolve --by client accepts only a decision the human typed in this session.
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

It prints one JSON line, `{items, open}`. Show each item on its own line: its `id`, `kind`, `title`, the `crews` it holds with their `session`, and whether it is `blocking`. When `open` is 0, say the inbox is empty.

The list carries no codes: the inbox stores only a hash of each one. Tell the human that an item's code is in the escalation message, the PM's message or the notify row, and that they resolve an item by typing `/truss:inbox <approve|reject|answer|dismiss> <E-id> <code> [note]`. Never run a command to find a code.

## Resolve an item

With arguments, read them as `<decision> <E-id> <code> [note…]`. The decision is one of `approve`, `reject`, `answer` or `dismiss`. If the decision isn't one of those, or the id or the code is missing, show the usage line above and stop.

1. If there is a note, write it with the Write tool to `<truss dir>/inbox-note-<E-id>.txt`. The note is the human's text: it goes through that file and never onto the command line.
2. Run:

   ```
   node <plugin>/bin/factory.ts resolve <E-id> --decision <decision> --by client --code <code> --note-file <truss dir>/inbox-note-<E-id>.txt --repo <repo> --dir <truss dir>
   ```

   Leave out `--note-file` and its path when there is no note.
3. Read the one JSON line it prints.
   - Exit 0 prints `{id, state: "resolved", decision, quote}`. Tell the human the item is resolved, with the decision and the quote it stored.
   - Exit 1 whose `error` says no prompt typed by the client was found means the check found no line the human typed that holds the id, the decision word and the code. Ask the human to type the line again as a plain prompt, not a slash command: `<decision> <E-id> <code> [note]`. When they have, run the same command once more.
   - Any other refusal (a wrong code, an item already resolved): show its `error` to the human as it is, and stop. Don't retry with other values.

`resolve --by client` reads this session's transcript for the human's own line, newer than the item, holding the id, the decision word and the code, and stores that line as the quote. There is no flag that sets the quote, so only the human's typing can approve.
