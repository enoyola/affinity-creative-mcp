import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("defaults to localhost so Affinity's IPv6-only listener is reachable", () => {
    const config = loadConfig({});
    expect(config.endpoint.href).toBe("http://localhost:6767/sse");
    expect(config.nativeCallTimeoutMs).toBe(60_000);
  });

  it("accepts a positive native call timeout and falls back for invalid values", () => {
    expect(loadConfig({ AFFINITY_MCP_CALL_TIMEOUT_MS: "120000" }).nativeCallTimeoutMs).toBe(120_000);
    expect(loadConfig({ AFFINITY_MCP_CALL_TIMEOUT_MS: "0" }).nativeCallTimeoutMs).toBe(60_000);
    expect(loadConfig({ AFFINITY_MCP_CALL_TIMEOUT_MS: "not-a-number" }).nativeCallTimeoutMs).toBe(60_000);
  });

  it("accepts IPv4 and IPv6 loopback endpoints", () => {
    expect(loadConfig({ AFFINITY_MCP_ENDPOINT: "http://127.0.0.1:6767/sse" }).endpoint.hostname).toBe("127.0.0.1");
    expect(loadConfig({ AFFINITY_MCP_ENDPOINT: "http://[::1]:6767/sse" }).endpoint.hostname).toBe("[::1]");
  });

  it("rejects non-loopback endpoints", () => {
    expect(() => loadConfig({ AFFINITY_MCP_ENDPOINT: "http://example.com/sse" })).toThrow(/loopback/);
    expect(() => loadConfig({ AFFINITY_MCP_ENDPOINT: "https://127.0.0.1:6767/sse" })).toThrow(/loopback/);
  });
});
