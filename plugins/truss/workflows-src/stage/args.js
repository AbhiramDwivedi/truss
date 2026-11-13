// stage.js module: the meta block, args.truss and the role and persona tables. Edit here, then run `npm run build:stage`.
export const meta = {
  name: 'truss-stage',
  description: 'Runs every crew of a truss stage at once: red check, split, members, green, stress test, scope check and QC, as ADR-0009 Decision 4. Returns one result per crew; never merges, pushes or asks the client.',
}

// stage.js plays the project manager's orchestration role as code. Every agent call goes through spawn(), which takes the
// agent type, model, effort and isolation from the roles table and throws before the call when the table is bad.

// ADR-0024 item 29: the Workflow gate expands args.trussFile into args.truss; without an object there, stop before any agent call
// ADR-0026 item 51e: args may also be a JSON string holding that object; both give the same args.truss
const ARGS = (() => {
  if (typeof args !== 'string') return args
  try {
    const v = JSON.parse(args)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
})()
const F = ARGS && ARGS.truss
if (!F || typeof F !== 'object' || Array.isArray(F)) throw new Error('args.truss is missing: the Workflow gate expands args.trussFile into args.truss; pass args.truss inline when the gate did not run')
const PLATFORM = typeof F.platform === 'string' ? F.platform : ''
const ROLE_EFFORTS = ['low', 'medium']
// ADR-0032: builder, tester and resolver members may run at effort high (via a persona, a task effort or ## Members);
// every other role keeps ROLE_EFFORTS. A persona is a project agent type (args.truss.personas) that routes the task's member.
const PERSONA_ROLES = ['builder', 'tester', 'resolver']
const PERSONA_EFFORTS = ['low', 'medium', 'high']
const effortsFor = (role) => (PERSONA_ROLES.includes(role) ? PERSONA_EFFORTS : ROLE_EFFORTS)
const PERSONAS = F.personas && typeof F.personas === 'object' && !Array.isArray(F.personas) ? F.personas : {}
const BANNED_TYPES = ['truss:project-manager', 'truss:commissioning-engineer', 'truss:integrator']
const TRAILER_ROLE = { tester: 'test-writer', builder: 'builder', writer: 'writer', resolver: 'resolver' }

