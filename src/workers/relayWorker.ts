import { SimplePool, type Filter, type Event as NostrToolsEvent } from "nostr-tools";
import { RelayWorkerRequest, RelayWorkerResponse } from "./relayWorker.types";
import type { NostrEvent } from "../types/events";
import { isNccDiscoveryKind } from "../utils/nccDiscovery";

const pool = new SimplePool();
let subscriptions: ReturnType<typeof pool.subscribe>[] = [];
let currentRelays: string[] = [];
const seenIds = new Set<string>();
const scheduledTimeouts: number[] = [];
const THROTTLE_INTERVAL_MS = 250;

const baseFilters: Filter[] = [
  { kinds: [1], limit: 60 },
  { kinds: [30023], limit: 40 },
  { kinds: [0], limit: 80 },
  { kinds: [6, 7], limit: 100 },
  { kinds: [30058, 30059, 30060, 30061], limit: 50 }
];
let extraFilters: Filter[] = [];

const mapEvent = (event: NostrToolsEvent): NostrEvent => ({
  id: event.id,
  kind: event.kind,
  author: event.pubkey,
  content: event.content,
  created_at: event.created_at * 1000,
  tags: event.tags,
  relays: [],
  isArticle: event.kind === 30023,
  isServiceRecord: event.kind === 30059
});

const handleDeletion = (event: NostrToolsEvent) => {
  const ids = event.tags.filter((tag) => tag[0] === "e").map((tag) => tag[1]).filter(Boolean);
  if (ids.length) {
    postMessage({ type: "deletions", ids });
  }
};

const dispatchEvent = (mapped: NostrEvent) => {
  postMessage({ type: "event", event: mapped });
};

const handleEvent = (event: NostrToolsEvent) => {
  if (event.kind === 5) {
    handleDeletion(event);
    return;
  }

  if (isNccDiscoveryKind(event.kind)) {
    const mapped = mapEvent(event);
    dispatchDiscovery(mapped);
    return;
  }

  if (seenIds.has(event.id)) {
    return;
  }

  seenIds.add(event.id);
  const mapped = mapEvent(event);
  dispatchEvent(mapped);
};

const dispatchDiscovery = (mapped: NostrEvent) => {
  postMessage({ type: "nccDiscovery", event: mapped });
};

const closeSubscriptions = () => {
  subscriptions.forEach((sub) => sub.close());
  subscriptions = [];
  scheduledTimeouts.forEach((timeout) => clearTimeout(timeout));
  scheduledTimeouts.length = 0;
};

const buildFilters = () => [...baseFilters, ...extraFilters];

const scheduleSubscriptions = () => {
  closeSubscriptions();
  if (!currentRelays.length) {
    postStatus(false);
    return;
  }
  postStatus(true);
  const filtersToUse = buildFilters();
  filtersToUse.forEach((filter, index) => {
    const timeout = self.setTimeout(() => {
      try {
        const sub = pool.subscribe(currentRelays, filter, {
          onevent: handleEvent
        });
        subscriptions.push(sub);
      } catch (err) {
        console.error("[RelayWorker] Subscribe error", err);
      }
    }, index * THROTTLE_INTERVAL_MS);
    scheduledTimeouts.push(timeout);
  });
};

const fetchEvent = (id: string) => {
  if (!id || !currentRelays.length) return;
  const filter: Filter = { ids: [id], limit: 1 };
  const sub = pool.subscribe(currentRelays, filter, {
    onevent: (event) => {
      if (event.id !== id) return;
      const mapped = mapEvent(event);
      postMessage({ type: "fetched", event: mapped });
      sub.close();
    }
  });
  setTimeout(() => sub.close(), 10000);
};

const postStatus = (connected: boolean) => {
  postMessage({ type: "status", relays: currentRelays, connected });
};

self.addEventListener("message", (event: MessageEvent<RelayWorkerRequest>) => {
  const data = event.data;
  switch (data.type) {
    case "init":
      currentRelays = data.relays;
      scheduleSubscriptions();
      break;
    case "updateRelays":
      currentRelays = data.relays;
      seenIds.clear();
      scheduleSubscriptions();
      break;
    case "fetch":
      fetchEvent(data.id);
      break;
    case "terminate":
      closeSubscriptions();
      break;
    case "updateFilters":
      extraFilters = data.filters ?? [];
      seenIds.clear();
      scheduleSubscriptions();
      break;
    default:
      postMessage({ type: "error", message: `Unknown worker command: ${(data as any).type}` });
  }
});
