// council/crypto/session.mjs — the confidential channel's epoch lifecycle.
//
// WHY THIS EXISTS. The channel is group-encrypted with a per-session symmetric key that is
// ROTATED per session (D8). Rotation is dangerous if done wrong: old ciphertext must stay
// readable until the scribe has archived it, the archive must land BEFORE the new epoch
// activates, and the scribe must be a keyring participant so it can decrypt-and-archive.
// This manager makes those invariants code, not convention:
//   - nonces are a persisted per-epoch counter (uniqueness by construction, case 3),
//   - the reader rejects a replayed (epoch, nonce) with different ciphertext (case 12),
//   - rotation is BLOCKED while the epoch's backlog is unconsumed and refuses to activate
//     a new epoch without an archive reference (case 14 — sequencing enforced),
//   - old session keys stay usable until consumeEpoch() (cases 2/9),
//   - membership changes re-wrap the active session key to the remaining participants and
//     the removed member's wrap blob is dropped (case 15).
//
// The wrap-key holder (orchestrator) runs the SessionManager; member readers (scribe,
// future fork) call openForReader() with their own keyring that holds a synced copy of the
// epoch's session record.
import {
  SCHEMA_WRAP, SCHEMA_SEAL,
  mintSessionKey, importSessionKey, sealWithKey, openWithKey,
  wrapSessionKey, unwrapSessionKey, importPublicJwk,
  hexToBytes, bytesToB64, b64ToBytes,
  verifyMember, deriveNoncePrefix,
} from './crypto-core.mjs';

const encode = (s) => new TextEncoder().encode(s);
const decode = (u) => new TextDecoder().decode(u);

export const wrapInfo = (topic) => encode(`${SCHEMA_WRAP}|${topic}`);
export const aadFor = (topic, epoch, authorId) => encode(`${SCHEMA_SEAL}|${topic}|${epoch}|${authorId}`);
export const legacyAadFor = (topic, epoch) => encode(`${SCHEMA_SEAL}|${topic}|${epoch}`);

export function nonceFrom(prefixHex, counter) {
  const out = new Uint8Array(12);
  out.set(hexToBytes(prefixHex), 0);          // bytes 0-7: per-sender prefix
  let v = BigInt(counter);
  for (let i = 11; i >= 8; i--) { out[i] = Number(v & 0xffn); v >>= 8n; }  // bytes 8-11: counter
  return out;
}

function randomHex(bytes) {
  const u = crypto.getRandomValues(new Uint8Array(bytes));
  return [...u].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class SessionManager {
  /**
   * @param {object} opts
   * @param {Keyring} opts.keyring   the wrap-key holder's keyring (vault owner private key + members + sessions)
   * @param {string}  opts.topic     e.g. 'OO.Private.Council'
   * @param {string}  opts.epoch     explicit epoch override (default 'auto')
   */
  constructor({ keyring, topic }) {
    this.keyring = keyring;
    this.topic = topic;
    this.activeEpoch = null;
    this.activeS = null;        // 32-byte session key, RAM-only
    this.seen = new Map();      // `${epoch}:${nonceB64}` → ctB64 (reuse detection)
  }

  /** Load the latest unconsumed session as active (bootstrap already done). */
  async init() {
    const epochs = Object.keys(this.keyring.data.sessions || {}).sort();
    for (let i = epochs.length - 1; i >= 0; i--) {
      const rec = this.keyring.getSession(epochs[i]);
      if (rec && !rec.consumed) {
        const S = await this._unwrapOwn(epochs[i], rec);
        this.activeEpoch = epochs[i];
        this.activeS = S;
        return { epoch: this.activeEpoch, minted: false };
      }
    }
    return { epoch: null, minted: false };
  }

  async _unwrapOwn(epoch, rec) {
    const wrapped = rec.wrapped?.[this.keyring.authorId];
    if (!wrapped) throw new Error(`session: no wrap blob for own authorId in epoch ${epoch}`);
    const S = await unwrapSessionKey(wrapped, this.keyring.privateKey, { salt: b64ToBytes(rec.salt), info: wrapInfo(this.topic) });
    if (!S) throw new Error(`session: could not unwrap own session key for epoch ${epoch}`);
    return S;
  }

  /** Bootstrap: mint the first epoch. Throws if an unconsumed epoch already exists. */
  async mintSession() {
    const epochs = Object.keys(this.keyring.data.sessions || {});
    for (const e of epochs) {
      if (this.keyring.getSession(e) && !this.keyring.getSession(e).consumed) {
        throw new Error('session: an unconsumed epoch exists — use rotate() to rotate, not mintSession()');
      }
    }
    return this._mintEpoch();
  }

  /** Wrap targets = live members plus the vault owner (the owner is a participant too). */
  _wrapTargets() {
    const targets = [...this.keyring.members];
    if (!targets.some((m) => m.authorId === this.keyring.authorId)) {
      targets.push({ role: this.keyring.role, authorId: this.keyring.authorId, x25519PublicJwk: this.keyring.data.x25519.public });
    }
    return targets;
  }

  async _mintEpoch() {
    const epoch = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomHex(4)}`;
    const rec = {
      mintedAt: new Date().toISOString(),
      salt: bytesToB64(crypto.getRandomValues(new Uint8Array(16))),
      prefix: randomHex(4),
      counter: 0,
      wrapped: {},
      archiveRef: null,
      unarchived: 0,
      consumed: false,
    };
    const S = await mintSessionKey();
    for (const m of this._wrapTargets()) {
      if (m.binding && !(await verifyMember(m))) throw new Error(`session: member ${m.role} has an invalid keybinding`);
      rec.wrapped[m.authorId] = await wrapSessionKey(S, await this._importMemberPub(m), {
        salt: b64ToBytes(rec.salt), info: wrapInfo(this.topic), iv: crypto.getRandomValues(new Uint8Array(12)),
      });
    }
    this.keyring.setSession(epoch, rec);
    this.keyring.save();
    this.activeEpoch = epoch;
    this.activeS = S;
    return { epoch, wrapped: Object.keys(rec.wrapped).length };
  }

  async _importMemberPub(m) {
    return importPublicJwk(m.x25519PublicJwk);
  }

  /** Seal plaintext into a channel envelope. Uniqueness of (epoch, nonce) is by
   *  construction — per-sender prefix derived via HKDF + per-sender counter (§18 fix). */
  async seal(plaintext) {
    if (!this.activeEpoch || !this.activeS) throw new Error('session: no active epoch (mintSession() first)');
    const rec = this.keyring.getSession(this.activeEpoch);
    const senderPrefix = await deriveNoncePrefix(this.activeS, {
      salt: b64ToBytes(rec.salt),
      authorId: this.keyring.authorId,
    });
    rec.counter += 1;
    rec.unarchived += 1;
    const nonce = nonceFrom(senderPrefix, rec.counter);
    const sessionKey = await importSessionKey(this.activeS);
    const ct = await sealWithKey(sessionKey, encode(plaintext), { nonce, aad: aadFor(this.topic, this.activeEpoch, this.keyring.authorId) });
    this.keyring.setSession(this.activeEpoch, rec);
    this.keyring.save();
    return { v: 1, kind: 'council-sealed', topic: this.topic, epoch: this.activeEpoch, nonce: bytesToB64(nonce), sender: this.keyring.authorId, ct };
  }

  /** Reader-side open (wrap-key holder reading its own topic). Delegates to openForReader
   *  so member readers share one code path. */
  async open(env) {
    return openForReader(env, { keyring: this.keyring, topic: this.topic, seen: this.seen });
  }

  /** Acknowledge that the scribe archived the epoch's backlog. */
  ackArchive(epoch, { ref }) {
    const rec = this.keyring.getSession(epoch);
    if (!rec) throw new Error(`session: no such epoch ${epoch}`);
    rec.archiveRef = ref;
    rec.unarchived = 0;
    this.keyring.setSession(epoch, rec);
    this.keyring.save();
  }

  /**
   * Rotate to a new epoch. Enforced sequencing (case 14):
   *   1. BLOCKED while the current epoch's backlog is unconsumed (unarchived > 0), and
   *   2. refuses to activate a new epoch without an archiveRef from the scribe.
   * The old epoch stays readable until consumeEpoch() (cases 2/9).
   */
  async rotate({ archiveRef } = {}) {
    if (!this.activeEpoch) throw new Error('session: no active epoch to rotate');
    const rec = this.keyring.getSession(this.activeEpoch);
    if (rec.unarchived > 0) {
      throw new Error(`session: rotation blocked — ${rec.unarchived} sealed message(s) in epoch ${this.activeEpoch} not yet archived`);
    }
    if (!archiveRef) {
      throw new Error('session: rotation requires an archiveRef (scribe archive must land before the new epoch activates)');
    }
    this.ackArchive(this.activeEpoch, { ref: archiveRef });
    return this._mintEpoch();
  }

  /** Drop old-epoch key material: post-change ciphertext in that epoch fails closed. */
  consumeEpoch(epoch) {
    const rec = this.keyring.getSession(epoch);
    if (!rec) throw new Error(`session: no such epoch ${epoch}`);
    rec.consumed = true;
    this.keyring.setSession(epoch, rec);
    this.keyring.save();
    for (const k of [...this.seen.keys()]) if (k.startsWith(`${epoch}:`)) this.seen.delete(k);
  }

  /** Membership change (case 15): add members (verified bindings) and/or remove members;
   *  the active session key is re-wrapped to the remaining participants and the removed
   *  member's wrap blob is dropped. */
  async rewrapMembers({ added = [], removed = [] }) {
    if (!this.activeEpoch || !this.activeS) throw new Error('session: no active epoch');
    const rec = this.keyring.getSession(this.activeEpoch);
    for (const m of added) {
      await this.keyring.addMember(m);
      const member = this.keyring.data.members[m.authorId];
      rec.wrapped[m.authorId] = await wrapSessionKey(this.activeS, await this._importMemberPub(member), {
        salt: b64ToBytes(rec.salt), info: wrapInfo(this.topic), iv: crypto.getRandomValues(new Uint8Array(12)),
      });
    }
    for (const authorId of removed) {
      this.keyring.revokeMember(authorId);
      delete rec.wrapped[authorId];
    }
    // Re-wrap to the remaining live members (and the owner) with fresh ephemerals.
    const rewrap = {};
    for (const m of this._wrapTargets()) {
      rewrap[m.authorId] = await wrapSessionKey(this.activeS, await this._importMemberPub(m), {
        salt: b64ToBytes(rec.salt), info: wrapInfo(this.topic), iv: crypto.getRandomValues(new Uint8Array(12)),
      });
    }
    rec.wrapped = rewrap;
    this.keyring.setSession(this.activeEpoch, rec);
    this.keyring.save();
    return { added: added.map((m) => m.role), removed, remaining: this.keyring.members.map((m) => m.role) };
  }
}

/**
 * Member-reader open: given a sealed envelope + a reader keyring that holds the reader's
 * private wrap key and a synced copy of the epoch's session record, unseal the payload.
 * Fails closed on: malformed envelope, no session record for the epoch, consumed epoch,
 * reader not a member (no wrap blob), tampered ciphertext, and nonce+epoch reuse.
 */
const _sessionKeyCache = new Map(); // epoch → { sessionKey, importPromise }

export async function openForReader(env, { keyring, topic, seen = new Map() }) {
  if (!env || typeof env !== 'object' || env.kind !== 'council-sealed' || !env.epoch || !env.nonce || !env.ct) {
    return { ok: false, reason: 'malformed envelope' };
  }
  const rec = keyring.getSession(env.epoch);
  if (!rec) return { ok: false, reason: `no session record for epoch ${env.epoch}` };
  if (rec.consumed) return { ok: false, reason: `epoch ${env.epoch} consumed` };

  const key = `${env.epoch}:${env.nonce}`;
  if (seen.has(key) && seen.get(key) !== env.ct) return { ok: false, reason: 'nonce+epoch reuse' };

  const wrapped = rec.wrapped?.[keyring.authorId];
  if (!wrapped) return { ok: false, reason: 'reader is not a member of this epoch' };

  // Cache the unwrapped session key per epoch — avoids re-deriving ECDH+HKDF for every message
  let cached = _sessionKeyCache.get(env.epoch);
  if (!cached) {
    const S = await unwrapSessionKey(wrapped, keyring.privateKey, { salt: b64ToBytes(rec.salt), info: wrapInfo(topic) });
    if (!S) return { ok: false, reason: 'decrypt failed' };
    const sessionKey = await importSessionKey(S);
    cached = { sessionKey };
    _sessionKeyCache.set(env.epoch, cached);
  }

  const pt = await openWithKey(cached.sessionKey, env.ct, { nonce: b64ToBytes(env.nonce),
    aad: ('sender' in env && env.sender) ? aadFor(topic, env.epoch, env.sender) : legacyAadFor(topic, env.epoch) });
  if (pt === null) return { ok: false, reason: 'decrypt failed' };

  seen.set(key, env.ct);
  return { ok: true, plaintext: decode(pt) };
}
