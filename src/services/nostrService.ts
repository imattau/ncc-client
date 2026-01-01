import { nip19 } from "nostr-tools";
import type { Event as NostrToolsEvent } from "nostr-tools";
import { DEFAULT_RELAYS } from "../config/relays";
import { getRelayPool } from "./nccClient";

export class NostrService {
  static parsePubkeyFromInput(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^[0-9a-f]{64}$/i.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.startsWith("npub1")) {
      try {
        const decoded = nip19.decode(trimmed);
        if (decoded.type === "npub" && typeof decoded.data === "string") {
          return decoded.data;
        }
      } catch {
        return null;
      }
    }
    return null;
  }

  static isEventIdQuery(value: string): string | null {
    const trimmed = value.trim();
    return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
  }

  static async fetchProfile(pubkey: string, relays: string[] = DEFAULT_RELAYS) {
    try {
      const pool = getRelayPool();
      const filter = {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      };
      const event = await pool.get(relays, filter);
      if (!event || !event.content) return null;
      try {
        return {
          metadata: JSON.parse(event.content),
          pubkey: event.pubkey
        };
      } catch (e) {
        console.error("[NostrService] Failed to parse profile metadata for pubkey", pubkey, e);
        return null;
      }
    } catch (e) {
      console.error("[NostrService] Failed to fetch profile for pubkey", pubkey, e);
      return null;
    }
  }

  static async fetchEvent(eventId: string): Promise<NostrToolsEvent | null> {
    try {
      const pool = getRelayPool();
      const events = await pool.querySync(DEFAULT_RELAYS, {
        ids: [eventId],
        kinds: [1, 30023],
        limit: 1
      });
      return events[0] ?? null;
    } catch {
      return null;
    }
  }

  static async fetchHashtag(hashtag: string): Promise<NostrToolsEvent[]> {
    try {
      const normalized = hashtag.replace(/^#+/, "").toLowerCase();
      if (!normalized) return [];
      const pool = getRelayPool();
      const events = await pool.querySync(DEFAULT_RELAYS, {
        kinds: [1, 30023],
        "#t": [normalized],
        limit: 30
      });
      return events;
    } catch {
      return [];
    }
  }

  static async fetchKeyword(keyword: string): Promise<NostrToolsEvent[]> {
    try {
      const trimmed = keyword.trim().toLowerCase();
      if (!trimmed) return [];
      const pool = getRelayPool();
      const events = await pool.querySync(DEFAULT_RELAYS, {
        kinds: [1, 30023],
        limit: 40
      });
      return events.filter((event) => event.content?.toLowerCase().includes(trimmed));
    } catch {
      return [];
    }
  }
}
