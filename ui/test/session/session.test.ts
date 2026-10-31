// createSession tests before any send: none of these starts a live Claude session.
// ADR-0011 Decision 9 (Session, SessionControl, AnswerResult) and Decision 2 (status, close).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const uiDir = path.resolve(here, '../..')
const repoRoot = path.resolve(uiDir, '..')
const { createSession } = (await import(pathToFileURL(path.join(uiDir, 'server/session/index.ts')).href)) as any

function withSession(fn: (s: any) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-ui-session-'))
    const s = createSession({ repo: dir, pluginPath: repoRoot })
    try {
      await fn(s)
    } finally {
      await s.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

test('before any send the view is idle with no requests and no transcript', withSession((s) => {
  // Decision 2 status table: idle = "No session yet." Session starts at the first message.
  const v = s.view()
  assert.equal(v.session.status, 'idle')
  assert.deepEqual(v.requests, [])
  assert.deepEqual(v.transcript, [])
}))

test('send with empty text gives {ok:false, error:"text"}', withSession((s) => {
  // Decision 9: send(text) error 'text' | 'ended'
  assert.deepEqual(s.send(''), { ok: false, error: 'text' })
  assert.equal(s.view().session.status, 'idle', 'nothing started')
}))

test('answer to an unknown id gives "unknown"', withSession((s) => {
  // Decision 3: "An unknown id gives unknown"
  const r = s.answer('no-such-id', {})
  assert.equal(r.ok, false)
  assert.equal(r.error, 'unknown')
}))

test('subscribe returns an unsubscribe function', withSession((s) => {
  // Decision 9: subscribe(fn): () => void
  const off = s.subscribe(() => {})
  assert.equal(typeof off, 'function')
  off()
  off()
}))

test('close resolves, and send after close gives "ended"', async () => {
  // Decision 9: send error 'ended'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'truss-ui-session-'))
  try {
    const s = createSession({ repo: dir, pluginPath: repoRoot })
    await s.close()
    assert.deepEqual(s.send('hi'), { ok: false, error: 'ended' })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
