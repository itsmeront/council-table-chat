// Real-Chromium check for the council channel. Serves the app via vite dev (the module
// server for the in-page self-test) and runs e2e/council.browser.spec.js.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    baseURL: 'http://localhost:4173',
    browserName: 'chromium',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
