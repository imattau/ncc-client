import { nip19 } from "nostr-tools";
import type { NostrEvent } from "../types/events";
import type { Profile } from "./userManager";
import type { SearchEntry } from "../types/search";

export type SearchManagerConfig = {
  maxEventResults?: number;
  maxProfileResults?: number;
};

export class SearchManager {
  private events: NostrEvent[] = [];
  private profiles: Record<string, Profile> = {};
  private config: SearchManagerConfig;

  constructor(config: SearchManagerConfig = {}) {
    this.config = {
      maxEventResults: config.maxEventResults ?? 20,
      maxProfileResults: config.maxProfileResults ?? 10
    };
  }

  updateEvents(events: NostrEvent[]) {
    this.events = events.slice(0, 200);
  }

  updateProfiles(profiles: Record<string, Profile>) {
    this.profiles = { ...profiles };
  }

  search(query: string, formatAuthor: (author: string) => string): SearchEntry[] {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return [];

    const matches: SearchEntry[] = [];
    let eventCount = 0;

    for (const event of this.events) {
      if (eventCount >= this.config.maxEventResults!) break;
      const previewText = event.content?.replace(/\s+/g, " ").trim() ?? "";
      const label = `${formatAuthor(event.author)} · ${event.kind === 30023 ? "Article" : "Note"}`;
      const candidateValues = [
        event.id,
        event.author,
        previewText,
        label,
        formatAuthor(event.author),
        (event.relays ?? []).join(" ")
      ];
      const npubAuthor = this.toNpub(event.author);
      if (npubAuthor) candidateValues.push(npubAuthor);
      if (!candidateValues.some((value) => this.matches(value, normalized))) continue;

      eventCount += 1;
      const description = previewText.length > 120 ? `${previewText.slice(0, 120).trim()}…` : previewText;
      matches.push({
        id: event.id,
        type: "event",
        label,
        description: description || "No text provided",
        meta: `Posted ${Math.round((Date.now() - event.created_at) / 1000 / 60)}m ago`,
        link: `https://nostr.build/events/${event.id}`
      });
    }

    let profileCount = 0;
    for (const [pubkey, profile] of Object.entries(this.profiles)) {
      if (profileCount >= this.config.maxProfileResults!) break;
      const displayName = profile?.display_name ?? profile?.name ?? formatAuthor(pubkey);
      const sources = [displayName, pubkey, profile?.nip05 ?? "", profile?.about ?? ""];
      const npubProfile = this.toNpub(pubkey);
      if (npubProfile) sources.push(npubProfile);
      if (!sources.some((value) => this.matches(value, normalized))) continue;

      profileCount += 1;
      matches.push({
        id: pubkey,
        type: "profile",
        label: displayName,
        description: profile?.about,
        meta: profile?.nip05 ?? formatAuthor(pubkey),
        link: `https://nostr.build/profiles/${pubkey}`
      });
    }

    return matches;
  }

  private matches(value: unknown, query: string) {
    if (value === null || value === undefined) return false;
    return String(value).toLowerCase().includes(query);
  }

  private toNpub(pubkey: string | undefined | null) {
    if (!pubkey) return null;
    if (!/^[0-9a-f]{64}$/i.test(pubkey)) return null;
    try {
      return nip19.npubEncode(pubkey);
    } catch {
      return null;
    }
  }
}
