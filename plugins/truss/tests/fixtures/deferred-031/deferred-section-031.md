<!-- Copied from the 0.31.0 release report, section "Deferred or unverified". -->
## Deferred or unverified

- The crew wall-clock after-measurement is pending until 0.32.0 runs.
- The background heavy job is unverified on Windows.
- A hung background suite holds its slot until it ends. Whether TaskStop can reach these detached jobs is untested.
- No test drives `concludeFrontmatterMerge` through `finish`. The function itself is unit-tested and covered through sync.
- Three line citations remain outside the lint's scope, two in skills/retro/SKILL.md (pinned by hygiene-029) and one in agents/planning-engineer.md.
- About 11 historical ADRs keep section titles that were renamed later. They were left on purpose as a record.
- The inbox timing test keeps a scaled wall-clock margin.
- The goalCheck pending test and some fixer tests were proved failing-first by reasoning rather than by a run against the old code, where the old code would hang.
- Item 8 has no requirements (R) entry, only a CHANGELOG line. The R-116 to R-124 "Added" stamps use a placeholder time of day.
- Proposed for 0.32.0: structural splits for sharper test selection, a run that survives its PM session ending (8h43 in wave 4), folding `admit` and standalone reaps into earlier calls, and real-time stamping of stage events.
