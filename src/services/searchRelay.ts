import { nip19 } from "nostr-tools";
import type { Event as NostrToolsEvent } from "nostr-tools";
import { DEFAULT_RELAYS } from "../config/relays";
import { getRelayPool } from "./nccClient";

export const parsePubkeyFromInput = (value: string) => {
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
};

export const isEventIdQuery = (value: string) => {
  const trimmed = value.trim();
  return /^[0-9a-f]{64}$/i.test(trimmed) ? trimmed.toLowerCase() : null;
};

export async function fetchRemoteProfile(pubkey: string) {
  try {
    const pool = getRelayPool();
    const filter = {
      kinds: [0],
      authors: [pubkey],
      limit: 1
    };
    const event = await pool.get(DEFAULT_RELAYS, filter);
    if (!event) return null;
    if (!event.content) return null;
    try {
      return {
        metadata: JSON.parse(event.content),
        pubkey: event.pubkey
      };
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function fetchRemoteEvent(eventId: string): Promise<NostrToolsEvent | null> {
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

export async function fetchRemoteHashtag(hashtag: string): Promise<NostrToolsEvent[]> {
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

export async function fetchRemoteKeyword(keyword: string): Promise<NostrToolsEvent[]> {
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
