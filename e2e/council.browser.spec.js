// Real-Chromium check for the council channel (TASK-P-0003). The vitest suite runs the
// same logic on Node; this proves it runs in an actual browser: vendored noble-ed25519,
// Web Crypto X25519/forced-P-256, non-extractable keys, and the IndexedDB keyring. The
// self-test module executes IN the page against the vite dev server's served modules.
import { test, expect } from '@playwright/test';

test('council crypto runs in real Chromium (self-test)', async ({ page }) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const mod = await import('/src/services/council/browserSelfTest.js');
    return mod.runBrowserSelfTest();
  });
  expect(result.ok, result.failures ? `failed in-browser: ${result.failures.join('; ')}` : '').toBe(true);
});
