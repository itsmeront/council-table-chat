// Honest send state — a publish is confirmed by its network echo, never by its
// island echo.
//
// Why this fence exists (2026-08-05, captured live): a session that slept
// overnight woke with zero peers. A message typed into it resolved pub(),
// self-rooted on the one-node island, echoed back through the local
// subscription, and rendered EXACTLY like a delivered message — while no other
// node on the network ever received it. The rule under test: pendingSends is
// cleared only by confirmSend, which the client calls on echo WITH peers>0;
// everything else leaves the record in place so the UI warns and recovery
// replays it. The replay is idempotent because the stored payload is the exact
// published object and msgId is content-addressed.
import { describe, it, expect, beforeEach } from 'vitest';

const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

import { useChatStore } from '../useChatStore.js';

const REC = (over = {}) => ({
  topicId: 'eagle::lobby:open',
  descriptor: { region: 'eagle', name: 'lobby', write: 'open' },
  payload: { v: 1, text: 'hello', handle: 'probe' },
  authorRef: 'handle-1',
  at: 1_000,
  island: false,
  ...over,
});

describe('pendingSends — honest send state', () => {
  beforeEach(() => {
    useChatStore.setState({ pendingSends: {} });
  });

  it('markPendingSend records the send keyed by msgId', () => {
    useChatStore.getState().markPendingSend('m1', REC());
    expect(useChatStore.getState().pendingSends.m1).toBeTruthy();
    expect(useChatStore.getState().pendingSends.m1.payload.text).toBe('hello');
  });

  it('confirmSend clears the pending record', () => {
    useChatStore.getState().markPendingSend('m1', REC());
    useChatStore.getState().confirmSend('m1');
    expect(useChatStore.getState().pendingSends.m1).toBeUndefined();
  });

  it('confirming an unknown msgId is a no-op, not a crash', () => {
    useChatStore.getState().markPendingSend('m1', REC());
    useChatStore.getState().confirmSend('never-sent');
    expect(Object.keys(useChatStore.getState().pendingSends)).toEqual(['m1']);
  });

  it('an island send stays pending until explicitly confirmed', () => {
    // The client only calls confirmSend when the echo arrives with peers>0 —
    // so a record marked island persists across any number of island echoes.
    // This pins the STORE side of that contract: nothing clears it implicitly.
    useChatStore.getState().markPendingSend('m2', REC({ island: true }));
    expect(useChatStore.getState().pendingSends.m2.island).toBe(true);
    // …and the stored payload is the exact object to replay, unchanged.
    expect(useChatStore.getState().pendingSends.m2.payload).toEqual(
      { v: 1, text: 'hello', handle: 'probe' }
    );
  });

  it('multiple pending sends are independent', () => {
    useChatStore.getState().markPendingSend('a', REC());
    useChatStore.getState().markPendingSend('b', REC({ island: true }));
    useChatStore.getState().confirmSend('a');
    const pending = useChatStore.getState().pendingSends;
    expect(pending.a).toBeUndefined();
    expect(pending.b).toBeTruthy();
  });
});
