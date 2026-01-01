import type { NostrEvent } from "../types/events";
import { LruCache } from "../utils/lruCache";

export interface Profile {
  name?: string;
  display_name?: string;
  picture?: string;
  about?: string;
  nip05?: string;
  created_at: number; // Timestamp of the Kind 0 event
}

export type ContactEventResult = {
  handled: boolean;
  following?: string[];
  followers?: string[];
};

export type UserManagerOptions = {
  baseFollowing?: string[];
  profileCacheSize?: number;
};

export class UserManager {
  private readonly PROFILE_STORAGE_KEY = "ncc-client-profile-cache";
  private readonly profileCache: LruCache<string, Profile>;
  private readonly baseFollowing: Set<string>;
  private following = new Set<string>();
  private followers = new Set<string>();
  private muted = new Set<string>();

  constructor(options: UserManagerOptions = {}) {
    this.baseFollowing = new Set(options.baseFollowing ?? []);
    this.profileCache = new LruCache(options.profileCacheSize ?? 256);
    this.loadCachedProfiles();
  }

  getProfiles(): Record<string, Profile> {
    return this.profileCache.toObject();
  }

  getProfile(pubkey: string) {
    return this.profileCache.get(pubkey);
  }

  updateProfile(pubkey: string, metadata: Omit<Profile, 'created_at'> & { created_at: number }) {
    const existing = this.profileCache.get(pubkey);

    // Only update if the incoming profile is newer than the existing one,
    // or if the existing one has no created_at (meaning it's an old cached entry without this field)
    if (existing && existing.created_at !== undefined && metadata.created_at <= existing.created_at) {
      return { profiles: this.getProfiles(), updated: false };
    }

    const updated: Profile = {
      ...existing, // Start with existing data to retain properties not in metadata (e.g., if partial update)
      ...metadata, // Overlay new metadata
      created_at: metadata.created_at // Ensure created_at is always from the latest event
    };
    this.profileCache.set(pubkey, updated);
    this.persistProfiles();
    return { profiles: this.getProfiles(), updated: true };
  }

  getFollowingList(): string[] {
    return Array.from(this.following);
  }

  getFollowersList(): string[] {
    return Array.from(this.followers);
  }

  getEffectiveFollowing(includePubkey?: string) {
    const authors = new Set<string>(this.baseFollowing);
    this.following.forEach((author) => authors.add(author));
    if (includePubkey) {
      authors.add(includePubkey);
    }
    return Array.from(authors);
  }

  setFollowing(authors: string[]) {
    this.following = new Set(authors.filter(Boolean));
  }

  setFollowers(authors: string[]) {
    this.followers = new Set(authors.filter(Boolean));
  }

  processContactEvent(event: NostrEvent, currentPubkey: string | null): ContactEventResult {
    if (event.kind !== 3 || !currentPubkey) {
      return { handled: false };
    }
    const referenced = (event.tags ?? [])
      .filter((tag) => tag[0] === "p" && typeof tag[1] === "string")
      .map((tag) => tag[1]);
    const uniqueTargets = Array.from(new Set(referenced));
    let handled = false;
    let followersUpdated = false;
    let followingUpdated = false;

    if (event.author === currentPubkey) {
      this.setFollowing(uniqueTargets);
      handled = true;
      followingUpdated = true;
    }

    if (uniqueTargets.includes(currentPubkey)) {
      if (!this.followers.has(event.author)) {
        this.followers.add(event.author);
        followersUpdated = true;
      }
      handled = true;
    }

    const result: ContactEventResult = { handled };
    if (followingUpdated) {
      result.following = this.getFollowingList();
    }
    if (followersUpdated) {
      result.followers = this.getFollowersList();
    }
    return result;
  }

  getMutedAuthors(): string[] {
    return Array.from(this.muted);
  }

  toggleMute(author: string) {
    if (this.muted.has(author)) {
      this.muted.delete(author);
      return false;
    }
    this.muted.add(author);
    return true;
  }

  muteAuthor(author: string) {
    this.muted.add(author);
  }

  unmuteAuthor(author: string) {
    this.muted.delete(author);
  }

  isMuted(author: string) {
    return this.muted.has(author);
  }

  resetSocialGraph() {
    this.following.clear();
    this.followers.clear();
  }

  resetMuted() {
    this.muted.clear();
  }

  reset() {
    this.resetSocialGraph();
    this.resetMuted();
    this.profileCache.clear();
    this.persistProfiles();
  }

  private loadCachedProfiles() {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(this.PROFILE_STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      Object.entries(parsed).forEach(([pubkey, metadata]) => {
        if (typeof pubkey !== "string" || !metadata || typeof metadata !== "object") return;
        const profileWithTs: Profile = {
          ...(metadata as Omit<Profile, 'created_at'>),
          created_at: (metadata as Profile).created_at ?? 0 // Assign 0 if created_at is missing
        };
        this.profileCache.set(pubkey, profileWithTs);
      });
    } catch {
      // ignore invalid cache
    }
  }

  private persistProfiles() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(this.PROFILE_STORAGE_KEY, JSON.stringify(this.profileCache.toObject()));
    } catch {
      // ignore storage failures
    }
  }
}
