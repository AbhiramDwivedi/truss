// The retro stage lane: the steps of the self-improving retro (extract, judges, triage, fix goal, fixes
// applied) as a list after the crew lanes. It only displays state.retro; it never writes plugin state.
// DOM updates are keyed by step and a node is touched only when its text changed.
// View interface: mount(root, api) returns update(state).

const STEPS = [
  ['extract', 'Extract'],
  ['judges', 'Judges'],
  ['triage', 'Triage'],
  ['fixGoal', 'Fix goal'],
  ['applied', 'Fixes applied'],
]
const MARK = { pending: '○', running: '▶', done: '✔', failed: '✘', skipped: '–' }

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}
function setText(e, text) {
  if (e.textContent !== text) e.textContent = text
}
function setAttr(e, name, value) {
  if (e.getAttribute(name) !== value) e.setAttribute(name, value)
}

export function mount(root) {
  root.replaceChildren()
  root.hidden = true
  const heading = el('h2', 'region-title', 'Retro')
  heading.id = 'retro-heading'
  const list = el('ul', 'retro-steps')
  root.append(heading, list)

  const rows = new Map()
  for (const [key, label] of STEPS) {
    const li = el('li', 'retro-step')
    const status = el('span', 'retro-status')
    const name = el('span', 'retro-name', label)
    const detail = el('span', 'retro-detail')
    detail.hidden = true
    li.append(status, document.createTextNode(' '), name, document.createTextNode(' '), detail)
    list.append(li)
    rows.set(key, { label, li, status, detail })
  }
  let last

  return function update(state) {
    if (state.retro === last) return
    last = state.retro
    const retro = state.retro
    if (!retro) {
      if (!root.hidden) root.hidden = true
      return
    }
    if (root.hidden) root.hidden = false
    for (const [key, row] of rows) {
      const step = retro.steps[key]
      const st = step.status
      setAttr(row.li, 'aria-label', row.label + ': ' + st)
      row.li.dataset.status = st
      setText(row.status, (MARK[st] || '·') + ' ' + st)
      const d = step.detail
      const text = d == null ? '' : d
      setText(row.detail, text)
      row.detail.hidden = d == null
    }
  }
}
