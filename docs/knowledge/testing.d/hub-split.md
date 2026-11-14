## Writing doc fragments

- A fragment replaces only sections at its own shallowest heading depth (`fragmentSections` and `applySection` in `bin/fragments.ts`). To change a `####` subsection, such as "Resource-aware sizing" under "### The Workflow path (ADR-0009)" in `architecture.md`, the fragment carries the whole `###` parent section.
- A rule file with no headings takes only an appended section, so a fragment cannot replace one of its stale bullets. Say in the appended section which bullet it supersedes.
