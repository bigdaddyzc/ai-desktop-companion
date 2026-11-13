import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  // Keep model smoke artifacts/logs outside Playwright's per-run cleanup scope.
  outputDir: './test-results/desktop',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { trace: 'retain-on-failure' },
});
