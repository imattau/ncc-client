const DB_NAME = "ncc-client-events";
const STORE_NAME = "events";
const DB_VERSION = 1;
const MAX_CACHE_SIZE = 500;

const isIndexedDBAvailable = () => typeof globalThis !== "undefined" && "indexedDB" in globalThis;

export const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!isIndexedDBAvailable()) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const indexedDBFactory = (globalThis as typeof globalThis & { indexedDB?: IDBFactory }).indexedDB;
    if (!indexedDBFactory) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDBFactory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("created_at", "created_at");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export const waitForTransaction = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export const pruneOldEvents = async (db: IDBDatabase, keep = MAX_CACHE_SIZE) => {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      const total = countRequest.result;
      if (total <= keep) {
        resolve();
        return;
      }
      const toRemove = total - keep;
      let removed = 0;
      const cursorRequest = store.index("created_at").openCursor(null, "next");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor && removed < toRemove) {
          cursor.delete();
          removed += 1;
          cursor.continue();
          return;
        }
        resolve();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    };
    countRequest.onerror = () => reject(countRequest.error);
  });
};

export const EVENT_STORE_NAME = STORE_NAME;
export { MAX_CACHE_SIZE };
