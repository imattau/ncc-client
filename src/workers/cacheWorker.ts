import type { NostrEvent } from "../types/events";
import { openDatabase, pruneOldEvents, waitForTransaction, EVENT_STORE_NAME } from "../utils/eventDb";

type CacheWorkerMessage = {
  type: "cache";
  entries: NostrEvent[];
};

const handleCache = async (entries: NostrEvent[]) => {
  if (!entries.length) return;
  try {
    const db = await openDatabase();
    const tx = db.transaction(EVENT_STORE_NAME, "readwrite");
    const store = tx.objectStore(EVENT_STORE_NAME);
    entries.forEach((entry) => {
      store.put(entry);
    });
    await waitForTransaction(tx);
    await pruneOldEvents(db);
  } catch {
    // silently ignore caching failures
  }
};

self.addEventListener("message", (event: MessageEvent<CacheWorkerMessage>) => {
  const data = event.data;
  if (data.type === "cache") {
    void handleCache(data.entries ?? []);
  }
});
