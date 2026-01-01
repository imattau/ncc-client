import { describe, it, expect } from "vitest";

import { classifyNccDiscoveryEvent } from "../nccDiscovery";

const baseEvent = {
  id: "event-id",
  author: "npub1example",
  content: "",
  created_at: Date.now(),
  tags: [] as string[][]
};

describe("ncc discovery classifier", () => {
  it("recognizes NCC-02 service records when required tags exist", () => {
    const event = {
      ...baseEvent,
      kind: 30059,
      tags: [
        ["d", "relay"],
        ["exp", `${Math.floor(Date.now() / 1000) + 60}`]
      ]
    };
    expect(classifyNccDiscoveryEvent(event)).toBe("serviceRecord");
  });

  it("ignores NCC-02-like events without the required tags", () => {
    const event = {
      ...baseEvent,
      kind: 30059,
      tags: [["d", "relay"]]
    };
    expect(classifyNccDiscoveryEvent(event)).toBeNull();
  });

  it("recognizes NCC-05 locators when the payload contains endpoints", () => {
    const payload = {
      v: 1,
      ttl: 3600,
      updated_at: Math.floor(Date.now() / 1000),
      endpoints: [{ type: "tcp", url: "tcp://1.2.3.4" }]
    };
    const event = {
      ...baseEvent,
      kind: 30058,
      content: JSON.stringify(payload),
      tags: [["d", "relay"]]
    };
    expect(classifyNccDiscoveryEvent(event)).toBe("locator");
  });

  it("skips NCC-05 candidates when the payload is malformed", () => {
    const event = {
      ...baseEvent,
      kind: 30058,
      content: "not-json",
      tags: [["d", "relay"]]
    };
    expect(classifyNccDiscoveryEvent(event)).toBeNull();
  });
});
