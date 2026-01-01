import type { Event as NostrToolsEvent } from "nostr-tools";
import { SimplePool } from "nostr-tools";
import * as ncc06 from "ncc-06-js";
import { DEFAULT_RELAYS } from "../config/relays";

let relayClient: SimplePool | null = null;

function createRelayClient() {
  if (relayClient) {
    return relayClient;
  }

  relayClient = new SimplePool();
  return relayClient;
}

export async function initNccClient() {
  createRelayClient();
  return relayClient;
}

export function getRelayPool() {
  const client = createRelayClient();
  return client;
}

export async function publishEvent(event: NostrToolsEvent) {
  const client = createRelayClient();
  await client.publish(DEFAULT_RELAYS, event);
}

export async function fetchRelayList() {
  if (typeof (ncc06 as any)?.listRelays === "function") {
    return (ncc06 as any).listRelays();
  }
  if (typeof (ncc06 as any)?.preferredRelays === "function") {
    return (ncc06 as any).preferredRelays();
  }
  return DEFAULT_RELAYS;
}
