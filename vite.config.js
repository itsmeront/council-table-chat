import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig(() => ({
  // Served by GitHub Pages under the project subpath (no custom domain on this
  // fork): the built HTML must reference /council-table-chat/*, not root, or
  // every asset 404s (the original axona.chat deployment used base '/' because
  // a custom domain fronts that Pages site at the root).
  base: '/council-table-chat/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version)
  },
  plugins: [
    react(),
    // Update mechanism (design §4.x): the app is a static site on GitHub
    // Pages, so a returning tab can run a stale build indefinitely. The
    // service worker precaches the fingerprinted shell; on a new deploy it
    // detects the change and the in-app UpdatePrompt offers a one-click
    // reload — the canonical PWA pattern, NOT a network-controlled channel
    // (a dev-pushed control topic would contradict the no-central-operator
    // boundary §3). registerType 'prompt' means we never reload without the
    // user's click. devOptions stays disabled so the SW never interferes
    // with the dev server / HMR.
    VitePWA({
      registerType: 'prompt',
      // Only precache the app shell; message/media come from the P2P mesh,
      // never the SW cache. Exclude the large social image.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}', 'favicon.png', 'apple-touch-icon.png', 'pwa-*.png'],
        navigateFallbackDenylist: [/^\/[^/]+\.[^/]+$/],
        // clientsClaim so the freshly-activated worker CLAIMS this tab the
        // instant the user clicks Reload (which posts SKIP_WAITING). Without
        // it, a tab that was never controlled by the previous worker — the
        // normal case right after a PWA first ships, which is exactly the
        // v0.26→v0.27 update H hit — activates the new worker but fires NO
        // controllerchange, so vite-plugin-pwa's reload-on-'controlling'
        // never runs and the Reload button appears to do nothing while the
        // toast survives a manual refresh. Claiming forces controllerchange.
        // Safe for the 'prompt' flow: the worker still WAITS until the user
        // clicks (skipWaiting is message-gated), so this never auto-updates.
        clientsClaim: true
      },
      includeAssets: ['favicon.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Axona Chat',
        short_name: 'Axona',
        description: 'Decentralized chat where humans and AI agents meet as first-class peers.',
        theme_color: '#1C1A18',
        background_color: '#1C1A18',
        display: 'standalone',
        start_url: '/council-table-chat/',
        icons: [
          { src: '/council-table-chat/pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/council-table-chat/pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/council-table-chat/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ],
  server: {
    // Bind IPv4 loopback explicitly. Vite's default localhost binding lands on
    // IPv6 ::1 (modern Node dns order), and Firefox cannot gather ANY ICE
    // candidates on a page served from a ::1 origin — every WebRTC dial fails
    // instantly ("ICE failed, your TURN server appears to be broken") and the
    // mesh never forms. Chromium is unaffected, which is why this only bit
    // Firefox users. Served from 127.0.0.1 the same code works everywhere.
    host: '127.0.0.1',
    // Honor an assigned port (launch harness autoPort) so parallel sessions
    // don't fight over one hardcoded port; vite's default otherwise.
    ...(process.env.PORT ? { port: Number(process.env.PORT), strictPort: true } : {})
  },
  test: {
    // Vitest walks the whole tree, and `.claude/worktrees/` holds live git
    // worktrees from parallel agent sessions — each a full checkout with its
    // own copy of every test. Without this exclude the suite silently runs
    // STALE code from those trees alongside the real one: the pass count
    // inflates, and a test can go green against a checkout nobody is editing.
    // Observed 2026-07-29 — 87 "passing" tests included duplicates of
    // CryptoService and composerLimits from two abandoned worktrees.
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    // Component tests need a DOM. Scoped by glob rather than set globally so
    // the service/store tests keep the faster node environment and their own
    // hand-built localStorage stub, which a jsdom global would shadow.
    environmentMatchGlobs: [['src/components/**', 'jsdom']]
  },
  resolve: {
    alias: {
      'node-datachannel/polyfill': path.resolve('./src/stubs/node-datachannel-stub.js'),
      'node-datachannel': path.resolve('./src/stubs/node-datachannel-stub.js')
    }
  }
}))
