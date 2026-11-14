// Barrel: re-exports the leaf modules that replaced this one (0.32.0 item 8). New code imports the leaf (slot, admit, reap), never
// this file; a later goal drops it. Never imports factory.ts, whose top-level await would make an import cycle.
export * from './slot.ts'
export * from './admit.ts'
export * from './reap.ts'
