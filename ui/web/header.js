// The header: model, session status in words, cost and per-model usage, background tasks, notices.
// View interface: mount(root, api) returns update(state).

const STATUS_WORDS = {
  idle: 'idle (no session yet)',
  running: 'running',
  waiting: 'waiting for input',
  ended: 'ended',
  error: 'error',
}
const CONNECTION_WORDS = {
  connecting: 'connecting',
  live: 'live',
  reconnecting: 'reconnecting',
}

const num = (n) => Number(n || 0).toLocaleString('en-US')

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function setText(e, text) {
  if (e.textContent !== text) e.textContent = text
}

function costText(usd) {
  if (typeof usd !== 'number') return ''
  return '$' + usd.toFixed(Math.abs(usd) < 0.01 && usd !== 0 ? 4 : 2)
}

// Notices: conditions the page states in words (a missing config, a Truss dir not on disk yet).
export function mountNotices(root) {
  root.replaceChildren()
  const list = el('ul', 'notice-list')
  root.append(list)
  root.hidden = true
  let last
  return function update(state) {
    if (state.notices === last) return
    last = state.notices
    const items = last || []
    root.hidden = items.length === 0
    const have = new Map(Array.from(list.children).map((li) => [li.dataset.id, li]))
    const seen = new Set()
    items.forEach((n, i) => {
      seen.add(n.id)
      let li = have.get(n.id)
      if (!li) {
        li = el('li', 'notice')
        li.dataset.id = n.id
        const tag = el('strong', 'notice-tag', 'Notice: ')
        const text = el('span', 'notice-text')
        li.append(tag, text)
      }
      setText(li.lastChild, n.text)
      if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null)
    })
    for (const [id, li] of have) if (!seen.has(id)) li.remove()
  }
}

export function mount(root) {
  root.replaceChildren()
  const bar = el('div', 'hdr-bar')
  const title = el('h1', 'hdr-title', 'Truss')
  const facts = el('dl', 'hdr-facts')
  bar.append(title, facts)
  const errorLine = el('p', 'hdr-error')
  errorLine.hidden = true
  const usageList = el('ul', 'hdr-usage')
  usageList.setAttribute('aria-label', 'Usage per model')
  usageList.hidden = true
  root.append(bar, errorLine, usageList)

  function fact(name) {
    const wrap = el('div', 'hdr-fact')
    const dt = el('dt', 'hdr-label', name)
    const dd = el('dd', 'hdr-value')
    wrap.append(dt, ' ', dd, ' ')
    facts.append(wrap)
    return { wrap, dd }
  }
  const model = fact('Model')
  const status = fact('Session')
  const cost = fact('Cost')
  const tasks = fact('Tasks')
  const link = fact('Connection')

  let lastSession
  let lastConnection

  return function update(state) {
    const s = state.session
    if (s !== lastSession) {
      lastSession = s
      setText(model.dd, s && s.model ? s.model : 'not reported yet')
      const word = STATUS_WORDS[s && s.status] || (s && s.status) || 'unknown'
      setText(status.dd, word)
      status.dd.dataset.status = (s && s.status) || 'unknown'
      const u = s && s.usage
      cost.wrap.hidden = !(u && typeof u.costUsd === 'number')
      setText(cost.dd, u ? costText(u.costUsd) : '')
      const n = s && s.backgroundTasks ? s.backgroundTasks.length : 0
      setText(tasks.dd, n + (n === 1 ? ' background task' : ' background tasks'))
      const hasError = s && s.status === 'error' && s.error
      errorLine.hidden = !hasError
      setText(errorLine, hasError ? 'Session error: ' + s.error : '')
      renderUsage(u)
    }
    if (state.connection !== lastConnection) {
      lastConnection = state.connection
      setText(link.dd, CONNECTION_WORDS[state.connection] || 'connecting')
      link.dd.dataset.status = state.connection || 'connecting'
    }
  }

  function renderUsage(u) {
    const models = u && u.models ? Object.keys(u.models) : []
    usageList.hidden = models.length === 0
    const lines = models.map((m) => {
      const c = u.models[m]
      return m + ': ' + num(c.inputTokens) + ' in, ' + num(c.outputTokens) + ' out, ' +
        num(c.cacheReadInputTokens) + ' cache read, ' + num(c.cacheCreationInputTokens) + ' cache write'
    })
    const have = Array.from(usageList.children)
    lines.forEach((text, i) => {
      if (have[i]) setText(have[i], text)
      else usageList.append(el('li', 'hdr-usage-item', text), ' ')
    })
    for (let i = have.length - 1; i >= lines.length; i--) have[i].remove()
  }
}
