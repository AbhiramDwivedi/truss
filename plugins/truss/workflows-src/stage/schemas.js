// stage.js module: the member and planner report schemas. Edit here, then run `npm run build:stage`.
const MEMBER_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string' },
    marker: { type: 'string', enum: ['DONE', 'CHECKPOINT', 'QUESTION', 'BLOCKED', 'PROPOSAL'] },
    branch: { type: 'string' },
    commit: { type: 'string' },
    proof: { type: 'string' },
    text: { type: 'string' },
    // the files the knowledge writer changed; optional, informational only: green always re-runs after the knowledge commit
    files: { type: 'array', items: { type: 'string' } },
    // ADR-0033: facts a later crew will need; optional, a missing field is []
    learned: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: LEARNED_KINDS },
          text: { type: 'string' },
          source: { type: 'string' },
          target: { type: 'string' },
        },
        required: ['kind', 'text', 'source'],
      },
    },
  },
  required: ['task', 'marker', 'branch', 'commit', 'proof', 'text'],
}
const PLANNER_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['tester', 'builder', 'writer'] },
          effort: { type: 'string', enum: ['low', 'medium', 'high'] },
          persona: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          files: { type: 'array', items: { type: 'string' } },
          reads: { type: 'array', items: { type: 'string' } },
          brief: { type: 'string' },
          after: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'role', 'effort', 'persona', 'files', 'reads', 'brief', 'after'],
      },
    },
    stop: {
      anyOf: [
        { type: 'null' },
        { type: 'object', properties: { tag: { type: 'string', enum: ['QUESTION', 'BLOCKED', 'PROPOSAL'] }, text: { type: 'string' } }, required: ['tag', 'text'] },
      ],
    },
  },
  required: ['tasks', 'stop'],
}

