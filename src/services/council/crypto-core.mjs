// council/crypto/crypto-core.mjs — Web Crypto primitives for the confidential council channel.
//
// WHY THIS EXISTS. OO.Private.Council (TASK-P-0003 / D8) is an app-layer group-encrypted
// channel: the relay and protocol are UNTOUCHED; confidentiality is added on top, per the
// D8 record. Every primitive here is portable Web Crypto (no Node built-ins beyond what a
// browser has), so the SAME file is importable by the axona-chat fork (which runs the same
// code path in Chromium, where the security review runs) and by the Node-side kit tooling.
//
// Mechanism (D8 rev 3, verbatim in spirit):
//   - wrap/unwrap:  X25519 ECDH → shared secret → HKDF-SHA256 → AES-GCM wrap key. The raw
//                   ECDH output is NEVER used as key material — it only ever feeds HKDF.
//   - seal/open:    AES-GCM under the per-session key; per-message nonce + epoch are bound
//                   via AAD (topic|epoch), so a ciphertext moved across topics or epochs
//                   fails closed; tampered/reordered ciphertext fails the auth tag.
//   - signer:       the Ed25519 authorId (verified by the kernel at receive) is preserved on
//                   the envelope; the keyring adds a SIGNED KEYBINDING from that Ed25519
//                   signer to the participant's X25519 wrap key (key↔identity binding, so a
//                   registry swap is a silent MITM otherwise).
//   - non-extractable: session keys and decrypt keys are imported extractable:false; key
//                   material is never exported (case 5 enforcement is the reader boundary).
//
// Test hook: __forceDhBackend('x25519'|'p256') forces a DH backend regardless of runtime
// support — used to unit-test the absent-X25519 (ECDH P-256) fallback on a runtime that has
// X25519 (case 10), and vice-versa.
import { sign, verify } from './ed25519.js';

export const SCHEMA_WRAP    = 'openopportunity/group-wrap/v1';
export const SCHEMA_SEAL    = 'openopportunity/seal/v1';
export const SCHEMA_BINDING = 'openopportunity/keybinding/v1';

// ── bytes helpers (portable: no Buffer) ─────────────────────────────────
export const bytesToHex = (u) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
export const hexToBytes = (h) => Uint8Array.from(h.match(/../g).map((x) => parseInt(x, 16)));
function b64FromBytes(u) { let s = ''; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); }
function bytesFromB64(s) { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
export const bytesToB64 = (u) => b64FromBytes(u instanceof Uint8Array ? u : new Uint8Array(u));
export const b64ToBytes = (s) => bytesFromB64(s);
const encode = (s) => new TextEncoder().encode(s);

// Canonical, key-sorted serialization — the exact bytes the binding signature covers.
export function canonicalJson(o) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortDeep(o));
}

// ── DH backend (X25519 preferred; ECDH P-256 fallback, never plaintext) ──
let _forced = null;      // 'x25519' | 'p256' | null — test hook
let _probed = null;      // cached probe result
export function __forceDhBackend(name) { _forced = name || null; _probed = null; }

export async function probeX25519() {
  if (_probed !== null) return _probed;
  try { await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']); _probed = true; }
  catch { _probed = false; }
  return _probed;
}

/** 'x25519' when the runtime has it, else the 'p256' fallback. */
export async function dhBackend() {
  return _forced || ((await probeX25519()) ? 'x25519' : 'p256');
}

function dhAlg(backend) {
  return backend === 'x25519' ? { name: 'X25519' } : { name: 'ECDH', namedCurve: 'P-256' };
}

// ── wrap-key lifecycle (each participant's X25519/P-256 encryption keypair) ──
export async function generateWrapKeypair({ extractable = false } = {}) {
  return crypto.subtle.generateKey(dhAlg(await dhBackend()), extractable, ['deriveBits']);
}
/** Public JWK — the only representation that travels (in the keyring / bindings). */
export async function exportPublicJwk(publicKey) { return crypto.subtle.exportKey('jwk', publicKey); }
/** Private JWK — ONLY for sealed-at-rest custody; runtime keys stay non-extractable. */
export async function exportPrivateJwk(privateKey) { return crypto.subtle.exportKey('jwk', privateKey); }
export async function importPublicJwk(jwk) {
  return crypto.subtle.importKey('jwk', jwk, dhAlg(await dhBackend()), false, []);
}
export async function importPrivateJwk(jwk, { extractable = false } = {}) {
  return crypto.subtle.importKey('jwk', jwk, dhAlg(await dhBackend()), extractable, ['deriveBits']);
}

async function deriveShared(privateKey, peerPublicKey) {
  const backend = await dhBackend();
  const alg = backend === 'x25519'
    ? { name: 'X25519', public: peerPublicKey }
    : { name: 'ECDH', public: peerPublicKey };
  return new Uint8Array(await crypto.subtle.deriveBits(alg, privateKey, 256));
}

/** The RAW ECDH shared secret. This is the "never use directly" primitive: it MUST feed
 *  deriveWrapKey (HKDF), never an AES key — that binding is what case 7 asserts. Exported
 *  for the negative test and for audits. */
export async function deriveSharedSecret(privateKey, peerPublicKey) {
  return deriveShared(privateKey, peerPublicKey);
}

// ── HKDF on ECDH — the shared secret feeds HKDF, never a raw AES key ────
export async function deriveWrapKey(sharedBytes, { salt, info }) {
  const base = await crypto.subtle.importKey('raw', sharedBytes, { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive a per-sender nonce prefix from the session key + authorId.
 * Returns 8 bytes (hex string) — enough namespace to avoid collisions.
 * This replaces the shared per-epoch prefix that caused nonce reuse (§18).
 */
export async function deriveNoncePrefix(sessionKeyBytes, { salt, authorId }) {
  const info = encode(`nonce-prefix|${authorId}`);
  const base = await crypto.subtle.importKey('raw', sessionKeyBytes, { name: 'HKDF' }, false, ['deriveBits']);
  const derived = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    base,
    64, // 8 bytes = 64 bits
  ));
  return bytesToHex(derived);
}

/** TEST ONLY: import the raw ECDH output directly as an AES key — proves the real
 *  path (HKDF) is not using the raw shared secret (case 7). */
export async function deriveRawSharedKey(sharedBytes) {
  return crypto.subtle.importKey('raw', sharedBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── wrap / unwrap a session key to one recipient ───────────────────────
/**
 * Encrypt the 32-byte session key to `peerPublicKey` (a wrap key CryptoKey).
 * A fresh ephemeral keypair makes every wrap independent (no key reuse across
 * recipients or rewraps). Returns the envelope to store in the keyring.
 */
export async function wrapSessionKey(sessionKeyBytes, peerPublicKey, { salt, info, iv }) {
  const ephem = await generateWrapKeypair({ extractable: false });
  const ephemPubJwk = await exportPublicJwk(ephem.publicKey);
  const shared = await deriveShared(ephem.privateKey, peerPublicKey);
  const kek = await deriveWrapKey(shared, { salt, info });
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, sessionKeyBytes);
  return { ephem: ephemPubJwk, iv: bytesToB64(iv), ct: bytesToB64(ct) };
}

/** Recover the 32-byte session key from a wrap envelope, or null (wrong
 *  recipient / tampered wrap / DH backend mismatch — all fail closed). */
export async function unwrapSessionKey(wrapped, privateKey, { salt, info }) {
  try {
    const ephemPub = await importPublicJwk(wrapped.ephem);
    const shared = await deriveShared(privateKey, ephemPub);
    const kek = await deriveWrapKey(shared, { salt, info });
    const S = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(wrapped.iv) }, kek, b64ToBytes(wrapped.ct));
    return new Uint8Array(S);
  } catch {
    return null;
  }
}

// ── AES-GCM seal / open (per-message nonce + AAD-bound topic|epoch) ─────
export async function sealWithKey(sessionKey, plaintext, { nonce, aad }) {
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, sessionKey, plaintext);
  return bytesToB64(ct);
}

/** Returns plaintext bytes or null (auth failure ≡ wrong recipient ≡ tamper). */
export async function openWithKey(sessionKey, ctB64, { nonce, aad }) {
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, sessionKey, b64ToBytes(ctB64));
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/** The 32-byte per-session symmetric key. RAM-only: held by the wrap-key holder
 *  (orchestrator) and transported ONLY as AES-GCM-wrapped ciphertext. */
export async function mintSessionKey() { return crypto.getRandomValues(new Uint8Array(32)); }

/** Import session-key bytes into a non-extractable AES-GCM decrypt/encrypt key. */
export async function importSessionKey(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ── signed keybinding: Ed25519 authorId ↔ X25519 wrap key ───────────────
/**
 * Sign the binding {schema, authorId, x25519PublicJwk} with the participant's Ed25519
 * signer. `signFn` is the identity's signer (e.g. id.sign from createAuthorIdentity, or
 * the vendored ed25519 sign). Verifying the binding at read binds the wrap key to the
 * authorId — a swapped keyring entry breaks verification (case 8).
 */
export async function createKeybinding({ authorId, x25519PublicJwk }, signFn) {
  const body = { schema: SCHEMA_BINDING, authorId, x25519PublicJwk };
  const canonical = canonicalJson(body);
  const sig = await signFn(new TextEncoder().encode(canonical));
  return { body, sigHex: bytesToHex(sig) };
}

export async function verifyKeybinding(binding, authorIdHex) {
  if (!binding || typeof binding !== 'object' || !binding.body || !binding.sigHex) return false;
  if (binding.body.schema !== SCHEMA_BINDING) return false;
  if (binding.body.authorId !== authorIdHex) return false;
  try {
    return await verify(hexToBytes(authorIdHex), new TextEncoder().encode(canonicalJson(binding.body)), hexToBytes(binding.sigHex));
  } catch {
    return false;
  }
}

/** Full member check: the binding must (a) validate against the member's Ed25519 authorId
 *  AND (b) cover the member's CURRENT x25519PublicJwk. A registry swap changes the record
 *  but not the signed binding — (b) breaks. */
export async function verifyMember(member) {
  if (!member || typeof member !== 'object') return false;
  if (!(await verifyKeybinding(member.binding, member.authorId))) return false;
  return canonicalJson(member.binding.body.x25519PublicJwk) === canonicalJson(member.x25519PublicJwk);
}

// Convenience re-export so callers can sign bindings with the vendored Ed25519.
export { sign, verify };

