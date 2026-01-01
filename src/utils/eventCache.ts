import type { NostrEvent } from "../types/events";

const DB_NAME = "ncc-client-events";
const STORE_NAME = "events";
const DB_VERSION = 1;
const MAX_CACHE_SIZE = 200;
const isBrowser = typeof window !== "undefined" && "indexedDB" in window;

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    if (!isBrowser) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);
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

const waitForTransaction = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const pruneOldEvents = async (db: IDBDatabase, keep = MAX_CACHE_SIZE) => {
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

export const readCachedEvents = async (limit = 100): Promise<NostrEvent[]> => {
  if (!isBrowser) return [];
  try {
    const db = await openDatabase();
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const index = store.index("created_at");
      const events: NostrEvent[] = [];
      const cursorRequest = index.openCursor(null, "prev");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor && events.length < limit) {
          events.push(cursor.value as NostrEvent);
          cursor.continue();
          return;
        }
        resolve(events);
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
  } catch {
    return [];
  }
};

export const cacheEvents = async (entries: NostrEvent[]) => {
  if (!isBrowser || !entries.length) return;
  try {
    const db = await openDatabase();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    entries.forEach((entry) => {
      store.put(entry);
    });
    await waitForTransaction(tx);
    await pruneOldEvents(db);
  } catch {
    // Quietly ignore failures
  }
};
