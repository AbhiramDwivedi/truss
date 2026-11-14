// Leaf module: reading a crew's goal file. The goal file is the one home of the crew's acceptance command; plan.json's
// acceptanceTest is only the fallback for a goal file with no `## Acceptance test` section. Imports no sibling and never factory.ts.

// A goal file's `## Heading` sections as {heading: text}; the text before the first heading is under "".
export function goalSections(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key = ''
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^## (.+?)\s*$/.exec(line)
    if (m) {
      out[key] = buf.join('\n').trim()
      key = m[1]
      buf = []
    } else buf.push(line)
  }
  out[key] = buf.join('\n').trim()
  return out
}

// The bodies of the fenced code blocks (``` or ~~~) in a text, in order. An unclosed fence runs to the end.
function fencedBlocks(text: string): string[] {
  const blocks: string[] = []
  let fence = ''
  let buf: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence === '') {
      if (m) {
        fence = m[1]
        buf = []
      }
    } else if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) {
      blocks.push(buf.join('\n'))
      fence = ''
    } else buf.push(line)
  }
  if (fence !== '') blocks.push(buf.join('\n'))
  return blocks
}

// The acceptance command a goal file holds: the body of the one fenced code block under `## Acceptance test`. undefined when the
// goal file has no such section (the caller falls back to plan.json); `{ error }` when the section holds no block or more than one,
// or an empty one. Prose is never read as a command.
export function acceptanceCommand(goalText: string): string | undefined | { error: string } {
  const section = goalSections(goalText)['Acceptance test']
  if (section === undefined) return undefined
  const blocks = fencedBlocks(section)
  if (blocks.length !== 1) return { error: `the "## Acceptance test" section must hold exactly one fenced code block, found ${blocks.length}` }
  const command = blocks[0].trim()
  if (command === '') return { error: 'the "## Acceptance test" fenced code block is empty' }
  return command
}
