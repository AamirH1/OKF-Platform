import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

/**
 * Browser E2E against the full stack (web + API + worker + Postgres + MinIO).
 * Locally this reuses `npm run dev` if it is already running; otherwise it starts it.
 * Each run uses unique accounts, so it is safe to run against a dev database.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node scripts/dev.mjs',
        url: `${baseURL}/login`,
        reuseExistingServer: true,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
