// Startup check: compares the running Node with package.json's engines range (never throws, never exits).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Triple = [number, number, number];

function triple(s: string, re: RegExp): Triple | null {
  const m = re.exec(s);
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

// Handles ">=X[.Y[.Z]]" and "^X[.Y[.Z]]"; anything else is unparseable and stays silent.
// Both only warn when Node is older than the full version: a newer major under a caret is silent too,
// since the warning says "older than", not "different from".
export function nodeVersionWarning(running: string, range: string): string | null {
  const min = triple(range.trim(), /^(?:>=|\^)\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const now = triple(running, /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!min || !now) return null;
  for (let i = 0; i < 3; i++) {
    if (now[i]! !== min[i]!) {
      if (now[i]! > min[i]!) return null;
      return `truss-ui: Node ${running} is older than the ${range} this UI is tested on; if something breaks, upgrade Node (https://nodejs.org).`;
    }
  }
  return null;
}

// The engines.node range from <dir>/package.json, or null when the file is missing, unreadable or not JSON.
export function readEnginesRange(dir: string): string | null {
  try {
    const range = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))?.engines?.node;
    return typeof range === 'string' ? range : null;
  } catch {
    return null;
  }
}
