import React, { createContext, useContext, useEffect, useState } from 'react';
import { connect } from '@axona/protocol/connect.js';
import { useNetwork } from './NetworkContext.jsx';
import AxonaChatClient from '../services/AxonaChatClient.js';

const PeerContext = createContext();

// ── Recovery watchdog constants ──────────────────────────────────────────────
// Captured live 2026-08-05: an overnight-slept session woke at "Seeking Peers"
// and stayed there for ten hours — deaf inbound, and a publish sent from it
// self-rooted on a one-node island and never reached the network. The status
// interval was already measuring the failure every 5 seconds; it just never
// ACTED. These constants turn the measurement into reflexes.
const TICK_MS = 5000;
// A tick gap this much longer than the interval means the machine slept or the
// tab was suspended — timers don't drift 30s on a live page.
const SLEEP_GAP_MS = 30_000;
// Zero peers for this long while online = wedged, whatever the cause. The
// kernel's own reconnect (1s→16s backoff) gets ample time to win first; this
// fires only when every lower layer has failed to.
const RECOVER_AFTER_MS = 25_000;
// Backoff between recovery ATTEMPTS, so a genuinely-down network doesn't
// hot-loop full reconnects.
const RETRY_INITIAL_MS = 10_000;
const RETRY_MAX_MS = 60_000;

export const PeerProvider = ({ children }) => {
  const { bridgeUrl } = useNetwork();
  const [peer, setPeer] = useState(null);
  const [status, setStatus] = useState({ ready: false, peers: 0, ms: 0, reason: 'connecting' });
  // Dev diagnostic: mesh dial outcomes, surfaced on-screen (see strip below).
  const [meshDiag, setMeshDiag] = useState({ ok: 0, failed: 0 });

  useEffect(() => {
    let active = true;
    let cleanup = null;
    let interval = null;
    // Watchdog state — plain locals, not React state: the tick reads and
    // writes them every 5s and nothing renders from them.
    let lastTickAt = Date.now();
    let zeroSince = null;        // when peers first read 0 (null = not zero)
    let everConnected = false;   // don't "recover" a session still bootstrapping
    let recovering = false;
    let retryDelayMs = RETRY_INITIAL_MS;
    let nextRetryAt = 0;
    let currentPeer = null;      // the live peer the tick health-checks

    // First run only: wait for onboarding to finish so the connection can
    // use the location the user just granted (or explicitly skipped).
    // Returning users (onboarded flag, or pre-feature installs that already
    // have handles) connect immediately.
    const isOnboarded = () => {
      try {
        return !!(localStorage.getItem('axona-onboarded') || localStorage.getItem('axona-handles'));
      } catch { return true; }
    };
    const waitForOnboarding = () => new Promise((resolve) => {
      if (isOnboarded()) return resolve();
      const done = () => { window.removeEventListener('axona-onboarded', done); resolve(); };
      window.addEventListener('axona-onboarded', done);
    });

    const storedLocation = () => {
      try {
        const raw = localStorage.getItem('axona-node-location');
        const loc = raw ? JSON.parse(raw) : null;
        if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) return loc;
      } catch { /* fall through */ }
      return { lat: 38.0, lng: -77.0 };   // default region (US East)
    };

    const init = async () => {
      setStatus({ ready: false, peers: 0, ms: 0, reason: 'connecting' });
      try {
        await waitForOnboarding();
        const location = storedLocation();

        if (!active) return;

        // ONE peer for the whole session. Authorship is per-call: every
        // publish/kill passes { signWith } with the active handle's author
        // key (AxonaChatClient.getActiveAuthor), so switching handles must
        // NOT reconnect — tearing down live WebRTC meshes per persona switch
        // churned the mesh and spammed ICE failures. author:false because
        // connect()'s minted default author is never used.
        const connectionOpts = {
          bridge: bridgeUrl,
          location,
          author: false,
          ready: { minPeers: 1, timeoutMs: 8000 }
        };

        const result = await connect(connectionOpts);

        if (!active) {
          if (result.disconnect) result.disconnect();
          return;
        }

        setPeer(result.peer);
        AxonaChatClient.setPeer(result.peer);
        setStatus(result.status || { ready: true, peers: 1, ms: 0, reason: 'connected' });

        // Attribute mesh dial failures. Firefox prints "WebRTC: ICE failed,
        // your TURN server appears to be broken" once per peer connection
        // whose ICE fails — on a churny testnet that's a dial to a peer that
        // just left (or one that can't do TURN from ITS side), not a TURN
        // outage. Log WHICH peer failed alongside each warning so the noise
        // is attributable.
        for (const lvl of ['debug', 'info', 'warn']) {
          try {
            result.peer.onLog(lvl, (evt, data) => {
              if (evt === 'pc-state' && data) {
                if (data.pc === 'failed') {
                  console.debug(
                    `[axona-mesh] dial to peer ${String(data.peerId).slice(0, 10)}… failed ` +
                    '(remote peer churned or cannot relay — not a local TURN problem)'
                  );
                  setMeshDiag(d => ({ ...d, failed: d.failed + 1 }));
                } else if (data.pc === 'connected') {
                  setMeshDiag(d => ({ ...d, ok: d.ok + 1 }));
                }
              }
            });
          } catch { /* level not supported — ignore */ }
        }
        cleanup = () => {
          AxonaChatClient.setPeer(null);
          if (result.disconnect) result.disconnect();
        };

        // Fresh connection: reset the zero-peer stopwatch, but NOT
        // everConnected — that flag means "this SESSION was ever connected",
        // and it must survive rebuilds. Resetting it here was the retry
        // killer Aster found (CHANGES-REQUIRED f0a9f88): connect() RESOLVES
        // with {ready:false, peers:0} on its timeout rather than rejecting,
        // so a failed rebuild reset the flag, every later tick bailed on the
        // !everConnected guard, and the watchdog never fired again. One
        // attempt, then permanent deafness — the exact disease it treats.
        zeroSince = null;
        currentPeer = result.peer;

      } catch (err) {
        console.error('Peer connection failed:', err);
        if (active) {
          setStatus({ ready: false, peers: 0, ms: 0, reason: err.message || 'connection-failed' });
        }
      }
    };

    // ── Recovery: tear the whole session down and rebuild it ────────────────
    // Deliberately a FULL rebuild, not a nudge to whichever layer looks stuck.
    // The wedge has at least three distinct causes (socket reconnect loop died,
    // socket back but mesh never rebuilt, graduated client whose re-dial
    // watchdog failed) and the app cannot tell them apart from out here — but a
    // rebuild recovers all of them. setPeer() → reconcileSubscriptions()
    // re-seats every topic, and replayPendingSends() re-publishes anything the
    // dead session stranded on its island (idempotent: same payload bytes →
    // same content-addressed msgId).
    const recover = async (why) => {
      if (recovering || !active) return;
      const now = Date.now();
      if (now < nextRetryAt) return;
      recovering = true;
      nextRetryAt = now + retryDelayMs;
      retryDelayMs = Math.min(retryDelayMs * 2, RETRY_MAX_MS);
      console.warn(`[axona-chat] session recovery: ${why} — rebuilding connection`);
      setStatus(prev => ({ ...prev, ready: false, reason: 'recovering' }));
      try {
        if (cleanup) { try { cleanup(); } catch { /* old session may be half-dead */ } }
        cleanup = null;
        currentPeer = null;
        await init();                      // rebuilds peer + setPeer → re-seats subs
        // Success means PEERS, not merely a peer object: connect() resolves
        // with {ready:false, peers:0} on timeout, and a rebuild into an empty
        // room is a failed attempt that must keep the backoff growing. The
        // tick keeps retrying because everConnected survives; replay waits
        // for a session that can actually deliver.
        const meshPeers = currentPeer?.peers ? currentPeer.peers().length : 0;
        if (meshPeers > 0) {
          retryDelayMs = RETRY_INITIAL_MS; // real recovery re-arms fast retry
          // WAIT for the new session's SUBs to be seated before republishing.
          // A replay that goes out first has nobody registered to hear its
          // echo, and on a live-tail subscription that echo never comes again:
          // the message would be delivered and stay marked NOT DELIVERED
          // forever (Aster, CHANGES-REQUIRED 8d37e65).
          await AxonaChatClient.whenSeated();
          await AxonaChatClient.replayPendingSends();
        }
      } finally {
        recovering = false;
      }
    };

    // ── The tick: measure AND act ───────────────────────────────────────────
    // This interval used to only repaint the footer label. It now also detects
    // sleep (a tick gap no live page produces) and persistent zero-peers, and
    // triggers recovery — because a status line that watches the session die
    // and reports it politely is not a health system (I-6's lesson, app-side).
    const tick = () => {
      const now = Date.now();
      const gap = now - lastTickAt;
      lastTickAt = now;
      if (!currentPeer || recovering) return;

      const peersCount = currentPeer.peers ? currentPeer.peers().length : 0;
      setStatus(prev => ({
        ...prev,
        ready: peersCount > 0,
        peers: peersCount,
        reason: peersCount > 0 ? 'connected' : 'seeking-peers'
      }));

      if (peersCount > 0) { everConnected = true; zeroSince = null; return; }
      if (!everConnected) return;          // still bootstrapping — init owns it
      if (zeroSince === null) zeroSince = now;

      // Sleep detected AND we woke up deaf: don't wait out the threshold —
      // the kernel's backoff timers slept too, and the user is looking at
      // the screen right now.
      if (gap > SLEEP_GAP_MS) { recover(`wake after ~${Math.round(gap / 1000)}s suspend with 0 peers`); return; }
      if (navigator.onLine !== false && now - zeroSince > RECOVER_AFTER_MS) {
        recover(`0 peers for ${Math.round((now - zeroSince) / 1000)}s`);
      }
    };
    interval = setInterval(tick, TICK_MS);

    // Coming back to a hidden tab or a returning network is the moment the
    // wedge becomes user-visible — check immediately instead of within 5s.
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);

    init();

    return () => {
      active = false;
      if (interval) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      if (cleanup) cleanup();
    };
  }, [bridgeUrl]); // Reconnect ONLY on bridge change — never on handle switch

  return (
    <PeerContext.Provider value={{ peer, status }}>
      {children}
      {/* Dev-only mesh diagnostic strip — visible even over the onboarding
          gate so connection health is observable without the console. */}
      {import.meta.env.DEV && (
        <div style={{
          position: 'fixed', bottom: 2, left: 2, zIndex: 9999,
          fontFamily: 'monospace', fontSize: 11, lineHeight: 1.2,
          background: 'rgba(0,0,0,0.75)', color: '#9f9',
          padding: '2px 8px', borderRadius: 4, pointerEvents: 'none'
        }}>
          mesh: {status.reason} · peers {status.peers} · dials ok {meshDiag.ok} / failed {meshDiag.failed}
        </div>
      )}
    </PeerContext.Provider>
  );
};

export const usePeer = () => useContext(PeerContext);
