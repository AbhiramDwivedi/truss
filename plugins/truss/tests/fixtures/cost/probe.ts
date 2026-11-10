// The ADR-0038 cost probe: node probe.ts <sid> <price-table-path>
// Runs `factory cost` on a real session in a temp repo whose .claude/truss.json holds the table's `pricing`, and prints one JSON line
// {usd, claudeCodeEstimateUsd, gap, found}: gap is the percent between usd and the transcript's newest cost-state line.
// The transcript is found as $TRUSS_TRANSCRIPTS_ROOT, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects, /*/<sid>.jsonl.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const [sid, tablePath] = process.argv.slice(2)
if (!sid || !tablePath) {
  console.log(JSON.stringify({ error: 'usage: probe.ts <sid> <price-table-path>' }))
  process.exit(2)
}

const factory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../bin/factory.ts')
const table = JSON.parse(readFileSync(tablePath, 'utf8'))
const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'cost-probe-')))
const git = spawnSync('git', ['init', '-q', repo], { windowsHide: true })
if (git.status !== 0) {
  console.log(JSON.stringify({ error: 'git init failed' }))
  process.exit(1)
}
mkdirSync(path.join(repo, '.claude'), { recursive: true })
writeFileSync(path.join(repo, '.claude', 'truss.json'), JSON.stringify({ pricing: table.pricing }))
const dir = path.join(repo, '.git', 'truss', sid)
mkdirSync(dir, { recursive: true })

const r = spawnSync(process.execPath, [factory, 'cost', '--dir', dir, '--repo', repo], { encoding: 'utf8', windowsHide: true })
let out: any = null
try {
  out = JSON.parse((r.stdout ?? '').trim().split('\n').pop() as string)
} catch {
  out = null
}

const root = process.env.TRUSS_TRANSCRIPTS_ROOT || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude'), 'projects')
let estimate: number | null = null
if (existsSync(root)) {
  for (const p of readdirSync(root, { withFileTypes: true })) {
    const f = path.join(root, p.name, `${sid}.jsonl`)
    if (!p.isDirectory() || !existsSync(f)) continue
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.includes('"cost-state"')) continue
      try {
        const o = JSON.parse(line)
        if (o.type === 'cost-state' && typeof o.totalCostUSD === 'number') estimate = o.totalCostUSD
      } catch {
        // a torn or foreign line
      }
    }
    break
  }
}
const usd = out?.session?.usd ?? null
const gap = typeof usd === 'number' && estimate !== null && estimate > 0 ? (Math.abs(usd - estimate) / estimate) * 100 : null
console.log(JSON.stringify({ usd, claudeCodeEstimateUsd: out?.claudeCodeEstimateUsd ?? estimate, gap, found: out?.sweep?.found ?? null }))
process.exit(r.status === 0 ? 0 : 1)
