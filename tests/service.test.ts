import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import { McpFailure } from "../src/errors.js";
import { AffinityService } from "../src/service.js";
import { ERROR_MARKER, RESULT_MARKER } from "../src/scripts.js";
import { FakeNativeBridge, testConfig } from "./helpers.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function setup(native = new FakeNativeBridge()) {
  const base = await mkdtemp(path.join(os.tmpdir(), "affinity-mcp-service-"));
  cleanups.push(base);
  const output = path.join(base, "output");
  const staging = path.join(base, "staging");
  await Promise.all([mkdir(output), mkdir(staging)]);
  const service = await AffinityService.create(testConfig(output, staging), native);
  return { base, output, staging, native, service };
}

class EmbeddedMarkerBridge extends FakeNativeBridge {
  override async executeScript(script: string): Promise<CallToolResult> {
    this.scripts.push(script);
    return {
      content: [{
        type: "text",
        text: `${RESULT_MARKER}${JSON.stringify({ documents: [{ title: `Name with ${RESULT_MARKER} inside` }] })}`,
      }],
    };
  }
}

class MultipleExportBridge extends FakeNativeBridge {
  override async executeScript(script: string): Promise<CallToolResult> {
    this.scripts.push(script);
    const match = script.match(/doc\.export\(("(?:\\.|[^"\\])*")\s*,\s*options/);
    if (match?.[1] === undefined) throw new Error("The export script did not contain a parseable staging path.");
    const stagingPath = JSON.parse(match[1]) as string;
    const extraPath = stagingPath.replace(/(\.[^.]+)$/, "-extra$1");
    await Promise.all([writeFile(stagingPath, "first"), writeFile(extraPath, "second")]);
    return {
      content: [{
        type: "text",
        text: `${RESULT_MARKER}${JSON.stringify({
          exported: true,
          preset: "PNG",
          area: "whole_document",
          records: [stagingPath, extraPath].map((recordPath) => ({
            path: recordPath,
            success: true,
            hasWarnings: false,
            warning: null,
            error: null,
          })),
        })}`,
      }],
    };
  }
}

class QueuedTextBridge extends FakeNativeBridge {
  readonly replies: Array<Record<string, unknown> | { affinityError: string } | Error> = [];

  queue(...replies: Array<Record<string, unknown> | { affinityError: string } | Error>): this {
    this.replies.push(...replies);
    return this;
  }

  override async executeScript(script: string): Promise<CallToolResult> {
    this.scripts.push(script);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error("Unexpected native text script.");
    if (reply instanceof Error) throw reply;
    const text = "affinityError" in reply
      ? `${ERROR_MARKER}${JSON.stringify({ message: reply.affinityError })}`
      : `${RESULT_MARKER}${JSON.stringify(reply)}`;
    return { content: [{ type: "text", text }] };
  }
}

function findTextResult(
  documentSessionUuid: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    documentSessionUuid,
    title: `${documentSessionUuid}.af`,
    path: `/allowed/${documentSessionUuid}.af`,
    historyPosition: 4,
    needsSaving: false,
    matchCount: 1,
    replaceableMatchCount: 1,
    blockedMatchCount: 0,
    matchedLayerCount: 1,
    matchFingerprint: "v1-0000000000000001",
    ...overrides,
  };
}

function replaceTextResult(documentSessionUuid: string, historyPosition = 5): Record<string, unknown> {
  return {
    documentSessionUuid,
    title: `${documentSessionUuid}.af`,
    path: `/allowed/${documentSessionUuid}.af`,
    historyPosition,
    previousHistoryPosition: historyPosition - 1,
    needsSaving: true,
    replacementCount: 1,
  };
}

describe("AffinityService.createDocument", () => {
  it("creates and verifies an editable Affinity file through the native bridge", async () => {
    const { output, native, service } = await setup();
    const outputPath = path.join(output, "social-card.af");
    const canonicalOutputPath = path.join(await realpath(output), "social-card.af");
    const result = await service.createDocument({ workspace: "designer", width: 1080, height: 1080, outputPath });

    expect(result).toMatchObject({
      created: true,
      committed: true,
      outputPath: canonicalOutputPath,
      document: { workspace: "designer", width: 1080, height: 1080, unit: "px" },
      affinity: {
        savedPath: canonicalOutputPath,
        finalDocumentOpen: false,
        stagingDocumentOpen: true,
        stagingSessionUuid: "fake-session",
      },
      safety: { overwritten: false },
      nextAction: "Call affinity_open_document with outputPath before editing the final file.",
    });
    expect(result.affinity).toMatchObject({ stagingPath: expect.stringMatching(/\.affinity-mcp-[\w-]+\.af$/) });
    expect(result.warnings).toEqual([expect.stringMatching(/staging document remains open/i)]);
    expect(await readFile(outputPath, "utf8")).toContain("editable Affinity document");
    expect(native.scripts).toHaveLength(1);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses an existing target before asking Affinity to execute", async () => {
    const { output, native, service } = await setup();
    const outputPath = path.join(output, "existing.af");
    await writeFile(outputPath, "do not replace");
    await expect(service.createDocument({ width: 640, height: 480, outputPath })).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    expect(native.scripts).toHaveLength(0);
    expect(await readFile(outputPath, "utf8")).toBe("do not replace");
  });

  it("returns a setup error without creating a file when the connector is disabled", async () => {
    const { output, native, service } = await setup();
    native.launchResult = { appRunning: true, nativeConnectorReady: false, endpoint: "http://127.0.0.1:6767/sse" };
    const outputPath = path.join(output, "not-created.af");
    await expect(service.createDocument({ width: 640, height: 480, outputPath })).rejects.toMatchObject({
      code: "AFFINITY_CONNECTOR_DISABLED",
    });
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("AffinityService structured results and export cleanup", () => {
  it("does not confuse marker text inside a returned document name with result framing", async () => {
    const { service } = await setup(new EmbeddedMarkerBridge());
    await expect(service.listOpenDocuments()).resolves.toEqual({
      documents: [{ title: `Name with ${RESULT_MARKER} inside` }],
    });
  });

  it("removes every reported staging file when an export unexpectedly produces multiple files", async () => {
    const { output, staging, service } = await setup(new MultipleExportBridge());
    const outputPath = path.join(output, "multi.png");
    await expect(service.exportDocument({
      documentSessionUuid: "session",
      outputPath,
      preset: "png",
      area: "whole_document",
    })).rejects.toMatchObject({ code: "AFFINITY_EXPORT_MULTIPLE_FILES" });

    await expect(readdir(staging)).resolves.toEqual([]);
    await expect(readFile(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("AffinityService batch text replacement", () => {
  it("audits a timed-out direct replacement and confirms when no edit occurred", async () => {
    const bridge = new QueuedTextBridge().queue(
      new McpFailure("AFFINITY_CALL_TIMEOUT", "native call timed out"),
      findTextResult("one"),
    );
    const { service } = await setup(bridge);
    await expect(service.replaceText({
      documentSessionUuid: "one",
      searchText: "XYZ",
      replacementText: "ABC",
      caseSensitive: true,
      wholeWord: false,
      expectedHistoryPosition: 4,
      expectedMatchCount: 1,
      expectedMatchFingerprint: "v1-0000000000000001",
    })).rejects.toMatchObject({
      code: "TEXT_REPLACE_NOT_APPLIED",
      details: {
        audit: {
          historyPosition: 4,
          matchCount: 1,
          matchFingerprint: "v1-0000000000000001",
        },
      },
    });
    expect(bridge.scripts).toHaveLength(2);
  });

  it("rejects duplicate sessions before sending any native script", async () => {
    const bridge = new QueuedTextBridge();
    const { service } = await setup(bridge);
    await expect(service.batchReplaceText({
      mode: "dry_run",
      documents: [{ documentSessionUuid: "same" }, { documentSessionUuid: "same" }],
      searchText: "XYZ",
      caseSensitive: true,
      wholeWord: false,
    })).rejects.toMatchObject({ code: "DUPLICATE_BATCH_DOCUMENT" });
    expect(bridge.scripts).toHaveLength(0);
  });

  it("returns guarded dry-run plans without changing documents", async () => {
    const bridge = new QueuedTextBridge().queue(
      findTextResult("one", { matchCount: 2, replaceableMatchCount: 2, matchFingerprint: "v1-0000000000000002" }),
      findTextResult("two", { matchCount: 0, replaceableMatchCount: 0, matchedLayerCount: 0 }),
    );
    const { service } = await setup(bridge);
    await expect(service.batchReplaceText({
      mode: "dry_run",
      documents: [{ documentSessionUuid: "one" }, { documentSessionUuid: "two" }],
      searchText: "XYZ",
      caseSensitive: true,
      wholeWord: false,
    })).resolves.toMatchObject({
      mode: "dry_run",
      ready: false,
      totalMatchCount: 2,
      documents: [
        { documentSessionUuid: "one", status: "ready", expectedMatchCount: 2 },
        { documentSessionUuid: "two", status: "no_matches", expectedMatchCount: 0 },
      ],
    });
    expect(bridge.scripts).toHaveLength(2);
    expect(bridge.scripts.every((script) => !script.includes("DocumentCommand.createSetText"))).toBe(true);
  });

  it("preflights every document and changes none when a guard is stale", async () => {
    const bridge = new QueuedTextBridge().queue(
      findTextResult("one"),
      findTextResult("two", { historyPosition: 9 }),
    );
    const { service } = await setup(bridge);
    await expect(service.batchReplaceText({
      mode: "apply",
      documents: [
        {
          documentSessionUuid: "one",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
        {
          documentSessionUuid: "two",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
      ],
      expectedTotalMatchCount: 2,
      searchText: "XYZ",
      replacementText: "ABC",
      caseSensitive: true,
      wholeWord: false,
    })).rejects.toMatchObject({ code: "BATCH_TEXT_PREFLIGHT_FAILED" });
    expect(bridge.scripts).toHaveLength(2);
    expect(bridge.scripts.every((script) => !script.includes("DocumentCommand.createSetText"))).toBe(true);
  });

  it("guarded-undoes an earlier document when a later replacement fails", async () => {
    const bridge = new QueuedTextBridge().queue(
      findTextResult("one"),
      findTextResult("two"),
      replaceTextResult("one"),
      { affinityError: "second replacement failed" },
      findTextResult("two"),
      {
        undone: true,
        sessionUuid: "one",
        previousHistoryPosition: 5,
        historyPosition: 4,
        needsSaving: true,
      },
      findTextResult("one", { needsSaving: true }),
    );
    const { service } = await setup(bridge);
    await expect(service.batchReplaceText({
      mode: "apply",
      documents: [
        {
          documentSessionUuid: "one",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
        {
          documentSessionUuid: "two",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
      ],
      expectedTotalMatchCount: 2,
      searchText: "XYZ",
      replacementText: "ABC",
      caseSensitive: true,
      wholeWord: false,
    })).rejects.toMatchObject({
      code: "BATCH_TEXT_REPLACE_ROLLED_BACK",
      details: {
        rollbackResults: [{
          documentSessionUuid: "one",
          restoredContent: true,
          exactOriginalStateVerified: true,
          needsSaving: true,
        }],
      },
    });
    expect(bridge.scripts).toHaveLength(7);
    expect(bridge.scripts[5]).toContain("doc.undo(false)");
    expect(bridge.scripts[5]).toContain("const expectedHistoryPosition = 5");
  });

  it("reports incomplete rollback when the failing document is no longer at its original fingerprint", async () => {
    const bridge = new QueuedTextBridge().queue(
      findTextResult("one"),
      findTextResult("two"),
      replaceTextResult("one"),
      { affinityError: "response failed after an uncertain native state" },
      findTextResult("two", {
        historyPosition: 5,
        matchCount: 0,
        replaceableMatchCount: 0,
        matchFingerprint: "v1-9999999999999999",
      }),
      {
        undone: true,
        sessionUuid: "one",
        previousHistoryPosition: 5,
        historyPosition: 4,
        needsSaving: true,
      },
      findTextResult("one", { needsSaving: true }),
    );
    const { service } = await setup(bridge);
    await expect(service.batchReplaceText({
      mode: "apply",
      documents: [
        {
          documentSessionUuid: "one",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
        {
          documentSessionUuid: "two",
          expectedHistoryPosition: 4,
          expectedMatchCount: 1,
          expectedMatchFingerprint: "v1-0000000000000001",
        },
      ],
      expectedTotalMatchCount: 2,
      searchText: "XYZ",
      replacementText: "ABC",
      caseSensitive: true,
      wholeWord: false,
    })).rejects.toMatchObject({
      code: "BATCH_TEXT_ROLLBACK_INCOMPLETE",
      details: {
        currentDocumentAudit: {
          documentSessionUuid: "two",
          exactOriginalStateVerified: false,
        },
        rollbackResults: [{
          documentSessionUuid: "one",
          exactOriginalStateVerified: true,
        }],
      },
    });
  });
});
