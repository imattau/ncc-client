import { nip19 } from "nostr-tools";
import type { Event as NostrToolsEvent } from "nostr-tools";
import { DEFAULT_RELAYS } from "../config/relays";
import { resolveService } from "../services/ncc02Resolver";
import { resolveNcc05Locator } from "../services/ncc05Resolver";
import { getRelayPool } from "../services/nccClient";

export type RelayOperationResult = {
  success: boolean;
  reason?: string;
};

const STORAGE_KEY = "ncc-client-relay-list";
const NCC02_SERVICE_ID = "relay";
const RELAY_LIST_KIND = 10002;

export type RelayManagerOptions = {
  ncc05SecretKey?: string | Uint8Array;
};

const normalizeRelay = (relay: string) => relay.trim();

const isValidRelay = (relay: string) => /^wss?:\/\/[^\s]+$/.test(relay);

const isNcc02Relay = (relay: string) => {
  try {
    const parsed = new URL(relay);
    return parsed.hostname.toLowerCase().startsWith("npub1");
  } catch {
    return false;
  }
};

const extractServiceId = (relay: string) => {
  try {
    const parsed = new URL(relay);
    const path = parsed.pathname.replace(/^\/+|\/+$/g, "");
    if (path) return path;
    const param = parsed.searchParams.get("serviceId");
    if (param) return param;
    return NCC02_SERVICE_ID;
  } catch {
    return NCC02_SERVICE_ID;
  }
};

const SERVICE_RECORD_KIND = 30059;
const SERVICE_RECORD_LIMIT = 32;

const resolveNcc02Relay = async (input: string, options?: RelayManagerOptions) => {
  try {
    const npubCandidate = extractNpubCandidate(input);
    if (!npubCandidate) return null;
    const serviceId = extractServiceId(input);
    const decoded = nip19.decode(npubCandidate);
    if (decoded.type !== "npub" || typeof decoded.data !== "string") return null;
    /*
    console.info(`[NCC-02] resolve attempt`, {
      target: input,
      serviceId,
      decoded
    });
    */
    const attemptResolve = async (candidateId: string) => {
      /*
      console.info(`[NCC-02] resolve attempt`, {
        target: input,
        serviceId: candidateId,
        decoded
      });
      */
      const result = await resolveService(decoded.data, candidateId);
      /*
      console.info(
        `[NCC-02] resolve result`,
        result ? { target: input, serviceId: candidateId, endpoint: result.endpoint } : { target: input, serviceId: candidateId, found: false }
      );
      */
      return result;
    };

    let resolvedRecord = await attemptResolve(serviceId);
    let usedServiceId = serviceId;

    if (!resolvedRecord) {
      const discoveredIds = await discoverServiceIds(decoded.data);
      for (const candidateId of discoveredIds) {
        if (candidateId === serviceId) continue;
        const candidateResult = await attemptResolve(candidateId);
        if (candidateResult) {
          resolvedRecord = candidateResult;
          usedServiceId = candidateId;
          break;
        }
      }
      if (!resolvedRecord) {
        // console.info(`[NCC-02] resolution exhausted`, { target: input, serviceId, candidates: discoveredIds });
        return null;
      }
    }

    let endpoint = resolvedRecord.endpoint ?? null;
    if (!endpoint) {
      const locator = await resolveNcc05Locator(decoded.data, usedServiceId, options?.ncc05SecretKey);
      if (locator) {
        // console.info(`[NCC-05] locator resolved`, { target: input, serviceId: usedServiceId, endpoint: locator });
        endpoint = locator;
      }
    }
    // console.info(`[NCC-02] resolved endpoint`, { target: input, serviceId: usedServiceId, endpoint });
    return endpoint;
  } catch {
    return null;
  }
};

const extractNpubCandidate = (relay: string) => {
  const normalized = normalizeRelay(relay);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower.startsWith("npub1")) {
    return normalized;
  }
  try {
    const parsed = new URL(normalized);
    const host = parsed.hostname.toLowerCase();
    if (host.startsWith("npub1")) {
      return host;
    }
  } catch {
    // ignore
  }
  return null;
};

const discoverServiceIds = async (ownerPubkey: string) => {
  try {
    const pool = getRelayPool();
    const events: NostrToolsEvent[] = await pool.querySync(DEFAULT_RELAYS, {
      authors: [ownerPubkey],
      kinds: [SERVICE_RECORD_KIND],
      limit: SERVICE_RECORD_LIMIT
    });
    const ids = new Set<string>();
    events.forEach((event) => {
      const dTag = event.tags?.find((tag) => tag[0] === "d" && Boolean(tag[1]));
      if (dTag && typeof dTag[1] === "string") {
        ids.add(dTag[1]);
      }
    });
    return Array.from(ids);
  } catch (error) {
    return [];
  }
};

export class RelayManager {
  private relays: string[] = [];
  private options: RelayManagerOptions;

  constructor(initial?: string[], options: RelayManagerOptions = {}) {
    this.options = options;
    this.relays = this.load() || initial?.slice(0) || DEFAULT_RELAYS.slice(0);
  }

  getRelays() {
    return this.relays.slice(0);
  }

  async addRelay(relay: string) {
    let candidate = normalizeRelay(relay);
    if (!candidate) return { success: false, reason: "Relay URL is empty" };
    const npubCandidate = extractNpubCandidate(candidate);
    if (npubCandidate) {
      const resolved = await resolveNcc02Relay(candidate, this.options);
      if (!resolved) {
        return { success: false, reason: "Failed to resolve NCC-02 service" };
      }
      candidate = resolved;
    }
    return this.addNormalizedRelay(candidate);
  }

  removeRelay(relay: string) {
    const normalized = normalizeRelay(relay);
    if (!this.relays.includes(normalized)) {
      return { success: false, reason: "Relay not found" };
    }
    this.relays = this.relays.filter((entry) => entry !== normalized);
    this.persist();
    return { success: true };
  }

  replaceRelays(relays: string[]) {
    this.relays = Array.from(
      new Set(relays.filter(Boolean).map(normalizeRelay).filter((entry) => isValidRelay(entry)))
    );
    this.persist();
  }

  async hydrate() {
    const resolved: string[] = [];
    for (const relay of this.relays) {
      const npubCandidate = extractNpubCandidate(relay);
      if (npubCandidate) {
        const endpoint = await resolveNcc02Relay(relay, this.options);
        if (endpoint && !resolved.includes(endpoint)) {
          resolved.push(endpoint);
        }
        continue;
      }
      if (isValidRelay(relay) && !resolved.includes(relay)) {
        resolved.push(relay);
      }
    }
    if (!resolved.length) {
      this.relays = DEFAULT_RELAYS.slice(0);
    } else {
      this.relays = resolved;
    }
    this.persist();
    return this.getRelays();
  }

  async fetchNip65Relays(pubkey: string) {
    try {
      const pool = getRelayPool();
      const events = await pool.querySync(DEFAULT_RELAYS, {
        authors: [pubkey],
        kinds: [RELAY_LIST_KIND],
        limit: 1
      });

      if (!events.length) return null;

      const event = events[0];
      const relays = event.tags
        .filter((tag) => tag[0] === "r" && tag[1])
        .map((tag) => tag[1]);

      if (relays.length > 0) {
        this.replaceRelays(relays);
        return relays;
      }
    } catch (error) {
      // ignore failures
    }
    return null;
  }

  private addNormalizedRelay(relay: string) {
    if (!isValidRelay(relay)) return { success: false, reason: "Invalid relay URI" };
    if (this.relays.includes(relay)) {
      return { success: false, reason: "Relay already managed" };
    }
    this.relays = [...this.relays, relay];
    this.persist();
    return { success: true };
  }

  private persist() {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(this.relays));
    } catch {
      // ignore storage failures
    }
  }

  private load(): string[] | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return null;
      const normalized = parsed
        .map((entry) => normalizeRelay(String(entry)))
        .filter((entry) => entry && isValidRelay(entry));
      return normalized.length ? Array.from(new Set(normalized)) : [];
    } catch {
      return null;
    }
  }
}
