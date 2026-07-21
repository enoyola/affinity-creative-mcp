import { execFile } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, copyFile, lstat, realpath, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AffinityMcpConfig } from "./config.js";
import { McpFailure } from "./errors.js";
import {
  buildAddLayerScript,
  buildAddLiveEffectScript,
  buildAddShapeScript,
  buildAddTextScript,
  buildExportDocumentScript,
  buildFindTextScript,
  buildInspectDocumentScript,
  buildListExportPresetsScript,
  buildListLayersScript,
  buildPlaceImageScript,
  buildReplaceTextScript,
  buildSaveDocumentScript,
  buildSelectLayerScript,
  buildSetFillScript,
  buildTransformSelectionScript,
  buildUndoScript,
  type AddLayerRequest,
  type AddLiveEffectRequest,
  type AddShapeRequest,
  type AddTextRequest,
  type ExportArea,
  type PlaceImageRequest,
  type TextReplaceRequest,
  type TextSearchRequest,
  type TransformSelectionRequest,
} from "./editing-scripts.js";
import { isEndpointReady, type NativeBridgeLike } from "./native-bridge.js";
import { PathPolicy } from "./path-policy.js";
import {
  buildCreateDocumentScript,
  buildListOpenDocumentsScript,
  ERROR_MARKER,
  normalizeDocumentRequest,
  RESULT_MARKER,
  type DocumentRequest,
  type NormalizedDocumentRequest,
} from "./scripts.js";

const execFileAsync = promisify(execFile);

const AFFINITY_DOCUMENT_EXTENSIONS = [".af", ".afdesign", ".afphoto", ".afpub"] as const;
const OPENABLE_EXTENSIONS = [
  ...AFFINITY_DOCUMENT_EXTENSIONS,
  ".png",
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".webp",
  ".gif",
  ".svg",
  ".pdf",
  ".eps",
] as const;
const PLACEABLE_IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp"] as const;
const MAX_PLACEABLE_IMAGE_BYTES = 512 * 1024 * 1024;
const MAX_BATCH_EXPORTS = 20;
const MAX_BATCH_TEXT_DOCUMENTS = 20;
const MAX_BATCH_TEXT_MATCHES = 5_000;
const MAX_BATCH_TEXT_INSERTED_CODE_UNITS = 5_000_000;

export const EXPORT_PRESETS = {
  png: { affinityName: "PNG", extensions: [".png"] },
  jpeg_best: { affinityName: "JPEG (Best quality)", extensions: [".jpg", ".jpeg"] },
  jpeg_high: { affinityName: "JPEG (High quality)", extensions: [".jpg", ".jpeg"] },
  jpeg_medium: { affinityName: "JPEG (Medium quality)", extensions: [".jpg", ".jpeg"] },
  jpeg_low: { affinityName: "JPEG (Low quality)", extensions: [".jpg", ".jpeg"] },
  gif_rgb: { affinityName: "GIF RGB", extensions: [".gif"] },
  tiff_rgb8: { affinityName: "TIFF RGB 8-bit", extensions: [".tif", ".tiff"] },
  tiff_rgb16: { affinityName: "TIFF RGB 16-bit", extensions: [".tif", ".tiff"] },
  tiff_cmyk: { affinityName: "TIFF CMYK", extensions: [".tif", ".tiff"] },
  svg_export: { affinityName: "SVG (for export)", extensions: [".svg"] },
  svg_small: { affinityName: "SVG (digital - small size)", extensions: [".svg"] },
  svg_high: { affinityName: "SVG (digital - high quality)", extensions: [".svg"] },
  svg_flatten: { affinityName: "SVG (flatten)", extensions: [".svg"] },
  pdf_export: { affinityName: "PDF (for export)", extensions: [".pdf"] },
  pdf_print: { affinityName: "PDF (for print)", extensions: [".pdf"] },
  pdf_press: { affinityName: "PDF (press ready)", extensions: [".pdf"] },
  pdf_small: { affinityName: "PDF (digital - small size)", extensions: [".pdf"] },
  pdf_high: { affinityName: "PDF (digital - high quality)", extensions: [".pdf"] },
  pdf_flatten: { affinityName: "PDF (flatten)", extensions: [".pdf"] },
  eps_export: { affinityName: "EPS (for export)", extensions: [".eps"] },
  psd_editable: { affinityName: "PSD (preserve editability)", extensions: [".psd"] },
  webp_best: { affinityName: "WebP (Best Quality)", extensions: [".webp"] },
  webp_high: { affinityName: "WebP (High Quality)", extensions: [".webp"] },
  webp_medium: { affinityName: "WebP (Medium Quality)", extensions: [".webp"] },
  webp_low: { affinityName: "WebP (Low Quality)", extensions: [".webp"] },
  webp_lossless: { affinityName: "WebP (Lossless, default)", extensions: [".webp"] },
} as const;

export type ExportPresetId = keyof typeof EXPORT_PRESETS;
export const EXPORT_PRESET_IDS = Object.keys(EXPORT_PRESETS) as [ExportPresetId, ...ExportPresetId[]];

export interface OpenDocumentRequest {
  inputPath: string;
  reuseIfOpen?: boolean;
}

export interface PlaceImageInput extends Omit<PlaceImageRequest, "stagedImagePath"> {
  inputPath: string;
}

export interface ExportDocumentRequest {
  documentSessionUuid: string;
  outputPath: string;
  preset: ExportPresetId;
  area: ExportArea;
}

export interface BatchTextDryRunRequest extends Omit<TextSearchRequest, "documentSessionUuid"> {
  mode: "dry_run";
  documents: Array<{ documentSessionUuid: string }>;
}

export interface BatchTextApplyRequest extends Omit<TextSearchRequest, "documentSessionUuid"> {
  mode: "apply";
  replacementText: string;
  expectedTotalMatchCount: number;
  documents: Array<{
    documentSessionUuid: string;
    expectedHistoryPosition: number;
    expectedMatchCount: number;
    expectedMatchFingerprint: string;
  }>;
}

export type BatchTextReplaceRequest = BatchTextDryRunRequest | BatchTextApplyRequest;

interface OpenDocumentSummary {
  title?: string;
  path?: string;
  sessionUuid?: string;
  [key: string]: unknown;
}

interface OpenDocumentsResult {
  documents: OpenDocumentSummary[];
}

interface InspectDocumentResult {
  title: string;
  path: string;
  sessionUuid: string;
  isReadOnly: boolean;
  mustSaveAs: boolean;
  needsSaving: boolean;
  [key: string]: unknown;
}

interface FindTextResult {
  documentSessionUuid: string;
  title: string;
  path: string;
  historyPosition: number;
  needsSaving: boolean;
  matchCount: number;
  replaceableMatchCount: number;
  blockedMatchCount: number;
  matchedLayerCount: number;
  matchFingerprint: string;
  [key: string]: unknown;
}

interface ReplaceTextResult {
  documentSessionUuid: string;
  title: string;
  path: string;
  historyPosition: number;
  previousHistoryPosition: number;
  needsSaving: boolean;
  replacementCount: number;
  [key: string]: unknown;
}

interface ExportScriptResult {
  exported: boolean;
  preset: string;
  area: ExportArea;
  records: Array<{
    path: string;
    success: boolean;
    hasWarnings: boolean;
    warning: string | null;
    error: string | null;
  }>;
}

interface StagedExport {
  request: ExportDocumentRequest;
  outputPath: string;
  stagingPath: string;
  bytes: number;
  sha256: string;
  affinity: ExportScriptResult;
}

interface CommittedFileIdentity {
  outputPath: string;
  device: number;
  inode: number;
}

function extractText(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function parseMarker<T>(text: string, marker: string): T | undefined {
  const line = text.split(/\r?\n/).reverse().find((candidate) => candidate.startsWith(marker));
  if (line === undefined) return undefined;
  const payload = line.slice(marker.length).trim();
  if (!payload) return undefined;
  try {
    return JSON.parse(payload) as T;
  } catch (error) {
    throw new McpFailure("AFFINITY_OUTPUT_PARSE_FAILED", "Affinity returned a result marker with invalid JSON.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function appVersion(config: AffinityMcpConfig): Promise<string | null> {
  try {
    const plist = path.join(config.appPath, "Contents", "Info.plist");
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function isAppRunning(config: AffinityMcpConfig): Promise<boolean> {
  try {
    const plist = path.join(config.appPath, "Contents", "Info.plist");
    const { stdout: executableNameOutput } = await execFileAsync("/usr/bin/plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      plist,
    ]);
    const executableName = executableNameOutput.trim();
    if (!executableName || path.basename(executableName) !== executableName) return false;
    const executable = path.join(config.appPath, "Contents", "MacOS", executableName);
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "command="]);
    return stdout.split(/\r?\n/).some((command) => {
      const trimmed = command.trim();
      return trimmed === executable || trimmed.startsWith(`${executable} `);
    });
  } catch {
    return false;
  }
}

export interface DocumentPlan {
  operation: "create_document";
  normalized: NormalizedDocumentRequest;
  safety: {
    overwrite: false;
    outputAllowed: true;
    nativeScriptExposed: false;
  };
}

export class AffinityService {
  private constructor(
    private readonly config: AffinityMcpConfig,
    private readonly native: NativeBridgeLike,
    private readonly paths: PathPolicy,
    private readonly stagingDirectory: string,
  ) {}

  static async create(config: AffinityMcpConfig, native: NativeBridgeLike): Promise<AffinityService> {
    let stagingDirectory: string;
    try {
      stagingDirectory = await realpath(config.stagingDirectory);
      const info = await lstat(stagingDirectory);
      if (!info.isDirectory()) throw new Error("not a directory");
      await access(stagingDirectory, fsConstants.R_OK | fsConstants.W_OK);
    } catch (error) {
      throw new McpFailure("INVALID_STAGING_DIRECTORY", "The Affinity staging directory must already exist and be writable.", {
        stagingDirectory: config.stagingDirectory,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return new AffinityService(config, native, await PathPolicy.create(config.allowedRoots), stagingDirectory);
  }

  private async ensureConnector(): Promise<void> {
    const launch = await this.native.launch();
    if (!launch.nativeConnectorReady) {
      throw new McpFailure(
        "AFFINITY_CONNECTOR_DISABLED",
        "Affinity opened, but its native MCP connector is disabled. Enable it and Desktop file access in Settings > Model Context Protocol.",
        { endpoint: launch.endpoint },
      );
    }
  }

  private async executeStructured<T extends object>(script: string): Promise<T> {
    const result = await this.native.executeScript(script);
    const output = extractText(result);
    const affinityError = parseMarker<{ message?: string; stack?: string }>(output, ERROR_MARKER);
    if (affinityError !== undefined) {
      throw new McpFailure("AFFINITY_SCRIPT_FAILED", affinityError.message ?? "Affinity could not complete the requested operation.", {
        ...(affinityError.stack === undefined ? {} : { stack: affinityError.stack }),
      });
    }
    const parsed = parseMarker<T>(output, RESULT_MARKER);
    if (parsed === undefined) {
      throw new McpFailure("AFFINITY_RESULT_MISSING", "Affinity did not return the expected structured result.", { output });
    }
    return parsed;
  }

  async status(): Promise<Record<string, unknown>> {
    const installed = await access(this.config.appPath, fsConstants.R_OK).then(() => true).catch(() => false);
    const connectorReady = await isEndpointReady(this.config.endpoint);
    return {
      installed,
      version: installed ? await appVersion(this.config) : null,
      appPath: this.config.appPath,
      appRunning: await isAppRunning(this.config),
      nativeConnectorReady: connectorReady,
      endpoint: this.config.endpoint.href,
      allowedRoots: this.paths.roots,
      stagingDirectory: this.stagingDirectory,
      requiredAffinitySettings: {
        enableAffinityMcp: true,
        accessFilesOnDesktop: true,
      },
      safety: {
        refusesOverwrite: true,
        rawExecuteScriptExposed: false,
        loopbackEndpointOnly: true,
      },
    };
  }

  async launch(): Promise<Record<string, unknown>> {
    const result = await this.native.launch();
    return {
      ...result,
      nextAction: result.nativeConnectorReady
        ? "Affinity is ready for automation."
        : "In Affinity, open Settings > Model Context Protocol and enable 'Enable Affinity MCP' and 'Access files on your Desktop'.",
    };
  }

  async planDocument(input: DocumentRequest): Promise<DocumentPlan> {
    const normalized = normalizeDocumentRequest(input);
    normalized.outputPath = await this.paths.resolveNewAffinityFile(normalized.outputPath);
    return {
      operation: "create_document",
      normalized,
      safety: { overwrite: false, outputAllowed: true, nativeScriptExposed: false },
    };
  }

  async createDocument(input: DocumentRequest): Promise<Record<string, unknown>> {
    const plan = await this.planDocument(input);
    const stagingPath = path.join(this.stagingDirectory, `.affinity-mcp-${randomUUID()}.af`);

    try {
      const launch = await this.native.launch();
      if (!launch.nativeConnectorReady) {
        throw new McpFailure(
          "AFFINITY_CONNECTOR_DISABLED",
          "Affinity opened, but its native MCP connector is disabled. Enable it and Desktop file access in Settings > Model Context Protocol.",
          { endpoint: this.config.endpoint.href },
        );
      }

      const script = buildCreateDocumentScript(plan.normalized, stagingPath);
      const result = await this.native.executeScript(script);
      const output = extractText(result);
      const affinityError = parseMarker<{ message?: string; stack?: string }>(output, ERROR_MARKER);
      if (affinityError !== undefined) {
        throw new McpFailure("AFFINITY_SCRIPT_FAILED", affinityError.message ?? "Affinity failed to create the document.");
      }
      const affinityResult = parseMarker<Record<string, unknown>>(output, RESULT_MARKER);
      if (affinityResult === undefined) {
        throw new McpFailure("AFFINITY_RESULT_MISSING", "Affinity did not return the expected document creation result.", { output });
      }
      const stagedInfo = await lstat(stagingPath).catch(() => undefined);
      if (stagedInfo === undefined || !stagedInfo.isFile()) {
        throw new McpFailure("STAGED_FILE_MISSING", "Affinity reported success but did not create the staged document.");
      }

      const stagedSha256 = await sha256(stagingPath);
      await this.commitVerifiedCopy(
        stagingPath,
        plan.normalized.outputPath,
        stagedSha256,
        "DOCUMENT_HASH_MISMATCH",
        "The committed Affinity document did not match its staged source.",
      );
      const { path: affinitySavedPath, sessionUuid: affinitySessionUuid, ...affinityReadback } = affinityResult;

      return {
        created: true,
        committed: true,
        outputPath: plan.normalized.outputPath,
        bytes: stagedInfo.size,
        sha256: stagedSha256,
        document: {
          workspace: plan.normalized.workspace,
          width: plan.normalized.width,
          height: plan.normalized.height,
          unit: plan.normalized.unit,
          dpi: plan.normalized.dpi,
          transparent: plan.normalized.transparent,
          rasterFormat: plan.normalized.rasterFormat,
          pages: plan.normalized.pages,
          facingPages: plan.normalized.facingPages,
        },
        affinity: {
          ...affinityReadback,
          savedPath: plan.normalized.outputPath,
          finalDocumentOpen: false,
          stagingDocumentOpen: true,
          stagingPath: affinitySavedPath ?? stagingPath,
          stagingSessionUuid: affinitySessionUuid,
        },
        safety: { overwritten: false },
        warnings: [
          "Affinity 3.2 cannot close documents through its SDK. A hidden Desktop staging document remains open; open the final output with affinity_open_document before editing it, then close the staging document manually when convenient.",
        ],
        nextAction: "Call affinity_open_document with outputPath before editing the final file.",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new McpFailure("OUTPUT_EXISTS", "Refusing to overwrite an existing file.", { outputPath: plan.normalized.outputPath });
      }
      throw error;
    }
  }

  async listOpenDocuments(): Promise<OpenDocumentsResult> {
    return this.executeStructured<OpenDocumentsResult>(buildListOpenDocumentsScript());
  }

  async openDocument(input: OpenDocumentRequest): Promise<Record<string, unknown>> {
    const inputPath = await this.paths.resolveExistingFile(input.inputPath, OPENABLE_EXTENSIONS);
    await this.ensureConnector();

    const matchingDocuments = async (documents: OpenDocumentSummary[]): Promise<OpenDocumentSummary[]> => {
      const matches: OpenDocumentSummary[] = [];
      for (const document of documents) {
        if (typeof document.path !== "string" || !document.path) continue;
        const canonicalDocumentPath = await realpath(document.path).catch(() => path.resolve(document.path as string));
        if (canonicalDocumentPath === inputPath) matches.push(document);
      }
      return matches;
    };

    const beforeOpen = await this.listOpenDocuments();
    const existing = await matchingDocuments(beforeOpen.documents);
    if (input.reuseIfOpen !== false) {
      const reusable = existing[0];
      if (reusable !== undefined) return { opened: true, reused: true, inputPath, document: reusable };
    }
    if (existing.length > 0) {
      throw new McpFailure(
        "DOCUMENT_ALREADY_OPEN",
        "The file is already open. Affinity may reuse its existing window, so requesting a duplicate session is refused.",
        { inputPath, sessions: existing.map((document) => document.sessionUuid).filter(Boolean) },
      );
    }
    const existingSessionUuids = new Set(
      existing.flatMap((document) => typeof document.sessionUuid === "string" ? [document.sessionUuid] : []),
    );

    try {
      await execFileAsync("/usr/bin/open", ["-b", this.config.bundleId, inputPath]);
    } catch (error) {
      throw new McpFailure("AFFINITY_OPEN_FAILED", "macOS could not ask Affinity to open the file.", {
        inputPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const deadline = Date.now() + Math.max(5_000, this.config.connectorWaitMs);
    do {
      const current = await this.listOpenDocuments();
      const matches = await matchingDocuments(current.documents);
      const document = matches.find((candidate) =>
        typeof candidate.sessionUuid !== "string" || !existingSessionUuids.has(candidate.sessionUuid),
      );
      if (document !== undefined) return { opened: true, reused: false, inputPath, document };
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);

    throw new McpFailure("AFFINITY_OPEN_TIMEOUT", "Affinity accepted the open request, but the document did not appear before the timeout.", {
      inputPath,
    });
  }

  async inspectDocument(documentSessionUuid: string): Promise<InspectDocumentResult> {
    await this.ensureConnector();
    return this.executeStructured<InspectDocumentResult>(buildInspectDocumentScript(documentSessionUuid));
  }

  async saveDocument(documentSessionUuid: string): Promise<Record<string, unknown>> {
    const inspected = await this.inspectDocument(documentSessionUuid);
    if (!inspected.path) {
      throw new McpFailure("DOCUMENT_HAS_NO_PATH", "This document has no existing file path and cannot be saved in place.");
    }
    if (inspected.mustSaveAs) {
      throw new McpFailure("DOCUMENT_REQUIRES_SAVE_AS", "This document requires Save As; in-place save is not available.");
    }
    if (inspected.isReadOnly) throw new McpFailure("DOCUMENT_READ_ONLY", "This document is read-only.");
    const canonicalPath = await this.paths.resolveExistingWritableFile(inspected.path, AFFINITY_DOCUMENT_EXTENSIONS);
    const saved = await this.executeStructured<Record<string, unknown>>(
      buildSaveDocumentScript(documentSessionUuid, inspected.path),
    );
    return { ...saved, canonicalPath };
  }

  async listLayers(documentSessionUuid: string): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildListLayersScript(documentSessionUuid));
  }

  async selectLayer(documentSessionUuid: string, name: string, occurrence: number): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(
      buildSelectLayerScript(documentSessionUuid, name, occurrence),
    );
  }

  async addLayer(request: AddLayerRequest): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildAddLayerScript(request));
  }

  async addShape(request: AddShapeRequest): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildAddShapeScript(request));
  }

  async addText(request: AddTextRequest): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildAddTextScript(request));
  }

  private async executeFindText(request: TextSearchRequest): Promise<FindTextResult> {
    return this.executeStructured<FindTextResult>(buildFindTextScript(request));
  }

  private async executeReplaceText(request: TextReplaceRequest): Promise<ReplaceTextResult> {
    return this.executeStructured<ReplaceTextResult>(buildReplaceTextScript(request));
  }

  async findText(request: TextSearchRequest): Promise<FindTextResult> {
    await this.ensureConnector();
    return this.executeFindText(request);
  }

  async replaceText(request: TextReplaceRequest): Promise<ReplaceTextResult> {
    await this.ensureConnector();
    try {
      return await this.executeReplaceText(request);
    } catch (error) {
      const transportStateUncertain =
        error instanceof McpFailure &&
        (error.code === "AFFINITY_CALL_TIMEOUT" || error.code === "AFFINITY_CONNECTION_LOST");
      if (!transportStateUncertain) throw error;

      try {
        const audit = await this.executeFindText({
          documentSessionUuid: request.documentSessionUuid,
          searchText: request.searchText,
          caseSensitive: request.caseSensitive,
          wholeWord: request.wholeWord,
          ...(request.layerNames === undefined ? {} : { layerNames: request.layerNames }),
        });
        const originalStateVerified =
          audit.historyPosition === request.expectedHistoryPosition &&
          audit.matchCount === request.expectedMatchCount &&
          audit.matchFingerprint === request.expectedMatchFingerprint;
        if (originalStateVerified) {
          throw new McpFailure(
            "TEXT_REPLACE_NOT_APPLIED",
            "The native response was lost, but the original history and text fingerprint were verified unchanged. It is safe to retry from a fresh find.",
            {
              originalError: { code: error.code, message: error.message, details: error.details },
              audit: {
                historyPosition: audit.historyPosition,
                matchCount: audit.matchCount,
                matchFingerprint: audit.matchFingerprint,
                needsSaving: audit.needsSaving,
              },
            },
          );
        }
        throw new McpFailure(
          "TEXT_REPLACE_STATE_UNCERTAIN",
          "The native response was lost and the document no longer matches the original text plan. Inspect it before any retry or undo.",
          {
            originalError: { code: error.code, message: error.message, details: error.details },
            expected: {
              historyPosition: request.expectedHistoryPosition,
              matchCount: request.expectedMatchCount,
              matchFingerprint: request.expectedMatchFingerprint,
            },
            actual: {
              historyPosition: audit.historyPosition,
              matchCount: audit.matchCount,
              matchFingerprint: audit.matchFingerprint,
              needsSaving: audit.needsSaving,
            },
          },
        );
      } catch (auditError) {
        if (auditError instanceof McpFailure && (
          auditError.code === "TEXT_REPLACE_NOT_APPLIED" ||
          auditError.code === "TEXT_REPLACE_STATE_UNCERTAIN"
        )) {
          throw auditError;
        }
        throw new McpFailure(
          "TEXT_REPLACE_STATE_UNCERTAIN",
          "The native response was lost and the MCP could not audit the document afterward. Inspect it before any retry or undo.",
          {
            originalError: { code: error.code, message: error.message, details: error.details },
            auditError: auditError instanceof McpFailure
              ? { code: auditError.code, message: auditError.message, details: auditError.details }
              : { code: "INTERNAL_ERROR", message: auditError instanceof Error ? auditError.message : String(auditError) },
          },
        );
      }
    }
  }

  async batchReplaceText(request: BatchTextReplaceRequest): Promise<Record<string, unknown>> {
    if (request.documents.length < 1 || request.documents.length > MAX_BATCH_TEXT_DOCUMENTS) {
      throw new McpFailure(
        "INVALID_BATCH_SIZE",
        `Batch text replacement requires between 1 and ${MAX_BATCH_TEXT_DOCUMENTS} open documents.`,
      );
    }
    const sessionIds = request.documents.map((document) => document.documentSessionUuid);
    if (new Set(sessionIds).size !== sessionIds.length) {
      throw new McpFailure("DUPLICATE_BATCH_DOCUMENT", "Every batch text document must use a different session UUID.");
    }

    const { mode: _mode, documents: _documents, ...search } = request;
    if (request.mode === "apply") {
      const expectedSum = request.documents.reduce((sum, document) => sum + document.expectedMatchCount, 0);
      if (expectedSum !== request.expectedTotalMatchCount) {
        throw new McpFailure(
          "BATCH_TEXT_TOTAL_MISMATCH",
          "expectedTotalMatchCount must equal the sum of every document's expectedMatchCount.",
          { expectedTotalMatchCount: request.expectedTotalMatchCount, documentMatchCountSum: expectedSum },
        );
      }
      if (expectedSum > MAX_BATCH_TEXT_MATCHES) {
        throw new McpFailure(
          "BATCH_TEXT_MATCH_LIMIT_EXCEEDED",
          `Batch text replacement is limited to ${MAX_BATCH_TEXT_MATCHES} total matches.`,
          { expectedTotalMatchCount: expectedSum },
        );
      }
      const insertedCodeUnits = expectedSum * request.replacementText.length;
      if (insertedCodeUnits > MAX_BATCH_TEXT_INSERTED_CODE_UNITS) {
        throw new McpFailure(
          "BATCH_TEXT_INSERT_LIMIT_EXCEEDED",
          `Batch text replacement is limited to ${MAX_BATCH_TEXT_INSERTED_CODE_UNITS} inserted UTF-16 code units.`,
          { insertedCodeUnits },
        );
      }
    }

    await this.ensureConnector();
    if (request.mode === "dry_run") {
      const plans: Array<Record<string, unknown>> = [];
      let totalMatchCount = 0;
      for (const document of request.documents) {
        try {
          const preview = await this.executeFindText({
            documentSessionUuid: document.documentSessionUuid,
            searchText: search.searchText,
            caseSensitive: search.caseSensitive,
            wholeWord: search.wholeWord,
            ...(search.layerNames === undefined ? {} : { layerNames: search.layerNames }),
          });
          totalMatchCount += preview.matchCount;
          plans.push({
            documentSessionUuid: document.documentSessionUuid,
            title: preview.title,
            path: preview.path,
            status:
              preview.matchCount === 0
                ? "no_matches"
                : preview.blockedMatchCount > 0
                  ? "blocked"
                  : "ready",
            expectedHistoryPosition: preview.historyPosition,
            expectedMatchCount: preview.matchCount,
            expectedMatchFingerprint: preview.matchFingerprint,
            replaceableMatchCount: preview.replaceableMatchCount,
            blockedMatchCount: preview.blockedMatchCount,
            matchedLayerCount: preview.matchedLayerCount,
            needsSaving: preview.needsSaving,
          });
        } catch (error) {
          plans.push({
            documentSessionUuid: document.documentSessionUuid,
            status: "error",
            error: error instanceof McpFailure
              ? { code: error.code, message: error.message, details: error.details }
              : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      if (totalMatchCount > MAX_BATCH_TEXT_MATCHES) {
        throw new McpFailure(
          "BATCH_TEXT_MATCH_LIMIT_EXCEEDED",
          `Batch text replacement is limited to ${MAX_BATCH_TEXT_MATCHES} total matches.`,
          { totalMatchCount, plans },
        );
      }
      return {
        mode: "dry_run",
        ready: plans.every((plan) => plan.status === "ready"),
        documentCount: plans.length,
        totalMatchCount,
        search: {
          searchText: search.searchText,
          caseSensitive: search.caseSensitive,
          wholeWord: search.wholeWord,
          layerNames: search.layerNames ?? null,
        },
        documents: plans,
        nextAction:
          "Call affinity_batch_replace_text in apply mode with the returned history positions, match counts, fingerprints, and total count.",
      };
    }

    const applySearch = {
      searchText: request.searchText,
      caseSensitive: request.caseSensitive,
      wholeWord: request.wholeWord,
      ...(request.layerNames === undefined ? {} : { layerNames: request.layerNames }),
    };
    const preflightFailures: Array<Record<string, unknown>> = [];
    const preflightResults: FindTextResult[] = [];
    for (const document of request.documents) {
      try {
        const preview = await this.executeFindText({
          documentSessionUuid: document.documentSessionUuid,
          ...applySearch,
        });
        preflightResults.push(preview);
        const reasons: string[] = [];
        if (preview.historyPosition !== document.expectedHistoryPosition) reasons.push("history_position_changed");
        if (preview.matchCount !== document.expectedMatchCount) reasons.push("match_count_changed");
        if (preview.matchFingerprint !== document.expectedMatchFingerprint) reasons.push("match_fingerprint_changed");
        if (preview.blockedMatchCount > 0 || preview.replaceableMatchCount !== preview.matchCount) {
          reasons.push("matches_not_replaceable");
        }
        if (reasons.length > 0) {
          preflightFailures.push({
            documentSessionUuid: document.documentSessionUuid,
            reasons,
            expected: {
              historyPosition: document.expectedHistoryPosition,
              matchCount: document.expectedMatchCount,
              matchFingerprint: document.expectedMatchFingerprint,
            },
            actual: {
              historyPosition: preview.historyPosition,
              matchCount: preview.matchCount,
              replaceableMatchCount: preview.replaceableMatchCount,
              blockedMatchCount: preview.blockedMatchCount,
              matchFingerprint: preview.matchFingerprint,
            },
          });
        }
      } catch (error) {
        preflightFailures.push({
          documentSessionUuid: document.documentSessionUuid,
          reasons: ["preflight_error"],
          error: error instanceof McpFailure
            ? { code: error.code, message: error.message, details: error.details }
            : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) },
        });
      }
    }
    const actualTotalMatchCount = preflightResults.reduce((sum, preview) => sum + preview.matchCount, 0);
    if (actualTotalMatchCount !== request.expectedTotalMatchCount) {
      preflightFailures.push({
        reasons: ["total_match_count_changed"],
        expectedTotalMatchCount: request.expectedTotalMatchCount,
        actualTotalMatchCount,
      });
    }
    if (preflightFailures.length > 0) {
      throw new McpFailure(
        "BATCH_TEXT_PREFLIGHT_FAILED",
        "No documents were changed because one or more batch text guards failed.",
        { failures: preflightFailures },
      );
    }

    const completed: Array<{
      guard: BatchTextApplyRequest["documents"][number];
      result: ReplaceTextResult;
    }> = [];
    let currentDocument: BatchTextApplyRequest["documents"][number] | undefined;
    try {
      for (const document of request.documents) {
        currentDocument = document;
        const result = await this.executeReplaceText({
          documentSessionUuid: document.documentSessionUuid,
          ...applySearch,
          replacementText: request.replacementText,
          expectedHistoryPosition: document.expectedHistoryPosition,
          expectedMatchCount: document.expectedMatchCount,
          expectedMatchFingerprint: document.expectedMatchFingerprint,
        });
        completed.push({ guard: document, result });
        currentDocument = undefined;
      }
    } catch (error) {
      let currentDocumentAudit: Record<string, unknown> | undefined;
      let currentDocumentRestored = currentDocument === undefined;
      if (currentDocument !== undefined) {
        try {
          const audit = await this.executeFindText({
            documentSessionUuid: currentDocument.documentSessionUuid,
            ...applySearch,
          });
          currentDocumentRestored =
            audit.historyPosition === currentDocument.expectedHistoryPosition &&
            audit.matchCount === currentDocument.expectedMatchCount &&
            audit.matchFingerprint === currentDocument.expectedMatchFingerprint;
          currentDocumentAudit = {
            documentSessionUuid: currentDocument.documentSessionUuid,
            exactOriginalStateVerified: currentDocumentRestored,
            expected: {
              historyPosition: currentDocument.expectedHistoryPosition,
              matchCount: currentDocument.expectedMatchCount,
              matchFingerprint: currentDocument.expectedMatchFingerprint,
            },
            actual: {
              historyPosition: audit.historyPosition,
              matchCount: audit.matchCount,
              matchFingerprint: audit.matchFingerprint,
              needsSaving: audit.needsSaving,
            },
          };
        } catch (auditError) {
          currentDocumentRestored = false;
          currentDocumentAudit = {
            documentSessionUuid: currentDocument.documentSessionUuid,
            exactOriginalStateVerified: false,
            auditError: auditError instanceof McpFailure
              ? { code: auditError.code, message: auditError.message, details: auditError.details }
              : { code: "INTERNAL_ERROR", message: auditError instanceof Error ? auditError.message : String(auditError) },
          };
        }
      }

      const rollbackResults: Array<Record<string, unknown>> = [];
      const rollbackFailures: Array<Record<string, unknown>> = [];
      for (const item of [...completed].reverse()) {
        try {
          const undone = await this.executeStructured<Record<string, unknown>>(
            buildUndoScript(item.guard.documentSessionUuid, item.result.historyPosition),
          );
          const audit = await this.executeFindText({
            documentSessionUuid: item.guard.documentSessionUuid,
            ...applySearch,
          });
          const restored =
            undone.historyPosition === item.guard.expectedHistoryPosition &&
            audit.historyPosition === item.guard.expectedHistoryPosition &&
            audit.matchCount === item.guard.expectedMatchCount &&
            audit.matchFingerprint === item.guard.expectedMatchFingerprint;
          if (!restored) {
            rollbackFailures.push({
              documentSessionUuid: item.guard.documentSessionUuid,
              reason: "post_undo_verification_failed",
              expected: {
                historyPosition: item.guard.expectedHistoryPosition,
                matchCount: item.guard.expectedMatchCount,
                matchFingerprint: item.guard.expectedMatchFingerprint,
              },
              actual: {
                undoHistoryPosition: undone.historyPosition,
                auditHistoryPosition: audit.historyPosition,
                auditMatchCount: audit.matchCount,
                auditMatchFingerprint: audit.matchFingerprint,
              },
            });
          } else {
            rollbackResults.push({
              documentSessionUuid: item.guard.documentSessionUuid,
              restoredContent: true,
              exactOriginalStateVerified: true,
              needsSaving: audit.needsSaving,
              historyPosition: audit.historyPosition,
            });
          }
        } catch (rollbackError) {
          rollbackFailures.push({
            documentSessionUuid: item.guard.documentSessionUuid,
            expectedHistoryPosition: item.result.historyPosition,
            error: rollbackError instanceof McpFailure
              ? { code: rollbackError.code, message: rollbackError.message, details: rollbackError.details }
              : {
                  code: "INTERNAL_ERROR",
                  message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
                },
          });
        }
      }
      const originalError = error instanceof McpFailure
        ? { code: error.code, message: error.message, details: error.details }
        : { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) };
      if (!currentDocumentRestored || rollbackFailures.length > 0) {
        throw new McpFailure(
          "BATCH_TEXT_ROLLBACK_INCOMPLETE",
          "Batch text replacement failed, and the exact original state could not be verified for every affected document.",
          { originalError, currentDocumentAudit, rollbackResults, rollbackFailures },
        );
      }
      throw new McpFailure(
        "BATCH_TEXT_REPLACE_ROLLED_BACK",
        "Batch text replacement failed. Earlier replacements were undone, but Affinity may still mark those documents as needing save.",
        { originalError, currentDocumentAudit, rollbackResults },
      );
    }

    return {
      mode: "apply",
      replaced: true,
      saved: false,
      documentCount: completed.length,
      totalReplacementCount: completed.reduce((sum, item) => sum + item.result.replacementCount, 0),
      search: {
        searchText: request.searchText,
        caseSensitive: request.caseSensitive,
        wholeWord: request.wholeWord,
        layerNames: request.layerNames ?? null,
      },
      replacementText: request.replacementText,
      documents: completed.map((item) => ({
        documentSessionUuid: item.guard.documentSessionUuid,
        title: item.result.title,
        path: item.result.path,
        replacementCount: item.result.replacementCount,
        previousHistoryPosition: item.result.previousHistoryPosition,
        historyPosition: item.result.historyPosition,
        needsSaving: item.result.needsSaving,
        saved: false,
      })),
      warnings: [
        "All replacements are open and unsaved. Render previews before saving.",
        "Batch rollback is compensating rather than transactional; external edits can prevent a guarded undo.",
      ],
    };
  }

  async placeImage(request: PlaceImageInput): Promise<Record<string, unknown>> {
    const inputPath = await this.paths.resolveExistingFile(request.inputPath, PLACEABLE_IMAGE_EXTENSIONS);
    const inputInfo = await lstat(inputPath);
    if (inputInfo.size > MAX_PLACEABLE_IMAGE_BYTES) {
      throw new McpFailure("IMAGE_TOO_LARGE", "The image exceeds the 512 MiB placement limit.", {
        inputPath,
        bytes: inputInfo.size,
        maxBytes: MAX_PLACEABLE_IMAGE_BYTES,
      });
    }

    const stagingPath = path.join(
      this.stagingDirectory,
      `.affinity-mcp-image-${randomUUID()}${path.extname(inputPath).toLowerCase()}`,
    );
    await copyFile(inputPath, stagingPath, fsConstants.COPYFILE_EXCL);
    try {
      await this.ensureConnector();
      const { inputPath: _inputPath, ...placement } = request;
      const result = await this.executeStructured<Record<string, unknown>>(
        buildPlaceImageScript({ ...placement, stagedImagePath: stagingPath }),
      );
      return { ...result, sourcePath: inputPath, embedded: true };
    } finally {
      await unlink(stagingPath).catch(() => undefined);
    }
  }

  async transformSelection(request: TransformSelectionRequest): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildTransformSelectionScript(request));
  }

  async setFill(documentSessionUuid: string, color: string): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildSetFillScript(documentSessionUuid, color));
  }

  async addLiveEffect(request: AddLiveEffectRequest): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(buildAddLiveEffectScript(request));
  }

  async undo(documentSessionUuid: string, expectedHistoryPosition: number): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    return this.executeStructured<Record<string, unknown>>(
      buildUndoScript(documentSessionUuid, expectedHistoryPosition),
    );
  }

  async listExportPresets(): Promise<Record<string, unknown>> {
    await this.ensureConnector();
    const live = await this.executeStructured<{ presets: string[] }>(buildListExportPresetsScript());
    return {
      ...live,
      supportedPresetIds: Object.entries(EXPORT_PRESETS).map(([id, preset]) => ({
        id,
        affinityName: preset.affinityName,
        extensions: preset.extensions,
        available: live.presets.includes(preset.affinityName),
      })),
    };
  }

  private async stageExport(request: ExportDocumentRequest, outputPath: string): Promise<StagedExport> {
    const preset = EXPORT_PRESETS[request.preset];
    const stagingStem = `.affinity-mcp-export-${randomUUID()}`;
    const stagingPath = path.join(
      this.stagingDirectory,
      `${stagingStem}${path.extname(outputPath).toLowerCase()}`,
    );
    const cleanupPaths = new Set([stagingPath]);
    try {
      const affinity = await this.executeStructured<ExportScriptResult>(
        buildExportDocumentScript(
          request.documentSessionUuid,
          stagingPath,
          preset.affinityName,
          request.area,
        ),
      );
      for (const record of affinity.records) {
        const recordPath = path.resolve(record.path);
        const belongsToThisExport =
          path.dirname(recordPath) === this.stagingDirectory && path.basename(recordPath).startsWith(stagingStem);
        if (belongsToThisExport) cleanupPaths.add(recordPath);
      }
      const unexpectedRecord = affinity.records.find((record) => {
        const recordPath = path.resolve(record.path);
        return path.dirname(recordPath) !== this.stagingDirectory || !path.basename(recordPath).startsWith(stagingStem);
      });
      if (unexpectedRecord !== undefined) {
        throw new McpFailure("AFFINITY_EXPORT_PATH_MISMATCH", "Affinity reported an export path outside this operation's staging prefix.", {
          expectedDirectory: this.stagingDirectory,
          expectedPrefix: stagingStem,
          actualPath: unexpectedRecord.path,
        });
      }
      if (affinity.records.length !== 1) {
        throw new McpFailure("AFFINITY_EXPORT_MULTIPLE_FILES", "This export produced multiple files; the MCP cleaned them up and did not commit a partial result.", {
          recordCount: affinity.records.length,
        });
      }
      const record = affinity.records[0];
      if (record === undefined || !record.success) {
        throw new McpFailure("AFFINITY_EXPORT_FAILED", "Affinity did not report a successful export record.", { affinity });
      }
      if (path.resolve(record.path) !== stagingPath) {
        throw new McpFailure("AFFINITY_EXPORT_PATH_MISMATCH", "Affinity exported to an unexpected path.", {
          expectedPath: stagingPath,
          actualPath: record.path,
        });
      }
      const info = await lstat(stagingPath).catch(() => undefined);
      if (info === undefined || !info.isFile()) {
        throw new McpFailure("STAGED_FILE_MISSING", "Affinity reported success but did not create the staged export.");
      }
      return {
        request,
        outputPath,
        stagingPath,
        bytes: info.size,
        sha256: await sha256(stagingPath),
        affinity,
      };
    } catch (error) {
      await Promise.all([...cleanupPaths].map((cleanupPath) => unlink(cleanupPath).catch(() => undefined)));
      throw error;
    }
  }

  private async commitVerifiedCopy(
    sourcePath: string,
    outputPath: string,
    expectedSha256: string,
    mismatchCode: string,
    mismatchMessage: string,
  ): Promise<CommittedFileIdentity> {
    await copyFile(sourcePath, outputPath, fsConstants.COPYFILE_EXCL);
    let identity: CommittedFileIdentity | undefined;
    try {
      const committedInfo = await lstat(outputPath);
      identity = { outputPath, device: committedInfo.dev, inode: committedInfo.ino };
      const committedHash = await sha256(outputPath);
      if (committedHash !== expectedSha256) {
        throw new McpFailure(mismatchCode, mismatchMessage, { outputPath });
      }
      return identity;
    } catch (error) {
      const current = await lstat(outputPath).catch(() => undefined);
      if (identity !== undefined && current?.dev === identity.device && current.ino === identity.inode) {
        await unlink(outputPath).catch(() => undefined);
      }
      throw error;
    }
  }

  private async commitStagedExport(staged: StagedExport): Promise<CommittedFileIdentity> {
    return this.commitVerifiedCopy(
      staged.stagingPath,
      staged.outputPath,
      staged.sha256,
      "EXPORT_HASH_MISMATCH",
      "The committed export did not match the staged file.",
    );
  }

  async exportDocument(request: ExportDocumentRequest): Promise<Record<string, unknown>> {
    const preset = EXPORT_PRESETS[request.preset];
    const outputPath = await this.paths.resolveNewFile(request.outputPath, preset.extensions);
    await this.ensureConnector();
    const staged = await this.stageExport(request, outputPath);
    try {
      await this.commitStagedExport(staged);
      return {
        exported: true,
        outputPath,
        bytes: staged.bytes,
        sha256: staged.sha256,
        preset: request.preset,
        area: request.area,
        warnings: staged.affinity.records.filter((record) => record.hasWarnings).map((record) => record.warning),
        safety: { overwritten: false },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new McpFailure("OUTPUT_EXISTS", "Refusing to overwrite an existing export.", { outputPath });
      }
      throw error;
    } finally {
      await unlink(staged.stagingPath).catch(() => undefined);
    }
  }

  async batchExport(jobs: ExportDocumentRequest[]): Promise<Record<string, unknown>> {
    if (jobs.length < 1 || jobs.length > MAX_BATCH_EXPORTS) {
      throw new McpFailure("INVALID_BATCH_SIZE", `Batch export requires between 1 and ${MAX_BATCH_EXPORTS} jobs.`);
    }
    const preflighted: Array<{ request: ExportDocumentRequest; outputPath: string }> = [];
    for (const request of jobs) {
      const preset = EXPORT_PRESETS[request.preset];
      preflighted.push({
        request,
        outputPath: await this.paths.resolveNewFile(request.outputPath, preset.extensions),
      });
    }
    const uniqueOutputs = new Set(preflighted.map((job) => job.outputPath));
    if (uniqueOutputs.size !== preflighted.length) {
      throw new McpFailure("DUPLICATE_BATCH_OUTPUT", "Every batch export job must use a different output path.");
    }

    await this.ensureConnector();
    const staged: StagedExport[] = [];
    const committed: CommittedFileIdentity[] = [];
    try {
      for (const job of preflighted) staged.push(await this.stageExport(job.request, job.outputPath));
      for (const item of staged) {
        committed.push(await this.commitStagedExport(item));
      }
      return {
        exported: true,
        count: staged.length,
        jobs: staged.map((item) => ({
          outputPath: item.outputPath,
          bytes: item.bytes,
          sha256: item.sha256,
          preset: item.request.preset,
          area: item.request.area,
          warnings: item.affinity.records.filter((record) => record.hasWarnings).map((record) => record.warning),
        })),
        safety: { overwritten: false, committedAfterAllStagingSucceeded: true },
      };
    } catch (error) {
      const rollbackFailures: Array<{ outputPath: string; cause: string }> = [];
      await Promise.all(committed.map(async (identity) => {
        let current;
        try {
          current = await lstat(identity.outputPath);
        } catch (rollbackError) {
          if ((rollbackError as NodeJS.ErrnoException).code !== "ENOENT") {
            rollbackFailures.push({
              outputPath: identity.outputPath,
              cause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
          return;
        }
        if (current.dev === identity.device && current.ino === identity.inode) {
          try {
            await unlink(identity.outputPath);
          } catch (rollbackError) {
            rollbackFailures.push({
              outputPath: identity.outputPath,
              cause: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            });
          }
        }
      }));
      if (rollbackFailures.length > 0) {
        throw new McpFailure("BATCH_ROLLBACK_INCOMPLETE", "Batch export failed and one or more created outputs could not be removed.", {
          rollbackFailures,
          originalError: error instanceof Error ? error.message : String(error),
        });
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new McpFailure("OUTPUT_EXISTS", "A batch output appeared before commit; created outputs were rolled back.");
      }
      throw error;
    } finally {
      await Promise.all(staged.map((item) => unlink(item.stagingPath).catch(() => undefined)));
    }
  }

  async listSdkDocumentation(): Promise<CallToolResult> {
    return this.native.callTool("list_sdk_documentation");
  }

  async readSdkDocumentation(filename: string): Promise<CallToolResult> {
    return this.native.callTool("read_sdk_documentation_topic", { filename });
  }

  async renderSpread(documentSessionUuid: string, spreadIndex: number): Promise<CallToolResult> {
    return this.native.callTool("render_spread", {
      document_session_uuid: documentSessionUuid,
      spread_index: spreadIndex,
    });
  }

  async renderSelection(): Promise<CallToolResult> {
    return this.native.callTool("render_selection");
  }

  async close(): Promise<void> {
    await this.native.close();
  }
}
