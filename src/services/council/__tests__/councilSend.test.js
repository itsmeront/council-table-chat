// Member-writer tests for the confidential council channel (TASK-P-0003).
//
// The browser write path (councilSend.js) seals under the same epoch session key the reader
// uses, but with a per-message RANDOM nonce instead of the orchestrator's shared counter
// (see the module comment for why — two writers advancing one counter is nonce reuse). These
// tests prove a member-sealed envelope opens for every wrapped member, fails closed on
// tamper, and that the send gate (assertCanSendCouncil) only lets a registry-known signer
// with a matching keyring through.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuthorIdentity } from '@axona/protocol';
import { SessionManager, openForReader } from '../session.mjs';
import {
  generateWrapKeypair, exportPublicJwk, importPrivateJwk, exportPrivateJwk, bytesToHex,
} from '../crypto-core.mjs';
import { canonicalBody } from '../registry.js';
import { sealForSend, assertCanSendCouncil } from '../councilSend.js';
import { __setKeyringProvider, __setRegistryProvider } from '../councilChannel.js';
import knownHosts from '../known-hosts.json';

const TOPIC = 'OO.Private.Council';
const mkHex = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

// Wrap-key-holder keyring (SessionManager needs setSession/save/members).
async function makeOwner(role, authorId) {
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

// Member keyring in the shape CouncilKeyring produces: non-extractable private wrap key
// imported from its own JWK (so it can unwrap the epoch session blob), plus a data payload
// that matches an export-keyring export (kind/version/x25519/sessions).
async function makeMember(role, authorId, { sessionsFor } = {}) {
  const { privateKey, publicKey } = await generateWrapKeypair({ extractable: true });
  const privateJwk = await exportPrivateJwk(privateKey);
  const publicJwk = await exportPublicJwk(publicKey);
  const data = {
    kind: 'council-keyring', version: 1, role, authorId,
    x25519: { public: publicJwk, private: privateJwk },
    members: {}, sessions: {},
  };
  const keyring = {
    authorId, role,
    privateKey: await importPrivateJwk(privateJwk, { extractable: false }),
    data,
    getSession: (e) => sessionsFor ? sessionsFor(e) : (data.sessions[e] ?? null),
  };
  return keyring;
}

async function makeRegistry(root, roles) {
  const reg = { schema: 'openopportunity/known-hosts/v1', root: root.authorId, roles: {}, signature: null };
  for (const r of roles) {
    reg.roles[r.role] = { authorId: r.authorId, handle: r.role, class: 'agent', operator: 'test', reviewer: false, added: '2026-01-01' };
  }
  const body = new TextEncoder().encode(canonicalBody(reg));
  const sig = await root.sign(body);
  reg.signature = { signer: root.authorId, ts: new Date().toISOString(), sig: bytesToHex(sig) };
  return reg;
}

describe('council member write path', () => {
  let root, owner, alice, bob, carol, aliceId, bobId, registry, epochs;

  beforeEach(async () => {
    __setKeyringProvider(() => null);
    __setRegistryProvider(() => null);
    const store = { v: {} };
    const memStore = { get: (k) => store.v[k] ?? null, set: (k, v) => { store.v[k] = v; } };
    root = await createAuthorIdentity({ persistAs: 'claude', store: memStore });

    owner = await makeOwner('orchestrator', root.authorId);
    alice = await makeMember('alice', mkHex());
    bob = await makeMember('bob', mkHex());
    carol = await makeMember('carol', mkHex());
    aliceId = alice.authorId;
    bobId = bob.authorId;

    owner.data.members[aliceId] = { role: 'alice', authorId: aliceId, x25519PublicJwk: alice.data.x25519.public };
    owner.data.members[bobId] = { role: 'bob', authorId: bobId, x25519PublicJwk: bob.data.x25519.public };

    registry = await makeRegistry(root, [
      { role: 'orchestrator', authorId: root.authorId },
      { role: 'alice', authorId: aliceId },
      { role: 'bob', authorId: bobId },
    ]);

    // Both members' keyrings carry the sessions the orchestrator minted — that is exactly
    // what the export-keyring payload ships (sessions embedded in data.sessions).
    const sm = new SessionManager({ keyring: owner, topic: TOPIC });
    await sm.mintSession();
    alice.data.sessions = owner.data.sessions;
    bob.data.sessions = owner.data.sessions;
    epochs = Object.keys(owner.data.sessions);
    expect(epochs.length).toBe(1);
  });

  afterEach(() => {
    __setKeyringProvider(() => null);
    __setRegistryProvider(() => null);
  });

  it('a member seals and EVERY wrapped member opens the same envelope', async () => {
    const env = await sealForSend('member sealed this', { keyring: alice, topic: TOPIC });
    expect(env.kind).toBe('council-sealed');
    expect(env.topic).toBe(TOPIC);
    expect(env.epoch).toBe(epochs[0]);

    const readAlice = await openForReader(env, { keyring: alice, topic: TOPIC });
    expect(readAlice.ok).toBe(true);
    expect(readAlice.plaintext).toBe('member sealed this');

    const readBob = await openForReader(env, { keyring: bob, topic: TOPIC });
    expect(readBob.ok).toBe(true);
    expect(readBob.plaintext).toBe('member sealed this');
  });

  it('uses a fresh random nonce per message (no shared-counter race)', async () => {
    const a = await sealForSend('one', { keyring: alice, topic: TOPIC });
    const b = await sealForSend('two', { keyring: alice, topic: TOPIC });
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.epoch).toBe(b.epoch);
  });

  it('fails closed on tampered member ciphertext', async () => {
    const env = await sealForSend('secret', { keyring: alice, topic: TOPIC });
    const tampered = { ...env, ct: env.ct === 'AAAA' ? 'AAAB' : 'AAAA' };
    const res = await openForReader(tampered, { keyring: bob, topic: TOPIC });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/decrypt failed/);
  });

  it('rejects sealing when there is no unconsumed session for the writer', async () => {
    owner.data.sessions[epochs[0]].consumed = true;
    await expect(sealForSend('too late', { keyring: alice, topic: TOPIC }))
      .rejects.toThrow(/no active session/);
  });

  it('rejects sealing when the writer has no wrap blob in the epoch (not a member)', async () => {
    carol.data.sessions = owner.data.sessions;
    await expect(sealForSend('not mine', { keyring: carol, topic: TOPIC }))
      .rejects.toThrow(/no active session/);
  });

  it('send gate: known signer with a matching keyring passes', async () => {
    const gate = await assertCanSendCouncil(aliceId, registry, () => alice);
    expect(gate.ok).toBe(true);
    expect(gate.role).toBe('alice');
  });

  it('send gate: unknown signer is refused', async () => {
    const gate = await assertCanSendCouncil(mkHex(), registry, () => alice);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toBe('signer not in known-hosts');
  });

  it('send gate: no keyring is refused (nothing to seal under)', async () => {
    const gate = await assertCanSendCouncil(aliceId, registry, () => null);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/no keyring provisioned/);
  });

  it('send gate: a keyring for a DIFFERENT persona is refused (never leak under the wrong signer)', async () => {
    const gate = await assertCanSendCouncil(aliceId, registry, () => bob);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/different persona/);
  });

  it('send gate: a tampered registry fails closed', async () => {
    const badReg = JSON.parse(JSON.stringify(registry));
    badReg.roles.alice.authorId = mkHex();
    const gate = await assertCanSendCouncil(aliceId, badReg, () => alice);
    expect(gate.ok).toBe(false);
    expect(gate.reason).toMatch(/registry signature not verified/);
  });

  it('the real vendored registry accepts a real member signer', async () => {
    const v = await assertCanSendCouncil(knownHosts.roles.architect.authorId, knownHosts, () => null);
    // Keyring absence is the refusable part; the signer itself IS authorized.
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/no keyring provisioned/);
  });
});
