// Personas (ADR-0032): parsing and checking persona files, the personas table start passes, and persona-install. Moved
// unchanged from bin/factory.ts (0.31.0 item 5). Never imports factory.ts, whose top-level await would make an import cycle.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { flat, need, readText, usage } from '../core.ts'
import type { Flags, Obj } from '../core.ts'
import { gitOrFail, repoOf, run } from './cli.ts'
import { sessionStartOnce } from './warnings.ts'

// ==== personas (ADR-0032) ====
// A persona is a project agent type file <repo>/.claude/agents/<name>.md (symlinks followed). Role stays the pipeline slot;
// the persona is who does a task: its agent type, model, effort and standards.
const PERSONA_MODELS = ['opus', 'sonnet']
const PERSONA_EFFORT_LEVELS = ['low', 'medium', 'high']
export const PERSONA_KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const PERSONA_DESCRIPTION_MAX = 400
type PersonaDoc = { fm: Record<string, string>; body: string }

// The frontmatter of an agent file as flat key/value strings (a folded or literal block value is joined), and the body after it.
// undefined when the text opens with no frontmatter block.
export function parsePersonaFile(text: string): PersonaDoc | undefined {
  const lines = (text.startsWith('﻿') ? text.slice(1) : text).replace(/\r\n?/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') return undefined
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---')
  if (end < 0) return undefined
  const fm: Record<string, string> = {}
  for (let i = 1; i < end; i++) {
    const m = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] as string)
    if (m === null) continue
    let v = (m[2] as string).trim()
    if (v === '' || /^[>|][+-]?$/.test(v)) {
      const block: string[] = []
      while (i + 1 < end && /^\s/.test(lines[i + 1] as string)) block.push((lines[++i] as string).trim())
      v = block.join(v.startsWith('|') ? '\n' : ' ').trim()
    } else if (/^(["']).*\1$/.test(v)) {
      v = v.slice(1, -1)
    }
    fm[m[1] as string] = v
  }
  return { fm, body: lines.slice(end + 1).join('\n').replace(/^\n+/, '').replace(/\s+$/, '') }
}

// Why a persona file is not valid, or undefined. fileName is the name without .md.
export function personaFault(fileName: string, doc: PersonaDoc | undefined): string | undefined {
  if (doc === undefined) return 'it has no frontmatter block'
  const { fm } = doc
  if (fm.name !== fileName) return `its frontmatter name ${fm.name === undefined ? '(missing)' : fm.name} differs from the file name ${fileName}`
  if ((fm.description ?? '') === '') return 'it has no description'
  if (fm.model !== undefined && !PERSONA_MODELS.includes(fm.model)) return `its model ${fm.model} is not opus or sonnet`
  if (fm.effort !== undefined && !PERSONA_EFFORT_LEVELS.includes(fm.effort)) return `its effort ${fm.effort} is not low, medium or high`
  // a file cut short by a fence that closed early has no Standards section: it is not installed
  if (!/^##[ \t]+Standards[ \t]*$/m.test(doc.body)) return 'it has no ## Standards heading (a draft cut short by an early-closing fence has none)'
  return undefined
}

// An editing persona: no tools line, or a tools line that holds Write or Edit (or all tools).
function personaReadOnly(fm: Record<string, string>): boolean {
  if (fm.tools === undefined) return false
  const tools = fm.tools.replace(/[[\]"']/g, '').split(/[,\s]+/).filter((t) => t !== '')
  if (tools.length === 0) return false
  return !tools.some((t) => t === 'Write' || t === 'Edit' || t === '*')
}

// The agent type that hosts a read-only persona whose body is inlined (it is not loaded, or only a draft exists): a plugin type that
// is always loaded and whose tools hold neither Write nor Edit, so an inlined judge never gets write tools. It is
// truss:judge (agents/judge.md; Read, Grep, Glob, Bash): a neutral host whose only instruction is to adopt the persona definition at
// the top of the brief, so no other role's system prompt competes with it.
export const READ_ONLY_HOST = 'truss:judge'
function personaInlineType(): string {
  return READ_ONLY_HOST
}

// The personas the stage args carry, from the main checkout's .claude/agents/*.md. loaded: the file is not newer than the session
// start (the session loads agent types only at start); false too when the start can't be read, the safe side. An unloaded
// persona carries its body, since stage.js runs it as general-purpose with that body inlined. A malformed file is skipped with a warning.
export function buildPersonas(repo: string): { personas: Obj; warnings: string[] } {
  const personas: Obj = {}
  const warnings: string[] = []
  const dir = `${flat(repo)}/.claude/agents`
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return { personas, warnings }
  }
  const started = sessionStartOnce()
  for (const n of names) {
    const file = `${dir}/${n}`
    const name = n.slice(0, -'.md'.length)
    let text: string
    let changed: number
    try {
      text = readFileSync(file, 'utf8')
      changed = statSync(file).mtimeMs // through a symlink: the real file's time
    } catch (e) {
      warnings.push(`persona file ${file} is skipped: it can't be read (${(e as Error).message})`)
      continue
    }
    const doc = parsePersonaFile(text)
    const fault = personaFault(name, doc)
    if (fault !== undefined || doc === undefined) {
      warnings.push(`persona file ${file} is skipped: ${fault}`)
      continue
    }
    const loaded = started !== undefined && !(changed > started)
    const readOnly = personaReadOnly(doc.fm)
    personas[name] = {
      agentType: name, model: doc.fm.model ?? 'sonnet', effort: doc.fm.effort ?? 'medium', file, description: (doc.fm.description as string).slice(0, PERSONA_DESCRIPTION_MAX),
      readOnly, ...(readOnly ? { inlineType: personaInlineType() } : {}), loaded, ...(loaded ? {} : { body: doc.body }),
    }
    if (!loaded) {
      warnings.push(`persona ${name} (${file}) is ${started === undefined ? "not known to be loaded (I can't read the session start)" : 'newer than the session start, so this session has not loaded it'}; its tasks run as ${readOnly ? READ_ONLY_HOST : 'general-purpose'} with its definition inlined. Restart the session to load it`)
    }
  }
  return { personas, warnings }
}

// factory persona-install --from <dir> --repo <root> [--replace]: copies <dir>/*.md into <root>/.claude/agents/ and commits them.
export function cmdPersonaInstall(f: Flags): Obj {
  const from = need(f, 'from')
  const repo = repoOf(f)
  const replace = f.replace === true
  let entries: string[]
  try {
    entries = readdirSync(from).filter((n) => n.endsWith('.md')).sort()
  } catch (e) {
    throw usage(`cannot read --from ${flat(from)}: ${(e as Error).message}`)
  }
  const jobs: { name: string; text: string }[] = []
  for (const n of entries) {
    const name = n.slice(0, -'.md'.length)
    if (!PERSONA_KEBAB.test(name)) throw usage(`${n}: the persona name must be kebab-case (lowercase letters, digits, hyphens)`)
    const fault = personaFault(name, parsePersonaFile(readText(path.join(from, n))))
    if (fault !== undefined) throw usage(`${n}: ${fault}`)
    jobs.push({ name, text: readText(path.join(from, n)) })
  }
  const target = path.join(repo, '.claude', 'agents')
  const installed: string[] = []
  const skipped: string[] = []
  const written: string[] = []
  for (const j of jobs) {
    const to = path.join(target, `${j.name}.md`)
    if (existsSync(to)) {
      if (readFileSync(to).equals(readFileSync(path.join(from, `${j.name}.md`)))) continue
      if (!replace) {
        skipped.push(j.name)
        continue
      }
    }
    mkdirSync(target, { recursive: true })
    copyFileSync(path.join(from, `${j.name}.md`), to)
    installed.push(j.name)
    written.push(path.posix.join('.claude', 'agents', `${j.name}.md`))
  }
  let commit: string | null = null
  if (written.length > 0) {
    gitOrFail(repo, ['add', '--', ...written])
    if (run(repo, ['diff', '--cached', '--quiet', '--', ...written]).status !== 0) {
      gitOrFail(repo, ['commit', '-q', '-m', `chore(agents): add personas ${installed.join(', ')}`, '--', ...written])
      commit = gitOrFail(repo, ['rev-parse', 'HEAD'])
    }
  }
  return { installed, skipped, commit }
}
