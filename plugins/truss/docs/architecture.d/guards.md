## Decision log Bash guard

This section adds a row to the Hooks table and corrects "A log written through Bash isn't seen" in the Decision times text: since 0.32.0 (R-134) a main-session `Bash` command that writes this session's `decisions.md` is refused, so `factory.ts decide` is the only writer through any tool.

| Event | What it does |
| --- | --- |
| `tool.call` on `Bash`, R-134, main session only | `decisionLogBashVerdict` refuses a command that writes this session's `decisions.md` (`isDecisionLog` on the resolved path): a redirect, `tee`, `sed -i`, a heredoc with a redirect, a nested `sh -c` or `bash -c`, a substitution, a write after a lone `&` (the guard reads `commandSegments(text, true)`, which splits on a background `&`), `uniq` with the file as its second operand, or another command that names the file. It also refuses a command that names the file with a target it cannot resolve (a variable, a glob, `~`, a substitution, a relative path after a `cd`). Reads, the decide command and a member's call (an `agentId`) are allowed. The deny is `DECISION_LOG_REFUSAL`, and the handler runs before the push gate. It fails closed, unlike every other handler: an error while judging a command that names the file refuses it, since letting it through is the write the guard exists to stop. |
