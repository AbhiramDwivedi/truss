# ADR-0036: diff hygiene, the dependency rule and the debugging rule

Status: accepted, 2026-11-09
Decided by: PM and product owner, 2026-11-09 (review of an external list of agent coding rules against truss)
Amends: core principle pack (adds rule 15, widens rule 13); the member prompts in `workflows/stage.js` and `agents/foreman.md`; QC engineer steps

## Context

An external list of coding rules for agents was checked item by item against truss. Truss already covers most of them (scope, proof, tests first, reuse, non-goals). Three gaps were real:

- A builder reformats, renames or tidies lines inside its owned files that the task did not change. The diff grows and review gets harder; the owned-files check cannot see it.
- A builder adds a dependency with no reason, or one the standard library or an existing dependency already covers.
- A bug fix guards over the symptom (a null check, an empty check, a catch) and leaves the cause.

## Decision

1. **Core rule 15:** a new dependency is added only when neither the language's standard library nor a dependency the project already has does the job, and the change says why. Its test: each package the diff adds to a manifest is named in the approved scope or has a `Why:` line in its commit message. Core rule 13 now reads "A behavior change or bug fix"; its test is unchanged.
2. **DIFF** (builder, tester and resolver member prompts, and `agents/foreman.md`): change only the lines the task needs, match the file's style, add no covered dependency, and report an unscoped dependency as a proposal.
3. **DEBUG** (builder prompts, `fixPrompt`, and `agents/foreman.md`): reproduce a bug with a failing test first, fix the cause, and say why an unexpected null, empty or error value occurs before guarding it.
4. Neither text goes into QC, stress, writer, planning or judge prompts.
5. **New QC step 10** (in `agents/qc-engineer.md` and `qcPrompt`, identical text): every hunk traces to the task; a pure reformat, rename or reorder is a finding unless the project's formatter or a hook produced it (compare `git diff <base>...<branch>` with `git diff -w`); each manifest addition is checked against rule 15; an unexplained guard or catch in a bug fix is a finding.
6. **Persona Standards** (design engineer guidance) name the stack's built-ins that replace common packages (JS: `fetch`, `crypto.randomUUID`, `structuredClone`; Python: `pathlib`, `uuid`, `urllib.request`; Go: `net/http`, `log/slog`). Language-specific rules stay in the persona, not in core.

## Declined

Recorded so a later run does not re-adopt them.

- **"Skip error handling for errors that can't occur" and "hardcode values".** They conflict with core rules 6 (validate at the boundary), 10 (secure defaults) and 11 (secrets from configuration).
- **"Stop, don't push through" on a failure.** It conflicts with the "be brave" rule. Truss handles the same worry with "beyond scope goes back as a PROPOSAL".
- **The communication rules.** The proof rule, `Examined` and `Not examined` already cover them.

## Consequences

- Core is now at its 15-rule cap. A further rule means merging or retiring one first.
- The formatter exemption in the QC step is essential. Without it, QC flags hunks the builder did not choose (formatter and hook output).
- A dependency found needed mid-build becomes a proposal round trip: the builder reports it, the PM approves, a builder continues. That is slower for a legitimate dependency and deliberate.
- Each member prompt grows by about 60 words, and the QC prompt by about 70.
- Rule 15 binds truss's own code, which is dogfooded (`docs/architecture.md`, "Core pack: all 15 rules adopted").
