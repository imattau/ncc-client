import { SimplePool, type Filter, type Event as NostrToolsEvent } from "nostr-tools";
import { normalizeURL } from "nostr-tools/utils";
import { RelayWorkerRequest } from "./relayWorker.types";
import type { NostrEvent } from "../types/events";
import { isNccDiscoveryKind } from "../utils/nccDiscovery";

let subscriptions: ReturnType<SimplePool["subscribe"]>[] = [];
let currentRelays: string[] = [];
const seenIds = new Set<string>();
const fingerprintSet = new Set<string>();
const scheduledTimeouts: number[] = [];
const relayStats: Record<string, { eventCount: number; dropCount: number }> = {};
const THROTTLE_INTERVAL_MS = 400;
const IMMEDIATE_SUBSCRIPTIONS = 1; // Number of subscriptions to fire immediately
const RATE_LIMIT_WINDOW_MS = 10_000;
const MAX_EVENTS_PER_AUTHOR = 6;
const RATE_LIMIT_KINDS = new Set([6, 7, 30058, 30059, 30060, 30061]);
const authorRateMap = new Map<string, { count: number; windowStart: number }>();
const TOTAL_STATS_KEY = "total";

let adaptiveThrottleMs = THROTTLE_INTERVAL_MS;
let lastScheduleStart = 0;
let eventSeenSinceSchedule = false;

const RELAY_URL_REGEX = /(wss?:\/\/[^\s'"]+)/i;
const RELAY_COOLDOWN_BASE_MS = 30_000;
const RELAY_COOLDOWN_CAP_MS = 5 * 60_000;

const relayFailureCounts: Record<string, number> = {};
const relayCooldownUntil: Record<string, number> = {};

let cooldownRetryTimer: number | null = null;

const normalizeRelayKey = (relay: string) => {
  try {
    return normalizeURL(relay);
  } catch {
    return relay.trim();
  }
};

const getRelayCooldownKey = (relay: string) => {
  const normalized = normalizeRelayKey(relay);
  return normalized || relay;
};

const getEligibleRelays = () => {
  const now = Date.now();
  return currentRelays.filter((relay) => {
    const key = getRelayCooldownKey(relay);
    const until = relayCooldownUntil[key];
    return !until || until <= now;
  });
};

const getNextCooldownExpiry = () => {
  const now = Date.now();
  let earliest: number | null = null;
  for (const relay of currentRelays) {
    const key = getRelayCooldownKey(relay);
    const until = relayCooldownUntil[key];
    if (until && until > now && (earliest === null || until < earliest)) {
      earliest = until;
    }
  }
  return earliest;
};

const recordRelayFailure = (relay: string | null) => {
  if (!relay) return;
  const normalized = normalizeRelayKey(relay);
  if (!normalized) return;
  const count = (relayFailureCounts[normalized] ?? 0) + 1;
  relayFailureCounts[normalized] = count;
  const cooldown = Math.min(RELAY_COOLDOWN_BASE_MS * count, RELAY_COOLDOWN_CAP_MS);
  relayCooldownUntil[normalized] = Date.now() + cooldown;
};

class RelayTrackingPool extends SimplePool {
  async ensureRelay(url: string, params?: { connectionTimeout?: number }) {
    try {
      return await super.ensureRelay(url, params);
    } catch (error) {
      recordRelayFailure(url);
      throw error;
    }
  }
}

const pool = new RelayTrackingPool();

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
  recordSubscriptionLatency();
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
  if (cooldownRetryTimer) {
    clearTimeout(cooldownRetryTimer);
    cooldownRetryTimer = null;
  }
};

const buildFilters = () => [...baseFilters, ...extraFilters];

const ensureRelayStatsEntry = (key: string) => {
  if (!relayStats[key]) {
    relayStats[key] = { eventCount: 0, dropCount: 0 };
  }
  return relayStats[key];
};

const isRelaySleeping = (relay: string) => {
  const key = getRelayCooldownKey(relay);
  const until = relayCooldownUntil[key];
  return Boolean(until && until > Date.now());
};

const getSleepingRelays = () => currentRelays.filter(isRelaySleeping);

const extractRelayFromError = (error: unknown) => {
  const text =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
      ? (error as { message?: string }).message ?? ""
      : "";
  const matches = text.match(RELAY_URL_REGEX);
  return matches?.[0] ?? null;
};

const recordSubscriptionLatency = () => {
  if (eventSeenSinceSchedule || !lastScheduleStart) return;
  const latency = Date.now() - lastScheduleStart;
  const blended = Math.round(adaptiveThrottleMs * 0.7 + latency * 0.3);
  adaptiveThrottleMs = Math.max(80, Math.min(600, blended));
  eventSeenSinceSchedule = true;
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
  if (cooldownRetryTimer) {
    clearTimeout(cooldownRetryTimer);
    cooldownRetryTimer = null;
  }
  if (!currentRelays.length) {
    postStatus(false, []);
    return;
  }

  const sleepingRelays = getSleepingRelays();
  const eligibleRelays = getEligibleRelays();
  if (!eligibleRelays.length) {
    const nextExpiry = getNextCooldownExpiry();
    const delay = nextExpiry ? Math.max(nextExpiry - Date.now(), 500) : RELAY_COOLDOWN_BASE_MS;
    cooldownRetryTimer = self.setTimeout(scheduleSubscriptions, delay);
    postStatus(false, sleepingRelays);
    return;
  }

  postStatus(true, sleepingRelays);
  lastScheduleStart = Date.now();
  eventSeenSinceSchedule = false;
  const filtersToUse = buildFilters();
  const throttleMs = Math.max(80, Math.min(600, Math.round(adaptiveThrottleMs)));
  filtersToUse.forEach((filter, index) => {
    // Calculate delay: first IMMEDIATE_SUBSCRIPTIONS are 0ms, then throttled
    const delay =
      index < IMMEDIATE_SUBSCRIPTIONS ? 0 : (index - IMMEDIATE_SUBSCRIPTIONS + 1) * throttleMs;
    const timeout = self.setTimeout(() => {
      try {
        const sub = pool.subscribe(eligibleRelays, filter, {
          onevent: (event) => {
            handleEvent(event);
          }
        });
        subscriptions.push(sub);
      } catch (err) {
        console.error("[RelayWorker] Subscribe error", err);
        const failedRelay = extractRelayFromError(err);
        recordRelayFailure(failedRelay);
      }
    }, delay);
    scheduledTimeouts.push(timeout);
  });
};

const fetchEvent = (id: string) => {
  if (!id) return;
  const filter: Filter = { ids: [id], limit: 1 };
  const eligibleRelays = getEligibleRelays();
  if (!eligibleRelays.length) return;
  const sub = pool.subscribe(eligibleRelays, filter, {
    onevent: (event) => {
      if (event.id !== id) return;
      const mapped = mapEvent(event);
      postMessage({ type: "fetched", event: mapped });
      sub.close();
    }
  });
  setTimeout(() => sub.close(), 10000);
};

const postStatus = (connected: boolean, sleepingRelays: string[]) => {
  postMessage({
    type: "status",
    relays: currentRelays,
    connected,
    stats: relayStats,
    sleepingRelays
  });
};

// Periodic status updates with stats
self.setInterval(() => {
  if (!currentRelays.length) return;
  const sleepingRelays = getSleepingRelays();
  const eligibleRelays = getEligibleRelays();
  postStatus(Boolean(eligibleRelays.length), sleepingRelays);
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
    }
  });
