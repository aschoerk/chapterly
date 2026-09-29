import { defineConfig, devices } from '@playwright/test';

// ---------------------------------------------------------------------------
// Playwright E2E config for chapterly (Docker single-origin).
//
// The whole app — SPA + API + LLM proxy — is served by ONE Docker container
// on ONE origin (http://127.0.0.1:8081). The API runs in MEMORY persistence
// seeded from e2e/fixtures/seed.json (see docker-compose.e2e.yml).
//
// Single origin means:
//   - no CORS allowlist to maintain,
//   - no ?port= query param (which hash-routing could lose),
//   - the Angular client resolves apiBase/proxyBase to the same origin.
// ---------------------------------------------------------------------------

export const E2E_HOST = '127.0.0.1';
export const E2E_PORT = 8081;
export const E2E_BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e/tests',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'en-US',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command:
      'docker compose -f docker-compose.e2e.yml down && ' +
      'docker compose -f docker-compose.e2e.yml up',
    url: `${E2E_BASE_URL}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});