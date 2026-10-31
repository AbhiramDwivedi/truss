// The file readers of ui-state (ADR-0011 Decision 4, "Sources"): plan.json, plan.md, decisions.md, reports/,
// <repo>/.claude/truss.json, the architecture doc and the ADR dir. Read-only. Each reader caches by the file's
// size, mtime, ctime and inode, so a poll that finds nothing changed reads nothing.
// Node built-ins only; erasable TypeScript. Nothing here imports from the plugin: the three rules below are
// re-implemented and name their source.
import fs from 'node:fs'
import path from 'node:path'
import type { Plan, PlanCrew, Qc } from './reduce.ts'

// a name safe as one path segment. Source: hooks/register.ts:117 (safeName).
export function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+|\.{2,}/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
  return cleaned === '' ? 'agent' : cleaned
}

// a crew's QC report files: <crew>-qc.md and <crew>-qc-<n>.md. Source: hooks/register.ts:772 (isQcFile).
export function isQcFile(crew: string, file: string): boolean {
  const prefix = `${safeName(crew)}-qc`
  if (!file.startsWith(prefix) || !file.endsWith('.md')) return false
  const middle = file.slice(prefix.length, -'.md'.length)
  return middle === '' || /^-\d+$/.test(middle)
}

// the k of <crew>-qc-<k>.md; the bare <crew>-qc.md is 1. Source: hooks/register.ts:510 (qcK).
const qcK = (name: string): number => Number(/-qc-(\d+)\.md$/.exec(name)?.[1] ?? 1)

// The verdict of a report: its first non-empty line is `VERDICT: PASS` or `VERDICT: FAIL`, else null. The template
// line `VERDICT: PASS | ...` is not a verdict. Source: hooks/register.ts:211 (markerOf), cut to PASS and FAIL.
export function verdictOf(text: string): 'PASS' | 'FAIL' | null {
  const first = text.split('\n').find((l) => l.trim() !== '')?.trimStart() ?? ''
  if (/^VERDICT: (PASS|FAIL) \| /.test(first)) return null
  if (first.startsWith('VERDICT: PASS')) return 'PASS'
  if (first.startsWith('VERDICT: FAIL')) return 'FAIL'
  return null
}

export interface Decision {
  n: number
  run: string | null
  text: string
}
export interface Adr {
  file: string
  title: string
  status: string | null
}
export interface Config {
  architecture: string | null // the .claude/truss.json key, as written
  adr: string | null
  complete: boolean // the file is there and has both keys
}

function sigOf(p: string): string | null {
  try {
    const s = fs.statSync(p)
    return s.isFile() ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}` : null
  } catch {
    return null
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)

export function parseDecisions(text: string): Decision[] {
  const out: Decision[] = []
  let run: string | null = null
  let open = false
  text.split('\n').forEach((raw, i) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('## Run ')) {
      run = line.slice('## Run '.length)
      open = false
    } else if (line.startsWith('- ')) {
      out.push({ n: i + 1, run, text: line.slice(2) })
      open = true
    } else if (open && line.startsWith('  ')) {
      out[out.length - 1].text += `\n${line.slice(2)}`
    } else {
      open = false
    }
  })
  return out
}

function parsePlan(text: string): Plan | undefined {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(v)) return undefined
  const crews: PlanCrew[] = []
  if (Array.isArray(v.crews)) {
    for (const c of v.crews) {
      if (!isObject(c) || typeof c.slug !== 'string' || c.slug === '') continue
      const status = c.status
      crews.push({
        slug: c.slug,
        stage: Number.isInteger(c.stage) ? (c.stage as number) : null,
        verdict: typeof c.verdict === 'string' ? c.verdict : null,
        status: status === 'planned' || status === 'running' || status === 'merged' || status === 'dropped' ? status : null,
        goal: typeof c.goal === 'string' ? c.goal : null,
        owns: Array.isArray(c.owns) ? c.owns.filter((o): o is string => typeof o === 'string') : [],
      })
    }
  }
  return {
    goal: typeof v.goal === 'string' ? v.goal : null,
    version: Number.isInteger(v.version) ? (v.version as number) : null,
    approval: v.approval === 'auto' || v.approval === 'client' ? v.approval : null,
    approvedAt: typeof v.approvedAt === 'string' ? v.approvedAt : null,
    crews,
  }
}

function parseAdr(file: string, text: string): Adr {
  const lines = text.split('\n')
  const h = lines.find((l) => l.startsWith('# '))
  const s = lines.find((l) => l.startsWith('Status: '))
  return {
    file,
    title: h === undefined ? file : h.slice(2).trimEnd(),
    status: s === undefined ? null : s.slice('Status: '.length).trimEnd(),
  }
}

export interface FileReaders {
  plan(trussDir: string): Plan | null
  planMd(trussDir: string): string | null
  decisions(trussDir: string): Decision[]
  config(): Config
  architecture(rel: string): { path: string; markdown: string } | null
  adrs(rel: string): Adr[]
  qc(trussDir: string, slug: string): Qc | null
}

export function createFileReaders(repo: string): FileReaders {
  const cache = new Map<string, { sig: string; value: unknown }>()

  // The parsed file, from the cache while its signature holds. A parse that fails (a half-written file) keeps the
  // last good value until the file changes again.
  function cached<T>(file: string, parse: (text: string) => T | undefined): T | null {
    const sig = sigOf(file)
    if (sig === null) {
      cache.delete(file)
      return null
    }
    const hit = cache.get(file)
    if (hit !== undefined && hit.sig === sig) return hit.value as T | null
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      return (hit?.value as T | undefined) ?? null
    }
    const value = parse(text)
    const kept = value === undefined ? ((hit?.value as T | undefined) ?? null) : value
    cache.set(file, { sig, value: kept })
    return kept
  }

  function inRepo(rel: string): string | null {
    const abs = path.resolve(repo, rel)
    const r = path.relative(repo, abs)
    return r === '' || r.startsWith('..') || path.isAbsolute(r) ? null : abs
  }

  return {
    plan: (trussDir) => cached(path.join(trussDir, 'plan.json'), parsePlan),
    planMd: (trussDir) => cached(path.join(trussDir, 'plan.md'), (t) => t),
    decisions: (trussDir) => cached(path.join(trussDir, 'decisions.md'), parseDecisions) ?? [],
    config() {
      const cfg = cached(path.join(repo, '.claude', 'truss.json'), (t): Config | undefined => {
        try {
          const v: unknown = JSON.parse(t)
          if (!isObject(v)) return undefined
          const architecture = typeof v.architecture === 'string' && v.architecture !== '' ? v.architecture : null
          const adr = typeof v.adr === 'string' && v.adr !== '' ? v.adr : null
          return { architecture, adr, complete: architecture !== null && adr !== null }
        } catch {
          return undefined
        }
      })
      return cfg ?? { architecture: null, adr: null, complete: false }
    },
    architecture(rel) {
      const abs = inRepo(rel)
      if (abs === null) return null
      const markdown = cached(abs, (t) => t)
      return markdown === null ? null : { path: rel, markdown }
    },
    adrs(rel) {
      const dir = inRepo(rel)
      if (dir === null) return []
      let names: string[]
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.md'))
      } catch {
        return []
      }
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      const out: Adr[] = []
      for (const n of names) {
        const adr = cached(path.join(dir, n), (t) => parseAdr(n, t))
        if (adr !== null) out.push(adr)
      }
      return out
    },
    qc(trussDir, slug) {
      const rel = `reports/${safeName(slug)}`
      const dir = path.join(trussDir, rel)
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        return null
      }
      // the newest QC file by mtime; on a tie the higher k (hooks/register.ts:513, latestQc, without the run filter)
      let best: { name: string; mtimeMs: number } | null = null
      for (const name of names) {
        if (!isQcFile(slug, name)) continue
        let mtimeMs: number
        try {
          const st = fs.statSync(path.join(dir, name))
          if (!st.isFile()) continue
          mtimeMs = st.mtimeMs
        } catch {
          continue
        }
        if (best === null || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && qcK(name) > qcK(best.name))) best = { name, mtimeMs }
      }
      if (best === null) return null
      const verdict = cached(path.join(dir, best.name), (t) => ({ v: verdictOf(t) }))
      return { verdict: verdict?.v ?? null, file: `${rel}/${best.name}` }
    },
  }
}
