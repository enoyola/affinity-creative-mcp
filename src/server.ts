import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { errorPayload } from "./errors.js";
import { EXPORT_PRESET_IDS, type AffinityService } from "./service.js";
import { DOCUMENT_UNITS, MAX_DPI, MAX_PAGES, RASTER_FORMATS, WORKSPACES } from "./scripts.js";

function success(data: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failure(error: unknown): CallToolResult {
  const payload = errorPayload(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

async function safely(run: () => Promise<CallToolResult | object>): Promise<CallToolResult> {
  try {
    const result = await run();
    return "content" in result && Array.isArray(result.content) ? (result as CallToolResult) : success(result);
  } catch (error) {
    return failure(error);
  }
}

const sessionUuidSchema = z.string().min(1).max(128).describe("Session UUID from affinity_list_open_documents");
const absolutePathSchema = z.string().min(1).max(4096).describe("Absolute path inside an allowed root");
const nameSchema = z.string().min(1).max(256);
const coordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);
const dimensionSchema = z.number().finite().positive().max(200_000);
const scaleSchema = z.number().finite().min(0.001).max(1_000);
const colourSchema = z.string().regex(/^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/, "Use #RRGGBB or #RRGGBBAA");
const exportAreaSchema = z.enum(["whole_document", "current_spread", "current_page"]).default("whole_document");
const textSearchSchema = {
  searchText: z.string().min(1).max(10_000)
    .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), "Search text cannot contain line breaks")
    .describe("Literal text to find; regular expressions and line-break matching are not supported"),
  caseSensitive: z.boolean().default(true),
  wholeWord: z.boolean().default(false),
  layerNames: z.array(nameSchema).min(1).max(50).optional().describe("Optional exact, case-sensitive layer-name allowlist"),
};
const replacementTextSchema = z.string().max(100_000).describe("Replacement text; an empty string deletes each match");
const historyPositionSchema = z.number().int().min(0).max(10_000_000);
const matchCountSchema = z.number().int().min(1).max(5_000);
const matchFingerprintSchema = z.string().regex(/^v1-[0-9a-f]{16}$/).describe("Fingerprint returned by a text find or batch dry-run");
const batchTextDocumentSchema = z.object({
  documentSessionUuid: sessionUuidSchema,
  expectedHistoryPosition: historyPositionSchema.optional().describe("Apply mode only: history position returned by dry-run"),
  expectedMatchCount: matchCountSchema.optional().describe("Apply mode only: match count returned by dry-run"),
  expectedMatchFingerprint: matchFingerprintSchema.optional().describe("Apply mode only: fingerprint returned by dry-run"),
}).strict();
const batchTextInputSchema = z.object({
  mode: z.enum(["dry_run", "apply"]),
  documents: z.array(batchTextDocumentSchema).min(1).max(20),
  ...textSearchSchema,
  replacementText: replacementTextSchema.optional().describe("Required in apply mode; omit in dry-run mode"),
  expectedTotalMatchCount: z.number().int().min(1).max(5_000).optional()
    .describe("Required in apply mode; total returned by dry-run"),
}).strict().superRefine((input, context) => {
  if (input.mode === "dry_run") {
    if (input.replacementText !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["replacementText"],
        message: "replacementText must be omitted in dry_run mode",
      });
    }
    if (input.expectedTotalMatchCount !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["expectedTotalMatchCount"],
        message: "expectedTotalMatchCount must be omitted in dry_run mode",
      });
    }
    input.documents.forEach((document, index) => {
      for (const field of ["expectedHistoryPosition", "expectedMatchCount", "expectedMatchFingerprint"] as const) {
        if (document[field] !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["documents", index, field],
            message: `${field} must be omitted in dry_run mode`,
          });
        }
      }
    });
    return;
  }

  if (input.replacementText === undefined) {
    context.addIssue({
      code: "custom",
      path: ["replacementText"],
      message: "replacementText is required in apply mode",
    });
  }
  if (input.expectedTotalMatchCount === undefined) {
    context.addIssue({
      code: "custom",
      path: ["expectedTotalMatchCount"],
      message: "expectedTotalMatchCount is required in apply mode",
    });
  }
  input.documents.forEach((document, index) => {
    for (const field of ["expectedHistoryPosition", "expectedMatchCount", "expectedMatchFingerprint"] as const) {
      if (document[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: ["documents", index, field],
          message: `${field} is required in apply mode`,
        });
      }
    }
  });
});
const liveEffectInputSchema = z.object({
  documentSessionUuid: sessionUuidSchema,
  effect: z.enum(["exposure", "gaussian_blur", "invert"]),
  amount: z.number().finite().min(-20).max(1024).optional()
    .describe("Exposure: -20 to 20. Gaussian blur: 0 to 1024. Omit for invert."),
  name: nameSchema.optional(),
}).strict().superRefine((input, context) => {
  if (input.effect === "invert" && input.amount !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "amount must be omitted for invert",
    });
  } else if (input.effect === "exposure" && input.amount !== undefined && input.amount > 20) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "exposure amount must be between -20 and 20",
    });
  } else if (input.effect === "gaussian_blur" && input.amount !== undefined && input.amount < 0) {
    context.addIssue({
      code: "custom",
      path: ["amount"],
      message: "gaussian blur amount must be between 0 and 1024",
    });
  }
});

const exportJobSchema = z.object({
  documentSessionUuid: sessionUuidSchema,
  outputPath: absolutePathSchema,
  preset: z.enum(EXPORT_PRESET_IDS),
  area: exportAreaSchema,
}).strict();

export const documentInputSchema = z.object({
  workspace: z.enum(WORKSPACES).default("photo").describe("photo creates a canvas, designer creates an artboard, publisher creates pages"),
  width: z.number().positive().max(1_000_000).finite().describe("Document width in the selected unit; pixel values must be integers"),
  height: z.number().positive().max(1_000_000).finite().describe("Document height in the selected unit; pixel values must be integers"),
  unit: z.enum(DOCUMENT_UNITS).default("px"),
  dpi: z.number().min(1).max(MAX_DPI).default(300),
  transparent: z.boolean().default(false),
  rasterFormat: z.enum(RASTER_FORMATS).default("RGBA8"),
  pages: z.number().int().min(1).max(MAX_PAGES).default(1).describe("Publisher mode only"),
  facingPages: z.boolean().default(false).describe("Publisher mode only"),
  outputPath: z.string().min(1).describe("Absolute output path ending in .af"),
});

export function createMcpServer(service: AffinityService): McpServer {
  const server = new McpServer({ name: "affinity-creative-mcp", version: "0.3.0" });

  server.registerTool(
    "affinity_status",
    {
      title: "Check Affinity automation status",
      description: "Check whether Affinity and its native MCP connector are ready, and show path/safety configuration.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.status()),
  );

  server.registerTool(
    "affinity_launch",
    {
      title: "Launch Affinity",
      description: "Launch Affinity and wait briefly for its native MCP connector.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.launch()),
  );

  server.registerTool(
    "affinity_plan_document",
    {
      title: "Validate an Affinity document plan",
      description: "Validate and normalize a new Photo, Designer, or Publisher document without launching Affinity or writing a file.",
      inputSchema: documentInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => safely(() => service.planDocument(input)),
  );

  server.registerTool(
    "affinity_create_document",
    {
      title: "Create an editable Affinity document",
      description: "Create a real editable Affinity document with exact dimensions through verified staging. Never overwrites; open the returned final path before editing.",
      inputSchema: documentInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.createDocument(input)),
  );

  server.registerTool(
    "affinity_list_open_documents",
    {
      title: "List open Affinity documents",
      description: "List open documents with dimensions, DPI, save state, and session IDs for rendering.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.listOpenDocuments()),
  );

  server.registerTool(
    "affinity_open_document",
    {
      title: "Open a file in Affinity",
      description: "Open an existing Affinity document or supported image/PDF in Affinity and return its document session UUID.",
      inputSchema: z.object({
        inputPath: absolutePathSchema,
        reuseIfOpen: z.boolean().default(true),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => safely(() => service.openDocument(input)),
  );

  server.registerTool(
    "affinity_inspect_document",
    {
      title: "Inspect an open Affinity document",
      description: "Read the path, save state, dimensions, DPI, and identity of one open document session.",
      inputSchema: z.object({ documentSessionUuid: sessionUuidSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ documentSessionUuid }) => safely(() => service.inspectDocument(documentSessionUuid)),
  );

  server.registerTool(
    "affinity_save_document",
    {
      title: "Save an Affinity document",
      description: "Save an open native Affinity document in place. The real path must be writable and inside an allowed root.",
      inputSchema: z.object({ documentSessionUuid: sessionUuidSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    ({ documentSessionUuid }) => safely(() => service.saveDocument(documentSessionUuid)),
  );

  server.registerTool(
    "affinity_list_layers",
    {
      title: "List Affinity layers",
      description: "List document layers in Affinity's flattened layer order, including names, bounds, indices, and selection state.",
      inputSchema: z.object({ documentSessionUuid: sessionUuidSchema }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ documentSessionUuid }) => safely(() => service.listLayers(documentSessionUuid)),
  );

  server.registerTool(
    "affinity_select_layer",
    {
      title: "Select an Affinity layer",
      description: "Select a document layer by its exact name and zero-based occurrence when duplicate names exist.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        name: nameSchema,
        occurrence: z.number().int().min(0).max(100_000).default(0),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ documentSessionUuid, name, occurrence }) => safely(() => service.selectLayer(documentSessionUuid, name, occurrence)),
  );

  server.registerTool(
    "affinity_add_layer",
    {
      title: "Add an Affinity layer",
      description: "Add and select a named top-level layer. The edit remains unsaved and undoable.",
      inputSchema: z.object({ documentSessionUuid: sessionUuidSchema, name: nameSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.addLayer(input)),
  );

  server.registerTool(
    "affinity_add_shape",
    {
      title: "Add a vector shape",
      description: "Add and select an editable rectangle or ellipse with a solid fill and optional stroke.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        shape: z.enum(["rectangle", "ellipse"]),
        x: coordinateSchema,
        y: coordinateSchema,
        width: dimensionSchema,
        height: dimensionSchema,
        fill: colourSchema.default("#000000FF"),
        stroke: colourSchema.optional(),
        strokeWidth: z.number().finite().min(0).max(10_000).optional(),
        name: nameSchema.optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.addShape(input)),
  );

  server.registerTool(
    "affinity_add_text",
    {
      title: "Add editable text",
      description: "Add and select artistic or frame text with position, size, alignment, and solid colour.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        text: z.string().min(1).max(100_000),
        x: coordinateSchema,
        y: coordinateSchema,
        kind: z.enum(["artistic", "frame"]).default("artistic"),
        frameWidth: dimensionSchema.optional(),
        frameHeight: dimensionSchema.optional(),
        fontSize: z.number().finite().min(1).max(2_000).default(48),
        color: colourSchema.default("#000000FF"),
        alignment: z.enum(["left", "center", "right", "justify"]).default("left"),
        name: nameSchema.optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.addText(input)),
  );

  server.registerTool(
    "affinity_find_text",
    {
      title: "Find editable Affinity text",
      description: "Preview literal matches in editable text layers and return history/count/fingerprint guards required for replacement. Does not use OCR or change the document.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        ...textSearchSchema,
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    (input) => safely(() => service.findText(input)),
  );

  server.registerTool(
    "affinity_replace_text",
    {
      title: "Replace editable Affinity text",
      description: "Replace a previously previewed literal match set in one open document as a single undoable, unsaved history operation. Refuses stale or blocked matches.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        ...textSearchSchema,
        replacementText: replacementTextSchema,
        expectedHistoryPosition: historyPositionSchema,
        expectedMatchCount: matchCountSchema,
        expectedMatchFingerprint: matchFingerprintSchema,
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.replaceText(input)),
  );

  server.registerTool(
    "affinity_batch_replace_text",
    {
      title: "Preview or batch-replace Affinity text",
      description: "Dry-run or apply the same literal replacement across up to 20 already-open documents. Apply preflights every document, leaves edits unsaved, and guarded-undoes earlier documents if a later edit fails.",
      inputSchema: batchTextInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => {
      const search = {
        searchText: input.searchText,
        caseSensitive: input.caseSensitive,
        wholeWord: input.wholeWord,
        ...(input.layerNames === undefined ? {} : { layerNames: input.layerNames }),
      };
      if (input.mode === "dry_run") {
        return service.batchReplaceText({
          mode: "dry_run",
          documents: input.documents.map((document) => ({
            documentSessionUuid: document.documentSessionUuid,
          })),
          ...search,
        });
      }
      const documents = input.documents.map((document) => {
        if (
          document.expectedHistoryPosition === undefined ||
          document.expectedMatchCount === undefined ||
          document.expectedMatchFingerprint === undefined
        ) {
          throw new Error("Validated apply-mode text guards were unexpectedly missing.");
        }
        return {
          documentSessionUuid: document.documentSessionUuid,
          expectedHistoryPosition: document.expectedHistoryPosition,
          expectedMatchCount: document.expectedMatchCount,
          expectedMatchFingerprint: document.expectedMatchFingerprint,
        };
      });
      if (input.replacementText === undefined || input.expectedTotalMatchCount === undefined) {
        throw new Error("Validated apply-mode text values were unexpectedly missing.");
      }
      return service.batchReplaceText({
        mode: "apply",
        documents,
        expectedTotalMatchCount: input.expectedTotalMatchCount,
        replacementText: input.replacementText,
        ...search,
      });
    }),
  );

  server.registerTool(
    "affinity_place_image",
    {
      title: "Place an image",
      description: "Embed a PNG, JPEG, TIFF, or WebP as an editable image layer, optionally resizing it. The source file is never changed.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        inputPath: absolutePathSchema,
        x: coordinateSchema.default(0),
        y: coordinateSchema.default(0),
        width: dimensionSchema.optional(),
        height: dimensionSchema.optional(),
        name: nameSchema.optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.placeImage(input)),
  );

  server.registerTool(
    "affinity_transform_selection",
    {
      title: "Transform the selected layers",
      description: "Move, scale, and rotate the current selection around its centre using bounded relative values.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        translateX: coordinateSchema.default(0),
        translateY: coordinateSchema.default(0),
        scaleX: scaleSchema.default(1),
        scaleY: scaleSchema.default(1),
        rotationDegrees: z.number().finite().min(-36_000).max(36_000).default(0),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.transformSelection(input)),
  );

  server.registerTool(
    "affinity_set_fill",
    {
      title: "Set selection fill colour",
      description: "Set the solid fill colour of the current Affinity selection.",
      inputSchema: z.object({ documentSessionUuid: sessionUuidSchema, color: colourSchema }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ documentSessionUuid, color }) => safely(() => service.setFill(documentSessionUuid, color)),
  );

  server.registerTool(
    "affinity_add_live_effect",
    {
      title: "Add a live adjustment or filter",
      description: "Add a clipped, non-destructive exposure, invert, or Gaussian blur effect to exactly one selected layer.",
      inputSchema: liveEffectInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => {
      const common = {
        documentSessionUuid: input.documentSessionUuid,
        ...(input.name === undefined ? {} : { name: input.name }),
      };
      if (input.effect === "invert") {
        return service.addLiveEffect({ ...common, effect: "invert" });
      }
      if (input.effect === "exposure") {
        return service.addLiveEffect({ ...common, effect: "exposure", amount: input.amount ?? 0 });
      }
      return service.addLiveEffect({ ...common, effect: "gaussian_blur", amount: input.amount ?? 0 });
    }),
  );

  server.registerTool(
    "affinity_undo",
    {
      title: "Undo the last Affinity edit",
      description: "Undo the most recent history operation only if the document is still at the expected history position returned by the preceding edit.",
      inputSchema: z.object({
        documentSessionUuid: sessionUuidSchema,
        expectedHistoryPosition: z.number().int().min(1).max(10_000_000),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    ({ documentSessionUuid, expectedHistoryPosition }) =>
      safely(() => service.undo(documentSessionUuid, expectedHistoryPosition)),
  );

  server.registerTool(
    "affinity_list_export_presets",
    {
      title: "List Affinity export presets",
      description: "List presets installed in Affinity and show which curated preset IDs this MCP can safely export.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.listExportPresets()),
  );

  server.registerTool(
    "affinity_export_document",
    {
      title: "Export an Affinity document",
      description: "Export an open document through a curated PNG, JPEG, GIF, TIFF, SVG, PDF, EPS, PSD, or WebP preset. Never overwrites.",
      inputSchema: exportJobSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (input) => safely(() => service.exportDocument(input)),
  );

  server.registerTool(
    "affinity_batch_export",
    {
      title: "Batch export Affinity documents",
      description: "Stage up to 20 explicit exports, then commit them only after every Affinity export succeeds. Never overwrites.",
      inputSchema: z.object({ jobs: z.array(exportJobSchema).min(1).max(20) }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ({ jobs }) => safely(() => service.batchExport(jobs)),
  );

  server.registerTool(
    "affinity_render_spread",
    {
      title: "Render an Affinity spread",
      description: "Render a preview of a spread from an open Affinity document.",
      inputSchema: z.object({
        documentSessionUuid: z.string().min(1),
        spreadIndex: z.number().int().min(0),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ documentSessionUuid, spreadIndex }) => safely(() => service.renderSpread(documentSessionUuid, spreadIndex)),
  );

  server.registerTool(
    "affinity_render_selection",
    {
      title: "Render the Affinity selection",
      description: "Render a preview of the current selection in Affinity.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.renderSelection()),
  );

  server.registerTool(
    "affinity_list_sdk_documentation",
    {
      title: "List Affinity scripting documentation",
      description: "List documentation topics exposed by the installed Affinity scripting SDK.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => safely(() => service.listSdkDocumentation()),
  );

  server.registerTool(
    "affinity_read_sdk_documentation",
    {
      title: "Read Affinity scripting documentation",
      description: "Read one documentation topic exposed by the installed Affinity scripting SDK.",
      inputSchema: z.object({ filename: z.string().min(1) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    ({ filename }) => safely(() => service.readSdkDocumentation(filename)),
  );

  return server;
}
