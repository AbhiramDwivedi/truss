import { defineConfig, devices } from '@playwright/test'

// Two test dirs: the contract spec (ui/contract/e2e) and ui-web's own specs (ui/e2e).
// Servers are started by the specs themselves, always on port 0.
export default defineConfig({
  outputDir: 'test-results',
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
  projects: [
    { name: 'contract', testDir: './contract/e2e', testMatch: '**/*.spec.ts' },
    { name: 'ui', testDir: './e2e', testMatch: '**/*.spec.ts' },
  ],
})
