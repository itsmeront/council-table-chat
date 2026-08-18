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
import { authorizeSigner, storeRegistry, loadBestAvailableRegistry, verifyRegistry } from './registry.js';
import { openForReader } from './session.mjs';
import { CouncilKeyring } from './CouncilKeyring.js';
import { EPOCH_KIND, JOIN_KIND, REGISTRY_KIND, verifyEpochAnnouncement, epochRecordFromAnnouncement } from './announce.mjs';

// Council topics follow the naming convention OO.Private.* — any topic with this
// pattern is end-to-end encrypted and requires a council keyring to read/write.
const COUNCIL_TOPIC = 'OO.Private.Council';
let registryPromise = null;
let keyringProvider = () => CouncilKeyring.load();
let registryProvider = () => {
  registryPromise ??= import('./known-hosts.json').then((m) => m.default);
  return registryPromise;
};

export const isCouncilTopic = (descriptor) => {
  const name = descriptor?.name;
  if (!name) return false;
  if (name === COUNCIL_TOPIC) return true;
  // Generic pattern: OO.Private.* topics are encrypted council channels
  return name.startsWith('OO.Private.');
};

/** Check if the topic is encrypted AND the browser has a keyring provisioned. */
export async function hasCouncilKeyring() {
  try {
    const kr = await CouncilKeyring.load();
    return !!kr;
  } catch { return false; }
}

/**
 * Load the best available registry: a topic-delivered (stored) revision takes precedence
 * over the statically bundled bootstrap.  Both are verified independently by callers.
 */
export async function loadRegistry() {
  const bundled = await registryProvider();
  return loadBestAvailableRegistry(bundled);
}

export function __setKeyringProvider(fn) { keyringProvider = fn; invalidateKeyringCache(); }
export function __setRegistryProvider(fn) { registryProvider = fn; invalidateRegistryCache(); }

// Injectable in tests so the install path is observable without IndexedDB.
let epochApplier = (epoch, record) => CouncilKeyring.applyEpoch(epoch, record);
export function __setEpochApplier(fn) { epochApplier = fn; }

// Buffer for epoch announcements that arrive before the keyring is provisioned.
// During backlog replay, the browser subscribes with since:'all' BEFORE the user
// provisions the keyring (selfMint). These announcements are verified but can't be
// installed yet — buffer them and flush when the keyring becomes available.
const _pendingEpochs = [];
export function flushEpochBuffer() {
  if (!_pendingEpochs.length) return Promise.resolve();
  const epochs = _pendingEpochs.splice(0);
  return epochs.reduce((p, { epoch, rec }) => p.then(() => epochApplier(epoch, rec)), Promise.resolve());
}
export function __getPendingEpochs() { return _pendingEpochs; }

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
let _cachedKeyring = null;
let _cachedKeyringPromise = null;
let _cachedRegistry = null;
let _cachedRegistryPromise = null;

async function getCachedKeyring() {
  if (_cachedKeyring) return _cachedKeyring;
  if (_cachedKeyringPromise) return _cachedKeyringPromise;
  _cachedKeyringPromise = (async () => {
    try {
      _cachedKeyring = await keyringProvider();
      // Flush any epoch announcements that were buffered before the keyring was provisioned.
      if (_cachedKeyring && _pendingEpochs.length) {
        await flushEpochBuffer();
        invalidateKeyringCache();
        _cachedKeyring = await keyringProvider();
      }
    } catch { _cachedKeyring = null; }
    _cachedKeyringPromise = null;
    return _cachedKeyring;
  })();
  return _cachedKeyringPromise;
}

export async function getCachedRegistry() {
  if (_cachedRegistry) return _cachedRegistry;
  if (_cachedRegistryPromise) return _cachedRegistryPromise;
  _cachedRegistryPromise = (async () => {
    try {
      _cachedRegistry = await loadRegistry();
    } catch { _cachedRegistry = null; }
    _cachedRegistryPromise = null;
    return _cachedRegistry;
  })();
  return _cachedRegistryPromise;
}

export function invalidateKeyringCache() { _cachedKeyring = null; }
export function invalidateRegistryCache() { _cachedRegistry = null; }

export async function tryOpenCached(envelope) {
  const keyring = await getCachedKeyring();
  if (!keyring) return { ok: false, reason: keyring === null ? 'keyring unavailable' : 'keyring not provisioned' };
  const registry = await getCachedRegistry();
  return openSealedEnvelope(envelope, { registry, keyring });
}

/**
 * Control-message intercept for the council topic — these are NEVER rendered as chat:
 *   • council-epoch — a verified orchestrator epoch announcement. Auto-installs the
 *     trimmed record into the keyring (rotation/membership changes arrive with NO manual
 *     re-import). If the keyring isn't provisioned yet the announcement is dropped; backlog
 *     replay (since:'all') re-delivers it on the next load, so a browser that joins late
 *     still catches up.
 *   • council-join — a join request (public material only): acknowledged, hidden.
 * FAIL CLOSED: any malformed, unsigned, or mis-signed control message is dropped. The
 * kernel-verified envelope signer must also match the inner `signer` field, binding the
 * kernel Ed25519 signature to the inner signature over the record body.
 * @returns {true} when the envelope WAS a control message (caller must not render it)
 */
export async function handleCouncilControl(envelope) {
  let msg = envelope?.message;
  if (typeof msg === 'string') { try { msg = JSON.parse(msg); } catch { return false; } }
  if (!msg || typeof msg !== 'object') return false;
  const kind = msg.kind;
  if (kind === EPOCH_KIND) {
    try {
      if (envelope.signerPubkey && envelope.signerPubkey !== msg.signer) return true;
      const registry = await loadRegistry();
      const v = await verifyEpochAnnouncement(msg, registry);
      if (!v.ok) return true;
      let keyring;
      try { keyring = await keyringProvider(); } catch { keyring = null; }
      if (!keyring) {
        // Keyring not provisioned yet (backlog replay before selfMint). Buffer the
        // verified announcement so it can be installed when the keyring becomes available.
        _pendingEpochs.push({ epoch: msg.epoch, msg });
        return true;
      }
      const rec = epochRecordFromAnnouncement(msg, keyring.authorId);
      await epochApplier(msg.epoch, rec);
      invalidateKeyringCache();
    } catch { /* drop on any failure */ }
    return true;
  }
  if (kind === JOIN_KIND) return true;
  if (kind === REGISTRY_KIND) {
    // Root-signed registry revision arriving on the council topic.  Verify the embedded
    // root signature, adopt if newer than the current revision (by signature.ts), and
    // store so every subsequent loadRegistry() call picks it up.  Non-members can still
    // publish to the topic, but a bad signature is silently dropped — the existing
    // bundled bootstrap remains the fallback until a verified revision arrives.
    try {
      const v = await verifyRegistry({
        schema: msg.schema, root: msg.root, roles: msg.roles, signature: msg.signature,
      });
      if (!v.ok) return true;
      // Only accept revisions signed by the bootstrap root (trust anchor, never changes).
      const bundled = await registryProvider();
      if (v.signer !== bundled.root) return true;
      storeRegistry({ schema: msg.schema, root: msg.root, roles: msg.roles, signature: msg.signature });
      registryPromise = null; // clear cached promise so loadRegistry() picks up the new one
      invalidateRegistryCache();
    } catch { /* drop on any failure */ }
    return true;
  }
  return false;
}
