// Runs inside real Chromium (Playwright, see e2e/council.browser.spec.js) to prove the
// council crypto path actually executes in a browser — the vendored noble-ed25519 verify,
// Web Crypto X25519 / forced P-256 fallback, NON-EXTRACTABLE key import, and the IndexedDB
// keyring (CouncilKeyring). Node's vitest suite covers the same logic but cannot exercise
// IndexedDB or the served ESM graph; only a real browser can.
import {
  generateWrapKeypair, exportPublicJwk, __forceDhBackend,
} from './crypto-core.mjs';
import { SessionManager, openForReader } from './session.mjs';
import { verifyRegistry } from './registry.js';
import { CouncilKeyring } from './CouncilKeyring.js';
import knownHosts from './known-hosts.json';

const TOPIC = 'OO.Private.Council';
const mkHex = () => [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

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

async function nonExportable(key) {
  try { await crypto.subtle.exportKey('jwk', key); return false; } catch { return true; }
}

export async function runBrowserSelfTest() {
  const failures = [];
  const check = (name, ok) => { if (!ok) failures.push(name); };

  const rv = await verifyRegistry(knownHosts);
  check(`registry root signature verifies in-browser (noble ed25519): ${rv.reason || 'ok'}`, rv.ok === true);

  const { privateKey } = await generateWrapKeypair({ extractable: false });
  check('fresh wrap key is non-extractable', await nonExportable(privateKey));

  const ext = await generateWrapKeypair({ extractable: true });
  const privJwk = await crypto.subtle.exportKey('jwk', ext.privateKey);
  const authorId = mkHex();
  await CouncilKeyring.provision({
    kind: 'council-keyring', version: 1, role: 'orchestrator', authorId,
    members: {},
    x25519: { public: await exportPublicJwk(ext.publicKey), private: privJwk },
    sessions: {},
  });
  const loaded = await CouncilKeyring.load();
  check('keyring provisions/loads from IndexedDB', !!loaded && loaded.authorId === authorId);
  check('provisioned key re-imports as non-extractable', loaded ? await nonExportable(loaded.privateKey) : false);

  const ownerId = mkHex();
  const architectId = mkHex();
  const owner = await makeKeyring('orchestrator', ownerId);
  const architect = await makeKeyring('architect', architectId);
  owner.data.members[architectId] = { role: 'architect', authorId: architectId, x25519PublicJwk: architect.data.x25519.public };
  const sm = new SessionManager({ keyring: owner, topic: TOPIC });
  await sm.mintSession();
  const sealed = await sm.seal('BROWSER-SMOKE');
  const reader = { authorId: architectId, getSession: (e) => owner.data.sessions[e] ?? null, privateKey: architect.privateKey };
  const opened = await openForReader(sealed, { keyring: reader, topic: TOPIC });
  check('seal→open round trip in-browser', opened.ok === true && opened.plaintext === 'BROWSER-SMOKE');

  __forceDhBackend('p256');
  try {
    const ownerP = await makeKeyring('orchestrator', mkHex());
    const archP = await makeKeyring('architect', mkHex());
    ownerP.data.members[archP.authorId] = { role: 'architect', authorId: archP.authorId, x25519PublicJwk: archP.data.x25519.public };
    const smP = new SessionManager({ keyring: ownerP, topic: TOPIC });
    await smP.mintSession();
    const sealedP = await smP.seal('FALLBACK-SMOKE');
    const readerP = { authorId: archP.authorId, getSession: (e) => ownerP.data.sessions[e] ?? null, privateKey: archP.privateKey };
    const openedP = await openForReader(sealedP, { keyring: readerP, topic: TOPIC });
    check('forced P-256 fallback round trip in-browser', openedP.ok === true && openedP.plaintext === 'FALLBACK-SMOKE');
  } finally {
    __forceDhBackend(null);
  }

  return { ok: failures.length === 0, failures };
}
