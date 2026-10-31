// The pure apply step for the wire contract (ui/contract/state.schema.json, ADR-0011 Decision 5).
// No DOM here. A model is { instance, seq, state }; every function returns a new model and never mutates its input.

export const SUPPORTED_VERSION = 1
export const TRANSCRIPT_MAX = 500

export function emptyModel() {
  return { instance: null, seq: 0, state: null }
}

// A snapshot replaces everything. A state whose v is not 1 asks for a page reload.
export function applySnapshot(model, msg) {
  if (!msg || !msg.state || msg.state.v !== SUPPORTED_VERSION) return { kind: 'reload', model }
  return {
    kind: 'applied',
    model: { instance: msg.instance, seq: msg.seq, state: msg.state },
    changed: Object.keys(msg.state),
  }
}

// A delta replaces each `set` key whole and appends `append.transcript`. Returns:
//   stale   seq already applied (a replay overlap); nothing changes
//   gap     seq is not the next one, or there is no snapshot yet: the caller reloads for a fresh snapshot
//   applied the new model and the keys that changed
export function applyDelta(model, delta) {
  if (!model.state) return { kind: 'gap', model }
  if (!delta || !Number.isInteger(delta.seq)) return { kind: 'gap', model }
  if (delta.seq <= model.seq) return { kind: 'stale', model }
  if (delta.seq !== model.seq + 1) return { kind: 'gap', model }
  const state = { ...model.state }
  const changed = []
  if (delta.set) {
    for (const key of Object.keys(delta.set)) {
      state[key] = delta.set[key]
      changed.push(key)
    }
  }
  const add = delta.append && delta.append.transcript
  if (add && add.length) {
    const prev = state.transcript || []
    const lastN = prev.length ? prev[prev.length - 1].n : 0
    const fresh = add.filter((e) => e.n > lastN)
    if (fresh.length) {
      state.transcript = prev.concat(fresh).slice(-TRANSCRIPT_MAX)
      if (!changed.includes('transcript')) changed.push('transcript')
    }
  }
  return { kind: 'applied', model: { instance: model.instance, seq: delta.seq, state }, changed }
}
