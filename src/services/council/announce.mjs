// Browser-side port of council/crypto/announce.mjs — verified epoch-announcement control
// messages, so key rotation and membership changes arrive WITHOUT a manual keyring
// re-import. The orchestrator broadcasts, on the council topic itself, the session record
// plus every member's wrap-blob (each encrypted TO that member's X25519 public key — so
// the announcement is public material and confidentiality is preserved by construction).
//
// AUTHENTICITY: the announcement carries an orchestrator Ed25519 signature over the
// canonical (key-sorted) record body; we check the signer against the root-signed registry
// ('orchestrator' role) AND verify the inner signature. Anything that fails is dropped
// (never rendered, never installed), and an epoch announcement that an attacker mints with
// their own session key fails closed because it cannot be signed by the orchestrator.
//
// The browser only ever receives announcements (it never mints epochs), so this mirror has
// the verify side plus the trim helper; the sender-side builder lives in the node tree.
import { canonicalJson, verify, hexToBytes } from './crypto-core.mjs';
import { authorizeSigner } from './registry.js';

export const EPOCH_KIND = 'council-epoch';
export const JOIN_KIND = 'council-join';
export const REGISTRY_KIND = 'council-registry';

function recordBody(env) {
  return {
    v: 1, kind: EPOCH_KIND, topic: env.topic, epoch: env.epoch,
    mintedAt: env.mintedAt, salt: env.salt, prefix: env.prefix, counter: env.counter,
    archiveRef: env.archiveRef ?? null, unarchived: env.unarchived ?? 0,
    consumed: !!env.consumed, wrapped: env.wrapped || {},
  };
}

/**
 * @returns {{ok:true, epoch, record} | {ok:false, reason}}
 */
export async function verifyEpochAnnouncement(env, registry) {
  if (!env || typeof env !== 'object' || env.kind !== EPOCH_KIND)
    return { ok: false, reason: 'not an epoch announcement' };
  if (!env.signer || !env.sigHex || !env.epoch || !env.salt || !env.wrapped)
    return { ok: false, reason: 'malformed announcement' };
  const auth = await authorizeSigner(env.signer, registry);
  if (!auth.ok) return auth;
  if (auth.role !== 'orchestrator') return { ok: false, reason: 'announcement not signed by the orchestrator' };
  const good = await verify(
    hexToBytes(env.signer),
    new TextEncoder().encode(canonicalJson(recordBody(env))),
    hexToBytes(env.sigHex),
  );
  if (!good) return { ok: false, reason: 'announcement signature invalid' };
  return {
    ok: true,
    epoch: env.epoch,
    record: {
      mintedAt: env.mintedAt, salt: env.salt, prefix: env.prefix, counter: env.counter,
      archiveRef: env.archiveRef ?? null, unarchived: env.unarchived ?? 0,
      consumed: !!env.consumed, wrapped: env.wrapped,
    },
  };
}

/**
 * Trim a verified announcement's wrapped map down to the ONE blob this author can unwrap.
 * The browser only stores its own blob — there is nothing to gain (or to leak) in keeping
 * the other members' ciphertexts, and the trimmed record is what gets persisted.
 */
export function epochRecordFromAnnouncement(env, ownAuthorId) {
  const wrapped = env.wrapped && env.wrapped[ownAuthorId]
    ? { [ownAuthorId]: env.wrapped[ownAuthorId] }
    : {};
  // Full list of member authorIds from the announcement — used to populate keyring.members.
  const memberAuthorIds = env.wrapped ? Object.keys(env.wrapped) : [];
  return {
    mintedAt: env.mintedAt, salt: env.salt, prefix: env.prefix, counter: env.counter,
    archiveRef: env.archiveRef ?? null, unarchived: env.unarchived ?? 0,
    consumed: !!env.consumed, wrapped, memberAuthorIds,
  };
}
