// Minimal promise wrapper over IndexedDB.

const DB_NAME = 'wkdash';
const VERSION = 1;

export const STORES = {
  subjects: { keyPath: 'id' },
  assignments: { keyPath: 'subject_id' },
  review_statistics: { keyPath: 'subject_id' },
  level_progressions: { keyPath: 'id' },
  srs_events: { autoIncrement: true, indexes: [['at', 'at']] },
  review_events: { autoIncrement: true, indexes: [['at', 'at']] },
  syncs: { autoIncrement: true },
  meta: { keyPath: 'key' },
};

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

export async function openDb(name = DB_NAME) {
  const r = indexedDB.open(name, VERSION);
  r.onupgradeneeded = () => {
    const db = r.result;
    for (const [store, def] of Object.entries(STORES)) {
      if (db.objectStoreNames.contains(store)) continue;
      const os = db.createObjectStore(store, { keyPath: def.keyPath, autoIncrement: def.autoIncrement });
      for (const [idx, key] of def.indexes ?? []) os.createIndex(idx, key);
    }
  };
  const db = await req(r);
  return new Db(db);
}

export async function deleteDb(name = DB_NAME) {
  await req(indexedDB.deleteDatabase(name));
}

export class Db {
  constructor(idb) { this.idb = idb; }

  tx(stores, mode = 'readonly') {
    const t = this.idb.transaction(stores, mode);
    const done = new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
    return { t, done };
  }

  async getAll(store) {
    const { t } = this.tx(store);
    return req(t.objectStore(store).getAll());
  }

  async get(store, key) {
    const { t } = this.tx(store);
    return req(t.objectStore(store).get(key));
  }

  async getMany(store, keys) {
    const { t } = this.tx(store);
    const os = t.objectStore(store);
    return Promise.all(keys.map((k) => req(os.get(k))));
  }

  async putAll(store, rows) {
    if (!rows.length) return;
    const { t, done } = this.tx(store, 'readwrite');
    const os = t.objectStore(store);
    for (const r of rows) os.put(r);
    await done;
  }

  /** Upsert rows with explicit keys into an autoIncrement store (server-assigned ids). */
  async putAllKeyed(store, rows, keyOf) {
    if (!rows.length) return;
    const { t, done } = this.tx(store, 'readwrite');
    const os = t.objectStore(store);
    for (const r of rows) os.put(r, keyOf(r));
    await done;
  }

  async addAll(store, rows) {
    if (!rows.length) return;
    const { t, done } = this.tx(store, 'readwrite');
    const os = t.objectStore(store);
    for (const r of rows) os.add(r);
    await done;
  }

  async clear(store) {
    const { t, done } = this.tx(store, 'readwrite');
    t.objectStore(store).clear();
    await done;
  }

  async count(store) {
    const { t } = this.tx(store);
    return req(t.objectStore(store).count());
  }

  async getMeta(key) { return (await this.get('meta', key))?.value; }
  async setMeta(key, value) { await this.putAll('meta', [{ key, value }]); }

  close() { this.idb.close(); }
}
