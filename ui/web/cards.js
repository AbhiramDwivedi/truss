// Goal and message box and the three request cards (ADR-0011 Decisions 3 and 6; R-3, R-7, R-15).
// View interface: mount(root, api) returns update(state). api has sendMessage(text) and answerRequest(id, body).
// Every control is a native form control with a text label; status is always said in words.

const MAX_SETTLED = 20

const CANCEL_WORDS = {
  aborted: 'the request was aborted, so the session stopped waiting for an answer',
  superseded: 'it was replaced: the session started a turn on its own',
  ended: 'the session ended while the request was open',
}

function el(tag, props, ...kids) {
  const node = document.createElement(tag)
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === 'text') node.textContent = v
      else if (k === 'class') node.className = v
      else if (v === true) node.setAttribute(k, '')
      else if (v !== false && v != null) node.setAttribute(k, v)
    }
  }
  for (const kid of kids) if (kid != null) node.append(kid)
  return node
}

let uid = 0
function nextId(prefix) {
  uid += 1
  return prefix + '-' + uid
}

// ---- goal and message box -----------------------------------------------------------------------------

function mountMessageBox(root, api) {
  const textId = nextId('msg')
  const hintId = nextId('msg-hint')
  const statusId = nextId('msg-status')
  const label = el('label', { for: textId, class: 'msg-label', text: 'Goal or message' })
  const hint = el('p', { id: hintId, class: 'msg-hint', text: 'Write the goal to start the session, or a message once it runs. Press Ctrl+Enter to send.' })
  const box = el('textarea', { id: textId, class: 'msg-text', rows: '3', 'aria-describedby': hintId + ' ' + statusId })
  const button = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Send' })
  const status = el('p', { id: statusId, class: 'msg-status', role: 'status' })
  const form = el('form', { class: 'msg-form' }, label, hint, box, el('div', { class: 'btn-row' }, button), status)
  const title = el('h2', { class: 'region-title', text: 'Goal and message' })
  const holder = el('div', { class: 'msg' }, title, form)
  let busy = false
  let replyOpen = false
  let ended = false

  function paintHint() {
    const parts = ['Write the goal to start the session, or a message once it runs. Press Ctrl+Enter to send.']
    if (replyOpen) parts.push('A reply request is open: what you send here answers it.')
    if (ended) parts.push('The session has ended; new messages cannot be sent.')
    hint.textContent = parts.join(' ')
  }

  async function send() {
    if (busy) return
    const text = box.value
    if (text.trim() === '') {
      status.textContent = 'Nothing to send: type a goal or message first.'
      box.focus()
      return
    }
    busy = true
    button.disabled = true
    box.readOnly = true
    status.textContent = 'Sending...'
    const res = await api.sendMessage(text)
    busy = false
    button.disabled = false
    box.readOnly = false
    if (res.status === 202 || res.status === 200) {
      box.value = ''
      grow()
      status.textContent = 'Sent.'
    } else if (res.status === 409) {
      status.textContent = 'The session has ended, so the message was not sent. Your text is still in the box.'
    } else if (res.status === 400) {
      status.textContent = 'The server refused an empty message. Type something first.'
    } else if (res.status === 0) {
      status.textContent = 'Could not reach the server; the message was not sent. Try again.'
    } else {
      status.textContent = 'The message was not sent (server answered ' + res.status + '). Try again.'
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); send() })
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
  })
  root.append(holder)

  function grow() {
    box.style.height = 'auto'
    const edge = box.offsetHeight - box.clientHeight
    box.style.height = (box.scrollHeight + edge) + 'px'
  }
  box.addEventListener('input', grow)

  update.focusBox = () => box.focus()
  function update(state) {
    const s = state.session || {}
    const open = (state.requests || []).some((r) => r.kind === 'reply' && r.status === 'open')
    const over = s.status === 'ended'
    if (open !== replyOpen || over !== ended) {
      replyOpen = open
      ended = over
      paintHint()
    }
  }
  return update
}

// ---- request cards ------------------------------------------------------------------------------------

function cancelWords(r) {
  return 'Cancelled: ' + (CANCEL_WORDS[r.cancelReason] || 'the request was cancelled') + '.'
}

function kindTitle(r) {
  if (r.kind === 'question') return 'Question from Claude'
  if (r.kind === 'permission') return 'Approval needed: ' + r.toolName
  return 'Reply needed'
}

function dl(rows) {
  const list = el('dl', { class: 'card-facts' })
  for (const [k, v, code] of rows) {
    if (v == null || v === '') continue
    const dd = el('dd', { class: code ? 'card-code' : null })
    if (code) dd.append(el('code', { text: v }))
    else dd.textContent = v
    list.append(el('dt', { text: k }), dd)
  }
  return list
}

function answeredText(r, sent) {
  // What the card says once answered: from the server's record, else from what this page just sent.
  if (r.kind === 'question') {
    const answers = r.answers || (sent && sent.answers) || {}
    const out = el('div', { class: 'card-result' }, el('p', null, el('strong', { text: 'Answered.' })))
    for (const q of r.questions) {
      const a = answers[q.question]
      out.append(el('p', null, el('strong', { text: q.header + ': ' }), a == null ? '(no answer recorded)' : a))
    }
    return out
  }
  const decision = r.decision || (sent && sent.decision)
  const message = r.message != null && r.message !== '' ? r.message : (sent && sent.message) || ''
  let words
  if (decision === 'allow') words = 'approved'
  else if (decision === 'deny') words = 'denied'
  else if (decision === 'message') words = 'replied with a message'
  else words = 'answered'
  const out = el('div', { class: 'card-result' }, el('p', null, el('strong', { text: 'Answered: ' + words + '.' })))
  if (message) out.append(el('p', { class: 'card-sent', text: 'Sent: ' + message }))
  return out
}

function buildCard(r, api, local) {
  const titleId = nextId('card-title')
  const card = el('article', { class: 'card card-' + r.kind, 'aria-labelledby': titleId, 'data-status': r.status })
  const settled = r.status !== 'open' || local.sent
  const head = el('h3', { id: titleId, class: 'card-title', text: kindTitle(r) })
  card.append(head)

  // Body: what is being asked.
  if (r.kind === 'permission') {
    if (r.title && r.title !== r.toolName) card.append(el('p', { class: 'card-sub', text: r.title }))
    card.append(dl([
      ['Tool', r.toolName],
      [r.toolName === 'Bash' ? 'Command' : 'Summary', r.summary, true],
      ['Why it asked', r.decisionReason],
      ['Blocked path', r.blockedPath, true],
    ]))
  } else if (r.kind === 'reply') {
    const lines = []
    if (r.isError) lines.push(el('p', { class: 'card-flag', text: 'Error: the turn ended with an error.' }))
    card.append(...lines)
    card.append(el('div', { class: 'card-text', text: r.text }))
    if (r.backgroundTasks > 0) {
      card.append(el('p', { class: 'card-note', text: r.backgroundTasks + ' background task' + (r.backgroundTasks === 1 ? '' : 's') + ' running when the turn ended; the session may start a turn on its own.' }))
    }
  }

  if (r.status === 'cancelled') {
    card.append(el('p', { class: 'card-state', role: 'status', text: cancelWords(r) }))
    if (r.kind === 'question') card.append(questionRecap(r))
    return card
  }
  if (settled) {
    card.append(el('div', { class: 'card-state', role: 'status' }, answeredText(r, local.sent)))
    if (r.kind === 'question' && !(r.answers || (local.sent && local.sent.answers))) card.append(questionRecap(r))
    return card
  }

  // Open: controls.
  const live = el('p', { class: 'card-error', role: 'alert' })
  const controls = []
  async function post(body, sent) {
    if (local.busy) return
    local.busy = true
    for (const c of controls) c.disabled = true
    live.textContent = ''
    const res = await api.answerRequest(r.id, body)
    local.busy = false
    if (res.status === 200 || (res.status === 409 && res.body && res.body.error === 'answered')) {
      local.sent = sent
      local.rebuild()
      return
    }
    if (res.status === 409 && res.body && res.body.error === 'cancelled') {
      local.cancelled = true
      local.rebuild()
      return
    }
    for (const c of controls) c.disabled = false
    if (res.status === 404) live.textContent = 'This request no longer exists on the server, so it could not be answered.'
    else if (res.status === 400) live.textContent = 'The server did not accept that answer. Check it and try again.'
    else if (res.status === 0) live.textContent = 'Could not reach the server; nothing was sent. Try again.'
    else live.textContent = 'The answer was not accepted (server answered ' + res.status + '). Try again.'
  }

  if (r.kind === 'question') {
    const form = el('form', { class: 'q-form' })
    const readers = []
    r.questions.forEach((q, qi) => {
      const group = nextId('q')
      const legendId = nextId('q-legend')
      const legendKids = [el('strong', { class: 'q-header', text: q.header }), ' ', el('span', { class: 'q-text', text: q.question })]
      let fs
      if (q.multiSelect) {
        fs = el('fieldset', { class: 'q-set' })
        fs.append(el('legend', { class: 'q-legend' }, ...legendKids))
      } else {
        // A radiogroup, not a fieldset: the card, not each question, is the group that holds the submit button.
        fs = el('div', { class: 'q-set', role: 'radiogroup', 'aria-labelledby': legendId })
        fs.append(el('div', { id: legendId, class: 'q-legend' }, ...legendKids))
      }
      const type = q.multiSelect ? 'checkbox' : 'radio'
      if (q.multiSelect) fs.append(el('p', { class: 'q-hint', text: 'Choose any number.' }))
      const inputs = []
      const sorted = q.options.filter((o) => o.recommended).concat(q.options.filter((o) => !o.recommended))
      for (const o of sorted) {
        const input = el('input', { type, name: group, value: o.label })
        inputs.push(input)
        controls.push(input)
        const text = el('span', { class: 'q-opt' }, el('span', { class: 'q-label', text: o.label }))
        if (o.description) text.append(el('span', { class: 'q-desc', text: o.description }))
        fs.append(el('label', { class: 'q-row' + (o.recommended ? ' q-rec' : '') }, input, text))
      }
      const ownId = nextId('own')
      const own = el('input', { type: 'text', id: ownId, class: 'q-own', 'aria-label': 'Your own answer for ' + q.header, autocomplete: 'off' })
      let other = null
      if (q.multiSelect) {
        // Checkbox count stays equal to the options; typed text is simply added to the picks.
        controls.push(own)
        fs.append(el('div', { class: 'q-row q-other' }, el('label', { class: 'q-other-label', for: ownId, text: 'Other: type your own answer (optional)' }), own))
      } else {
        other = el('input', { type: 'radio', name: group, value: '' })
        own.addEventListener('input', () => { if (own.value !== '' && !other.checked) other.checked = true })
        controls.push(other, own)
        fs.append(el('div', { class: 'q-row q-other' }, el('label', { class: 'q-other-label' }, other, el('span', { class: 'q-label', text: 'Other: type your own answer' })), own))
      }
      form.append(fs)
      readers.push(() => {
        const picked = []
        for (const i of inputs) if (i.checked) picked.push(i.value)
        if ((other ? other.checked : true) && own.value.trim() !== '') picked.push(own.value.trim())
        if (picked.length === 0) return { missing: true, focus: inputs[0] || own }
        return { key: q.question, value: picked.join(', ') }
      })
      void qi
    })
    const submit = el('button', { type: 'submit', class: 'btn btn-primary', text: 'Submit answers' })
    controls.push(submit)
    form.append(el('div', { class: 'btn-row' }, submit), live)
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const answers = {}
      for (const read of readers) {
        const got = read()
        if (got.missing) {
          live.textContent = 'Answer every question before submitting: choose an option or type your own.'
          got.focus.focus()
          return
        }
        answers[got.key] = got.value
      }
      post({ answers }, { answers })
    })
    card.append(form)
    return card
  }

  // permission and reply
  const noteId = nextId('note')
  const note = el('input', { type: 'text', id: noteId, autocomplete: 'off' })
  const noteLabel = el('label', { for: noteId, class: 'card-note-label', text: r.kind === 'reply' ? 'Optional note to send with your decision' : 'Optional note to send with a denial' })
  const approve = el('button', { type: 'button', class: 'btn btn-primary', text: 'Approve' })
  const deny = el('button', { type: 'button', class: 'btn', text: 'Deny' })
  controls.push(note, approve, deny)
  const decide = (decision) => () => {
    const message = note.value.trim()
    const body = message === '' ? { decision } : { decision, message }
    post(body, { decision, message })
  }
  approve.addEventListener('click', decide('allow'))
  deny.addEventListener('click', decide('deny'))
  if (r.kind === 'permission') {
    noteLabel.textContent = 'Optional note to send with your decision'
  }
  card.append(el('div', { class: 'card-note-row' }, noteLabel, note), el('div', { class: 'btn-row' }, approve, deny), live)
  return card
}

function questionRecap(r) {
  const out = el('div', { class: 'card-recap' })
  for (const q of r.questions) out.append(el('p', null, el('strong', { text: q.header + ': ' }), q.question))
  return out
}

function mountCards(root, api, focusGoal) {
  const title = el('h2', { class: 'region-title', text: 'Requests' })
  const empty = el('p', { class: 'empty', text: 'No requests from Claude right now.' })
  const openList = el('div', { class: 'card-list', 'aria-label': 'Open requests' })
  const settledHead = el('h3', { class: 'card-group-title', text: 'Earlier requests' })
  const settledList = el('div', { class: 'card-list card-list-settled', 'aria-label': 'Earlier requests' })
  root.append(title, empty, openList, settledHead, settledList)
  const items = new Map() // id -> { node, sig, local }
  let last
  let lastSig = ''
  const bgLine = el('p', { class: 'bg-line', role: 'status' })
  bgLine.hidden = true
  root.insertBefore(bgLine, empty)

  // After an answered card leaves the open list: the next open card's first enabled control, else the goal box.
  function focusNext(except) {
    for (const card of openList.children) {
      if (card === except) continue
      const c = card.querySelector('input:not(:disabled), button:not(:disabled), textarea:not(:disabled)')
      if (c) { c.focus(); return }
    }
    if (focusGoal) focusGoal()
  }

  function place(list, wanted) {
    wanted.forEach((node, i) => {
      if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null)
    })
    while (list.children.length > wanted.length) list.lastChild.remove()
  }

  function paint(requests) {
    const open = []
    const settled = []
    const keep = new Set()
    // Settled ones: newest first, capped.
    const ordered = requests.slice()
    const shownSettled = new Set(
      ordered.filter((r) => r.status !== 'open').reverse().slice(0, MAX_SETTLED).map((r) => r.id),
    )
    for (const r of ordered) {
      const isOpen = r.status === 'open'
      if (!isOpen && !shownSettled.has(r.id)) continue
      keep.add(r.id)
      let item = items.get(r.id)
      const sig = JSON.stringify(r)
      if (!item) {
        item = { node: null, sig: '', local: { busy: false, sent: null, cancelled: false, rebuild: null } }
        items.set(r.id, item)
      }
      const it = item
      it.local.rebuild = () => {
        const fresh = buildCard(it.request, api, it.local)
        fresh.dataset.rid = it.request.id
        const a = document.activeElement
        const lostFocus = !a || a === document.body || (it.node && it.node.contains(a))
        if (it.node && it.node.parentNode) it.node.replaceWith(fresh)
        it.node = fresh
        if (lostFocus) focusNext(fresh)
      }
      if (it.sig !== sig) {
        it.request = it.local.cancelled && r.status === 'open' ? { ...r, status: 'cancelled', cancelReason: r.cancelReason || null } : r
        it.sig = sig
        const fresh = buildCard(it.request, api, it.local)
        fresh.dataset.rid = r.id
        if (it.node && it.node.parentNode) it.node.replaceWith(fresh)
        it.node = fresh
      }
      const stillOpenHere = isOpen && !it.local.sent && !it.local.cancelled
      if (stillOpenHere) open.push(it.node)
      else settled.push({ node: it.node, r })
    }
    for (const [id, item] of items) {
      if (!keep.has(id)) { item.node.remove(); items.delete(id) }
    }
    settled.reverse()
    place(openList, open)
    place(settledList, settled.map((s) => s.node))
    empty.hidden = open.length > 0 || settled.length > 0
    settledHead.hidden = settled.length === 0
    settledList.hidden = settled.length === 0
    openList.hidden = open.length === 0
  }

  return function update(state) {
    const reqs = state.requests || []
    const s = state.session || {}
    const tasks = Array.isArray(s.backgroundTasks) ? s.backgroundTasks.length : (s.backgroundTasks || 0)
    const replyOpen = reqs.some((r) => r.kind === 'reply' && r.status === 'open')
    const showBg = s.status === 'waiting' && tasks > 0 && !replyOpen
    bgLine.hidden = !showBg
    bgLine.textContent = showBg ? 'Agents still running; nothing needed from you' : ''
    if (reqs === last) return
    last = reqs
    paint(reqs)
  }
}

export function mount(root, api) {
  root.replaceChildren()
  // The wrapper is not a named landmark: each card and the message form carry their own names, and a
  // region around every card would stand in for the card itself to assistive tech and to tests that look for one.
  root.removeAttribute('aria-label')
  const messageHost = el('div', { class: 'cards-message' })
  const cardsHost = el('div', { class: 'cards-requests' })
  root.append(messageHost, cardsHost)
  const updateMessage = mountMessageBox(messageHost, api)
  const updateCards = mountCards(cardsHost, api, () => updateMessage.focusBox())
  return function update(state) {
    updateMessage(state)
    updateCards(state)
  }
}
