// The header says agents are still running when the session waits with background tasks and no open request
// (checker-6, ADR-0014). Rendered through the real Banner.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import React from 'react'
import { createRenderer, uiDir, type Renderer } from '../../test/render.ts'

const LINE = 'Agents still running; nothing needed from you'
const NOW = Date.parse('2026-11-02T12:00:00.000Z')
const base: any = JSON.parse(fs.readFileSync(path.join(uiDir, 'contract', 'fixtures', 'rework', 'live', 'state.json'), 'utf8'))
const task = { id: 't1', description: 'build', startedAt: '2026-11-02T11:00:00.000Z' }

let r: Renderer
before(async () => { r = await createRenderer() })
after(async () => { await r?.close() })

async function html(session: Record<string, unknown>, requests: unknown[]): Promise<string> {
  const mod = await r.load('views/shell/Banner.tsx')
  const state = { ...base, requests, session: { ...base.session, ...session } }
  return r.render(React.createElement(mod['Banner'], { state, now: NOW, connection: 'live' }))
}

test('Banner: waiting with background tasks and no open request says agents are still running', async () => {
  assert.ok((await html({ status: 'waiting', backgroundTasks: [task] }, [])).includes(LINE))
})

test('Banner: an open request hides the line', async () => {
  const open = { id: 'q1', kind: 'question', status: 'open' }
  assert.ok(!(await html({ status: 'waiting', backgroundTasks: [task] }, [open])).includes(LINE))
})

test('Banner: no background tasks, or a running session, hides the line', async () => {
  assert.ok(!(await html({ status: 'waiting', backgroundTasks: [] }, [])).includes(LINE))
  assert.ok(!(await html({ status: 'running', backgroundTasks: [task] }, [])).includes(LINE))
})
