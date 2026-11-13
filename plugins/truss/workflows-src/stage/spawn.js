// stage.js module: spawn(), the one agent() call site, with the roles-table checks. Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- spawn

function spawn(role, label, prompt, opts = {}) {
  const r = F.roles && F.roles[role]
  if (!r) throw new Error(`role ${role} is missing from the roles table`)
  if (r.model !== 'opus' && r.model !== 'sonnet') throw new Error(`role ${role} has model ${r.model}; only opus or sonnet`)
  if (!ROLE_EFFORTS.includes(r.effort)) throw new Error(`role ${role} has effort ${r.effort}; only low or medium`)
  if (typeof r.agentType !== 'string' || !r.agentType || BANNED_TYPES.includes(r.agentType)) throw new Error(`role ${role} has agentType ${r.agentType}, which is not allowed`)
  let effort = r.effort
  const persona = opts.persona ? PERSONAS[opts.persona] : undefined
  if (opts.persona) {
    // ADR-0033: the po role is the one place a read-only (judge) persona runs; every other role takes editing personas only
    if (role === 'po') {
      if (!persona || persona.readOnly !== true) throw new Error(`persona ${opts.persona} is not a read-only persona in args.truss.personas`)
    } else {
      if (!PERSONA_ROLES.includes(role)) throw new Error(`role ${role} may not take persona ${opts.persona}`)
      if (!persona || persona.readOnly === true) throw new Error(`persona ${opts.persona} is not an editing persona in args.truss.personas`)
    }
  }
  if (opts.effort !== undefined) {
    if ((role !== 'builder' && !persona) || !effortsFor(role).includes(opts.effort)) throw new Error(`role ${role} may not take effort ${opts.effort}`)
    effort = opts.effort
  }
  // ADR-0022 U6 (item 23): the goal file's ## Members line (the entry's members) wins over the roles row and the task effort
  let model = r.model
  if (opts.member) {
    const m = opts.member
    if (m.model !== 'opus' && m.model !== 'sonnet') throw new Error(`role ${role} has a ## Members model ${m.model}; only opus or sonnet`)
    if (!effortsFor(role).includes(m.effort)) throw new Error(`role ${role} has a ## Members effort ${m.effort}; only ${effortsFor(role).join(', ')}`)
    model = m.model
    effort = m.effort
  }
  let agentType = r.agentType
  // ADR-0032: a persona's model stands, its effort is the higher of its own and the task's, and its type runs the member when this
  // session loaded it; otherwise general-purpose runs it with the persona file's body as the first lines of the prompt
  if (persona) {
    if (persona.model !== 'opus' && persona.model !== 'sonnet') throw new Error(`persona ${opts.persona} has model ${persona.model}; only opus or sonnet`)
    if (!PERSONA_EFFORTS.includes(persona.effort)) throw new Error(`persona ${opts.persona} has effort ${persona.effort}; only low, medium or high`)
    model = persona.model
    const task = opts.effort === undefined ? persona.effort : opts.effort
    effort = PERSONA_EFFORTS.indexOf(task) > PERSONA_EFFORTS.indexOf(persona.effort) ? task : persona.effort
    if (persona.loaded === true) {
      if (typeof persona.agentType !== 'string' || !persona.agentType || BANNED_TYPES.includes(persona.agentType)) throw new Error(`persona ${opts.persona} has agentType ${persona.agentType}, which is not allowed`)
      agentType = persona.agentType
    } else {
      // a read-only persona whose body is inlined runs as its inlineType, else as truss:judge (both read-only agent types), so a judge
      // never gets every tool; an editing persona that is not loaded runs as general-purpose
      const inline = persona.readOnly === true ? (typeof persona.inlineType === 'string' && persona.inlineType && !BANNED_TYPES.includes(persona.inlineType) ? persona.inlineType : 'truss:judge') : null
      agentType = inline ?? 'general-purpose'
      prompt = `You are the ${opts.persona} persona. Its definition follows and is your system prompt for this task:\n\n${String(persona.body || '').replace(/\s+$/, '')}\n---\n${prompt}`
    }
  }
  const o = { label, agentType, model, effort }
  if (opts.schema) o.schema = opts.schema
  if (r.isolation === 'worktree') o.isolation = 'worktree'
  return agent(prompt, o)
}

