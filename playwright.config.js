import { defineConfig, devices } from '@playwright/test';

/**
 * Ports: E2E_UI_PORT (default 5180) and E2E_API_PORT (default 8788) must be free.
 * If the UI port is busy (e.g. a leftover e2e-web process), run with different ports, e.g. PowerShell:
 *   $env:E2E_UI_PORT='5182'; $env:E2E_API_PORT='8790'; npm run test:e2e
 * Optional: E2E_REUSE_SERVER=1 reuses an already-running dev stack (may use the wrong DB — use only when you understand the tradeoff).
 * Fresh E2E DB: npm run wipe:e2e-db (removes data/playwright.sqlite only). See docs/ENVIRONMENT.md.
 * HR stress (opt-in): HR_STRESS=1 HR_STRESS_N=12 npm run test:e2e -- e2e/hr-stress.spec.js
 */
export default defineConfig({
  testDir: './e2e',
  /** Default per-test limit (includes fixture setup like browser newPage under load). */
  timeout: 90_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${process.env.E2E_UI_PORT || 5180}`,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/e2e-web.mjs',
    url: `http://127.0.0.1:${process.env.E2E_UI_PORT || 5180}`,
    env: {
      ZAREWA_DB: 'data/playwright.sqlite',
      E2E_UI_PORT: process.env.E2E_UI_PORT || '5180',
      E2E_API_PORT: process.env.E2E_API_PORT || '8788',
    },
    // Prefer the Playwright stack (API + Vite with playwright.sqlite). Set E2E_REUSE_SERVER=1 only if you intentionally reuse a running server.
    reuseExistingServer: !!process.env.E2E_REUSE_SERVER,
    timeout: 180_000,
  },
});
