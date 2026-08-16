// Decrypt-before-render bridge for the confidential council channel (TASK-P-0003).
//
// The relay topic carries ONLY sealed ciphertext — nothing on the wire is readable.
// A council message is a JSON envelope of kind `council-sealed`; the sender's Ed25519
// signature is verified by the kernel (envelope.signerPubkey), and THIS module adds the
// two read-side gates the kernel deliberately does not have:
//   1. authorizeSigner — the signer must be a known (root-signed registry) participant;
//   2. openForReader — decrypt with the reader's own non-extractable wrap key.
// FAIL CLOSED: a council message that fails either gate is HIDDEN, never rendered.
// Non-council topics pass through untouched (this module is not consulted).
import { authorizeSigner } from './registry.js';
import { openForReader } from './session.mjs';
import { CouncilKeyring } from './CouncilKeyring.js';

const COUNCIL_TOPIC = 'OO.Private.Council';
let registryPromise = null;
let keyringProvider = () => CouncilKeyring.load();
let registryProvider = () => {
  registryPromise ??= import('./known-hosts.json').then((m) => m.default);
  return registryPromise;
};

export const isCouncilTopic = (descriptor) => descriptor?.name === COUNCIL_TOPIC;

export async function loadRegistry() {
  return registryProvider();
}

export function __setKeyringProvider(fn) { keyringProvider = fn; }
export function __setRegistryProvider(fn) { registryProvider = fn; }

/**
 * Pure read-side open: authorize the signer, then unseal for the reader. Testable
 * without a browser — the keyring is any object implementing openForReader's interface.
 * @returns {{ok:true, plaintext, role, handle} | {ok:false, reason}}
 */
export async function openSealedEnvelope(envelope, { registry, keyring, topic = COUNCIL_TOPIC, seen = new Map() }) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'malformed envelope' };
  let seal = envelope.message;
  if (typeof seal === 'string') {
    try { seal = JSON.parse(seal); } catch { return { ok: false, reason: 'not a sealed message' }; }
  }
  const auth = await authorizeSigner(envelope.signerPubkey, registry);
  if (!auth.ok) return auth;
  const opened = await openForReader(seal, { keyring, topic, seen });
  if (!opened.ok) return opened;
  return { ok: true, plaintext: opened.plaintext, signer: envelope.signerPubkey, role: auth.role, handle: auth.handle };
}

/**
 * Browser path: lazily load the provisioned keyring (cached) and the root-verified
 * registry, then run the two gates. Used by the AxonaChatClient sub callback BEFORE
 * addEnvelope, so ciphertext never reaches the render path on failure.
 */
export async function tryOpenCached(envelope) {
  let keyring;
  try { keyring = await keyringProvider(); } catch { return { ok: false, reason: 'keyring unavailable' }; }
  if (!keyring) return { ok: false, reason: 'keyring not provisioned' };
  const registry = await loadRegistry();
  return openSealedEnvelope(envelope, { registry, keyring });
}
