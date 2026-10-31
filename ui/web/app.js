// Page wiring: the SSE connection, the model, and each view's update (ADR-0011 Decision 5).
// Every view module exports mount(root, api) returning update(state).
import { api } from './api.js'
import { applyDelta, applySnapshot, emptyModel } from './state.js'
import * as header from './header.js'
import * as crews from './crews.js'
import * as retro from './retro.js'
import * as cards from './cards.js'
import * as panels from './panels.js'

function byId(id) {
  return document.getElementById(id)
}

// The conversation: the user's messages and the session's text, keyed by entry number.
function mountTranscript(root) {
  root.replaceChildren()
  const title = document.createElement('h2')
  title.className = 'region-title'
  title.textContent = 'Conversation'
  const log = document.createElement('div')
  log.className = 'transcript'
  log.setAttribute('role', 'log')
  log.setAttribute('aria-label', 'Conversation log')
  const empty = document.createElement('p')
  empty.className = 'empty'
  empty.textContent = 'Nothing said yet.'
  root.append(title, empty, log)
  const WHO = { user: 'You', assistant: 'Claude', error: 'Error' }
  const items = new Map()
  let last
  return function update(state) {
    if (state.transcript === last) return
    last = state.transcript
    const list = last || []
    empty.hidden = list.length > 0
    const keep = new Set()
    list.forEach((entry, i) => {
      keep.add(entry.n)
      let item = items.get(entry.n)
      if (item && item.ts !== entry.ts) { item.node.remove(); items.delete(entry.n); item = null }
      if (!item) {
        const node = document.createElement('p')
        node.className = 'say say-' + entry.role
        const who = document.createElement('strong')
        who.className = 'say-who'
        who.textContent = (WHO[entry.role] || entry.role) + ': '
        const text = document.createElement('span')
        text.className = 'say-text'
        text.textContent = entry.text
        node.append(who, text)
        item = { node, ts: entry.ts }
        items.set(entry.n, item)
      }
      if (log.children[i] !== item.node) log.insertBefore(item.node, log.children[i] || null)
    })
    for (const [n, item] of items) {
      if (!keep.has(n)) { item.node.remove(); items.delete(n) }
    }
  }
}

const views = [
  header.mount(byId('app-header'), api),
  header.mountNotices(byId('notices')),
  cards.mount(byId('cards-region'), api),
  mountTranscript(byId('transcript')),
  crews.mount(byId('crews'), api),
  retro.mount(byId('retro'), api),
  panels.mount(byId('panels'), api),
]

let model = emptyModel()
let connection = 'connecting'

function render() {
  if (!model.state) return
  const view = { ...model.state, connection }
  for (const update of views) update(view)
}

// A v other than 1, or a gap in seq, means this page can't follow the stream: reload for a fresh snapshot.
// Once per few seconds at most, so a server that keeps sending v 2 doesn't loop.
function reloadPage() {
  try {
    const at = Number(sessionStorage.getItem('truss-ui-reload') || 0)
    if (Date.now() - at < 5000) return
    sessionStorage.setItem('truss-ui-reload', String(Date.now()))
  } catch { /* storage may be blocked */ }
  location.reload()
}

function parse(e) {
  try { return JSON.parse(e.data) } catch { return null }
}

let source = null
let retryTimer = null

function connect() {
  clearTimeout(retryTimer)
  if (source) source.close()
  const es = new EventSource('/api/events')
  source = es
  es.addEventListener('open', () => { connection = 'live'; render() })
  es.addEventListener('snapshot', (e) => {
    const msg = parse(e)
    if (!msg) return
    const r = applySnapshot(model, msg)
    if (r.kind === 'reload') return reloadPage()
    model = r.model
    connection = 'live'
    render()
  })
  es.addEventListener('delta', (e) => {
    const msg = parse(e)
    if (!msg) return
    const r = applyDelta(model, msg)
    if (r.kind === 'gap') return reloadPage()
    if (r.kind === 'stale') return
    model = r.model
    render()
  })
  es.addEventListener('error', () => {
    connection = 'reconnecting'
    render()
    // The browser reconnects by itself with Last-Event-ID. If it gave up, start over (a fresh snapshot).
    if (es.readyState === EventSource.CLOSED && source === es) {
      retryTimer = setTimeout(connect, 1000)
    }
  })
}

connect()
