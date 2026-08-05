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
// `subDelayMs` holds sub() open, so a replacement can happen mid-flight —
// which is the whole hazard: native sub() has several awaited setup steps.
const makeFakePeer = (name, subDelayMs = 0) => {
  const p = {
    name,
    subCalls: [],
    stopped: [],
    handles: [],
    pubs: [],
    sub: async (descriptor) => {
      p.subCalls.push(descriptor);
      if (subDelayMs) await new Promise(r => setTimeout(r, subDelayMs));
      const handle = { owner: name, stop: () => p.stopped.push(descriptor) };
      p.handles.push(handle);
      return handle;
    },
    pub: async (descriptor) => { p.pubs.push(descriptor); return 'fake-msgid'; },
    peers: () => [{}],
  };
  return p;
};

// One definition of the lobby topic and its STORE key. The bug this file now
// fences came from two places deriving an id differently; a fixture keeps the
// test from repeating that.
const LOBBY = { region: 'eagle', name: 'lobby', write: 'open' };
const LOBBY_KEY = `${LOBBY.region}::${LOBBY.name}:${LOBBY.write}`;
const pendingLobby = () => ({
  topicId: LOBBY_KEY, descriptor: LOBBY,
  payload: { v: 1, text: 'pending' }, authorRef: 'someone',
  at: 1785960000000, island: true,
});

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

  // Aster, CHANGES-REQUIRED 8d37e65. Clearing the map is not enough: an
  // in-flight subscribeTo() from the OLD peer resolves after the clear and
  // writes its dead handle back into the LIVE map, possibly over B's handle
  // for the same topic. The next reconcile then sees that topic as seated and
  // skips it — the original stale-map failure, reconstructed by a race.
  it('a LATE sub from the old peer is stopped, never recorded (A → null → B)', async () => {
    const peerA = makeFakePeer('A', 120);   // sub() stays open across the swap
    const peerB = makeFakePeer('B');
    AxonaChatClient.setPeer(peerA);
    await new Promise(r => setTimeout(r, 20));   // A's subs are in flight, unresolved
    expect(peerA.subCalls.length).toBeGreaterThanOrEqual(3);
    expect(AxonaChatClient.activeSubscriptions.size).toBe(0);  // none resolved yet

    AxonaChatClient.setPeer(null);
    AxonaChatClient.setPeer(peerB);
    // Long enough for A's delayed subs to land — which is when the bug fires.
    await new Promise(r => setTimeout(r, 250));

    // Every handle in the live map belongs to B. Pre-fix, A's late handles
    // are here instead.
    const owners = [...AxonaChatClient.activeSubscriptions.values()].map(h => h.owner);
    expect(owners.length).toBeGreaterThanOrEqual(3);
    expect(owners.every(o => o === 'B')).toBe(true);
    expect(owners).not.toContain('A');
    // And the late arrivals were stopped rather than leaked.
    expect(peerA.stopped.length).toBe(peerA.subCalls.length);
    AxonaChatClient.setPeer(null);
  });

  // The matching ordering hole: replay must not publish before the new
  // session's SUBs are seated, or the echo that clears the pending record is
  // never heard on a live-tail subscription.
  // Aster, CHANGES-REQUIRED 6af3ed6. PeerContext and ChatShell BOTH call
  // setPeer with the same peer object. The generation is unchanged so nothing
  // is cleared, but each call used to launch its own reconciliation; two of
  // them observe an empty map while sub() awaits, and both subscribe. The map
  // keeps one handle and the other callback stays live forever, delivering
  // every message twice.
  it('two setPeer calls with the SAME peer produce exactly one SUB per topic', async () => {
    const peerB = makeFakePeer('B', 60);        // sub() open across both calls
    const first = AxonaChatClient.setPeer(peerB);
    const second = AxonaChatClient.setPeer(peerB);   // the duplicate owner
    expect(second).toBe(first);                 // coalesced, not a second run
    await Promise.all([first, second]);
    await new Promise(r => setTimeout(r, 50));

    const perTopic = new Map();
    for (const d of peerB.subCalls) {
      const k = JSON.stringify(d);
      perTopic.set(k, (perTopic.get(k) || 0) + 1);
    }
    const doubled = [...perTopic.entries()].filter(([, n]) => n > 1);
    expect(doubled).toEqual([]);                 // pre-fix: every topic twice
    expect(AxonaChatClient.activeSubscriptions.size).toBe(peerB.subCalls.length);
    AxonaChatClient.setPeer(null);
  });

  // A SUB that rejects must not be reported as seated. subscribeTo catches its
  // own rejection so Promise.all still resolves; replay therefore has to ask
  // per topic, not trust the batch.
  //
  // This assertion was itself broken until now (Aster, 837c1a0): it checked the
  // protocol HEX id, which _seatedTopicIds no longer contains for any topic. It
  // was therefore true for every state of the world — including an
  // implementation that wrongly recorded the rejected lobby under its store
  // key, the exact defect it claims to guard. Same failure as the mismatch it
  // was written alongside, in the test rather than the code, and it survived a
  // round because "the negative passes" reads like evidence.
  it('a topic whose sub() REJECTS is not seated, and its pending send is HELD', async () => {
    const peerB = makeFakePeer('B');
    const realSub = peerB.sub;
    peerB.sub = async (descriptor) => {
      if (descriptor.name === 'lobby') throw new Error('sub refused');
      return realSub(descriptor);
    };
    await AxonaChatClient.setPeer(peerB);       // resolves despite the failure
    await new Promise(r => setTimeout(r, 50));

    // The STORE key — the id the set actually holds and pendingSends carries.
    expect(AxonaChatClient._seatedTopicIds.has(LOBBY_KEY)).toBe(false);
    // The topics that DID seat are still recorded — this is per-topic, not
    // an all-or-nothing flag.
    expect(AxonaChatClient._seatedTopicIds.size).toBeGreaterThan(0);

    // And the property that matters, stated behaviourally: a pending send for
    // the unseated topic must not go out. Asserting set membership alone would
    // pass again the next time the keys drift.
    useChatStore.setState({ pendingSends: { 'msg-r': pendingLobby() } });
    const before = peerB.pubs.length;
    await AxonaChatClient.replayPendingSends();
    expect(peerB.pubs.length).toBe(before);
    useChatStore.setState({ pendingSends: {} });
    AxonaChatClient.setPeer(null);
  });

  // THE case v0.47.3 got wrong, and the one its tests could not see (Aster,
  // CHANGES-REQUIRED 14e949b). The seating gate compared a protocol hex id
  // against a store key, so `has(rec.topicId)` was false for EVERY pending
  // record: recovery held every replay forever, and the gate written to protect
  // replay disabled it instead. The old test only asserted that a REJECTED sub
  // is absent from the set — true either way, and therefore blind to this.
  //
  // A guard that only ever checks the negative cannot detect a predicate that
  // is always false. This asserts the POSITIVE end-to-end: a normal topic that
  // seated successfully must actually be republished.
  it('a pending send on a SEATED topic is actually replayed (not held)', async () => {
    const peerB = makeFakePeer('B');
    await AxonaChatClient.setPeer(peerB);
    await new Promise(r => setTimeout(r, 50));

    // Record a pending send exactly as publish() does — same key derivation.
    const descriptor = LOBBY;
    useChatStore.setState({ pendingSends: { 'msg-1': pendingLobby() } });

    const pubsBefore = peerB.pubs.length;
    await AxonaChatClient.replayPendingSends();
    // Pre-fix: zero pubs, one "replay HELD" warning, message never resent.
    expect(peerB.pubs.length).toBe(pubsBefore + 1);
    expect(peerB.pubs[peerB.pubs.length - 1]).toEqual(descriptor);

    useChatStore.setState({ pendingSends: {} });
    AxonaChatClient.setPeer(null);
  });

  // The other leg of the gate (Aster, 837c1a0). Seating must be RETIRED when a
  // topic's handle is stopped, or "seated" quietly means "was seated once" and
  // a later pending send publishes into a topic with no live callback.
  it('a topic REMOVED from the subscription list stops being seated, and its replay is HELD', async () => {
    const peerB = makeFakePeer('B');
    await AxonaChatClient.setPeer(peerB);
    await new Promise(r => setTimeout(r, 50));
    expect(AxonaChatClient._seatedTopicIds.has(LOBBY_KEY)).toBe(true);   // seated

    // Drop lobby from the store and reconcile: its handle is stopped.
    useChatStore.setState({ subscribedTopics: [] });
    await AxonaChatClient.reconcileSubscriptions();
    await new Promise(r => setTimeout(r, 30));
    expect(AxonaChatClient._seatedTopicIds.has(LOBBY_KEY)).toBe(false);  // retired

    // A pending send arriving now must not be published — nothing is listening.
    useChatStore.setState({ pendingSends: { 'msg-x': pendingLobby() } });
    const before = peerB.pubs.length;
    await AxonaChatClient.replayPendingSends();
    expect(peerB.pubs.length).toBe(before);

    useChatStore.setState({ pendingSends: {} });
    AxonaChatClient.setPeer(null);
  });

  it('whenSeated() resolves only after every SUB is seated', async () => {
    const peerB = makeFakePeer('B', 80);
    const seated = AxonaChatClient.setPeer(peerB);
    // Not yet: sub() is still open.
    expect(AxonaChatClient.activeSubscriptions.size).toBe(0);
    await seated;
    // The promise is the contract: when it resolves, the handles exist.
    expect(AxonaChatClient.activeSubscriptions.size).toBe(peerB.subCalls.length);
    expect(AxonaChatClient.activeSubscriptions.size).toBeGreaterThanOrEqual(3);
    AxonaChatClient.setPeer(null);
  });
});
