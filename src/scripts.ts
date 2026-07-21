import { McpFailure } from "./errors.js";

export const RESULT_MARKER = "AFFINITY_MCP_RESULT:";
export const ERROR_MARKER = "AFFINITY_MCP_ERROR:";

export const WORKSPACES = ["photo", "designer", "publisher"] as const;
export type Workspace = (typeof WORKSPACES)[number];

export const DOCUMENT_UNITS = ["px", "mm", "cm", "in"] as const;
export type DocumentUnit = (typeof DOCUMENT_UNITS)[number];

export const RASTER_FORMATS = ["RGBA8", "RGBA16", "RGBAUF", "IA8", "IA16", "CMYKA8", "LABA16"] as const;
export type RasterFormat = (typeof RASTER_FORMATS)[number];

export const MAX_DPI = 100_000;
export const MAX_PAGES = 500;
export const MAX_PIXEL_DIMENSION = 200_000;
export const MAX_PAGE_PIXELS = 500_000_000;
export const MAX_DOCUMENT_PIXELS = 5_000_000_000;

export interface DocumentRequest {
  workspace?: Workspace;
  width: number;
  height: number;
  unit?: DocumentUnit;
  dpi?: number;
  transparent?: boolean;
  rasterFormat?: RasterFormat;
  pages?: number;
  facingPages?: boolean;
  outputPath: string;
}

export interface NormalizedDocumentRequest {
  workspace: Workspace;
  width: number;
  height: number;
  unit: DocumentUnit;
  dpi: number;
  transparent: boolean;
  rasterFormat: RasterFormat;
  pages: number;
  facingPages: boolean;
  outputPath: string;
  createsArtboard: boolean;
  createsMultiPageDocument: boolean;
  estimatedPixels: {
    width: number;
    height: number;
    perPage: number;
    acrossPages: number;
  };
}

function estimatePixelDimension(value: number, unit: DocumentUnit, dpi: number): number {
  switch (unit) {
    case "px":
      return value;
    case "mm":
      return (value / 25.4) * dpi;
    case "cm":
      return (value / 2.54) * dpi;
    case "in":
      return value * dpi;
  }
}

export function normalizeDocumentRequest(input: DocumentRequest): NormalizedDocumentRequest {
  const workspace = input.workspace ?? "photo";
  const unit = input.unit ?? "px";
  const dpi = input.dpi ?? 300;
  const pages = input.pages ?? 1;

  if (!Number.isFinite(input.width) || input.width <= 0 || !Number.isFinite(input.height) || input.height <= 0) {
    throw new McpFailure("INVALID_DIMENSIONS", "width and height must be positive finite numbers.");
  }
  if (unit === "px" && (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height))) {
    throw new McpFailure("PIXELS_MUST_BE_INTEGERS", "Pixel dimensions must be whole numbers.");
  }
  if (!Number.isFinite(dpi) || dpi < 1 || dpi > MAX_DPI) {
    throw new McpFailure("INVALID_DPI", `dpi must be between 1 and ${MAX_DPI.toLocaleString("en-US")}.`);
  }
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES) {
    throw new McpFailure("INVALID_PAGE_COUNT", `pages must be an integer between 1 and ${MAX_PAGES}.`);
  }
  if (workspace !== "publisher" && pages !== 1) {
    throw new McpFailure("PAGES_REQUIRE_PUBLISHER", "Multiple pages are only available in publisher workspace mode.");
  }
  if (workspace !== "publisher" && input.facingPages === true) {
    throw new McpFailure("FACING_PAGES_REQUIRE_PUBLISHER", "Facing pages are only available in publisher workspace mode.");
  }

  const estimatedWidth = estimatePixelDimension(input.width, unit, dpi);
  const estimatedHeight = estimatePixelDimension(input.height, unit, dpi);
  const perPage = estimatedWidth * estimatedHeight;
  const acrossPages = perPage * pages;
  if (
    estimatedWidth > MAX_PIXEL_DIMENSION ||
    estimatedHeight > MAX_PIXEL_DIMENSION ||
    perPage > MAX_PAGE_PIXELS ||
    acrossPages > MAX_DOCUMENT_PIXELS
  ) {
    throw new McpFailure("DOCUMENT_TOO_LARGE", "The requested document exceeds this MCP's safe resource limits.", {
      estimatedWidthPixels: Math.ceil(estimatedWidth),
      estimatedHeightPixels: Math.ceil(estimatedHeight),
      estimatedPixelsPerPage: Math.ceil(perPage),
      estimatedPixelsAcrossPages: Math.ceil(acrossPages),
      limits: {
        maxPixelDimension: MAX_PIXEL_DIMENSION,
        maxPixelsPerPage: MAX_PAGE_PIXELS,
        maxPixelsAcrossPages: MAX_DOCUMENT_PIXELS,
      },
    });
  }

  return {
    workspace,
    width: input.width,
    height: input.height,
    unit,
    dpi,
    transparent: input.transparent ?? false,
    rasterFormat: input.rasterFormat ?? "RGBA8",
    pages,
    facingPages: workspace === "publisher" ? (input.facingPages ?? false) : false,
    outputPath: input.outputPath,
    createsArtboard: workspace === "designer",
    createsMultiPageDocument: workspace === "publisher",
    estimatedPixels: {
      width: Math.ceil(estimatedWidth),
      height: Math.ceil(estimatedHeight),
      perPage: Math.ceil(perPage),
      acrossPages: Math.ceil(acrossPages),
    },
  };
}

const UNIT_ALIASES: Record<DocumentUnit, string[]> = {
  px: ["Pixel", "Pixels"],
  mm: ["Millimetres", "Millimetre"],
  cm: ["Centimetres", "Centimetre"],
  in: ["Inches", "Inch"],
};

export function buildCreateDocumentScript(request: NormalizedDocumentRequest, stagingPath: string): string {
  const unitAliases = UNIT_ALIASES[request.unit];
  return `
const { Document, NewDocumentOptions } = require('/document');
const { UnitType } = require('/units');
const { RasterFormat } = require('/rasterobject');
const resultMarker = ${JSON.stringify(RESULT_MARKER)};
const errorMarker = ${JSON.stringify(ERROR_MARKER)};
let createdDocument = null;
try {
  const unitAliases = ${JSON.stringify(unitAliases)};
  const unit = unitAliases.map((name) => UnitType[name]).find((value) => value !== undefined);
  if (unit === undefined) throw new Error('This Affinity build does not expose the requested unit: ${request.unit}');
  const rasterFormat = RasterFormat[${JSON.stringify(request.rasterFormat)}];
  if (rasterFormat === undefined) throw new Error('This Affinity build does not expose raster format: ${request.rasterFormat}');

  const options = NewDocumentOptions.createDefault();
  options.units = unit;
  options.width = ${JSON.stringify(request.width)};
  options.height = ${JSON.stringify(request.height)};
  options.isLandscape = ${JSON.stringify(request.width > request.height)};
  options.dpi = ${JSON.stringify(request.dpi)};
  options.viewDpi = ${JSON.stringify(request.dpi)};
  options.isTransparentBackground = ${JSON.stringify(request.transparent)};
  options.rasterFormat = rasterFormat;
  options.createArtboard = ${JSON.stringify(request.createsArtboard)};
  options.isMultiPage = ${JSON.stringify(request.createsMultiPageDocument)};
  options.pageCount = ${JSON.stringify(request.pages)};
  options.isFacing = ${JSON.stringify(request.facingPages)};
  options.createMaster = ${JSON.stringify(request.workspace === "publisher")};

  createdDocument = Document.create(options);
  createdDocument.saveAs(${JSON.stringify(stagingPath)});
  const result = {
    title: createdDocument.title,
    path: createdDocument.path,
    sessionUuid: createdDocument.sessionUuid,
    widthPixels: createdDocument.widthPixels,
    heightPixels: createdDocument.heightPixels,
    dpi: createdDocument.dpi,
    workspace: ${JSON.stringify(request.workspace)},
    pages: ${JSON.stringify(request.pages)}
  };
  console.log(resultMarker + JSON.stringify(result));
} catch (error) {
  console.log(errorMarker + JSON.stringify({
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  }));
}
`.trim();
}

export function buildListOpenDocumentsScript(): string {
  return `
const { Document } = require('/document');
const resultMarker = ${JSON.stringify(RESULT_MARKER)};
const documents = Document.all.map((document) => ({
  title: document.title,
  path: document.path,
  widthPixels: document.widthPixels,
  heightPixels: document.heightPixels,
  dpi: document.dpi,
  sessionUuid: document.sessionUuid,
  persistentUuid: document.persistentUuid,
  pageCount: document.pageCount,
  hasArtboards: document.hasArtboards,
  needsSaving: document.needsSaving,
  isReadOnly: document.isReadOnly,
  mustSaveAs: document.mustSaveAs,
  historyPosition: document.history.position
}));
console.log(resultMarker + JSON.stringify({ documents }));
`.trim();
}
