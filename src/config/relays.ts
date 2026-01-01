import { selectEndpoints } from "ncc-05-js";

const RAW_RELAYS = [
  { type: "ws", url: "wss://relay.damus.io", priority: 10, family: "ipv4" },
  { type: "ws", url: "wss://nostr-pub.wellorder.net", priority: 15, family: "ipv4" },
  { type: "ws", url: "wss://nostr.bitcoiner.social", priority: 20, family: "ipv4" },
  { type: "ws", url: "wss://relay.snort.social", priority: 25, family: "ipv4" },
  { type: "ws", url: "wss://eden.nostr.land", priority: 30, family: "ipv4" }
] satisfies Parameters<typeof selectEndpoints>[0];

const DEFAULT_RELAY_ENDPOINTS: ReturnType<typeof selectEndpoints> = selectEndpoints(RAW_RELAYS);

export const DEFAULT_RELAYS = DEFAULT_RELAY_ENDPOINTS.map((endpoint: { url: string }) => endpoint.url);
