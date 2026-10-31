// Startup check: compares the running Node with the major in package.json's engines (never exits).
export function nodeVersionWarning(running: string, range: string): string | null {
  const min = /(\d+)/.exec(range)?.[1];
  const major = /^v?(\d+)/.exec(running)?.[1];
  if (min === undefined || major === undefined || Number(major) >= Number(min)) return null;
  return `truss-ui: Node ${running} is older than the ${range} this UI is tested on; if something breaks, upgrade Node (https://nodejs.org).`;
}
