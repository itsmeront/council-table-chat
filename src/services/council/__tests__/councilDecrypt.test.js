// Decrypt-before-render tests for the confidential council channel (TASK-P-0003).
//
// These mirror the platform's read-path cases (authorize → unseal, fail closed) but at
// the fork's render boundary: a council envelope either opens to plaintext with a known
// role+handle, or is HIDDEN. The browser-only pieces (IndexedDB keyring) are injected
// via __setKeyringProvider so the whole bridge runs under vitest on Node's WebCrypto.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuthorIdentity } from '@axona/protocol';
import { SessionManager } from '../session.mjs';
import {
  generateWrapKeypair, exportPublicJwk, importPrivateJwk, bytesToHex, probeX25519, __forceDhBackend,
} from '../crypto-core.mjs';
import { canonicalBody, verifyRegistry } from '../registry.js';
import { openSealedEnvelope, tryOpenCached, isCouncilTopic, __setKeyringProvider, __setRegistryProvider } from '../councilChannel.js';
import knownHosts from '../known-hosts.json';

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

function relayEnvelope(seal, signerPubkey) {
  return { msgId: 'test', ts: Date.now(), signerPubkey, message: JSON.stringify(seal) };
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

describe('council decrypt-before-render', () => {
  let root, owner, architect, searcher, observer, architectId, searcherId, observerId;
  let registry, ownerSm, sealed;

  beforeEach(async () => {
    __setKeyringProvider(() => null);
    __setRegistryProvider(() => null);
    const store = { v: {} };
    const memStore = { get: (k) => store.v[k] ?? null, set: (k, v) => { store.v[k] = v; } };
    root = await createAuthorIdentity({ persistAs: 'claude', store: memStore });

    owner = await makeKeyring('orchestrator', root.authorId);
    architect = await makeKeyring('architect', mkHex());
    searcher = await makeKeyring('searcher', mkHex());
    observer = await makeKeyring('observer', mkHex());
    architectId = architect.authorId;
    searcherId = searcher.authorId;
    observerId = observer.authorId;

    // Orchestrator wraps the two members; only `architect` will ever hold a wrap blob.
    owner.data.members[architectId] = { role: 'architect', authorId: architectId, x25519PublicJwk: architect.data.x25519.public };
    owner.data.members[searcherId] = { role: 'searcher', authorId: searcherId, x25519PublicJwk: searcher.data.x25519.public };

    registry = await makeRegistry({
      root,
      roles: [
        { role: 'orchestrator', authorId: root.authorId },
        { role: 'architect', authorId: architectId },
        { role: 'searcher', authorId: searcherId },
        { role: 'observer', authorId: observerId },
      ],
    });
    __setRegistryProvider(() => registry);

    ownerSm = new SessionManager({ keyring: owner, topic: TOPIC });
    await ownerSm.mintSession();
    sealed = await ownerSm.seal('TOP SECRET');

    // Reader keyrings: they can read the sessions the owner published (only their blob).
    architect.getSession = (e) => owner.data.sessions[e] ?? null;
    searcher.getSession = (e) => owner.data.sessions[e] ?? null;
    observer.getSession = (e) => owner.data.sessions[e] ?? null;
  });

  afterEach(() => {
    __forceDhBackend(null);
    __setKeyringProvider(() => null);
    __setRegistryProvider(() => null);
  });

  it('opens a valid sealed message for a known, wrapped reader (role+handle)', async () => {
    const res = await openSealedEnvelope(relayEnvelope(sealed, architectId), { registry, keyring: architect });
    expect(res).toEqual({ ok: true, plaintext: 'TOP SECRET', signer: architectId, role: 'architect', handle: 'architect' });
  });

  it('decrypt-before-render bridge returns plaintext through the cached path', async () => {
    __setKeyringProvider(() => architect);
    const res = await tryOpenCached(relayEnvelope(sealed, architectId));
    expect(res.ok).toBe(true);
    expect(res.plaintext).toBe('TOP SECRET');
    expect(res.role).toBe('architect');
  });

  it('HIDES a tampered ciphertext (decrypt failed)', async () => {
    const tampered = { ...sealed, ct: 'AAAA' === sealed.ct ? 'AAAB' : 'AAAA' };
    __setKeyringProvider(() => architect);
    const res = await tryOpenCached(relayEnvelope(tampered, architectId));
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/decrypt failed/);
  });

  it('HIDES a message for a signer who is authorized but not a wrapped member', async () => {
    // `observer` is in the registry but the orchestrator never wrapped a session key for them.
    __setKeyringProvider(() => observer);
    const res = await tryOpenCached(relayEnvelope(sealed, observerId));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('reader is not a member of this epoch');
  });

  it('HIDES a message from a signer not in known-hosts', async () => {
    __setKeyringProvider(() => architect);
    const res = await tryOpenCached(relayEnvelope(sealed, mkHex()));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signer not in known-hosts');
  });

  it('HIDES a handle-only envelope (no verified signer)', async () => {
    const env = { msgId: 'test', ts: Date.now(), message: JSON.stringify(sealed) };
    const res = await openSealedEnvelope(env, { registry, keyring: architect });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no verified signer (handle-only envelope)');
  });

  it('HIDES a message when the registry is tampered (root signature breaks)', async () => {
    const tamperedReg = JSON.parse(JSON.stringify(registry));
    tamperedReg.roles.architect.authorId = mkHex();
    const res = await openSealedEnvelope(relayEnvelope(sealed, architectId), { registry: tamperedReg, keyring: architect });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('registry signature not verified: bad signature');
  });

  it('HIDES a message from a revoked signer', async () => {
    const reg2 = await makeRegistry({
      root,
      roles: [
        { role: 'orchestrator', authorId: root.authorId },
        { role: 'architect', authorId: architectId },
      ],
      revoked: ['architect'],
    });
    const res = await openSealedEnvelope(relayEnvelope(sealed, architectId), { registry: reg2, keyring: architect });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('signer revoked (architect)');
  });

  it('HIDES a replayed nonce+epoch (reuse)', async () => {
    const seen = new Map([[`${sealed.epoch}:${sealed.nonce}`, 'SOMETHING-ELSE']]);
    const res = await openSealedEnvelope(relayEnvelope(sealed, architectId), { registry, keyring: architect, seen });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('nonce+epoch reuse');
  });

  it('HIDES a message in a consumed epoch', async () => {
    owner.data.sessions[sealed.epoch].consumed = true;
    const res = await openSealedEnvelope(relayEnvelope(sealed, architectId), { registry, keyring: architect });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/consumed/);
  });

  it('HIDES a non-sealed payload on the council topic', async () => {
    const env = { msgId: 'test', ts: Date.now(), signerPubkey: architectId, message: 'just plain text' };
    const res = await openSealedEnvelope(env, { registry, keyring: architect });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('not a sealed message');
  });

  it('only consults the bridge on the council topic', () => {
    expect(isCouncilTopic({ name: 'OO.Private.Council' })).toBe(true);
    expect(isCouncilTopic({ name: 'some.other.topic' })).toBe(false);
  });

  it('provisioned reader keys are non-extractable', async () => {
    const { privateKey } = await generateWrapKeypair({ extractable: false });
    await expect(crypto.subtle.exportKey('jwk', privateKey)).rejects.toThrow();

    const extractable = await generateWrapKeypair({ extractable: true });
    const jwk = await crypto.subtle.exportKey('jwk', extractable.privateKey);
    const nonExtractable = await importPrivateJwk(jwk, { extractable: false });
    await expect(crypto.subtle.exportKey('jwk', nonExtractable)).rejects.toThrow();
  });

  it('verifies the real vendored registry (interop with the platform signed data)', async () => {
    const v = await verifyRegistry(knownHosts);
    expect(v.ok).toBe(true);
  });

  it('absent-X25519 fallback (forced P-256) still seals and opens end-to-end', async () => {
    // On runtimes without X25519 (older Chrome/WebView) every wrap/unwrap and seal/open
    // runs the ECDH P-256 + HKDF fallback. This runtime HAS X25519, so we force the
    // fallback on — the same branch the Chromium CI job exercises for real.
    expect(await probeX25519()).toBe(true);
    __forceDhBackend('p256');

    const ownerP = await makeKeyring('orchestrator', root.authorId);
    const architectP = await makeKeyring('architect', architectId);
    ownerP.data.members[architectId] = { role: 'architect', authorId: architectId, x25519PublicJwk: architectP.data.x25519.public };
    architectP.getSession = (e) => ownerP.data.sessions[e] ?? null;

    const sm = new SessionManager({ keyring: ownerP, topic: TOPIC });
    await sm.mintSession();
    const sealedP = await sm.seal('FALLBACK-TEXT');

    __setKeyringProvider(() => architectP);
    const res = await tryOpenCached(relayEnvelope(sealedP, architectId));
    expect(res).toEqual({ ok: true, plaintext: 'FALLBACK-TEXT', signer: architectId, role: 'architect', handle: 'architect' });
  });

  it('cross-backend keys fail closed (P-256-wrapped blob cannot be opened by a native key)', async () => {
    __forceDhBackend('p256');
    const ownerP = await makeKeyring('orchestrator', root.authorId);
    const architectP = await makeKeyring('architect', architectId);
    ownerP.data.members[architectId] = { role: 'architect', authorId: architectId, x25519PublicJwk: architectP.data.x25519.public };
    const sm = new SessionManager({ keyring: ownerP, topic: TOPIC });
    await sm.mintSession();
    const sealedP = await sm.seal('FALLBACK-TEXT');

    // The architect's "same authorId" key now uses the native X25519 backend — deriving
    // with it against the P-256-wrapped blob must fail, never silently plaintext.
    __forceDhBackend(null);
    const architectNative = await makeKeyring('architect', architectId);
    architectNative.getSession = (e) => ownerP.data.sessions[e] ?? null;
    __setKeyringProvider(() => architectNative);
    const res = await tryOpenCached(relayEnvelope(sealedP, architectId));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('decrypt failed');
  });
});
