// Browser council channel — MEMBER WRITE path (TASK-P-0003).
//
// The Node CLI (private-council.mjs) is the single counter-based writer: the orchestrator
// seals under the shared epoch session key with a persisted per-epoch nonce counter. A
// browser member CANNOT reuse that counter — its copy of the session record is a stale
// snapshot, and two writers advancing one counter is how nonce reuse (== key compromise)
// happens. So the member writer uses a DIFFERENT, equally sound nonce discipline:
//
//   • the session key still comes from the keyring's own wrap blob (same unwrap path as
//     openForReader), so only an actual member of the epoch can seal;
//   • the nonce is 96 random bits per message (crypto.getRandomValues) instead of
//     prefix+counter — the RFC 5116 AES-GCM IV size, collision probability ~2^-96, and the
//     reader's (epoch,nonce) seen-map replay detection still applies unchanged;
//   • the AAD still binds topic|epoch, so a member-writer envelope moved across topics or
//     epochs fails closed exactly like an orchestrator one.
//
// Invariants preserved: non-extractable decrypt keys, signer authorization (the registry
// check in assertCanSendCouncil), fail-closed decrypt. The one thing the browser does NOT
// track is the orchestrator's `unarchived` backlog counter — member writes are not counted
// there, so rotation bookkeeping is unaffected (the scribe archives by reading the topic,
// which is how member-sent messages are covered).
import {
  unwrapSessionKey, importSessionKey, sealWithKey,
  b64ToBytes, bytesToB64,
} from './crypto-core.mjs';
import { wrapInfo, aadFor } from './session.mjs';

export const COUNCIL_TOPIC = 'OO.Private.Council';

function randomNonce() {
  return crypto.getRandomValues(new Uint8Array(12));
}

/**
 * Latest unconsumed session the reader can actually unwrap (has a wrap blob for the
 * keyring's own authorId). Mirrors SessionManager.init's selection, minus the mint branch.
 * @returns {{epoch: string, rec: object} | null}
 */
export async function activeEpochSession(keyring) {
  const epochs = Object.keys(keyring.data?.sessions || {}).sort();
  for (let i = epochs.length - 1; i >= 0; i--) {
    const rec = keyring.getSession(epochs[i]);
    if (rec && !rec.consumed && rec.wrapped?.[keyring.authorId]) {
      return { epoch: epochs[i], rec };
    }
  }
  return null;
}

/**
 * Seal plaintext into a council-channel envelope as a member writer. Throws on anything
 * that would produce an undecryptable or unauthorized message (no active session, not a
 * member of the epoch, unwrap failure).
 *
 * @param {string} plaintext
 * @param {{keyring: object, topic?: string}} opts  keyring implements openForReader's
 *        interface (authorId, privateKey, getSession) — see CouncilKeyring.
 * @returns {{v:1, kind:'council-sealed', topic, epoch, nonce, ct}}
 */
export async function sealForSend(plaintext, { keyring, topic = COUNCIL_TOPIC }) {
  const act = await activeEpochSession(keyring, topic);
  if (!act) {
    throw new Error('council: no active session — re-export a fresh keyring (the epoch may have rotated)');
  }
  const S = await unwrapSessionKey(act.rec.wrapped[keyring.authorId], keyring.privateKey, {
    salt: b64ToBytes(act.rec.salt), info: wrapInfo(topic),
  });
  if (!S) {
    throw new Error('council: could not unwrap the session key — wrong keyring for this role');
  }
  const sessionKey = await importSessionKey(S);
  const nonce = randomNonce();
  const ct = await sealWithKey(sessionKey, new TextEncoder().encode(plaintext), {
    nonce, aad: aadFor(topic, act.epoch),
  });
  return { v: 1, kind: 'council-sealed', topic, epoch: act.epoch, nonce: bytesToB64(nonce), ct };
}

/**
 * Fail-closed gate for the browser send path: the signing persona must be a registry-known
 * council participant, the keyring must be provisioned, and the keyring must BELONG to the
 * signing persona (keyring.authorId === signer) — otherwise a stray keyring would let a
 * non-member signer seal (which the registry read side would then hide anyway). Pure, so it
 * is testable without a peer.
 *
 * @returns {{ok:true, role, handle, keyring} | {ok:false, reason}}
 */
export async function assertCanSendCouncil(signerHex, registry, keyringLoader) {
  const { authorizeSigner } = await import('./registry.js');
  const auth = await authorizeSigner(signerHex, registry);
  if (!auth.ok) return { ok: false, reason: auth.reason };
  const keyring = await keyringLoader();
  if (!keyring) return { ok: false, reason: 'no keyring provisioned — import one first' };
  if (keyring.authorId !== signerHex) {
    return { ok: false, reason: 'keyring belongs to a different persona than the one posting — refusing to leak under the wrong signer' };
  }
  return { ok: true, role: auth.role, handle: auth.handle, keyring };
}
