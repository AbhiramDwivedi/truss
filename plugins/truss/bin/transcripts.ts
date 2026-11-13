// truss contract-025 section 2 (ADR-0037), split in 0.32.0: where Claude Code keeps session transcripts and the inbox proof's one read of
// one. Node built-ins and relative paths only; no module imports factory.ts, which has a top-level await. bin/store.ts re-exports this module.
import * as nodeFs from 'node:fs'
import { homedir, userInfo } from 'node:os'
import path from 'node:path'
import { flat } from './core.ts'
import { fn } from './lock.ts'
import type { FsLike } from './lock.ts'

// The root the inbox proof reads a transcript under: the OS user's home and .claude/projects, never an env var, so the caller cannot point
// the proof at a file of its own. Reading spend (transcriptsOf) grants no authority; a proof does.
export const proofTranscriptRoot = (): string => flat(path.join(userInfo().homedir, '.claude', 'projects'))

// The one read of a transcript for the inbox proof (the tests stub it by re-export, so every proof read goes through it).
export const readProofFile = (p: string, opts: { fs?: FsLike } = {}): Buffer => fn(opts.fs, 'readFileSync')(p) as Buffer

// Where Claude Code keeps session transcripts: $TRUSS_TRANSCRIPTS_ROOT, else $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects.
// main is <root>/<project>/<sid>.jsonl; agents are <root>/<project>/<sid>/subagents/**/agent-*.jsonl, each with its agent-*.meta.json
// parsed as meta (null when it is not written yet or not JSON).
export function transcriptsOf(sid: string, env: NodeJS.ProcessEnv = process.env): { main: string | null; agents: { path: string; meta: any }[]; root: string } {
  const root = flat(env.TRUSS_TRANSCRIPTS_ROOT || (env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'projects') : path.join(homedir(), '.claude', 'projects')))
  const out: { main: string | null; agents: { path: string; meta: any }[]; root: string } = { main: null, agents: [], root }
  if (!/^[A-Za-z0-9._-]+$/.test(sid) || sid === '.' || sid === '..') return out
  let projects: string[]
  try {
    projects = nodeFs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    return out
  }
  const walk = (dir: string): void => {
    let entries: nodeFs.Dirent[]
    try {
      entries = nodeFs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = `${dir}/${e.name}`
      if (e.isDirectory()) walk(full)
      else if (/^agent-.+\.jsonl$/.test(e.name)) {
        let meta: any = null
        try {
          meta = JSON.parse(nodeFs.readFileSync(full.replace(/\.jsonl$/, '.meta.json'), 'utf8'))
        } catch {
          meta = null
        }
        out.agents.push({ path: full, meta })
      }
    }
  }
  for (const proj of projects) {
    const main = `${root}/${proj}/${sid}.jsonl`
    if (out.main === null && nodeFs.existsSync(main)) out.main = main
    walk(`${root}/${proj}/${sid}/subagents`)
  }
  return out
}
