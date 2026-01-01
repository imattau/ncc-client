import type { Filter } from "nostr-tools";
import type { NostrEvent } from "../types/events";

export type RelayWorkerRequest =
  | { type: "init"; relays: string[] }
  | { type: "updateRelays"; relays: string[] }
  | { type: "updateFilters"; filters: Filter[] }
  | { type: "updateBaseFilters"; filters: Filter[] }
  | { type: "fetch"; id: string }
  | { type: "terminate" };

export type RelayWorkerResponse =
  | { type: "event"; event: NostrEvent }
  | { type: "deletions"; ids: string[] }
  | { type: "fetched"; event: NostrEvent }
  | { type: "status"; relays: string[]; connected: boolean; stats?: Record<string, { eventCount: number; dropCount: number }> }
  | { type: "error"; message: string }
  | { type: "nccDiscovery"; event: NostrEvent };
