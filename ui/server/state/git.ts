// ui-state git side (ADR-0011 Decisions 4, 7 and 9): the Truss dir for a session, the image files a run's crews
// added, and the bytes of one of those images. Read-only git subcommands only (rev-parse, symbolic-ref,
// for-each-ref, log, diff, cat-file); nothing here writes to the repo or the Truss dir.
// Node built-ins only; erasable TypeScript.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface Image {
  ref: string
  path: string
}

const GIT_TIMEOUT_MS = 10_000 // Decision 4: each git child has a 10 s timeout
const GIT_EVERY_MS = 5_000 // Decision 4: git runs every 5 s, not on every poll
const IMAGE_MAX_BYTES = 64 * 1024 * 1024
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'])

function git(cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer, encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, windowsHide: true },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    )
  })
}

// Copied from hooks/register.ts:115-118 (safeName); ui/ never imports the plugin (Decision 1).
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+|\.{2,}/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100)
  return cleaned === '' ? 'agent' : cleaned
}

// <git common dir>/truss/<safeName(sessionId)>, as hooks/register.ts:128-131 builds it. Resolves null outside a git
// repo (the plugin falls back to the home folder there; the UI does not guess at it) or when git fails.
export async function trussDirFor(repo: string, sessionId: string): Promise<string | null> {
  try {
    const out = (await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trim()
    if (out === '') return null
    return path.join(out, 'truss', safeName(sessionId))
  } catch {
    return null
  }
}

const isImage = (p: string): boolean => IMAGE_EXT.has(path.extname(p).toLowerCase())

function names(out: Buffer): string[] {
  return out
    .toString('utf8')
    .split('\0')
    .map((s) => s.replace(/^\n+/, ''))
    .filter((s) => s !== '' && isImage(s))
}

// The target branch .claude/truss.json names; when it names none, the branch the repo has checked out.
async function targetOf(repo: string): Promise<string | null> {
  try {
    const cfg: unknown = JSON.parse(fs.readFileSync(path.join(repo, '.claude', 'truss.json'), 'utf8'))
    const t = cfg !== null && typeof cfg === 'object' ? (cfg as Record<string, unknown>).target : undefined
    if (typeof t === 'string' && t !== '' && !t.startsWith('-')) return t
  } catch {
    // no readable config: fall through
  }
  const head = (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).toString('utf8').trim()
  return head === '' ? null : head
}

async function listImages(repo: string, approvedAt: string | null): Promise<Image[]> {
  const found: Image[] = []
  const seen = new Set<string>()
  const add = (ref: string, files: string[]): void => {
    for (const p of files) {
      const k = `${ref}\0${p}`
      if (!seen.has(k)) {
        seen.add(k)
        found.push({ ref, path: p })
      }
    }
  }
  const target = await targetOf(repo)
  if (target === null) throw new Error('no target branch')
  // approvedAt unknown (no plan yet): nothing counts as added by the run on the target, so the target lists none.
  if (approvedAt !== null) {
    add(target, names(await git(repo, ['log', '-z', `--since=${approvedAt}`, '--diff-filter=A', '--name-only', '--format=', target, '--'])))
  }
  const heads = (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/truss-*'])).toString('utf8').split('\n')
  for (const b of heads.map((s) => s.trim()).filter((s) => s.startsWith('truss-') && s !== target)) {
    add(b, names(await git(repo, ['diff', '-z', '--diff-filter=A', '--name-only', `${target}...${b}`, '--'])))
  }
  return found
}

export interface ImageTracker {
  // Called from every poll. Starts a git pass when 5 s have passed since the last one began, or when approvedAt
  // changed, and none is running. `onChange` fires after a pass that changed the images or the failure flag.
  tick(approvedAt: string | null): void
  images(): Image[] // the last good list
  failed(): boolean // the last pass failed
  read(ref: string, p: string): Promise<Buffer | null> // bytes only for a pair in images(), else null
  close(): void
}

export function createImageTracker(repo: string, onChange: () => void): ImageTracker {
  let good: Image[] = []
  let failed = false
  let running = false
  let closed = false
  let started = false
  let lastStart = 0
  let lastInput: string | null = null

  async function pass(approvedAt: string | null): Promise<void> {
    let next: Image[] | null
    try {
      next = await listImages(repo, approvedAt)
    } catch {
      next = null
    }
    running = false
    if (closed) return
    const wasFailed = failed
    const before = JSON.stringify(good)
    if (next === null) failed = true
    else {
      failed = false
      good = next
    }
    if (failed !== wasFailed || JSON.stringify(good) !== before) onChange()
  }

  return {
    tick(approvedAt) {
      if (closed || running) return
      const now = Date.now()
      if (started && now - lastStart < GIT_EVERY_MS && approvedAt === lastInput) return
      started = true
      running = true
      lastStart = now
      lastInput = approvedAt
      void pass(approvedAt)
    },
    images: () => good.map((i) => ({ ...i })),
    failed: () => failed,
    async read(ref, p) {
      if (!good.some((i) => i.ref === ref && i.path === p)) return null
      try {
        return await git(repo, ['cat-file', 'blob', `${ref}:${p}`], IMAGE_MAX_BYTES)
      } catch {
        return null
      }
    },
    close() {
      closed = true
    },
  }
}
