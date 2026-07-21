import { describe, expect, it } from "vitest";
import { endpointCandidates, isPortOpen } from "../src/native-bridge.js";

describe("native bridge endpoints", () => {
  it("preserves the configured endpoint first and adds both loopback families", () => {
    expect(endpointCandidates(new URL("http://localhost:6767/sse?token=test")).map((candidate) => candidate.href)).toEqual([
      "http://localhost:6767/sse?token=test",
      "http://[::1]:6767/sse?token=test",
      "http://127.0.0.1:6767/sse?token=test",
    ]);
  });

  it("does not duplicate an explicitly configured IPv6 endpoint", () => {
    expect(endpointCandidates(new URL("http://[::1]:6767/sse")).map((candidate) => candidate.href)).toEqual([
      "http://[::1]:6767/sse",
      "http://127.0.0.1:6767/sse",
      "http://localhost:6767/sse",
    ]);
  });

  it("accepts URL-style bracketed IPv6 hostnames for socket probes", async () => {
    await expect(isPortOpen("[::1]", 1, 10)).resolves.toBe(false);
  });
});
