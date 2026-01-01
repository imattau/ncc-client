import { describe, it, expect, vi, MockedFunction, beforeEach } from "vitest";

import type { ResolvedService } from "ncc-02-js";

vi.mock("../ncc02Resolver", () => {
  return {
    resolveService: vi.fn()
  };
});

vi.mock("../ncc05Resolver", () => {
  return {
    resolveNcc05Locator: vi.fn().mockResolvedValue(null)
  };
});

vi.mock("../nccClient", () => {
  return {
    getRelayPool: () => ({
      querySync: vi.fn(async () => [])
    })
  };
});

import { resolveService } from "../ncc02Resolver";
import { RelayManager } from "../relayManager";

describe("RelayManager NCC-02 handling", () => {
  const npubUrl = "wss://npub1cxstracs7tnd528p9kkwcxd70pgy9txe7t2amnlr4f63euqah49s0mw48s";
  const npubValue = "npub1cxstracs7tnd528p9kkwcxd70pgy9txe7t2amnlr4f63euqah49s0mw48s";
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const serviceRecord: ResolvedService = {
    endpoint: "wss://relays.example.com",
    fingerprint: "svc-fp",
    expiry: Date.now() + 1000,
    eventId: "srv-event",
    pubkey: "c1a0b1f710f2e6da28e12dacec19be785042acd9f2d5ddcfe3aa751cf01dbd4b",
    attestations: [
      {
        kind: 30060,
        id: "ncc05-event",
        pubkey:
          "ab3d5287c8cc4f749d28b1386ff5c1b1e1410da39e67e007beed5edc58a7bc55",
        content: JSON.stringify({
          v: 1,
          endpoints: [{ type: "tcp", url: "tcp://1.2.3.4:9999" }],
          ttl: 3600,
          updated_at: Date.now()
        })
      }
    ]
  };

  it("resolves a npub entry and stores the endpoint", async () => {
    const mockedResolve = resolveService as MockedFunction<typeof resolveService>;
    mockedResolve.mockResolvedValue(serviceRecord);

    const relayManager = new RelayManager();
    const result = await relayManager.addRelay(npubValue);

    expect(result.success).toBe(true);
    expect(relayManager.getRelays()).toContain(serviceRecord.endpoint);
    expect(mockedResolve).toHaveBeenCalledWith(serviceRecord.pubkey, "relay");
  });

  it("reports failure when NCC-02 resolution fails", async () => {
    const mockedResolve = resolveService as MockedFunction<typeof resolveService>;
    mockedResolve.mockResolvedValue(null);

    const relayManager = new RelayManager();
    const result = await relayManager.addRelay(npubUrl);

    expect(result.success).toBe(false);
    expect(result.reason).toBe("Failed to resolve NCC-02 service");
  });
});
