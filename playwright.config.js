// Real-Chromium check for the council channel. Serves the app via vite dev (the module
// server for the in-page self-test) and runs e2e/council.browser.spec.js.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  use: {
    // The app is built with base '/council-table-chat/' (GitHub Pages subpath),
    // so vite dev serves it under that prefix too. All spec URLs are relative to
    // this so the tests stay base-agnostic.
    baseURL: 'http://localhost:4173/council-table-chat/',
    browserName: 'chromium',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173/council-table-chat/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
