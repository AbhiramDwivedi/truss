// Decisions and ADRs panel, design panel (R-5, R-6). Each is a disclosure: a button (aria-expanded) in a
// heading that shows or hides its body. Both start open. Markdown is rendered by markdown.js, which loads
// marked the first time the design panel has something to show.
// View interface: mount(root, api) returns update(state).
import { renderMarkdown } from './markdown.js'

function el(tag, className, text) {
  const e = document.createElement(tag)
  if (className) e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

let counter = 0

// A titled section whose button opens and closes its body. Returns { section, body, isOpen }.
function disclosure(title, onOpen) {
  const id = 'panel-body-' + ++counter
  const section = el('section', 'panel')
  const heading = el('h2', 'panel-title')
  const btn = el('button', 'panel-toggle')
  btn.type = 'button'
  btn.setAttribute('aria-expanded', 'true')
  btn.setAttribute('aria-controls', id)
  const mark = el('span', 'panel-mark')
  mark.setAttribute('aria-hidden', 'true')
  mark.textContent = '▾'
  btn.append(mark, document.createTextNode(title))
  heading.append(btn)
  const body = el('div', 'panel-body')
  body.id = id
  section.append(heading, body)
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true'
    btn.setAttribute('aria-expanded', String(open))
    body.hidden = !open
    mark.textContent = open ? '▾' : '▸'
    if (open && onOpen) onOpen()
  })
  return { section, body, isOpen: () => btn.getAttribute('aria-expanded') === 'true' }
}

function decisionsPanel() {
  const d = disclosure('Decisions and ADRs')
  d.section.id = 'decisions-panel'
  d.section.tabIndex = -1
  const h3a = el('h3', 'panel-sub', 'Decisions')
  const noDecisions = el('p', 'empty', 'No decisions recorded yet.')
  const decisionBox = el('div', 'entry-groups')
  const h3b = el('h3', 'panel-sub', 'ADRs')
  const noAdrs = el('p', 'empty', 'No ADR files found.')
  const adrList = el('ul', 'entry-list')
  adrList.setAttribute('aria-label', 'ADRs')
  d.body.append(h3a, noDecisions, decisionBox, h3b, noAdrs, adrList)

  let lastDecisions
  let lastAdrs
  function update(state) {
    const decisions = state.decisions || []
    const sigD = JSON.stringify(decisions)
    if (sigD !== lastDecisions) {
      lastDecisions = sigD
      noDecisions.hidden = decisions.length > 0
      // One list per run heading, in file order. The text sits directly in the item, which carries it as its name.
      const groups = []
      let current
      for (const x of decisions) {
        const run = x.run == null ? '' : x.run
        if (!current || current.run !== run) {
          const box = el('div', 'entry-group')
          if (run) box.append(el('h4', 'entry-run', 'Run ' + run))
          const ul = el('ul', 'entry-list')
          ul.setAttribute('aria-label', run ? 'Decisions of run ' + run : 'Decisions')
          box.append(ul)
          current = { run, box, ul }
          groups.push(box)
        }
        const li = el('li', 'entry decision', x.text)
        li.setAttribute('aria-label', x.text.replace(/\s*\n\s*/g, ' '))
        current.ul.append(li)
      }
      decisionBox.replaceChildren(...groups)
    }
    const adrs = state.adrs || []
    const sigA = JSON.stringify(adrs)
    if (sigA !== lastAdrs) {
      lastAdrs = sigA
      noAdrs.hidden = adrs.length > 0
      const items = adrs.map((x) => {
        const li = el('li', 'entry adr')
        const status = x.status ? 'Status: ' + x.status : 'Status: not stated'
        li.setAttribute('aria-label', x.title + ', ' + status)
        li.append(el('span', 'entry-text', x.title), el('span', 'entry-status', status), el('span', 'entry-meta', x.file))
        return li
      })
      adrList.replaceChildren(...items)
    }
  }
  return { section: d.section, update }
}

function imageUrl(img) {
  return new URL('/api/image?' + new URLSearchParams({ ref: img.ref, path: img.path }).toString(), location.href).href
}

function designPanel() {
  const d = disclosure('Design', () => update.last && update(update.last))
  d.section.id = 'design-panel'
  d.section.tabIndex = -1
  const empty = el('p', 'empty', 'No plan, architecture doc or images yet.')

  const planSec = el('section', 'design-sec')
  const planTitle = el('h3', 'panel-sub', 'Plan')
  const planDoc = el('div', 'md')
  planSec.append(planTitle, planDoc)

  const archSec = el('section', 'design-sec')
  const archTitle = el('h3', 'panel-sub')
  const archDoc = el('div', 'md')
  archSec.append(archTitle, archDoc)

  const imgSec = el('section', 'design-sec')
  imgSec.append(el('h3', 'panel-sub', 'Images the run built'))
  const imgList = el('ul', 'image-list')
  imgList.setAttribute('aria-label', 'Images the run built')
  imgSec.append(imgList)

  d.body.append(empty, planSec, archSec, imgSec)

  let lastPlan = null
  let lastArch = null
  const figures = new Map()

  function update(state) {
    update.last = state
    const design = state.design || { planMd: null, architecture: null, images: [] }
    const hasPlan = design.planMd != null
    const hasArch = design.architecture != null
    const images = design.images || []
    empty.hidden = hasPlan || hasArch || images.length > 0
    planSec.hidden = !hasPlan
    archSec.hidden = !hasArch
    imgSec.hidden = images.length === 0
    // Nothing is rendered, and marked isn't loaded, while the panel is closed.
    if (!d.isOpen()) return

    if (hasPlan && design.planMd !== lastPlan) {
      lastPlan = design.planMd
      renderMarkdown(planDoc, design.planMd)
    }
    if (hasArch) {
      const a = design.architecture
      if (archTitle.textContent !== 'Architecture: ' + a.path) archTitle.textContent = 'Architecture: ' + a.path
      if (a.markdown !== lastArch) {
        lastArch = a.markdown
        renderMarkdown(archDoc, a.markdown)
      }
    }

    const keep = new Set()
    images.forEach((img, i) => {
      const key = img.ref + '\n' + img.path
      keep.add(key)
      let li = figures.get(key)
      if (!li) {
        li = el('li', 'image-item')
        const fig = el('figure', 'image-fig')
        const pic = el('img', 'image-pic')
        pic.alt = img.path + ' (built on ' + img.ref + ')'
        pic.src = imageUrl(img)
        fig.append(pic, el('figcaption', 'image-cap', img.path + ' (' + img.ref + ')'))
        li.append(fig)
        figures.set(key, li)
      }
      if (imgList.children[i] !== li) imgList.insertBefore(li, imgList.children[i] || null)
    })
    for (const [key, li] of figures) {
      if (!keep.has(key)) { li.remove(); figures.delete(key) }
    }
  }
  return { section: d.section, update }
}

export function mount(root, api) {
  void api
  root.replaceChildren()
  const decisions = decisionsPanel()
  const design = designPanel()
  root.append(decisions.section, design.section)
  return function update(state) {
    decisions.update(state)
    design.update(state)
  }
}
