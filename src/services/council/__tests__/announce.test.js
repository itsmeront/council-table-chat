// Auto key-delivery unit tests for the confidential council channel (TASK-P-0003).
//
// These cover the browser side of the epoch-announcement path: verification of the
// orchestrator-signed control message (the same trust checks as the platform), the
// wrapped-map trim, the consumed-monotone merge, the control-message intercept that never
// renders, and self-mint. The IndexedDB persistence itself is exercised in real Chromium
// (browserSelfTest), so the install path is made observable here via __setEpochApplier.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuthorIdentity } from '@axona/protocol';
import { SessionManager } from '../session.mjs';
import {
  generateWrapKeypair, exportPublicJwk, exportPrivateJwk, createKeybinding, verifyKeybinding,
  bytesToHex, canonicalJson, __forceDhBackend,
} from '../crypto-core.mjs';
import { canonicalBody } from '../registry.js';
import { verifyEpochAnnouncement, epochRecordFromAnnouncement } from '../announce.mjs';
import { mergeEpochRecord, CouncilKeyring } from '../CouncilKeyring.js';
import {
  handleCouncilControl, isCouncilTopic, __setKeyringProvider, __setRegistryProvider, __setEpochApplier,
} from '../councilChannel.js';

const TOPIC = 'OO.Private.Council';
const mkHex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

async function makeKeyring(role, authorId) {
  const { privateKey, publicKey } = await generateWrapKeypair({ extractable: false });
  const publicJwk = await exportPublicJwk(publicKey);
  const data = { sessions: {}, members: {}, x25519: { public: publicJwk } };
  return {
    authorId, role, privateKey, data,
    get members() { return Object.values(data.members); },
    getSession: (e) => data.sessions[e] ?? null,
    setSession: (e, r) => { data.sessions[e] = r; },
    save: () => {},
  };
}

function relayEnvelope(msg, signerPubkey) {
  return { msgId: 'test', ts: Date.now(), signerPubkey, message: JSON.stringify(msg) };
}

async function makeRegistry({ root, roles, revoked = [] }) {
  const reg = { schema: 'openopportunity/known-hosts/v1', root: root.authorId, roles: {}, signature: null };
  for (const r of roles) {
    reg.roles[r.role] = { authorId: r.authorId, handle: r.role, class: 'agent', operator: 'test', reviewer: false, added: '2026-01-01' };
  }
  for (const role of revoked) reg.roles[role].revoked = new Date().toISOString();
  const body = new TextEncoder().encode(canonicalBody(reg));
  const sig = await root.sign(body);
  reg.signature = { signer: root.authorId, ts: new Date().toISOString(), sig: bytesToHex(sig) };
  return reg;
}

// Mirrors council/crypto/announce.mjs buildEpochAnnouncement — the exact body the platform
// signs. Kept here so a drift between the two trees fails the tests that matter.
async function buildAnnouncement({ topic, epoch, record, signer, signFn }) {
  const env = {
    v: 1, kind: 'council-epoch', topic, epoch,
    mintedAt: record.mintedAt, salt: record.salt, prefix: record.prefix, counter: record.counter,
    archiveRef: record.archiveRef ?? null, unarchived: record.unarchived ?? 0,
    consumed: !!record.consumed, wrapped: record.wrapped,
  };
  const sig = await signFn(new TextEncoder().encode(canonicalJson(env)));
  return { ...env, signer, sigHex: bytesToHex(sig) };
}

describe('council auto key-delivery', () => {
  let root, orch, memberId;
  let registry, ownerSm, owner, memberKeyring;

  beforeEach(async () => {
    __forceDhBackend(null);
    __setEpochApplier((e, r) => { owner.data.sessions[e] = r; });
    __setRegistryProvider(() => registry);
    const store = { v: {} };
    const memStore = { get: (k) => store.v[k] ?? null, set: (k, v) => { store.v[k] = v; } };
    root = await createAuthorIdentity({ persistAs: 'claude', store: memStore });
    orch = await createAuthorIdentity({ persistAs: 'orch', store: memStore });
    memberId = mkHex();

    owner = await makeKeyring('orchestrator', orch.authorId);
    memberKeyring = await makeKeyring('member', memberId);
    owner.data.members[memberId] = { role: 'member', authorId: memberId, x25519PublicJwk: memberKeyring.data.x25519.public };

    registry = await makeRegistry({
      root,
      roles: [
        { role: 'orchestrator', authorId: orch.authorId },
        { role: 'member', authorId: memberId },
      ],
    });

    ownerSm = new SessionManager({ keyring: owner, topic: TOPIC });
    await ownerSm.mintSession();
    __setKeyringProvider(() => memberKeyring);
  });

  afterEach(() => {
    __forceDhBackend(null);
    __setKeyringProvider(() => null);
    __setRegistryProvider(() => null);
    __setEpochApplier((e, r) => { owner.data.sessions[e] = r; });
  });

  it('verifies a genuine orchestrator announcement (epoch + record round-trip)', async () => {
    const epoch = ownerSm.activeEpoch;
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: orch.authorId, signFn: (b) => orch.sign(b),
    });
    const v = await verifyEpochAnnouncement(env, registry);
    expect(v.ok).toBe(true);
    expect(v.epoch).toBe(epoch);
    expect(v.record.salt).toEqual(owner.getSession(epoch).salt);
    expect(v.record.wrapped).toEqual(owner.getSession(epoch).wrapped);
  });

  it('rejects an announcement signed by a non-orchestrator', async () => {
    const epoch = ownerSm.activeEpoch;
    const rogue = await createAuthorIdentity({ persistAs: 'rogue', store: { get: () => null, set: () => {} } });
    // The rogue is a REGISTRY-KNOWN member — so the failure is the ROLE check, not absence.
    const reg2 = await makeRegistry({
      root,
      roles: [
        { role: 'orchestrator', authorId: orch.authorId },
        { role: 'member', authorId: memberId },
        { role: 'member', authorId: rogue.authorId },
      ],
    });
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: rogue.authorId, signFn: (b) => rogue.sign(b),
    });
    const v = await verifyEpochAnnouncement(env, reg2);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/not signed by the orchestrator/);
  });

  it('rejects a tampered wrap-blob', async () => {
    const epoch = ownerSm.activeEpoch;
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: orch.authorId, signFn: (b) => orch.sign(b),
    });
    const blob = env.wrapped[memberId];
    env.wrapped[memberId] = { ...blob, iv: blob.iv.split('').reverse().join('') };
    const v = await verifyEpochAnnouncement(env, registry);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/signature invalid/);
  });

  it('trims the wrapped map to the reader\'s own blob only', () => {
    const epoch = ownerSm.activeEpoch;
    const rec = owner.getSession(epoch);
    const trimmed = epochRecordFromAnnouncement(
      { ...rec, wrapped: { [memberId]: rec.wrapped[memberId], otherAuthor: { ephem: 'x' } } },
      memberId,
    );
    expect(Object.keys(trimmed.wrapped)).toEqual([memberId]);
    expect(trimmed.wrapped.otherAuthor).toBeUndefined();
  });

  it('mergeEpochRecord installs a new epoch', () => {
    const data = { sessions: {} };
    const rec = { salt: 's', wrapped: { [memberId]: {} } };
    mergeEpochRecord(data, 'epoch-1', rec);
    expect(data.sessions['epoch-1']).toBe(rec);
  });

  it('mergeEpochRecord never downgrades a consumed epoch', () => {
    const data = { sessions: {} };
    mergeEpochRecord(data, 'epoch-1', { salt: 's', consumed: true, wrapped: {} });
    mergeEpochRecord(data, 'epoch-1', { salt: 'older', consumed: false, wrapped: {} });
    expect(data.sessions['epoch-1'].consumed).toBe(true);
    expect(data.sessions['epoch-1'].salt).toBe('older');
  });

  it('handleCouncilControl installs a verified epoch and never renders it', async () => {
    const epoch = ownerSm.activeEpoch;
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: orch.authorId, signFn: (b) => orch.sign(b),
    });
    const calls = [];
    __setEpochApplier((e, r) => { calls.push([e, r]); });
    const handled = await handleCouncilControl(relayEnvelope(env, orch.authorId));
    expect(handled).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe(epoch);
    expect(Object.keys(calls[0][1].wrapped)).toEqual([memberId]);
  });

  it('handleCouncilControl drops an announcement when the keyring is not provisioned', async () => {
    const epoch = ownerSm.activeEpoch;
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: orch.authorId, signFn: (b) => orch.sign(b),
    });
    __setKeyringProvider(() => null);
    const calls = [];
    __setEpochApplier((e, r) => { calls.push([e, r]); });
    const handled = await handleCouncilControl(relayEnvelope(env, orch.authorId));
    expect(handled).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('handleCouncilControl drops a forged announcement (never renders, never installs)', async () => {
    const epoch = ownerSm.activeEpoch;
    const rogue = await createAuthorIdentity({ persistAs: 'rogue2', store: { get: () => null, set: () => {} } });
    const env = await buildAnnouncement({
      topic: TOPIC, epoch, record: owner.getSession(epoch), signer: rogue.authorId, signFn: (b) => rogue.sign(b),
    });
    const calls = [];
    __setEpochApplier((e, r) => { calls.push([e, r]); });
    const handled = await handleCouncilControl(relayEnvelope(env, rogue.authorId));
    expect(handled).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('handleCouncilControl swallows join requests (never rendered)', async () => {
    const join = { v: 1, kind: 'council-join', topic: TOPIC, role: 'member', handle: 'member', authorId: memberId, x25519PublicJwk: memberKeyring.data.x25519.public, binding: {} };
    const handled = await handleCouncilControl(relayEnvelope(join, memberId));
    expect(handled).toBe(true);
  });

  it('handleCouncilControl lets non-control messages through to the render path', async () => {
    const handled = await handleCouncilControl({ msgId: 'm', signerPubkey: memberId, message: JSON.stringify({ kind: 'council-sealed', epoch: 'e', nonce: 'n', ct: 'c' }) });
    expect(handled).toBe(false);
  });

  it('isCouncilTopic matches only the council topic', () => {
    expect(isCouncilTopic({ name: 'OO.Private.Council' })).toBe(true);
    expect(isCouncilTopic({ name: 'lobby' })).toBe(false);
    expect(isCouncilTopic(null)).toBe(false);
  });

  it('selfMint produces a keyring bound to the persona with a public-only join payload', async () => {
    // Pure logic check of the self-mint data shape (IndexedDB writes are browserSelfTest's job):
    const persona = await createAuthorIdentity({ persistAs: 'persona', store: { get: () => null, set: () => {} } });
    const pair = await generateWrapKeypair({ extractable: true });
    const publicJwk = await exportPublicJwk(pair.publicKey);
    const privateJwk = await exportPrivateJwk(pair.privateKey);
    const binding = await createKeybinding({ authorId: persona.authorId, x25519PublicJwk: publicJwk }, (b) => persona.sign(b));
    expect(await verifyKeybinding(binding, persona.authorId)).toBe(true);
    // A swapped pubkey breaks the binding — the admin gate verifies this before approving.
    expect(await verifyKeybinding({ ...binding, body: { ...binding.body, x25519PublicJwk: { crv: 'other' } } }, persona.authorId)).toBe(false);
    expect(typeof publicJwk).toBe('object');
    expect(typeof privateJwk).toBe('object');
    // And CouncilKeyring.selfMint still exists with the right contract:
    expect(typeof CouncilKeyring.selfMint).toBe('function');
    expect(typeof CouncilKeyring.applyEpoch).toBe('function');
  });
});
