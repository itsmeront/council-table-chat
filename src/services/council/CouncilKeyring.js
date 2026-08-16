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
import { importPrivateJwk } from './crypto-core.mjs';

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
}
