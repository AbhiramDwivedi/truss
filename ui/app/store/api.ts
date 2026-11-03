// POSTs to the server (ADR-0018 section 9, ADR-0023 section 1). Neither function rejects, neither touches the
// store, and the caller's text goes out exactly as given.
import type { Intent, PostResult } from './types.ts'

/** A POST that has not answered in this long resolves {status: 0, error: 'timeout'}. */
export const POST_TIMEOUT_MS = 15_000

async function post(url: string, body: unknown): Promise<PostResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    let error: string | null = res.ok ? null : 'http'
    let id: string | undefined
    try {
      const data = (await res.json()) as { error?: unknown; id?: unknown } | null
      if (data && typeof data.error === 'string') error = data.error
      if (data && typeof data.id === 'string') id = data.id
    } catch {
      // body is not JSON; keep the status-derived error
    }
    return id === undefined ? { status: res.status, error } : { status: res.status, error, id }
  } catch {
    return { status: 0, error: controller.signal.aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/** Sends {text}, or {text, intent} when an intent is given; a 202 body's id comes back as id. */
export function postMessage(text: string, intent?: Intent): Promise<PostResult> {
  return post('/api/message', intent === undefined ? { text } : { text, intent })
}

export function postAnswer(id: string, body: unknown): Promise<PostResult> {
  return post(`/api/requests/${encodeURIComponent(id)}/answer`, body)
}
