import type { NostrEvent } from "../types/events";

export type NccDiscoveryType = "serviceRecord" | "locator" | "attestation" | "revocation";

export interface NccDiscoveryStats {
  serviceRecords: number;
  locators: number;
  attestations: number;
  revocations: number;
}

export const INITIAL_NCC_STATS: NccDiscoveryStats = {
  serviceRecords: 0,
  locators: 0,
  attestations: 0,
  revocations: 0
};

const NCC_DISCOVERY_KINDS = [30058, 30059, 30060, 30061];

export const isNccDiscoveryKind = (kind: number) => NCC_DISCOVERY_KINDS.includes(kind);

const hasTag = (event: NostrEvent, name: string) =>
  !!event.tags?.some((tag) => Array.isArray(tag) && tag[0] === name && Boolean(tag[1]));

const parseLocatorPayload = (content: string) => {
  try {
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    if (!Array.isArray((parsed as { endpoints?: unknown }).endpoints)) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const classifyNccDiscoveryEvent = (event: NostrEvent): NccDiscoveryType | null => {
  switch (event.kind) {
    case 30059: {
      if (hasTag(event, "d") && hasTag(event, "exp")) {
        return "serviceRecord";
      }
      return null;
    }
    case 30058: {
      if (!hasTag(event, "d")) return null;
      const payload = parseLocatorPayload(event.content);
      if (!payload) return null;
      return "locator";
    }
    case 30060: {
      if (hasTag(event, "srv") && hasTag(event, "subj") && hasTag(event, "e") && hasTag(event, "std")) {
        return "attestation";
      }
      return null;
    }
    case 30061: {
      if (hasTag(event, "e")) {
        return "revocation";
      }
      return null;
    }
    default:
      return null;
  }
};
