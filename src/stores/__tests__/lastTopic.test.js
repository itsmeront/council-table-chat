// The restored channel must be one the user is still subscribed to.
//
// Restoring a topic blind is worse than not restoring at all: the app would
// open on a channel that is not in the sidebar, cannot be left, and receives
// nothing — because leaving it unsubscribed it from the network. Every case
// below is a real state localStorage can hold.
import { describe, it, expect, beforeEach } from 'vitest';
// Node has no localStorage. A minimal in-memory shim keeps this test free of a
// jsdom dependency — the code under test only ever calls getItem/setItem.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
  clear: () => mem.clear(),
};

import { loadLastTopic, getTopicId } from '../useChatStore.js';

const LOBBY = { region: 'eagle', name: 'lobby' };
const TECH  = { region: 'eagle', name: 'tech' };
const SUBSCRIBED = [LOBBY, TECH];

const store = (v) => localStorage.setItem('axona-last-topic', v);

describe('loadLastTopic', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to lobby when nothing is stored', () => {
    expect(loadLastTopic(SUBSCRIBED)).toEqual(LOBBY);
  });

  it('restores a topic the user is still subscribed to', () => {
    store(JSON.stringify(TECH));
    expect(getTopicId(loadLastTopic(SUBSCRIBED))).toBe(getTopicId(TECH));
  });

  it('falls back when the topic has since been left', () => {
    store(JSON.stringify({ region: 'eagle', name: 'a-channel-i-left' }));
    expect(loadLastTopic(SUBSCRIBED)).toEqual(LOBBY);
  });

  it('falls back on corrupt JSON rather than throwing', () => {
    store('{not json');
    expect(loadLastTopic(SUBSCRIBED)).toEqual(LOBBY);
  });

  it('falls back on a well-formed object that is not a topic', () => {
    store(JSON.stringify({ nope: true }));
    expect(loadLastTopic(SUBSCRIBED)).toEqual(LOBBY);
  });

  // Owner and write policy fold into the topic id, so a name match is NOT a
  // topic match — an owner-write channel called "tech" is a different channel
  // from the open one, and restoring the wrong one would open a channel the
  // user cannot post to while looking identical in the header.
  it('does not match on name alone when the write policy differs', () => {
    store(JSON.stringify({ region: 'eagle', name: 'tech', write: 'owner', owner: 'abc' }));
    expect(loadLastTopic(SUBSCRIBED)).toEqual(LOBBY);
  });
});
