// Request card shapes (ui/contract/state.schema.json "request") and the pure builders for
// the question and permission cards (ADR-0011 Decision 3). Internal: import via index.ts.

export interface QuestionOption {
  label: string
  description: string
  recommended: boolean
}
export interface QuestionItem {
  question: string
  header: string
  multiSelect: boolean
  options: QuestionOption[]
}
interface Base {
  id: string
  status: 'open' | 'answered' | 'cancelled'
  createdAt: string
  answeredAt: string | null
  cancelReason: 'aborted' | 'superseded' | 'ended' | null
}
export interface QuestionRequest extends Base {
  kind: 'question'
  questions: QuestionItem[]
  answers: Record<string, string> | null
}
export interface PermissionRequest extends Base {
  kind: 'permission'
  toolName: string
  title: string
  summary: string
  input: Record<string, unknown>
  decisionReason: string | null
  blockedPath: string | null
  decision: 'allow' | 'deny' | null
  message: string | null
}
export interface ReplyRequest extends Base {
  kind: 'reply'
  text: string
  isError: boolean
  backgroundTasks: number
  decision: 'allow' | 'deny' | 'message' | null
  message: string | null
}
export type Request = QuestionRequest | PermissionRequest | ReplyRequest

type NewOf<T> = T extends Base ? Omit<T, keyof Base> : never
export type NewRequest = NewOf<Request>
export type NewQuestion = NewOf<QuestionRequest>
export type NewPermission = NewOf<PermissionRequest>

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

// The raw canUseTool input behind a question card, so the answer can echo the questions as sent.
const rawInputs = new WeakMap<object, Record<string, unknown>>()
export function rawInputOf(card: object): Record<string, unknown> | undefined {
  return rawInputs.get(card)
}

export function questionCard(input: unknown): NewQuestion {
  const raw = isObj(input) ? input : {}
  const qs = Array.isArray(raw.questions) ? raw.questions : []
  const questions: QuestionItem[] = qs.filter(isObj).map((q) => ({
    question: str(q.question) ?? '',
    header: str(q.header) ?? '',
    multiSelect: q.multiSelect === true,
    options: (Array.isArray(q.options) ? q.options : []).filter(isObj).map((o) => {
      const label = str(o.label) ?? ''
      return { label, description: str(o.description) ?? '', recommended: label.endsWith(' (Recommended)') }
    }),
  }))
  const card: NewQuestion = { kind: 'question', questions, answers: null }
  rawInputs.set(card, raw)
  return card
}

export function questionAnswer(
  input: unknown,
  answers: Record<string, string>,
): { behavior: 'allow'; updatedInput: unknown } {
  const questions = isObj(input) ? input.questions : undefined
  return { behavior: 'allow', updatedInput: { questions, answers } }
}

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'NotebookEdit']

export function permissionCard(toolName: string, input: Record<string, unknown>, options: unknown): NewPermission {
  const opts = isObj(options) ? options : {}
  const inp = isObj(input) ? input : {}
  const title = str(opts.description) ?? str(inp.description) ?? toolName
  let summary: string | null = null
  if (toolName === 'Bash') summary = str(inp.command)
  else if (FILE_TOOLS.includes(toolName)) summary = str(inp.file_path)
  return {
    kind: 'permission',
    toolName,
    title,
    summary: summary ?? JSON.stringify(inp),
    input: inp,
    decisionReason: str(opts.decisionReason),
    blockedPath: str(opts.blockedPath),
    decision: null,
    message: null,
  }
}
