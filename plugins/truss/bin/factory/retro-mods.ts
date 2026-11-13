// The lazy load of retro/, so a plugin copy without it still runs every other command. A leaf: it imports no sibling
// module. Moved unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an
// import cycle.
// retro/ is loaded lazily, so a plugin copy without it still runs every other command; a command that needs it says so.
let retroMods: { cat: typeof import('../../retro/catalog.ts'); ex: typeof import('../../retro/extract.ts') } | undefined
try {
  retroMods = { cat: await import('../../retro/catalog.ts'), ex: await import('../../retro/extract.ts') }
} catch {
  retroMods = undefined
}
export const retro = (): NonNullable<typeof retroMods> => {
  if (retroMods === undefined) throw new Error('retro/ is not in this plugin copy')
  return retroMods
}
