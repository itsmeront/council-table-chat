// Runs inside real Chromium (Playwright, see e2e/council.browser.spec.js) to prove the
// council crypto path actually executes in a browser — the vendored noble-ed25519 verify,
// Web Crypto X25519 / forced P-256 fallback, NON-EXTRACTABLE key import, and the IndexedDB
// keyring (CouncilKeyring). Node's vitest suite covers the same logic but cannot exercise
// IndexedDB or the served ESM graph; only a real browser can.
import {
  generateWrapKeypair, exportPublicJwk, exportPrivateJwk, __forceDhBackend, bytesToHex, canonicalJson,
} from './crypto-core.mjs';
import { generateKeyPair as genEd, exportPublicKey as exportEd, sign as edSign } from './ed25519.js';
import { SessionManager, openForReader } from './session.mjs';
import { verifyRegistry, canonicalBody } from './registry.js';
import { sealForSend } from './councilSend.js';
import { CouncilKeyring } from './CouncilKeyring.js';
import { verifyEpochAnnouncement } from './announce.mjs';
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

  // ── member WRITE path: seal under the epoch session key with a per-message random nonce
  // (councilSend.js), through a keyring PROVISIONED in IndexedDB. The browser's own
  // encrypt-on-send is exactly this: sealForSend → peer.pub(JSON.stringify(env)).
  const ownerM = await makeKeyring('orchestrator', mkHex());
  const memPair = await generateWrapKeypair({ extractable: true });
  const memPubJwk = await exportPublicJwk(memPair.publicKey);
  const memPrivJwk = await exportPrivateJwk(memPair.privateKey);
  const memId = mkHex();
  ownerM.data.members[memId] = { role: 'member', authorId: memId, x25519PublicJwk: memPubJwk };
  const smM = new SessionManager({ keyring: ownerM, topic: TOPIC });
  await smM.mintSession();

  await CouncilKeyring.provision({
    kind: 'council-keyring', version: 1, role: 'member', authorId: memId,
    members: { [memId]: { role: 'member', authorId: memId, x25519PublicJwk: memPubJwk } },
    x25519: { public: memPubJwk, private: memPrivJwk },
    sessions: ownerM.data.sessions,
  });
  const memKr = await CouncilKeyring.load();
  const memberEnv = await sealForSend('MEMBER-WRITES-IN-BROWSER', { keyring: memKr, topic: TOPIC });
  const memberOpen = await openForReader(memberEnv, { keyring: memKr, topic: TOPIC });
  check('member seal→open round trip in-browser (random-nonce writer)',
    memberOpen.ok === true && memberOpen.plaintext === 'MEMBER-WRITES-IN-BROWSER');

  // ── AUTO KEY-DELIVERY (epoch announcements) in-browser, real IndexedDB: the join→approve
  // →auto-install loop. The browser SELF-MINTS a keyring (private key stays here), publishes
  // a public-only join request, the admin approves, and a signed epoch announcement then
  // delivers the wrap-blob WITHOUT any manual keyring re-import.
  const personaPair = await genEd({ extractable: true });
  const personaId = bytesToHex(await exportEd(personaPair.publicKey));
  const personaSign = (bytes) => edSign(personaPair.privateKey, bytes);

  const { keyring: minted, joinPayload } = await CouncilKeyring.selfMint({
    role: 'member', handle: 'member', authorId: personaId, signFn: personaSign,
  });
  check('self-minted keyring is bound to the persona authorId', minted.authorId === personaId);
  check('join request carries NO private key material (public-only wire payload)',
    !JSON.stringify(joinPayload).includes('"private"'));

  // Admin approval, simulated in-browser: orchestrator wraps the new member and mints an
  // epoch, then signs an announcement with ITS OWN ed key (a synthetic registry is built
  // and root-signed so the real verify path runs end-to-end).
  const rootPair = await genEd({ extractable: true });
  const orchPair = await genEd({ extractable: true });
  const rootId = bytesToHex(await exportEd(rootPair.publicKey));
  const orchId = bytesToHex(await exportEd(orchPair.publicKey));
  const reg = {
    schema: 'openopportunity/known-hosts/v1', root: rootId,
    roles: {
      orchestrator: { authorId: orchId, handle: 'orchestrator' },
      member: { authorId: personaId, handle: 'member' },
    },
    signature: null,
  };
  reg.signature = {
    signer: rootId,
    ts: new Date().toISOString(),
    sig: bytesToHex(await edSign(rootPair.privateKey, new TextEncoder().encode(canonicalBody(reg)))),
  };
  const regVer = await verifyRegistry(reg);
  check(`synthetic registry verifies in-browser (${regVer.reason || 'ok'})`, regVer.ok === true);

  const ownerA = await makeKeyring('orchestrator', orchId);
  ownerA.data.members[personaId] = { role: 'member', authorId: personaId, x25519PublicJwk: joinPayload.x25519PublicJwk };
  const smA = new SessionManager({ keyring: ownerA, topic: TOPIC });
  const mintA = await smA.mintSession();
  const epochA = mintA.epoch;
  const recA = ownerA.data.sessions[epochA];

  const envA = {
    v: 1, kind: 'council-epoch', topic: TOPIC, epoch: epochA,
    mintedAt: recA.mintedAt, salt: recA.salt, prefix: recA.prefix, counter: recA.counter,
    archiveRef: null, unarchived: 0, consumed: false, wrapped: recA.wrapped,
  };
  envA.sigHex = bytesToHex(await edSign(orchPair.privateKey, new TextEncoder().encode(canonicalJson(envA))));
  envA.signer = orchId;

  const vA = await verifyEpochAnnouncement(envA, reg);
  check('epoch announcement verifies in-browser (orchestrator-signed)', vA.ok === true);

  // A forged announcement (signed by the member, not the orchestrator) must fail closed.
  const envBad = { ...envA, signer: personaId, sigHex: bytesToHex(await personaSign(new TextEncoder().encode(canonicalJson({ ...envA, signer: personaId })))) };
  const vBad = await verifyEpochAnnouncement(envBad, reg);
  check('forged epoch announcement fails closed in-browser', vBad.ok === false);

  const installed = await CouncilKeyring.applyEpoch(epochA, {
    mintedAt: recA.mintedAt, salt: recA.salt, prefix: recA.prefix, counter: recA.counter,
    archiveRef: null, unarchived: 0, consumed: false,
    wrapped: { [personaId]: recA.wrapped[personaId] },
  });
  check('auto-installed epoch arrives in the keyring (no manual re-import)',
    !!installed && installed.authorId === personaId && !!installed.getSession(epochA));

  const sealedA = await smA.seal('AUTO-DELIVERED-KEY');
  const openA = await openForReader(sealedA, { keyring: installed, topic: TOPIC });
  check('message sealed after approval opens with the auto-installed key',
    openA.ok === true && openA.plaintext === 'AUTO-DELIVERED-KEY');

  const sealedB = await sealForSend('MEMBER-AFTER-AUTO-INSTALL', { keyring: installed, topic: TOPIC });
  const openB = await openForReader(sealedB, { keyring: installed, topic: TOPIC });
  check('member send after auto-install round-trips',
    openB.ok === true && openB.plaintext === 'MEMBER-AFTER-AUTO-INSTALL');

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
