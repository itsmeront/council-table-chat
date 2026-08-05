// Peer replacement must re-seat every subscription on the NEW peer.
//
// Why this fence exists (Aster, CHANGES-REQUIRED f0a9f88): setPeer(null)
// stopped the presence heartbeat and nothing else. activeSubscriptions kept
// every handle from the dead peer, so reconcileSubscriptions() on the fresh
// peer saw each topic as already-subscribed and skipped it. A recovered
// session held a map full of dead handles, received no topic traffic, and
// could never see the echo that confirms a replayed send — the recovery
// path recovered nothing.
import { describe, it, expect, beforeEach } from 'vitest';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

import AxonaChatClient from '../AxonaChatClient.js';
import { useChatStore } from '../../stores/useChatStore.js';

// A fake peer that records sub() calls and hands out stoppable handles.
const makeFakePeer = (name) => {
  const p = {
    name,
    subCalls: [],
    stopped: [],
    sub: async (descriptor) => {
      p.subCalls.push(descriptor);
      const handle = { stop: () => p.stopped.push(descriptor) };
      return handle;
    },
    pub: async () => 'fake-msgid',
    peers: () => [{}],
  };
  return p;
};

describe('setPeer — peer replacement re-seats subscriptions', () => {
  beforeEach(() => {
    useChatStore.setState({
      subscribedTopics: [{ region: 'eagle', name: 'lobby', write: 'open' }],
      currentHandle: null,
    });
    AxonaChatClient.activeSubscriptions.clear();
    AxonaChatClient.stopPresenceHeartbeat?.();
  });

  it('subscribes every topic on the first peer', async () => {
    const peerA = makeFakePeer('A');
    AxonaChatClient.setPeer(peerA);
    await new Promise(r => setTimeout(r, 50));   // reconcile is fire-and-forget
    // lobby + ticker + presence at minimum
    expect(peerA.subCalls.length).toBeGreaterThanOrEqual(3);
    expect(AxonaChatClient.activeSubscriptions.size).toBeGreaterThanOrEqual(3);
    AxonaChatClient.setPeer(null);
  });

  it('replacement stops old handles, clears the map, re-subscribes on the new peer', async () => {
    const peerA = makeFakePeer('A');
    AxonaChatClient.setPeer(peerA);
    await new Promise(r => setTimeout(r, 50));
    const seatedOnA = peerA.subCalls.length;
    expect(seatedOnA).toBeGreaterThanOrEqual(3);

    const peerB = makeFakePeer('B');
    AxonaChatClient.setPeer(peerB);
    await new Promise(r => setTimeout(r, 50));

    // Old handles stopped — the dead session holds nothing.
    expect(peerA.stopped.length).toBe(seatedOnA);
    // New peer got the SUBs — the rebuilt session actually hears the network.
    expect(peerB.subCalls.length).toBeGreaterThanOrEqual(3);
    // And the live map points at B's handles only.
    expect(AxonaChatClient.activeSubscriptions.size).toBe(peerB.subCalls.length);
    AxonaChatClient.setPeer(null);
  });

  it('setPeer(null) clears everything so a later peer starts clean', async () => {
    const peerA = makeFakePeer('A');
    AxonaChatClient.setPeer(peerA);
    await new Promise(r => setTimeout(r, 50));
    AxonaChatClient.setPeer(null);
    expect(AxonaChatClient.activeSubscriptions.size).toBe(0);
  });
});
