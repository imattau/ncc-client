import { nip19 } from "nostr-tools";

export type NaddrReference = {
  pubkey: string;
  kind: number;
  identifier: string;
  relays?: string[];
  uri: string;
};

export function parseNaddrUri(uri: string): NaddrReference | null {
  if (!uri || !uri.startsWith("nostr:naddr")) return null;
  try {
    const decoded = nip19.decode(uri);
    if (decoded.type !== "naddr" || typeof decoded.data !== "object" || !decoded.data) {
      return null;
    }
    const { pubkey, kind, identifier, relays } = decoded.data as {
      pubkey?: string;
      kind?: number;
      identifier?: string;
      relays?: string[];
    };
    if (!pubkey || !kind || !identifier) return null;
    return {
      pubkey,
      kind,
      identifier,
      relays: Array.isArray(relays) ? relays.filter(Boolean) : undefined,
      uri
    };
  } catch {
    return null;
  }
}
