// Same-origin JSON POST helpers (ADR-0011 Decision 6). Each returns { status, body }.
// status 0 means the request never reached the server.

async function postJson(path, payload) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })
    let body = null
    try { body = await res.json() } catch { body = null }
    return { status: res.status, body }
  } catch {
    return { status: 0, body: { error: 'network' } }
  }
}

export function sendMessage(text) {
  return postJson('/api/message', { text })
}

export function answerRequest(id, answer) {
  return postJson('/api/requests/' + encodeURIComponent(id) + '/answer', answer)
}

export const api = { sendMessage, answerRequest }
