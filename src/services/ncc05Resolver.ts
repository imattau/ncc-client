import { selectEndpoints, type NCC05Endpoint, NCC05Resolver } from "ncc-05-js";
import { DEFAULT_RELAYS } from "../config/relays";
import { getRelayPool } from "./nccClient";
import { appErrorManager } from "../utils/errorManager";

let resolver: NCC05Resolver | null = null;

const ensureResolver = () => {
  if (!resolver) {
    resolver = new NCC05Resolver({
      bootstrapRelays: DEFAULT_RELAYS,
      pool: getRelayPool()
    });
  }
  return resolver;
};

export async function resolveNcc05Locator(
  targetPubkey: string,
  serviceId: string,
  secretKey?: string | Uint8Array
): Promise<string | null> {
  try {
    const payload = await ensureResolver().resolve(targetPubkey, secretKey, serviceId, { gossip: true });
    if (!payload?.endpoints?.length) return null;
    const wsEndpoints: NCC05Endpoint[] = payload.endpoints.filter(
      (endpoint) => typeof endpoint.url === "string" && endpoint.url.startsWith("ws")
    );
    if (!wsEndpoints.length) return null;
    const sorted = selectEndpoints(wsEndpoints);
    return sorted[0]?.url ?? null;
  } catch (error) {
    appErrorManager.report({
      message: "NCC-05 locator resolution failed",
      severity: "warning",
      source: "NCC-05 resolver",
      details: error
    });
    return null;
  }
}
