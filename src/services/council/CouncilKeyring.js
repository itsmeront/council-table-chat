// Browser council keyring: IndexedDB-backed, holding the same data shape the platform's
// Node keyring.mjs uses so the shared session.mjs reader path (openForReader) runs
// unchanged in the browser.
//
// AT-REST MODEL. The platform's Node vault seals the X25519 wrap key with scrypt/SSH at
// rest (0600, only opened on demand). A browser page cannot match that without OS-keyring
// support, so it pins the two properties it CAN hold:
//   • the wrap private key is imported with extractable:false — while loaded it can never
//     be exported via crypto.subtle (the key is usable but unreadable, even to the page);
//   • provisioning is a deliberate act (the platform's `export-keyring` emits the payload).
// IndexedDB itself is not encrypted at rest — the device boundary is the trust perimeter.
import {
  importPrivateJwk,
  generateWrapKeypair,
  exportPublicJwk,
  exportPrivateJwk,
  createKeybinding,
} from './crypto-core.mjs';

const DB = 'council-keyring';
const STORE = 'kv';
const VER = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function kv(mode, key, value) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = mode === 'readonly' ? store.get(key) : store.put(value, key);
      req.onsuccess = () => resolve(mode === 'readonly' ? (req.result ?? null) : true);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/**
 * Pure merge of one epoch announcement into a keyring data object. `consumed` is monotone —
 * an older announcement replaying (backlog) can never resurrect a consumed epoch's key
 * material. Exported so the merge invariant is unit-testable without IndexedDB.
 */
export function mergeEpochRecord(data, epoch, record) {
  data.sessions = data.sessions || {};
  const existing = data.sessions[epoch];
  const merged = existing && existing.consumed && !record.consumed
    ? { ...record, consumed: true }
    : record;
  data.sessions[epoch] = merged;
  return data;
}

/**
 * Provisioned from a `council-keyring` payload (see the platform's export-keyring CLI).
 * Implements the interface openForReader needs: `authorId`, `privateKey`, `getSession`.
 */
export class CouncilKeyring {
  constructor(data, privateKey) {
    this.data = data;
    this.authorId = data.authorId;
    this.role = data.role;
    this.privateKey = privateKey; // X25519 wrap key, extractable:false
  }

  get members() {
    return Object.values(this.data.members || {});
  }

  getSession(epoch) {
    return this.data.sessions?.[epoch] ?? null;
  }

  static async provision(provisionJson) {
    const data = provisionJson && typeof provisionJson === 'object' ? provisionJson : JSON.parse(provisionJson);
    if (data.kind !== 'council-keyring' || !data.authorId || !data.x25519?.private)
      throw new Error('keyring: not a council-keyring provision payload');
    await kv('readwrite', 'data', data);
    // Restore persona key envelope if bundled (full backup import)
    if (data.persona && data.authorId) {
      const persistKey = `axona-author-council-${data.authorId.slice(0, 12)}`;
      localStorage.setItem(persistKey, JSON.stringify(data.persona));
    }
    return CouncilKeyring.load();
  }

  static async load() {
    const data = await kv('readonly', 'data');
    if (!data) return null;
    const privateKey = await importPrivateJwk(data.x25519.private, { extractable: false });
    return new CouncilKeyring(data, privateKey);
  }

  static async reset() {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase(DB);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /** Export the full keyring payload (JSON-serializable object).
   *  If personaEnvelope is provided, it is bundled for cross-browser restore. */
  exportPayload(personaEnvelope) {
    const payload = JSON.parse(JSON.stringify(this.data));
    if (personaEnvelope) payload.persona = personaEnvelope;
    return payload;
  }

  /**
   * Install a verified epoch announcement's record (the wrapped map already trimmed to this
   * keyring's own blob). Rotation/membership updates flow this way — no manual re-import.
   * INVARIANT: an epoch's `consumed` flag is monotone — we never downgrade a consumed epoch
   * back to unconsumed, even if an older announcement for the same epoch replays (backlog).
   */
  static async applyEpoch(epoch, record) {
    if (!epoch || !record || !record.salt || !record.wrapped) return null;
    const data = await kv('readonly', 'data');
    if (!data) return null;
    await kv('readwrite', 'data', mergeEpochRecord(data, epoch, record));
    return CouncilKeyring.load();
  }

  /**
   * Self-mint a keyring from the ACTIVE persona: the browser generates its own X25519 wrap
   * keypair, keeps the private key locally (stored, re-imported extractable:false on load —
   * same at-rest posture as provisioning), and binds its public half to the persona's
   * Ed25519 identity via a signed binding. The private key NEVER leaves the page: what the
   * admin approves is only { authorId, x25519PublicJwk, binding }, and what the orchestrator
   * then delivers is the epoch wrap-blob encrypted TO this key — i.e. only public material
   * ever travels in-band.
   * @returns {{keyring: CouncilKeyring, joinPayload: object}}
   */
  static async selfMint({ role, handle, authorId, signFn }) {
    if (!authorId || !signFn) throw new Error('keyring: selfMint needs the active persona (authorId + signFn)');
    const pair = await generateWrapKeypair({ extractable: true });
    const x25519PublicJwk = await exportPublicJwk(pair.publicKey);
    const x25519Private = await exportPrivateJwk(pair.privateKey);
    const binding = await createKeybinding({ authorId, x25519PublicJwk }, signFn);
    const data = {
      kind: 'council-keyring', version: 1,
      role: role || handle || 'council-member', handle: handle || role,
      authorId, members: {},
      x25519: { public: x25519PublicJwk, private: x25519Private },
      binding, sessions: {},
    };
    await kv('readwrite', 'data', data);
    const keyring = await CouncilKeyring.load();
    return {
      keyring,
      joinPayload: {
        v: 1, kind: 'council-join', topic: 'OO.Private.Council',
        role: data.role, handle: data.handle, authorId,
        x25519PublicJwk, binding,
      },
    };
  }
}
