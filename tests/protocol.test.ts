import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { AffinityService } from "../src/service.js";
import { FakeNativeBridge, testConfig } from "./helpers.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("MCP protocol", () => {
  it("lists the complete safe editing/export surface and hides raw script execution", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "affinity-mcp-protocol-"));
    cleanups.push(base);
    const output = path.join(base, "output");
    const staging = path.join(base, "staging");
    await Promise.all([mkdir(output), mkdir(staging)]);

    const service = await AffinityService.create(testConfig(output, staging), new FakeNativeBridge());
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "affinity_status",
          "affinity_launch",
          "affinity_plan_document",
          "affinity_create_document",
          "affinity_list_open_documents",
          "affinity_open_document",
          "affinity_inspect_document",
          "affinity_save_document",
          "affinity_list_layers",
          "affinity_select_layer",
          "affinity_add_layer",
          "affinity_add_shape",
          "affinity_add_text",
          "affinity_find_text",
          "affinity_replace_text",
          "affinity_batch_replace_text",
          "affinity_place_image",
          "affinity_transform_selection",
          "affinity_set_fill",
          "affinity_add_live_effect",
          "affinity_undo",
          "affinity_list_export_presets",
          "affinity_export_document",
          "affinity_batch_export",
          "affinity_render_spread",
          "affinity_render_selection",
          "affinity_list_sdk_documentation",
          "affinity_read_sdk_documentation",
        ]),
      );
      expect(names).not.toContain("execute_script");
      expect(names).not.toContain("affinity_execute_script");

      const findText = listed.tools.find((tool) => tool.name === "affinity_find_text");
      const replaceText = listed.tools.find((tool) => tool.name === "affinity_replace_text");
      const batchReplaceText = listed.tools.find((tool) => tool.name === "affinity_batch_replace_text");
      const addLiveEffect = listed.tools.find((tool) => tool.name === "affinity_add_live_effect");
      expect(findText?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(replaceText?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
      expect(batchReplaceText?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });

      const findProperties = (findText?.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }).properties;
      const replaceProperties = (replaceText?.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }).properties;
      const batchProperties = (batchReplaceText?.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }).properties;
      const liveEffectProperties = (addLiveEffect?.inputSchema as {
        properties?: Record<string, Record<string, unknown>>;
      }).properties;
      expect(findProperties?.searchText).toMatchObject({ type: "string", minLength: 1, maxLength: 10_000 });
      expect(findProperties?.caseSensitive).toMatchObject({ type: "boolean", default: true });
      expect(findProperties?.wholeWord).toMatchObject({ type: "boolean", default: false });
      expect(replaceProperties?.replacementText).toMatchObject({ type: "string", maxLength: 100_000 });
      expect(replaceProperties?.expectedHistoryPosition).toMatchObject({
        type: "integer",
        minimum: 0,
        maximum: 10_000_000,
      });
      expect(replaceProperties?.expectedMatchCount).toMatchObject({ type: "integer", minimum: 1, maximum: 5_000 });
      expect(replaceProperties?.expectedMatchFingerprint).toMatchObject({
        type: "string",
        pattern: "^v1-[0-9a-f]{16}$",
      });
      expect(batchProperties?.mode).toMatchObject({ type: "string", enum: ["dry_run", "apply"] });
      expect(batchProperties?.documents).toMatchObject({
        type: "array",
        minItems: 1,
        maxItems: 20,
      });
      expect(batchProperties?.searchText).toMatchObject({ type: "string", minLength: 1, maxLength: 10_000 });
      expect(batchProperties?.replacementText).toMatchObject({ type: "string", maxLength: 100_000 });
      expect(batchProperties?.expectedTotalMatchCount).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: 5_000,
      });
      expect(liveEffectProperties?.effect).toMatchObject({
        type: "string",
        enum: ["exposure", "gaussian_blur", "invert"],
      });

      const result = await client.callTool({
        name: "affinity_plan_document",
        arguments: { width: 1920, height: 1080, outputPath: path.join(output, "video.af") },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        operation: "create_document",
        normalized: { workspace: "photo", width: 1920, height: 1080, unit: "px", dpi: 300 },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects invalid colours, empty/oversized batches, and bounded editing values before execution", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "affinity-mcp-protocol-"));
    cleanups.push(base);
    const output = path.join(base, "output");
    const staging = path.join(base, "staging");
    await Promise.all([mkdir(output), mkdir(staging)]);

    const native = new FakeNativeBridge();
    const service = await AffinityService.create(testConfig(output, staging), native);
    const server = createMcpServer(service);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const invalidCalls = [
        {
          name: "affinity_add_shape",
          arguments: {
            documentSessionUuid: "session",
            shape: "rectangle",
            x: 0,
            y: 0,
            width: 100,
            height: 100,
            fill: "red",
          },
        },
        {
          name: "affinity_set_fill",
          arguments: { documentSessionUuid: "session", color: "#12345" },
        },
        {
          name: "affinity_add_shape",
          arguments: {
            documentSessionUuid: "session",
            shape: "rectangle",
            x: 0,
            y: 0,
            width: 200_001,
            height: 100,
            fill: "#000000",
          },
        },
        {
          name: "affinity_transform_selection",
          arguments: { documentSessionUuid: "session", scaleX: 0.0001, rotationDegrees: 36_001 },
        },
        {
          name: "affinity_add_text",
          arguments: { documentSessionUuid: "session", text: "x".repeat(100_001), x: 0, y: 0 },
        },
        {
          name: "affinity_find_text",
          arguments: { documentSessionUuid: "session", searchText: "" },
        },
        {
          name: "affinity_find_text",
          arguments: { documentSessionUuid: "session", searchText: "x".repeat(10_001) },
        },
        {
          name: "affinity_find_text",
          arguments: { documentSessionUuid: "session", searchText: "first\nsecond" },
        },
        {
          name: "affinity_find_text",
          arguments: { documentSessionUuid: "session", searchText: "XYZ", regex: true },
        },
        {
          name: "affinity_replace_text",
          arguments: {
            documentSessionUuid: "session",
            searchText: "XYZ",
            replacementText: "ABC",
            expectedHistoryPosition: -1,
            expectedMatchCount: 1,
            expectedMatchFingerprint: "v1-0123456789abcdef",
          },
        },
        {
          name: "affinity_replace_text",
          arguments: {
            documentSessionUuid: "session",
            searchText: "XYZ",
            replacementText: "ABC",
            expectedHistoryPosition: 0,
            expectedMatchCount: 0,
            expectedMatchFingerprint: "v1-0123456789abcdef",
          },
        },
        {
          name: "affinity_replace_text",
          arguments: {
            documentSessionUuid: "session",
            searchText: "XYZ",
            replacementText: "ABC",
            expectedHistoryPosition: 0,
            expectedMatchCount: 1,
            expectedMatchFingerprint: "not-a-fingerprint",
          },
        },
        {
          name: "affinity_batch_replace_text",
          arguments: {
            mode: "dry_run",
            documents: [],
            searchText: "XYZ",
          },
        },
        {
          name: "affinity_add_live_effect",
          arguments: {
            documentSessionUuid: "session",
            effect: "exposure",
            amount: 21,
          },
        },
        {
          name: "affinity_add_live_effect",
          arguments: {
            documentSessionUuid: "session",
            effect: "invert",
            amount: 1,
          },
        },
        {
          name: "affinity_batch_replace_text",
          arguments: {
            mode: "dry_run",
            documents: Array.from({ length: 21 }, (_, index) => ({
              documentSessionUuid: `session-${index}`,
            })),
            searchText: "XYZ",
          },
        },
        {
          name: "affinity_batch_replace_text",
          arguments: {
            mode: "apply",
            documents: [{
              documentSessionUuid: "session",
              expectedHistoryPosition: 0,
              expectedMatchCount: 1,
              expectedMatchFingerprint: "v1-0123456789abcdef",
            }],
            expectedTotalMatchCount: 0,
            searchText: "XYZ",
            replacementText: "ABC",
          },
        },
        {
          name: "affinity_batch_replace_text",
          arguments: {
            mode: "dry_run",
            documents: [
              { documentSessionUuid: "duplicate-session" },
              { documentSessionUuid: "duplicate-session" },
            ],
            searchText: "XYZ",
          },
        },
        {
          name: "affinity_undo",
          arguments: { documentSessionUuid: "session" },
        },
        {
          name: "affinity_batch_export",
          arguments: { jobs: [] },
        },
        {
          name: "affinity_batch_export",
          arguments: {
            jobs: Array.from({ length: 21 }, (_, index) => ({
              documentSessionUuid: "session",
              outputPath: path.join(output, `export-${index}.png`),
              preset: "png",
              area: "whole_document",
            })),
          },
        },
      ];

      for (const request of invalidCalls) {
        const result = await client.callTool(request);
        expect(result.isError, request.name).toBe(true);
        expect(JSON.stringify(result.content), request.name).toMatch(
          /invalid|validation|too (?:big|small)|expected|unrecognized|duplicate/i,
        );
      }
      expect(native.scripts).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
