// The tab title and opt-in desktop notifications (ADR-0014).
// Title: "(<open requests>) Truss", plain "Truss" at 0.
// Notifications: asked for only on a click, then one per newly opened question or permission request.
// Never for reply requests or session status.
const NOTIFY_KINDS = new Set(['question', 'permission'])

function supported() {
  return typeof window.Notification === 'function'
}

function permission() {
  try { return window.Notification.permission } catch { return 'default' }
}

export function mount(root) {
  root.replaceChildren()
  const title = document.createElement('h2')
  title.className = 'region-title'
  title.textContent = 'Desktop notifications'
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'btn'
  button.textContent = 'Enable desktop notifications'
  const status = document.createElement('p')
  status.className = 'empty'
  status.setAttribute('role', 'status')
  root.append(title, button, status)

  const seen = new Set()
  let enabled = false

  function paint() {
    if (!supported()) {
      button.hidden = true
      status.textContent = 'Desktop notifications are not available in this browser.'
      return
    }
    const p = permission()
    enabled = p === 'granted'
    if (p === 'granted') {
      button.hidden = true
      status.textContent = 'Desktop notifications are on for questions and approvals.'
    } else if (p === 'denied') {
      button.hidden = true
      status.textContent = 'Desktop notifications are blocked in this browser.'
    } else {
      button.hidden = false
      status.textContent = 'Desktop notifications are off.'
    }
  }

  button.addEventListener('click', async () => {
    if (!supported()) return
    try {
      await window.Notification.requestPermission()
    } catch { /* leave the state as the browser reports it */ }
    paint()
  })

  paint()

  return function update(state) {
    const open = (state.requests || []).filter((r) => r.status === 'open')
    document.title = open.length > 0 ? '(' + open.length + ') Truss' : 'Truss'
    for (const r of open) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      if (!enabled || !NOTIFY_KINDS.has(r.kind)) continue
      try {
        const body = r.kind === 'question' ? 'Question from Claude' : 'Approval needed: ' + (r.toolName || '')
        new window.Notification('Truss: ' + body)
      } catch { /* a notification that cannot be raised is not worth breaking the page */ }
    }
  }
}
