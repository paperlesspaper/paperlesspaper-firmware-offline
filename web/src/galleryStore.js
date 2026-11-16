// Storage of the gallery in the browser: IndexedDB, or memory if the browser offers none.
//
//   items   one record per picture (original, edit settings, rendered picture files, preview)
//   remote  previews of pictures that are only on a device, by id
//   meta    single values (play settings, ids to delete on the device)

const DB_NAME = "paperlesspaper-gallery";
const DB_VERSION = 1;
const STORES = { items: "key", remote: "id", meta: null };

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      for (const [name, keyPath] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, keyPath ? { keyPath } : undefined);
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error("blocked"));
  });
}

class DatabaseStore {
  constructor(db) {
    this.db = db;
    this.persistent = true;
  }
  _store(name, mode) {
    return this.db.transaction(name, mode).objectStore(name);
  }
  all(name) {
    return request(this._store(name, "readonly").getAll());
  }
  get(name, key) {
    return request(this._store(name, "readonly").get(key));
  }
  /** `key` only for the store without key path (meta). */
  put(name, value, key) {
    return request(key === undefined ? this._store(name, "readwrite").put(value) : this._store(name, "readwrite").put(value, key));
  }
  remove(name, key) {
    return request(this._store(name, "readwrite").delete(key));
  }
}

class MemoryStore {
  constructor() {
    this.persistent = false;
    this.data = Object.fromEntries(Object.keys(STORES).map((name) => [name, new Map()]));
  }
  async all(name) {
    return [...this.data[name].values()];
  }
  async get(name, key) {
    return this.data[name].get(key);
  }
  async put(name, value, key) {
    this.data[name].set(key === undefined ? value[STORES[name]] : key, value);
  }
  async remove(name, key) {
    this.data[name].delete(key);
  }
}

/** Never fails: without a usable IndexedDB the gallery lives in memory (`persistent` is false). */
export async function openGalleryStore() {
  try {
    if (typeof indexedDB === "undefined" || !indexedDB) throw new Error("IndexedDB is not available");
    const store = new DatabaseStore(await openDatabase());
    await store.all("meta"); // a first read shows whether the database really works
    return store;
  } catch (e) {
    console.warn("Gallery storage falls back to memory:", e);
    return new MemoryStore();
  }
}
