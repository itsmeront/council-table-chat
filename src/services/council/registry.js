// Browser-side port of the platform's council/scripts/known-hosts.mjs (verifyRegistry)
// and council/crypto/read.mjs (authorizeSigner).
//
// The registry (council/known-hosts.json) is PUBLIC, root-signed data: it holds only
// public keys, and every revision is signed by Ron's durable operator key. Verifying
// that signature is what turns a self-authenticating Ed25519 authorId into a "known"
// council role — the same trust anchor as the platform, no Node built-ins required.
import { verify } from './ed25519.js';

const SCHEMA = 'openopportunity/known-hosts/v1';
const HEX64 = /^[0-9a-f]{64}$/i;
const HEX128 = /^[0-9a-f]{128}$/i;

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k]);
    return o;
  }
  return v;
}

// Canonical, key-sorted serialization — the exact bytes the root signature covers.
// Exported so test fixtures sign the IDENTICAL bytes this module verifies.
export function canonicalBody(reg) {
  return JSON.stringify(sortDeep({ schema: SCHEMA, root: reg.root, roles: reg.roles }));
}

/**
 * @returns {{ok:true, signer} | {ok:false, reason}}
 */
export async function verifyRegistry(reg) {
  if (!reg || reg.schema !== SCHEMA) return { ok: false, reason: `schema mismatch (${reg?.schema})` };
  if (!reg.signature || !reg.signature.signer || !reg.signature.sig)
    return { ok: false, reason: 'unsigned — no signature' };
  if (!HEX64.test(reg.signature.signer)) return { ok: false, reason: 'malformed signer' };
  if (!HEX128.test(reg.signature.sig)) return { ok: false, reason: 'malformed signature' };
  const body = new TextEncoder().encode(canonicalBody(reg));
  const good = await verify(hexToBytes(reg.signature.signer), body, hexToBytes(reg.signature.sig));
  return good ? { ok: true, signer: reg.signature.signer } : { ok: false, reason: 'bad signature' };
}

// ── dynamic registry (from topic) ──────────────────────────────────────────
// The council-registry control message carries a root-signed known-hosts on the topic
// itself, so web clients auto-adopt the newest revision without a redeploy.  The static
// bundle (imported by councilChannel.js) is the first-load bootstrap; a topic-delivered
// revision stored here takes precedence.  localStorage is fine — the registry is PUBLIC.
const REGISTRY_STORAGE_KEY = 'council-known-hosts-v1';

/**
 * Store a verified registry revision from the topic.  Only replaces if newer (ts).
 */
export function storeRegistry(reg) {
  try {
    const existing = loadStoredRegistry();
    if (existing && existing.signature?.ts && reg.signature?.ts
        && existing.signature.ts >= reg.signature.ts) return; // not newer
    localStorage.setItem(REGISTRY_STORAGE_KEY, JSON.stringify(reg));
  } catch { /* quota or parse */ }
}

/**
 * Load the stored (topic-delivered) registry, or null if none yet.
 */
export function loadStoredRegistry() {
  try { const s = localStorage.getItem(REGISTRY_STORAGE_KEY); return s ? JSON.parse(s) : null; }
  catch { return null; }
}

/**
 * Load the best available registry: topic-delivered (stored) preferred over the static
 * bundle.  Both are verified independently by the caller before use.
 * @param {object} bundled - The statically imported known-hosts.json (fallback).
 */
export function loadBestAvailableRegistry(bundled) {
  const stored = loadStoredRegistry();
  return stored || bundled;
}

// ── existing API ──────────────────────────────────────────────────────────

/**
 * @returns {{ok:true, role, handle} | {ok:false, reason}}
 */
export async function authorizeSigner(signerHex, registry) {
  if (!signerHex || !HEX64.test(signerHex)) return { ok: false, reason: 'no verified signer (handle-only envelope)' };
  const v = await verifyRegistry(registry);
  if (!v.ok) return { ok: false, reason: `registry signature not verified: ${v.reason}` };
  for (const [role, r] of Object.entries(registry.roles || {})) {
    if (r.authorId === signerHex) {
      if (r.revoked) return { ok: false, reason: `signer revoked (${role})` };
      return { ok: true, role, handle: r.handle || role };
    }
  }
  return { ok: false, reason: 'signer not in known-hosts' };
}
