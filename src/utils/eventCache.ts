import type { NostrEvent } from "../types/events";
import { openDatabase, EVENT_STORE_NAME } from "./eventDb";

export const readCachedEvents = async (limit = 100, skip = 0): Promise<NostrEvent[]> => {
  try {
    const db = await openDatabase();
    return new Promise<NostrEvent[]>((resolve, reject) => {
      const tx = db.transaction(EVENT_STORE_NAME, "readonly");
      const store = tx.objectStore(EVENT_STORE_NAME);
      const index = store.index("created_at");
      const events: NostrEvent[] = [];
      let skipped = 0;
      const cursorRequest = index.openCursor(null, "prev");
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          resolve(events);
          return;
        }
        if (skipped < skip) {
          skipped += 1;
          cursor.continue();
          return;
        }
        if (events.length < limit) {
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
