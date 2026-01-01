import { NCC02Resolver, ResolvedService } from "ncc-02-js";
import { DEFAULT_RELAYS } from "../config/relays";
import { getRelayPool } from "./nccClient";
import { appErrorManager } from "../utils/errorManager";

export interface Ncc02ResolveOptions {
  requireAttestation?: boolean;
  minLevel?: string;
  standard?: string;
}

let resolver: NCC02Resolver | null = null;

function ensureResolver(trustedCAPubkeys: string[] = []) {
  if (!resolver) {
    resolver = new NCC02Resolver(DEFAULT_RELAYS, {
      pool: getRelayPool(),
      trustedCAPubkeys
    });
  }
  return resolver;
}

export function initNcc02Resolver(trustedCAPubkeys: string[] = []) {
  return ensureResolver(trustedCAPubkeys);
}

export async function resolveService(
  ownerPubkey: string,
  serviceId: string,
  options?: Ncc02ResolveOptions,
  trustedCAPubkeys?: string[]
): Promise<ResolvedService | null> {
  try {
    const client = ensureResolver(trustedCAPubkeys);
    const resolved = await client.resolve(ownerPubkey, serviceId, options);
    return resolved;
  } catch (error) {
    appErrorManager.report({
      message: `NCC-02 resolve failed: ${(error as Error).message ?? "unknown"}`,
      source: "NCC-02 resolver",
      severity: "warning",
      details: error
    });
    return null;
  }
}

export function closeResolver() {
  if (!resolver) return;
  resolver.close();
  resolver = null;
}
