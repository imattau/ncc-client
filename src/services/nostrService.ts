import { nip19 } from "nostr-tools";
import { normalizeURL } from "nostr-tools/utils";
import type { Event as NostrToolsEvent } from "nostr-tools";
import { DEFAULT_RELAYS } from "../config/relays";
import { getRelayPool } from "./nccClient";

import type { Profile } from "./userManager"; // Import Profile type

let sleepingRelaysSet = new Set<string>();

const normalizeRelayEntry = (relay: string) => {
  try {
    const normalized = normalizeURL(relay.trim());
    return normalized;
  } catch {
    const trimmed = relay.trim();
    return trimmed || null;
  }
};

const sanitizeRelays = (relays: string[]) => {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const relay of relays) {
    const normalizedRelay = normalizeRelayEntry(relay);
    if (!normalizedRelay) continue;
    if (seen.has(normalizedRelay)) continue;
    seen.add(normalizedRelay);
    normalized.push(normalizedRelay);
  }
  return normalized;
};

const getEligibleRelays = (relays: string[]) => {
  if (!relays.length) return [];
  const normalized = sanitizeRelays(relays);
  return normalized.filter((relay) => !sleepingRelaysSet.has(relay));
};

export const setSleepingRelays = (relays: string[] | undefined) => {
  if (!relays?.length) {
    sleepingRelaysSet = new Set();
    return;
  }
  const normalized = sanitizeRelays(relays);
  sleepingRelaysSet = new Set(normalized);
};

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

  static async fetchProfile(pubkey: string, relays: string[] = DEFAULT_RELAYS): Promise<{ metadata: Omit<Profile, 'created_at'>, pubkey: string, created_at: number } | null> {
    try {
      const pool = getRelayPool();
      const filter = {
        kinds: [0],
        authors: [pubkey],
        limit: 1
      };
      const targetRelays = getEligibleRelays(relays);
      if (!targetRelays.length) {
        return null;
      }
      const event = await pool.get(targetRelays, filter);
      if (!event || !event.content) return null;
      try {
        return {
          metadata: JSON.parse(event.content),
          pubkey: event.pubkey,
          created_at: event.created_at
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

  static async fetchEvent(eventId: string, relays: string[] = DEFAULT_RELAYS): Promise<NostrToolsEvent | null> {
    try {
      const pool = getRelayPool();
      const targetRelays = getEligibleRelays(relays);
      if (!targetRelays.length) {
        return null;
      }
      const events = await pool.querySync(targetRelays, {
        ids: [eventId],
        kinds: [1, 30023],
        limit: 1
      });
      return events[0] ?? null;
    } catch {
      return null;
    }
  }

  static async fetchHashtag(hashtag: string, relays: string[] = DEFAULT_RELAYS): Promise<NostrToolsEvent[]> {
    try {
      const normalized = hashtag.replace(/^#+/, "").toLowerCase();
      if (!normalized) return [];
      const pool = getRelayPool();
      const targetRelays = getEligibleRelays(relays);
      if (!targetRelays.length) {
        return [];
      }
      const events = await pool.querySync(targetRelays, {
        kinds: [1, 30023],
        "#t": [normalized],
        limit: 30
      });
      return events;
    } catch {
      return [];
    }
  }

  static async fetchKeyword(keyword: string, relays: string[] = DEFAULT_RELAYS): Promise<NostrToolsEvent[]> {
    try {
      const trimmed = keyword.trim().toLowerCase();
      if (!trimmed) return [];
      const pool = getRelayPool();
      const targetRelays = getEligibleRelays(relays);
      if (!targetRelays.length) {
        return [];
      }
      const events = await pool.querySync(targetRelays, {
        kinds: [1, 30023],
        limit: 40
      });
      return events.filter((event) => event.content?.toLowerCase().includes(trimmed));
    } catch {
      return [];
    }
  }
}
