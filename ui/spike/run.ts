// Spike: one real Claude Agent SDK session with the Truss plugin loaded.
// Records every SDK message and every canUseTool / hook call to
// ui/contract/fixtures/sdk-stream.jsonl (one compact JSON object per line;
// callback lines carry "_spike"). Erasable TypeScript: node ui/spike/run.ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const out = join(root, 'ui', 'contract', 'fixtures', 'sdk-stream.jsonl');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, '');

const secret = /(sk-ant-[A-Za-z0-9_-]+|(?:oauth|bearer|token)["']?\s*[:=]\s*["'][^"']{12,}["'])/gi;
let seq = 0;
function rec(obj: Record<string, unknown>): void {
  const line = JSON.stringify({ _seq: ++seq, ...obj }).replace(secret, '[scrubbed]');
  appendFileSync(out, line + '\n');
}

const repo = mkdtempSync(join(tmpdir(), 'truss-spike-'));
const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'spike@example.invalid');
git('config', 'user.name', 'spike');
writeFileSync(join(repo, 'README.md'), '# tiny\n');
git('add', '.');
git('commit', '-q', '-m', 'init');
rec({ _spike: 'setup', repo, pluginPath: root });

// Streaming input: next prompt is pushed when the previous turn's result arrives.
const prompts = [
  'Use the truss:brief skill for this tiny goal: "add a --version flag to a hello-world CLI". Ask me the questions with AskUserQuestion, at most two questions in total, then stop.',
  'Run the Bash command `mkdir spike-out` in the working directory, then say done.',
  'Launch exactly one background subagent with the Agent tool (run_in_background true, general-purpose) whose job is to run `ls` in the working directory and report the output. Then wait for it to finish and tell me what it reported.',
];
let turn = 0;
let wake: (() => void) | undefined;
const pending: string[] = [prompts[0]!];
let closed = false;
async function* input() {
  while (true) {
    while (pending.length === 0) {
      if (closed) return;
      await new Promise<void>((r) => (wake = r));
    }
    const text = pending.shift()!;
    rec({ _spike: 'user_turn', turn: turn + 1, text });
    yield { type: 'user' as const, message: { role: 'user' as const, content: text }, parent_tool_use_id: null };
  }
}

function hook(name: string) {
  return async (inp: unknown, toolUseID: unknown) => {
    rec({ _spike: 'hook', hook: name, toolUseID: toolUseID ?? null, input: inp });
    return {};
  };
}

const q = query({
  prompt: input(),
  options: {
    cwd: repo,
    plugins: [{ type: 'local', path: root }],
    canUseTool: async (toolName: string, toolInput: Record<string, any>, opts: Record<string, any>) => {
      const { signal: _s, ...o } = opts;
      rec({ _spike: 'canUseTool', toolName, input: toolInput, options: o });
      if (toolName === 'AskUserQuestion') {
        const questions = toolInput.questions as Array<{ question: string; options: Array<{ label: string }> }>;
        const answers: Record<string, string> = {};
        for (const qn of questions) answers[qn.question] = qn.options[0]!.label;
        const reply = { behavior: 'allow' as const, updatedInput: { questions, answers } };
        rec({ _spike: 'canUseTool_reply', toolName, reply });
        return reply;
      }
      if (toolName === 'Bash' && !/^\s*(mkdir|ls|git (rev-parse|status|log|branch))\b/.test(String(toolInput.command))) {
        const reply = { behavior: 'deny' as const, message: 'spike: only mkdir/ls/read-only git allowed' };
        rec({ _spike: 'canUseTool_reply', toolName, reply });
        return reply;
      }
      const reply = { behavior: 'allow' as const, updatedInput: toolInput };
      rec({ _spike: 'canUseTool_reply', toolName, reply });
      return reply;
    },
    hooks: {
      PreToolUse: [{ hooks: [hook('PreToolUse')] }],
      SubagentStart: [{ hooks: [hook('SubagentStart')] }],
      SubagentStop: [{ hooks: [hook('SubagentStop')] }],
    },
  } as any,
});

const timer = setTimeout(() => {
  rec({ _spike: 'timeout' });
  closed = true;
  q.interrupt().catch(() => {});
}, 15 * 60 * 1000);

for await (const m of q) {
  rec(m as unknown as Record<string, unknown>);
  if ((m as any).type === 'result' && !(m as any).parent_tool_use_id) {
    turn++;
    if (turn < prompts.length) {
      pending.push(prompts[turn]!);
    } else {
      closed = true;
    }
    wake?.();
  }
}
clearTimeout(timer);
rec({ _spike: 'end', turns: turn });
console.log(`wrote ${out} (${seq} lines), repo ${repo}`);
