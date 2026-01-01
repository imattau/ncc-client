import { SimplePool, type Filter, type Event as NostrToolsEvent } from "nostr-tools";
import { RelayWorkerRequest } from "./relayWorker.types";
import type { NostrEvent } from "../types/events";
import { isNccDiscoveryKind } from "../utils/nccDiscovery";

const pool = new SimplePool();
let subscriptions: ReturnType<typeof pool.subscribe>[] = [];
let currentRelays: string[] = [];
const seenIds = new Set<string>();
const fingerprintSet = new Set<string>();
const scheduledTimeouts: number[] = [];
const relayStats: Record<string, { eventCount: number; dropCount: number }> = {};
const THROTTLE_INTERVAL_MS = 250;
const IMMEDIATE_SUBSCRIPTIONS = 2; // Number of subscriptions to fire immediately
const RATE_LIMIT_WINDOW_MS = 10_000;
const MAX_EVENTS_PER_AUTHOR = 6;
const RATE_LIMIT_KINDS = new Set([6, 7, 30058, 30059, 30060, 30061]);
const authorRateMap = new Map<string, { count: number; windowStart: number }>();
const TOTAL_STATS_KEY = "total";

let baseFilters: Filter[] = [
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

  if (shouldDropDueToRateLimit(event)) {
    return;
  }

  const tagsKey = event.tags?.map((tag) => tag.join(":")).join("|") ?? "";
  const fingerprint = `${event.pubkey}:${event.kind}:${event.content}:${tagsKey}`;
  if (fingerprintSet.has(fingerprint)) {
    return;
  }

  if (seenIds.has(event.id)) {
    return;
  }

  const stats = ensureRelayStatsEntry(TOTAL_STATS_KEY);
  stats.eventCount += 1;

  fingerprintSet.add(fingerprint);
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

const ensureRelayStatsEntry = (key: string) => {
  if (!relayStats[key]) {
    relayStats[key] = { eventCount: 0, dropCount: 0 };
  }
  return relayStats[key];
};

const shouldDropDueToRateLimit = (event: NostrToolsEvent) => {
  if (!RATE_LIMIT_KINDS.has(event.kind) || !event.pubkey) {
    return false;
  }
  const now = Date.now();
  const existing = authorRateMap.get(event.pubkey);
  if (!existing || now - existing.windowStart > RATE_LIMIT_WINDOW_MS) {
    authorRateMap.set(event.pubkey, { count: 1, windowStart: now });
    return false;
  }
  if (existing.count >= MAX_EVENTS_PER_AUTHOR) {
    const stats = ensureRelayStatsEntry(TOTAL_STATS_KEY);
    stats.dropCount += 1;
    return true;
  }
  existing.count += 1;
  return false;
};

const resetAuthorRateLimit = () => authorRateMap.clear();

const scheduleSubscriptions = () => {
  closeSubscriptions();
  if (!currentRelays.length) {
    postStatus(false);
    return;
  }
  postStatus(true);
  const filtersToUse = buildFilters();
  filtersToUse.forEach((filter, index) => {
    // Calculate delay: first IMMEDIATE_SUBSCRIPTIONS are 0ms, then throttled
    const delay = index < IMMEDIATE_SUBSCRIPTIONS ? 0 : (index - IMMEDIATE_SUBSCRIPTIONS + 1) * THROTTLE_INTERVAL_MS;
    const timeout = self.setTimeout(() => {
      try {
        const sub = pool.subscribe(currentRelays, filter, {
          onevent: (event) => {
            // Track per-relay stats if possible. Some versions of SimplePool provide a second argument.
            // Even if not directly provided in the signature, we can try to infer or at least track total.
            handleEvent(event);
          }
        });
        subscriptions.push(sub);
      } catch (err) {
        console.error("[RelayWorker] Subscribe error", err);
      }
    }, delay);
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
  postMessage({ type: "status", relays: currentRelays, connected, stats: relayStats });
};

// Periodic status updates with stats
self.setInterval(() => {
  if (currentRelays.length > 0) {
    postStatus(true);
  }
}, 5000);

self.addEventListener("message", (event: MessageEvent<RelayWorkerRequest>) => {
  const data = event.data;
  switch (data.type) {
    case "init":
      currentRelays = data.relays;
      seenIds.clear();
      fingerprintSet.clear();
      resetAuthorRateLimit();
      scheduleSubscriptions();
      break;
    case "updateRelays":
      currentRelays = data.relays;
      seenIds.clear();
      fingerprintSet.clear();
      resetAuthorRateLimit();
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
      fingerprintSet.clear();
      resetAuthorRateLimit();
      scheduleSubscriptions();
      break;
    case "updateBaseFilters":
      baseFilters = data.filters ?? [];
      seenIds.clear(); // Clear seen IDs as filters have changed significantly
      fingerprintSet.clear();
      resetAuthorRateLimit();
      scheduleSubscriptions();
      break;
    default:
      postMessage({ type: "error", message: `Unknown worker command: ${data.type}` });
    }
  });
