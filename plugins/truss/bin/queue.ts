// The intake queue commands (contract-025 section 6, ADR-0040). A0 stub: no commands yet; c-unattended replaces it.
// Imports node: builtins and relative paths only, and never factory.ts (its top-level await would make an import cycle).

import type { Flags, Obj } from './store.ts'

export const QUEUE_COMMANDS: Record<string, (f: Flags) => Obj> = {}
