// stage.js module: task validation, the planner and split(). Edit here, then run `npm run build:stage`.
// ---------------------------------------------------------------- split

function globToRegExp(glob) {
  if (glob.endsWith('/')) glob += '**' // a bare `dir/` owns entry means `dir/**`
  let s = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*' && glob[i + 1] === '*') {
      s += '.*'
      i++
    } else if (ch === '*') {
      s += '[^/]*'
    } else {
      s += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${s}$`)
}

// ownTests: the entry's test globs, checked on a fresh plan only (ADR-0019 items 6, 16): a builder task that lists a file
// one of them matches, a file a tester task lists, or a file of guarded (the test files the acceptance test names) is sent
// back, since test files are read-only to builders. null (a saved plan, or an old-form entry with no ownTests key) skips
// it; ownTests [] still checks the other two.
function validateTasks(tasks, owns, ownTests = null, guarded = []) {
  const errors = []
  if (!Array.isArray(tasks) || tasks.length === 0) return ['the plan has no tasks']
  const owned = owns.map(globToRegExp)
  if (Array.isArray(ownTests)) {
    const testGlobs = ownTests.map((g) => ({ g, re: globToRegExp(g) }))
    const testerOf = new Map()
    for (const t of tasks.filter((x) => x && x.role === 'tester')) for (const f of t.files || []) if (!testerOf.has(f)) testerOf.set(f, t.name)
    const guard = new Set((Array.isArray(guarded) ? guarded : []).filter((g) => typeof g === 'string'))
    for (const t of tasks.filter((x) => x && x.role === 'builder')) {
      for (const f of t.files || []) {
        if (typeof f !== 'string') continue
        const hit = testGlobs.find(({ re }) => re.test(f))
        const why = hit ? `it matches ownTests ${hit.g}` : testerOf.has(f) ? `tester task ${testerOf.get(f)} lists it` : guard.has(f) ? 'the acceptance test names it, so it is guarded' : ''
        if (why) errors.push(`builder task ${t.name} lists file ${f}, a test file (${why}); test files are read-only to builders, so give that change to a tester task`)
      }
    }
  }
  const byName = {}
  for (const t of tasks) {
    if (byName[t.name]) errors.push(`duplicate task name: ${t.name}`)
    else byName[t.name] = t
    if (!['tester', 'builder', 'writer'].includes(t.role)) errors.push(`task ${t.name} has role ${t.role}; use tester, builder or writer`)
    if (!PERSONA_EFFORTS.includes(t.effort)) errors.push(`task ${t.name} has effort ${t.effort}; use low, medium or high`)
    if (t.persona !== undefined && t.persona !== null) {
      if (typeof t.persona !== 'string') errors.push(`task ${t.name} has persona ${JSON.stringify(t.persona)}; use a persona name or null`)
      else if (!Object.hasOwn(PERSONAS, t.persona)) errors.push(`task ${t.name} has persona ${t.persona}, which is not a persona of this project (${Object.keys(PERSONAS).join(', ') || 'none defined'}); use one of them or null`)
      else if (PERSONAS[t.persona] && PERSONAS[t.persona].readOnly === true) errors.push(`task ${t.name} has persona ${t.persona}, which is read-only (a judge); give the task an editing persona or null`)
    }
    for (const f of t.files || []) {
      if (typeof f !== 'string' || f === '' || f.endsWith('/') || /\\|\/\/|^\/|^\.\//.test(f) || f.split('/').some((seg) => seg === '.' || seg === '..')) errors.push(`task ${t.name} lists file ${f}, which is not a canonical repo-relative path; use forward slashes, no leading / or ./, no // and no . or .. segments`)
      else if (/[*?[{]/.test(f)) errors.push(`task ${t.name} lists file ${f}, which is a glob; list exact file paths`)
      else if (!owned.some((re) => re.test(f))) errors.push(`task ${t.name} lists file ${f}, which matches none of the crew owns`)
    }
    for (const a of t.after || []) {
      if (!tasks.some((x) => x.name === a)) errors.push(`task ${t.name} lists after: ${a}, but no task has that name`)
    }
  }
  const reach = (name) => {
    const seen = new Set()
    const walk = (n) => {
      for (const a of (byName[n] && byName[n].after) || []) {
        if (!seen.has(a)) {
          seen.add(a)
          walk(a)
        }
      }
    }
    walk(name)
    return seen
  }
  for (const t of tasks) {
    if (reach(t.name).has(t.name)) errors.push(`task ${t.name} is in a cycle of after lists`)
  }
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i]
      const b = tasks[j]
      const bl = (b.files || []).map((f) => String(f).toLowerCase())
      const overlap = (x, y) => x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
      const shared = (a.files || []).filter((f) => bl.some((g) => overlap(String(f).toLowerCase(), g)))
      if (shared.length && !reach(a.name).has(b.name) && !reach(b.name).has(a.name)) {
        errors.push(`tasks ${a.name} and ${b.name} both change ${shared.join(', ')} with no after chain between them`)
      }
    }
  }
  for (const b of tasks.filter((t) => t.role === 'builder')) {
    for (const t of tasks.filter((x) => x.role === 'tester')) {
      if (!reach(b.name).has(t.name)) errors.push(`builder ${b.name} is not after tester ${t.name}`)
    }
  }
  return errors
}

function plannerPrompt(crew, errors) {
  const e = crew.e
  const lines = [
    `Split the goal of crew ${crew.slug} into member tasks.`,
    `Goal file: ${e.goalFile}`,
    `Crew worktree: ${e.worktree}`,
    `Owns: ${e.owns.join(', ')}`,
    `High-impact paths: ${e.highImpact.join(', ') || 'none'}`,
    `Approved scope: ${scopeOf(e)}`,
    `Architecture doc: ${e.architecture}`,
    `ADRs: ${e.adrs.join(', ') || 'none'}`,
  ]
  const dl = directionLines(crew)
  if (dl.length) lines.push('', ...dl)
  // ADR-0035: the agents index and the rules index, so a task's reads can name the rule files that match its files
  if (typeof F.agentsIndex === 'string' && F.agentsIndex) lines.push('', `Agents index: ${F.agentsIndex}`)
  const rules = Array.isArray(F.rules) ? F.rules.filter((r) => r && typeof r.path === 'string' && r.path && Array.isArray(r.paths)) : []
  if (rules.length) lines.push('', "Rules index (area rules, each loaded for the files its globs match). List a rule file in a task's reads when one of its globs matches one of the task's files:", ...rules.map((r) => `- ${r.path}: ${r.paths.join(', ')}`))
  const names = Object.keys(PERSONAS)
  if (names.length) {
    lines.push('', "Personas (project agents, each specialised by stack and area). Give every builder and tester task the editing persona whose stack and area fit the task's files; a task never spans two personas' areas, so split it instead; persona is null only when no persona fits. A read-only persona is a judge and never takes a task:")
    for (const n of names) lines.push(`- ${n}: ${String((PERSONAS[n] && PERSONAS[n].description) || '')} (${PERSONAS[n] && PERSONAS[n].readOnly === true ? 'read-only' : 'editing'})`)
  } else {
    lines.push('', 'This project defines no personas: set persona to null on every task.')
  }
  const answers = e.answers || []
  if (answers.length) lines.push('', 'Answers to earlier stops of this crew:', ...answers.map((a) => `- at ${a.at}: ${a.text}`))
  lines.push('', 'Load the `subagent-limits:split-work` skill before splitting work.')
  if (errors) lines.push('', 'Your last plan failed these checks. Fix every one:', ...errors.map((x) => `- ${x}`))
  return lines.join('\n')
}

async function askPlanner(crew, errors) {
  const plan = await ask(crew, 'planner', plannerPrompt(crew, errors), { schema: PLANNER_SCHEMA })
  if (!plan) throw new Stop('BLOCKED', 'the planner returned no plan', 'split')
  if (plan.stop) throw new Stop(plan.stop.tag, plan.stop.text, 'split')
  return plan.tasks
}

async function split(crew) {
  crew.step = 'split'
  // an old-form entry (no ownTests key, so no guarded either) skips the test-file check; a lean entry runs it even with []
  const ownTests = Array.isArray(crew.e.ownTests) ? ownTestsOf(crew) : null
  let tasks = await askPlanner(crew, null)
  let errors = validateTasks(tasks, crew.e.owns, ownTests, crew.e.guarded)
  if (errors.length) {
    tasks = await askPlanner(crew, errors)
    errors = validateTasks(tasks, crew.e.owns, ownTests, crew.e.guarded)
    if (errors.length) throw new Stop('BLOCKED', `the plan failed these checks twice:\n${errors.map((x) => `- ${x}`).join('\n')}`, 'split')
  }
  return tasks
}

