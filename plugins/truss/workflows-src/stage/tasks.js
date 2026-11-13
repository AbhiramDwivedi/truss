// stage.js module: personas, runTask, runMembers, fixBuilder and fresh answers. Edit here, then run `npm run build:stage`.
// ADR-0032: the persona a task's member runs as (a builder or tester task with a persona), else null
const taskPersona = (task) => (['builder', 'tester'].includes(task.role) && typeof task.persona === 'string' && task.persona ? task.persona : null)

// A resolver or fix member inherits the persona of the task it works for: the task `at` names, else the one task of its role
// whose files `text` names, else the one persona all of the crew's tasks of its role share; null when none is clear.
function personaFor(crew, role, text, at) {
  const tasks = (crew.tasks && crew.tasks.length ? crew.tasks : crew.e.tasks) || []
  const byAt = tasks.find((t) => t.name === at)
  if (byAt) return taskPersona(byAt)
  const pool = tasks.filter((t) => (role === 'resolver' ? ['builder', 'tester'].includes(t.role) : t.role === role))
  const pick = (list) => {
    const set = new Set(list.map(taskPersona))
    return set.size === 1 && !set.has(null) ? [...set][0] : null
  }
  const named = text ? pool.filter((t) => (t.files || []).some((f) => namesFile(String(text), f))) : []
  return pick(named) ?? (pool.length ? pick(pool) : null)
}

function taskOpts(task) {
  const persona = taskPersona(task)
  return { title: task.name, ...(task.role === 'builder' || persona ? { effort: task.effort } : {}), ...(persona ? { persona } : {}) }
}

async function runTask(crew, task) {
  const at = task.name
  const makePrompt = (note) => taskPrompt(crew, task, note)
  // a resume: the task's product call may still wait on its inbox item (stop again) or be answered (start with the answer)
  const first = await pendingCall(crew, task.role, makePrompt, taskOpts(task), at, true)
  const report = await runMember(crew, task.role, makePrompt, taskOpts(task), at, first)
  report.task = task.name
  crew.proofs.push(`${task.name}: ${report.proof}`)
  await integrate(crew, report.branch, at)
}

// a task starts only when every task in its after list is integrated; after a stop no new task starts
// ADR-0026 item 48: a done task an answer's at names runs again with that answer; its done dependants stay done
async function runMembers(crew, tasks) {
  const answered = new Set((crew.e.answers || []).map((a) => a.at))
  const doneNames = new Set((crew.e.done || []).filter((n) => !answered.has(n)))
  const byName = {}
  for (const t of tasks) byName[t.name] = t
  const started = {}
  const start = (name) => (started[name] ??= (async () => {
    if (doneNames.has(name)) return true
    const task = byName[name]
    const deps = await Promise.all(task.after.map(start))
    if (crew.halted || !deps.every(Boolean)) return false
    try {
      await runTask(crew, task)
      return true
    } catch (err) {
      crew.halted ??= err instanceof Stop ? err : new Stop('BLOCKED', err && err.message ? String(err.message) : String(err), name)
      return false
    }
  })())
  await Promise.all(tasks.map((t) => start(t.name)))
  if (crew.halted) throw crew.halted
}

// fix builder for a failing check, a QC finding or a stress-test finding; integrates its branch
// prev: a branch an earlier fix member committed on before it stopped (greenFix's code half), merged in the first step
async function fixBuilder(crew, what, detail, role = 'builder', prev = '') {
  const at = crew.step
  guardAllowance(crew, at)
  const persona = personaFor(crew, role, detail, null)
  const make = (resume) => fixPrompt(crew, what, resume ? `${detail}\n\n${resumeLines(resume).join('\n')}` : detail, role, (resume && resume.branch) || prev)
  const opts = { title: `Fix ${what}`, ...(persona ? { persona } : {}) }
  const first = await pendingCall(crew, role, make, opts, at)
  const report = await runMember(crew, role, make, opts, at, first)
  crew.proofs.push(`fix (${what}): ${report.proof}`)
  await integrate(crew, report.branch, at)
}

// 0.31.0 item 6: the answers the PM wrote for this resume. factory start puts them first and counts them in entry.freshAnswers; the
// rest are rulings carried from the crew's answers store, which an earlier run already had. With no count, every answer is new.
const freshAnswers = (e) => {
  const all = Array.isArray(e.answers) ? e.answers : []
  return Number.isInteger(e.freshAnswers) && e.freshAnswers >= 0 ? all.slice(0, e.freshAnswers) : all
}

