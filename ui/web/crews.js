// The crew lines: one button per crew (stage, status, latest activity, QC verdict as words) that opens
// into its members' one-line status. DOM updates are keyed by crew slug and member name, and a node is
// touched only when its text changed, so 12 crews and 100 agents stay fast (R-14).
// View interface: mount(root, api) returns update(state).

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function setText(e, text) {
  if (e.textContent !== text) e.textContent = text
}

const STATUS_MARK = { planned: '○', running: '▶', merged: '✔', dropped: '✕' }
const QC_MARK = { PASS: '✔', FAIL: '✘' }

function qcText(qc) {
  if (!qc) return 'QC none yet'
  if (qc.verdict === 'PASS' || qc.verdict === 'FAIL') return 'QC ' + qc.verdict
  return 'QC no verdict'
}

function memberLine(m, isForeman) {
  const bits = []
  bits.push(m.name)
  if (isForeman) bits.push('(foreman)')
  bits.push(m.type || 'unknown type', m.model || 'unknown model', m.effort || 'unknown effort')
  bits.push(m.detail ? m.state + ' ' + m.detail : m.state)
  return bits.join(' · ')
}

export function mount(root) {
  root.replaceChildren()
  const heading = el('h2', 'region-title', 'Crews')
  heading.id = 'crews-heading'
  const goal = el('p', 'run-goal')
  const empty = el('p', 'empty', 'No run yet. Crews appear here when a plan exists.')
  const list = el('div', 'crew-list')
  root.append(heading, goal, empty, list)

  const rows = new Map()
  const open = new Set()
  let counter = 0
  let lastRun

  function makeRow(slug) {
    const id = 'crew-members-' + ++counter
    const wrap = el('div', 'crew')
    const btn = el('button', 'crew-line')
    btn.type = 'button'
    btn.setAttribute('aria-expanded', 'false')
    btn.setAttribute('aria-controls', id)
    const chevron = el('span', 'crew-chevron')
    chevron.setAttribute('aria-hidden', 'true')
    const slugEl = el('span', 'crew-slug', slug)
    const stage = el('span', 'crew-stage')
    const status = el('span', 'crew-status')
    const qc = el('span', 'crew-qc')
    const latest = el('span', 'crew-latest')
    btn.append(chevron, slugEl)
    for (const e of [stage, status, qc, latest]) { btn.append(document.createTextNode(' '), e) }
    const members = el('ul', 'members')
    members.id = id
    members.hidden = true
    wrap.append(btn, members)
    const row = { slug, wrap, btn, chevron, stage, status, qc, latest, members, sig: '', msig: '', items: new Map(), crew: null }
    btn.addEventListener('click', () => toggle(row))
    return row
  }

  function toggle(row) {
    const isOpen = !open.has(row.slug)
    if (isOpen) open.add(row.slug)
    else open.delete(row.slug)
    applyOpen(row)
  }

  function applyOpen(row) {
    const isOpen = open.has(row.slug)
    row.btn.setAttribute('aria-expanded', String(isOpen))
    setText(row.chevron, isOpen ? '▾' : '▸')
    row.members.hidden = !isOpen
    if (isOpen) renderMembers(row)
  }

  function renderMembers(row) {
    const crew = row.crew
    if (!crew) return
    const all = []
    if (crew.foreman) all.push([crew.foreman, true])
    for (const m of crew.members) all.push([m, false])
    const msig = JSON.stringify(all)
    if (msig === row.msig) return
    row.msig = msig
    const seen = new Set()
    all.forEach(([m, isForeman], i) => {
      seen.add(m.name)
      let li = row.items.get(m.name)
      if (!li) {
        li = el('li', 'member')
        row.items.set(m.name, li)
      }
      setText(li, memberLine(m, isForeman))
      if (row.members.children[i] !== li) row.members.insertBefore(li, row.members.children[i] || null)
    })
    for (const [name, li] of row.items) {
      if (!seen.has(name)) { li.remove(); row.items.delete(name) }
    }
  }

  function renderRow(row, crew) {
    row.crew = crew
    const latest = crew.latest ? crew.latest.text : 'no activity yet'
    const sig = JSON.stringify([crew.stage, crew.status, crew.qc, latest])
    if (sig !== row.sig) {
      row.sig = sig
      setText(row.stage, typeof crew.stage === 'number' ? 'Stage ' + crew.stage : 'No stage')
      const st = crew.status || 'not in plan'
      setText(row.status, (STATUS_MARK[crew.status] || '·') + ' ' + st)
      row.status.dataset.status = crew.status || 'none'
      const q = qcText(crew.qc)
      setText(row.qc, (crew.qc && QC_MARK[crew.qc.verdict] ? QC_MARK[crew.qc.verdict] + ' ' : '') + q)
      row.qc.dataset.verdict = crew.qc && crew.qc.verdict ? crew.qc.verdict : 'none'
      setText(row.latest, 'Latest: ' + latest)
    }
    if (open.has(row.slug)) renderMembers(row)
  }

  return function update(state) {
    if (state.run === lastRun) return
    lastRun = state.run
    const run = state.run
    const crews = run ? run.crews : []
    empty.hidden = crews.length > 0
    goal.hidden = !(run && run.goal)
    setText(goal, run && run.goal ? 'Goal: ' + run.goal : '')
    const seen = new Set()
    crews.forEach((crew, i) => {
      seen.add(crew.slug)
      let row = rows.get(crew.slug)
      if (!row) {
        row = makeRow(crew.slug)
        rows.set(crew.slug, row)
        applyOpen(row)
      }
      renderRow(row, crew)
      if (list.children[i] !== row.wrap) list.insertBefore(row.wrap, list.children[i] || null)
    })
    for (const [slug, row] of rows) {
      if (!seen.has(slug)) { row.wrap.remove(); rows.delete(slug) }
    }
  }
}
