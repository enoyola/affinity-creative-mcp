import { McpFailure } from "./errors.js";
import { ERROR_MARKER, RESULT_MARKER } from "./scripts.js";

export interface RgbaColour {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface AddLayerRequest {
  documentSessionUuid: string;
  name: string;
}

export interface AddShapeRequest {
  documentSessionUuid: string;
  shape: "rectangle" | "ellipse";
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  stroke?: string | undefined;
  strokeWidth?: number | undefined;
  name?: string | undefined;
}

export interface AddTextRequest {
  documentSessionUuid: string;
  text: string;
  x: number;
  y: number;
  kind: "artistic" | "frame";
  frameWidth?: number | undefined;
  frameHeight?: number | undefined;
  fontSize: number;
  color: string;
  alignment: "left" | "center" | "right" | "justify";
  name?: string | undefined;
}

export interface PlaceImageRequest {
  documentSessionUuid: string;
  stagedImagePath: string;
  x: number;
  y: number;
  width?: number | undefined;
  height?: number | undefined;
  name?: string | undefined;
}

export interface TransformSelectionRequest {
  documentSessionUuid: string;
  translateX: number;
  translateY: number;
  scaleX: number;
  scaleY: number;
  rotationDegrees: number;
}

export interface AddLiveEffectRequest {
  documentSessionUuid: string;
  effect: "exposure" | "invert" | "gaussian_blur";
  amount?: number | undefined;
  name?: string | undefined;
}

export interface TextSearchRequest {
  documentSessionUuid: string;
  searchText: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  layerNames?: string[] | undefined;
}

export interface TextReplaceRequest extends TextSearchRequest {
  replacementText: string;
  expectedHistoryPosition: number;
  expectedMatchCount: number;
  expectedMatchFingerprint: string;
}

export type ExportArea = "whole_document" | "current_spread" | "current_page";

export function parseHexColour(value: string): RgbaColour {
  const match = /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  if (match?.[1] === undefined) {
    throw new McpFailure("INVALID_COLOUR", "Colours must use #RRGGBB or #RRGGBBAA hexadecimal notation.", { value });
  }
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) : 255,
  };
}

function wrapScript(body: string): string {
  return `
const resultMarker = ${JSON.stringify(RESULT_MARKER)};
const errorMarker = ${JSON.stringify(ERROR_MARKER)};
try {
${body}
} catch (error) {
  console.log(errorMarker + JSON.stringify({
    message: error && error.message ? error.message : String(error),
    stack: error && error.stack ? error.stack : undefined
  }));
}
`.trim();
}

const NODE_SUMMARY = `
function displayName(node) {
  return node.userDescription || node.defaultDescriptionForDisplay || node.description || null;
}
function summarizeNode(node) {
  let box = null;
  try {
    const raw = node.getSpreadBaseBox();
    if ([raw.x, raw.y, raw.width, raw.height].every((value) => Number.isFinite(value) && Math.abs(value) < 1e100)) {
      box = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    }
  } catch (_) {}
  return {
    type: Object.prototype.toString.call(node).slice(8, -1),
    name: displayName(node),
    userDescription: node.userDescription || null,
    box
  };
}
function documentState(document) {
  return {
    needsSaving: document.needsSaving,
    historyPosition: document.history.position,
    undoDescription: document.history.canUndo ? document.history.undoDescription : null
  };
}
`;

function withDocument(documentSessionUuid: string, body: string): string {
  return wrapScript(`
  const { Document } = require('/document');
  const requestedSessionUuid = ${JSON.stringify(documentSessionUuid)};
  const doc = Document.all.find((candidate) => candidate.sessionUuid === requestedSessionUuid);
  if (!doc) throw new Error('No open Affinity document matches session UUID: ' + requestedSessionUuid);
${NODE_SUMMARY}
${body}
  `);
}

const TEXT_MATCHING_HELPERS = `
const MAX_TEXT_MATCHES = 5000;
const MAX_TEXT_GLYPHS = 500000;
const MAX_TEXT_LAYERS = 10000;
const MAX_TEXT_INSERTED_CODE_UNITS = 2000000;

function createTextHasher() {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const hex = (number) => (number >>> 0).toString(16).padStart(8, '0');
  return {
    update(value) {
      for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 0x01000193);
        second = Math.imul(second ^ code, 0x85ebca6b);
        second ^= second >>> 13;
      }
    },
    digest() {
      return 'v1-' + hex(first) + hex(second);
    }
  };
}

function textFingerprint(value) {
  const hasher = createTextHasher();
  hasher.update(value);
  return hasher.digest();
}

function glyphContentFingerprint(glyphs) {
  const hasher = createTextHasher();
  for (const glyph of glyphs) {
    hasher.update(glyph.isCharGlyph === true ? 'char:' : 'special:');
    hasher.update(glyph.description);
    hasher.update('\\u0000');
  }
  return hasher.digest();
}

function visibleTextState(node) {
  const storyInterface = node.storyInterface;
  const storyRange = storyInterface.storyRange;
  const glyphs = [...storyInterface.glyphs];
  let text = '';
  const offsetsByStoryPosition = new Map();
  offsetsByStoryPosition.set(storyRange.begin, 0);
  for (let glyphOffset = 0; glyphOffset < glyphs.length; glyphOffset += 1) {
    const glyph = glyphs[glyphOffset];
    if (glyph.isStoryTerminator === true) break;
    text += glyph.description;
    offsetsByStoryPosition.set(storyRange.begin + glyphOffset + 1, text.length);
  }
  return { text, offsetsByStoryPosition };
}

function collectTextMatches(document, options) {
  const allLayers = [...document.layers.all];
  const requestedLayerNames = options.layerNames === null ? null : new Set(options.layerNames);
  const needle = options.caseSensitive ? options.searchText : options.searchText.toLowerCase();
  const matches = [];
  const internalMatches = [];
  const blockedLayers = [];
  const textSnapshots = [];
  let textLayerCount = 0;
  let includedTextLayerCount = 0;
  let editableTextLayerCount = 0;
  let specialGlyphCount = 0;
  let scannedGlyphCount = 0;

  for (let layerIndex = 0; layerIndex < allLayers.length; layerIndex += 1) {
    const node = allLayers[layerIndex];
    if (!node.isTextNode) continue;
    textLayerCount += 1;
    if (textLayerCount > MAX_TEXT_LAYERS) {
      throw new Error('Text search exceeded the maximum of ' + MAX_TEXT_LAYERS + ' text layers.');
    }
    const layerName = displayName(node);
    if (requestedLayerNames !== null && !requestedLayerNames.has(layerName)) continue;
    includedTextLayerCount += 1;

    const storyInterface = node.storyInterface;
    const story = storyInterface.story;
    const storyRange = storyInterface.storyRange;
    const layerType = Object.prototype.toString.call(node).slice(8, -1);
    const linkedTextFlow = storyInterface.isMultiFrameTextFlow === true;
    const editable = node.isEditable === true;
    if (editable && !linkedTextFlow && document.isReadOnly !== true) editableTextLayerCount += 1;
    const blockedReason =
      document.isReadOnly === true
        ? 'document_read_only'
        : !editable
          ? 'locked_or_not_editable'
          : linkedTextFlow
            ? 'linked_text_flow'
            : null;
    if (blockedReason !== null) {
      blockedLayers.push({ layerIndex, layerName, layerType, reason: blockedReason });
    }

    const glyphs = [...storyInterface.glyphs];
    scannedGlyphCount += glyphs.length;
    if (scannedGlyphCount > MAX_TEXT_GLYPHS) {
      throw new Error('Text search exceeded the maximum of ' + MAX_TEXT_GLYPHS + ' story glyphs.');
    }
    textSnapshots.push({
      layerIndex,
      layerName,
      layerType,
      storyBegin: storyRange.begin,
      storyEnd: storyRange.end,
      editable,
      linkedTextFlow,
      contentFingerprint: glyphContentFingerprint(glyphs)
    });

    let segmentOriginal = '';
    let segmentSearch = '';
    let searchBoundaries = new Map();
    searchBoundaries.set(0, { storyPosition: storyRange.begin, originalOffset: 0 });

    const scanSegment = () => {
      if (segmentSearch.length === 0) return;
      let cursor = 0;
      while (cursor <= segmentSearch.length - needle.length) {
        const found = segmentSearch.indexOf(needle, cursor);
        if (found < 0) break;
        const startBoundary = searchBoundaries.get(found);
        const endBoundary = searchBoundaries.get(found + needle.length);
        if (startBoundary !== undefined && endBoundary !== undefined) {
          const wholeWordMatches =
            !options.wholeWord ||
            (story.isWordBegin(startBoundary.storyPosition) && story.isWordEnd(endBoundary.storyPosition));
          if (wholeWordMatches) {
            const contextStart = Math.max(0, startBoundary.originalOffset - 40);
            const contextEnd = Math.min(segmentOriginal.length, endBoundary.originalOffset + 40);
            const publicMatch = {
              layerIndex,
              layerName,
              layerType,
              begin: startBoundary.storyPosition,
              end: endBoundary.storyPosition,
              matchedText: segmentOriginal.slice(startBoundary.originalOffset, endBoundary.originalOffset),
              contextBefore: segmentOriginal.slice(contextStart, startBoundary.originalOffset),
              contextAfter: segmentOriginal.slice(endBoundary.originalOffset, contextEnd),
              replaceable: blockedReason === null,
              blockedReason
            };
            matches.push(publicMatch);
            internalMatches.push({ ...publicMatch, node });
            if (matches.length > MAX_TEXT_MATCHES) {
              throw new Error('Text search exceeded the maximum of ' + MAX_TEXT_MATCHES + ' matches.');
            }
          }
        }
        cursor = found + Math.max(needle.length, 1);
      }
    };

    const resetSegment = (nextStoryPosition) => {
      segmentOriginal = '';
      segmentSearch = '';
      searchBoundaries = new Map();
      searchBoundaries.set(0, { storyPosition: nextStoryPosition, originalOffset: 0 });
    };

    for (let glyphOffset = 0; glyphOffset < glyphs.length; glyphOffset += 1) {
      const glyph = glyphs[glyphOffset];
      const storyPosition = storyRange.begin + glyphOffset;
      const piece = glyph.isCharGlyph === true ? glyph.string : '';
      if (glyph.isCharGlyph !== true || piece.length === 0) {
        scanSegment();
        if (glyph.isStoryTerminator !== true) specialGlyphCount += 1;
        resetSegment(storyPosition + 1);
        continue;
      }

      const searchPiece = options.caseSensitive ? piece : piece.toLowerCase();
      segmentOriginal += piece;
      segmentSearch += searchPiece;
      searchBoundaries.set(segmentSearch.length, {
        storyPosition: storyPosition + 1,
        originalOffset: segmentOriginal.length
      });
    }
    scanSegment();
  }

  const replaceableMatchCount = matches.filter((match) => match.replaceable).length;
  const matchedLayerCount = new Set(matches.map((match) => match.layerIndex)).size;
  const fingerprintPayload = JSON.stringify({
    version: 1,
    documentSessionUuid: document.sessionUuid,
    historyPosition: document.history.position,
    searchText: options.searchText,
    caseSensitive: options.caseSensitive,
    wholeWord: options.wholeWord,
    layerNames: options.layerNames,
    textSnapshots,
    matches: matches.map((match) => ({
      layerIndex: match.layerIndex,
      layerName: match.layerName,
      layerType: match.layerType,
      begin: match.begin,
      end: match.end,
      matchedText: match.matchedText,
      replaceable: match.replaceable,
      blockedReason: match.blockedReason
    }))
  });

  return {
    textLayerCount,
    includedTextLayerCount,
    editableTextLayerCount,
    matchCount: matches.length,
    replaceableMatchCount,
    blockedMatchCount: matches.length - replaceableMatchCount,
    matchedLayerCount,
    specialGlyphCount,
    scannedGlyphCount,
    blockedLayers,
    matches,
    internalMatches,
    matchFingerprint: textFingerprint(fingerprintPayload)
  };
}
`;

export function buildFindTextScript(request: TextSearchRequest): string {
  return withDocument(
    request.documentSessionUuid,
    `
${TEXT_MATCHING_HELPERS}
  const searchOptions = {
    searchText: ${JSON.stringify(request.searchText)},
    caseSensitive: ${JSON.stringify(request.caseSensitive)},
    wholeWord: ${JSON.stringify(request.wholeWord)},
    layerNames: ${JSON.stringify(request.layerNames ?? null)}
  };
  const report = collectTextMatches(doc, searchOptions);
  const warnings = [];
  if (report.blockedMatchCount > 0) {
    warnings.push('One or more matches are in locked, uneditable, or linked text and cannot be replaced by this MCP.');
  }
  if (report.specialGlyphCount > 0) {
    warnings.push('Dynamic fields, page numbers, line breaks, and other special glyphs are search boundaries and are never replaced.');
  }
  warnings.push('Only editable Affinity text layers are searched; rasterized, outlined, and embedded-document text require another workflow.');
  console.log(resultMarker + JSON.stringify({
    documentSessionUuid: doc.sessionUuid,
    title: doc.title,
    path: doc.path,
    search: searchOptions,
    textLayerCount: report.textLayerCount,
    includedTextLayerCount: report.includedTextLayerCount,
    editableTextLayerCount: report.editableTextLayerCount,
    matchCount: report.matchCount,
    replaceableMatchCount: report.replaceableMatchCount,
    blockedMatchCount: report.blockedMatchCount,
    matchedLayerCount: report.matchedLayerCount,
    scannedGlyphCount: report.scannedGlyphCount,
    matchFingerprint: report.matchFingerprint,
    blockedLayers: report.blockedLayers,
    matches: report.matches,
    warnings,
    ...documentState(doc)
  }));
`,
  );
}

export function buildReplaceTextScript(request: TextReplaceRequest): string {
  return withDocument(
    request.documentSessionUuid,
    `
  const { Selection, TextSelection } = require('/selections');
  const { CompoundCommandBuilder, DocumentCommand } = require('/commands');
  const { StoryRange } = require('affinity:story');
${TEXT_MATCHING_HELPERS}
  const expectedHistoryPosition = ${JSON.stringify(request.expectedHistoryPosition)};
  if (doc.history.position !== expectedHistoryPosition) {
    throw new Error(
      'The document history changed before text replacement. Expected position ' +
      expectedHistoryPosition + ', found ' + doc.history.position + '.'
    );
  }
  const searchOptions = {
    searchText: ${JSON.stringify(request.searchText)},
    caseSensitive: ${JSON.stringify(request.caseSensitive)},
    wholeWord: ${JSON.stringify(request.wholeWord)},
    layerNames: ${JSON.stringify(request.layerNames ?? null)}
  };
  const report = collectTextMatches(doc, searchOptions);
  const expectedMatchCount = ${JSON.stringify(request.expectedMatchCount)};
  if (report.matchCount !== expectedMatchCount) {
    throw new Error(
      'The text match count changed before replacement. Expected ' +
      expectedMatchCount + ', found ' + report.matchCount + '.'
    );
  }
  const expectedMatchFingerprint = ${JSON.stringify(request.expectedMatchFingerprint)};
  if (report.matchFingerprint !== expectedMatchFingerprint) {
    throw new Error('The text match fingerprint changed before replacement.');
  }
  if (report.blockedMatchCount > 0) {
    throw new Error(
      'Text replacement was refused because ' + report.blockedMatchCount +
      ' matching occurrence(s) are locked, uneditable, or part of linked text flows.'
    );
  }
  if (report.matchCount < 1) throw new Error('No replaceable text matches were found.');

  const replacementText = ${JSON.stringify(request.replacementText)};
  if (replacementText.length * report.matchCount > MAX_TEXT_INSERTED_CODE_UNITS) {
    throw new Error(
      'Text replacement exceeded the maximum of ' + MAX_TEXT_INSERTED_CODE_UNITS +
      ' inserted UTF-16 code units per document.'
    );
  }
  const orderedMatches = [...report.internalMatches].sort((left, right) =>
    right.layerIndex - left.layerIndex || right.begin - left.begin
  );
  const expectedLayerTexts = new Map();
  for (const match of orderedMatches) {
    if (expectedLayerTexts.has(match.layerIndex)) continue;
    const state = visibleTextState(match.node);
    let expectedText = state.text;
    const layerMatches = orderedMatches.filter((candidate) => candidate.layerIndex === match.layerIndex);
    for (const layerMatch of layerMatches) {
      const startOffset = state.offsetsByStoryPosition.get(layerMatch.begin);
      const endOffset = state.offsetsByStoryPosition.get(layerMatch.end);
      if (startOffset === undefined || endOffset === undefined) {
        throw new Error('Affinity could not map a planned text range back to visible text.');
      }
      expectedText = expectedText.slice(0, startOffset) + replacementText + expectedText.slice(endOffset);
    }
    expectedLayerTexts.set(match.layerIndex, {
      originalText: state.text,
      expectedText
    });
  }

  const compound = CompoundCommandBuilder.create();
  for (const match of orderedMatches) {
    const selection = Selection.create(doc, match.node);
    const textSelection = TextSelection.create([new StoryRange(match.begin, match.end)]);
    if (!selection.addSubSelectionForNode(match.node, textSelection)) {
      throw new Error('Affinity could not attach a text range to layer index ' + match.layerIndex + '.');
    }
    compound.addCommand(
      DocumentCommand.createSetText(selection, replacementText)
    );
  }

  const previousHistoryPosition = doc.history.position;
  const guardedRollback = () => {
    if (doc.history.position === previousHistoryPosition + 1 && doc.history.canUndo) {
      try {
        doc.undo(false);
        const restoredLayers = [...doc.layers.all];
        const contentRestored = [...expectedLayerTexts].every(([layerIndex, expected]) => {
          const restoredNode = restoredLayers[layerIndex];
          return restoredNode && restoredNode.isTextNode && visibleTextState(restoredNode).text === expected.originalText;
        });
        return doc.history.position === previousHistoryPosition && contentRestored
          ? 'succeeded'
          : 'did not restore the exact prior history and text';
      } catch (rollbackError) {
        return 'failed with: ' + (rollbackError && rollbackError.message ? rollbackError.message : String(rollbackError));
      }
    }
    return 'not attempted because the history position was not the single expected step';
  };
  try {
    doc.executeCommand(compound.createCommand());
  } catch (executionError) {
    const rollback = guardedRollback();
    throw new Error(
      'Affinity threw while executing the text replacement: ' +
      (executionError && executionError.message ? executionError.message : String(executionError)) +
      '. Guarded rollback ' + rollback + '.'
    );
  }

  const failPostcondition = (message) => {
    throw new Error(message + ' Guarded rollback ' + guardedRollback() + '.');
  };

  if (doc.history.position !== previousHistoryPosition + 1) {
    failPostcondition(
      'Affinity created an unexpected number of history entries for text replacement. Expected ' +
      (previousHistoryPosition + 1) + ', found ' + doc.history.position + '.'
    );
  }
  const updatedLayers = [...doc.layers.all];
  let textReadbackMatches = false;
  try {
    textReadbackMatches = [...expectedLayerTexts].every(([layerIndex, expected]) => {
      const updatedNode = updatedLayers[layerIndex];
      return updatedNode && updatedNode.isTextNode && visibleTextState(updatedNode).text === expected.expectedText;
    });
  } catch (readbackError) {
    failPostcondition(
      'Affinity could not read back the complete text replacement: ' +
      (readbackError && readbackError.message ? readbackError.message : String(readbackError)) + '.'
    );
  }
  if (!textReadbackMatches) {
    failPostcondition('Affinity text readback did not match the complete planned replacement.');
  }
  const affectedLayers = [...new Map(report.matches.map((match) => [
    match.layerIndex,
    { layerIndex: match.layerIndex, layerName: match.layerName, layerType: match.layerType }
  ])).values()];
  console.log(resultMarker + JSON.stringify({
    replaced: true,
    saved: false,
    documentSessionUuid: doc.sessionUuid,
    title: doc.title,
    path: doc.path,
    search: searchOptions,
    replacementText,
    replacementCount: report.matchCount,
    affectedLayerCount: affectedLayers.length,
    affectedLayers,
    previousHistoryPosition,
    matchFingerprint: report.matchFingerprint,
    postconditions: {
      exactHistoryStep: true,
      completeTextReadback: true
    },
    formatting: {
      surroundingFormattingPreserved: true,
      replacementInheritsStartOfRange: true,
      mixedFormattingInsideReplacedRangePreserved: false
    },
    warnings: [
      'The replacements are open and unsaved.',
      'Longer text can reflow or overflow a frame; render a preview before saving.'
    ],
    ...documentState(doc)
  }));
`,
  );
}

export function buildInspectDocumentScript(documentSessionUuid: string): string {
  return withDocument(
    documentSessionUuid,
    `
  console.log(resultMarker + JSON.stringify({
    title: doc.title,
    path: doc.path,
    sessionUuid: doc.sessionUuid,
    persistentUuid: doc.persistentUuid,
    isReadOnly: doc.isReadOnly,
    mustSaveAs: doc.mustSaveAs,
    ...documentState(doc),
    widthPixels: doc.widthPixels,
    heightPixels: doc.heightPixels,
    dpi: doc.dpi
  }));
`,
  );
}

export function buildSaveDocumentScript(documentSessionUuid: string, expectedPath: string): string {
  return withDocument(
    documentSessionUuid,
    `
  const expectedPath = ${JSON.stringify(expectedPath)};
  if (doc.path !== expectedPath) throw new Error('The document path changed before it could be saved.');
  if (doc.isReadOnly) throw new Error('This document is read-only.');
  if (doc.mustSaveAs) throw new Error('This document has no writable path; use a saved or opened document before calling save.');
  const neededSavingBefore = doc.needsSaving;
  doc.save();
  console.log(resultMarker + JSON.stringify({
    saved: true,
    path: doc.path,
    title: doc.title,
    sessionUuid: doc.sessionUuid,
    neededSavingBefore,
    needsSaving: doc.needsSaving
  }));
`,
  );
}

export function buildListLayersScript(documentSessionUuid: string): string {
  return withDocument(
    documentSessionUuid,
    `
  const selectedNodes = doc.selection.nodes;
  const layers = [...doc.layers.all].map((node, index) => ({
    index,
    ...summarizeNode(node),
    selected: selectedNodes.some((selected) => selected.isSameNode(node))
  }));
  console.log(resultMarker + JSON.stringify({
    documentSessionUuid: doc.sessionUuid,
    title: doc.title,
    ...documentState(doc),
    layers
  }));
`,
  );
}

export function buildSelectLayerScript(documentSessionUuid: string, name: string, occurrence: number): string {
  return withDocument(
    documentSessionUuid,
    `
  const { Selection } = require('/selections');
  const requestedName = ${JSON.stringify(name)};
  const matches = [...doc.layers.all].filter((node) => displayName(node) === requestedName);
  const occurrence = ${JSON.stringify(occurrence)};
  if (matches.length <= occurrence) {
    throw new Error('No layer named "' + requestedName + '" exists at occurrence ' + occurrence + '. Found: ' + matches.length);
  }
  const node = matches[occurrence];
  doc.selection = Selection.create(doc, node);
  console.log(resultMarker + JSON.stringify({ selected: true, matchCount: matches.length, node: summarizeNode(node) }));
`,
  );
}

export function buildAddLayerScript(request: AddLayerRequest): string {
  return withDocument(
    request.documentSessionUuid,
    `
  const { ContainerNodeDefinition } = require('/nodes');
  const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
  const definition = ContainerNodeDefinition.create(${JSON.stringify(request.name)});
  const builder = AddChildNodesCommandBuilder.create();
  builder.addNode(definition);
  const command = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  console.log(resultMarker + JSON.stringify({ created: true, node: summarizeNode(node), sessionUuid: doc.sessionUuid, ...documentState(doc) }));
`,
  );
}

export function buildAddShapeScript(request: AddShapeRequest): string {
  const fill = parseHexColour(request.fill);
  const stroke = request.stroke === undefined ? undefined : parseHexColour(request.stroke);
  const shapeFactory = request.shape === "rectangle" ? "ShapeRectangle" : "ShapeEllipse";
  return withDocument(
    request.documentSessionUuid,
    `
  const { ShapeNodeDefinition } = require('/nodes');
  const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
  const { ShapeRectangle, ShapeEllipse } = require('/shapes');
  const { FillDescriptor } = require('/fills');
  const { Rectangle } = require('/geometry');
  const { LineStyleDescriptor } = require('/linestyle');
  const { RGBA8 } = require('/colours');
  const { BlendMode } = require('affinity:common');
  const shape = ${shapeFactory}.create();
  const bounds = new Rectangle(${JSON.stringify(request.x)}, ${JSON.stringify(request.y)}, ${JSON.stringify(request.width)}, ${JSON.stringify(request.height)});
  const fill = FillDescriptor.createSolid(RGBA8(${fill.r}, ${fill.g}, ${fill.b}, ${fill.a}), BlendMode.Normal);
  const stroke = ${stroke === undefined ? "FillDescriptor.createNone()" : `FillDescriptor.createSolid(RGBA8(${stroke.r}, ${stroke.g}, ${stroke.b}, ${stroke.a}), BlendMode.Normal)`};
  const lineStyle = LineStyleDescriptor.createDefault(${JSON.stringify(request.strokeWidth ?? 1)});
  const transparency = FillDescriptor.createNone();
  const definition = ShapeNodeDefinition.create(shape, bounds, fill, stroke, lineStyle, transparency);
  definition.userDescription = ${JSON.stringify(request.name ?? request.shape)};
  const builder = AddChildNodesCommandBuilder.create();
  builder.addNode(definition);
  const command = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  console.log(resultMarker + JSON.stringify({ created: true, node: summarizeNode(node), sessionUuid: doc.sessionUuid, ...documentState(doc) }));
`,
  );
}

export function buildAddTextScript(request: AddTextRequest): string {
  const color = parseHexColour(request.color);
  const alignment = {
    left: "Left",
    center: "Centre",
    right: "Right",
    justify: "JustifyAll",
  }[request.alignment];
  if (request.kind === "frame" && (!(request.frameWidth && request.frameWidth > 0) || !(request.frameHeight && request.frameHeight > 0))) {
    throw new McpFailure("FRAME_DIMENSIONS_REQUIRED", "Frame text requires positive frameWidth and frameHeight values.");
  }
  return withDocument(
    request.documentSessionUuid,
    `
  const { StoryBuilder } = require('/storybuilder');
  const { StoryDelta } = require('/storydelta');
  const { GlyphAttDoubleType } = require('/glyphatts');
  const { ParagraphAlignXType } = require('/paragraphatts');
  const { ArtTextNodeDefinition, FrameTextNodeDefinition } = require('/nodes');
  const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
  const { FillDescriptor } = require('/fills');
  const { RGBA8 } = require('/colours');
  const { BlendMode } = require('affinity:common');
  const story = StoryBuilder.create();
  ${request.kind === "frame" ? "story.setToFrameTextDefaultStyle(doc.dpi, doc.format);" : "story.setToArtisticTextDefaultStyle(doc.dpi, doc.format);"}
  story.applyGlyphDelta(StoryDelta.createGlyphDouble(GlyphAttDoubleType.Height, ${JSON.stringify(request.fontSize)}));
  story.applyGlyphDelta(StoryDelta.createBrushFill(FillDescriptor.createSolid(RGBA8(${color.r}, ${color.g}, ${color.b}, ${color.a}), BlendMode.Normal)));
  story.applyParagraphDelta(StoryDelta.createAlignX(ParagraphAlignXType.${alignment}));
  story.addText(${JSON.stringify(request.text)});
  const definition = ${
    request.kind === "frame"
      ? `FrameTextNodeDefinition.createFromStoryBuilder({ x: ${JSON.stringify(request.x)}, y: ${JSON.stringify(request.y)}, width: ${JSON.stringify(request.frameWidth)}, height: ${JSON.stringify(request.frameHeight)} }, story)`
      : `ArtTextNodeDefinition.createFromStoryBuilder({ x: ${JSON.stringify(request.x)}, y: ${JSON.stringify(request.y)} }, story)`
  };
  definition.userDescription = ${JSON.stringify(request.name ?? "Text")};
  const builder = AddChildNodesCommandBuilder.create();
  builder.addNode(definition);
  const command = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  console.log(resultMarker + JSON.stringify({ created: true, node: summarizeNode(node), sessionUuid: doc.sessionUuid, ...documentState(doc) }));
`,
  );
}

export function buildPlaceImageScript(request: PlaceImageRequest): string {
  return withDocument(
    request.documentSessionUuid,
    `
  const { Bitmap } = require('/rasterobject');
  const { ImageNodeDefinition } = require('/nodes');
  const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
  const { Selection } = require('/selections');
  const { TransformBuilder } = require('/geometry');
  const bitmap = Bitmap.loadFromFile(${JSON.stringify(request.stagedImagePath)}, doc.format);
  const definition = ImageNodeDefinition.create(doc.format);
  definition.bitmap = bitmap;
  definition.userDescription = ${JSON.stringify(request.name ?? "Placed image")};
  const builder = AddChildNodesCommandBuilder.create();
  builder.addNode(definition);
  const command = builder.createCommand(true, NodeChildType.Main);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  const before = node.getSpreadBaseBox();
  let scaleX = 1;
  let scaleY = 1;
  const requestedWidth = ${request.width === undefined ? "null" : JSON.stringify(request.width)};
  const requestedHeight = ${request.height === undefined ? "null" : JSON.stringify(request.height)};
  if (requestedWidth !== null && requestedHeight !== null) {
    scaleX = requestedWidth / before.width;
    scaleY = requestedHeight / before.height;
  } else if (requestedWidth !== null) {
    scaleX = scaleY = requestedWidth / before.width;
  } else if (requestedHeight !== null) {
    scaleX = scaleY = requestedHeight / before.height;
  }
  const transform = new TransformBuilder()
    .translate(-before.x, -before.y)
    .scale(scaleX, scaleY)
    .translate(${JSON.stringify(request.x)}, ${JSON.stringify(request.y)})
    .transform;
  const selection = Selection.create(doc, node);
  doc.applyTransform(transform, node);
  doc.selection = selection;
  console.log(resultMarker + JSON.stringify({
    created: true,
    sourcePixelWidth: bitmap.width,
    sourcePixelHeight: bitmap.height,
    node: summarizeNode(node),
    sessionUuid: doc.sessionUuid,
    ...documentState(doc)
  }));
`,
  );
}

export function buildTransformSelectionScript(request: TransformSelectionRequest): string {
  return withDocument(
    request.documentSessionUuid,
    `
  const { TransformBuilder } = require('/geometry');
  const selection = doc.selection;
  if (!selection || selection.length === 0) throw new Error('Select at least one layer before transforming it.');
  const selectedNodes = [...selection.nodes];
  const before = selectedNodes.map(summarizeNode);
  const boxes = selectedNodes.map((node) => node.getSpreadBaseBox(false));
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const transform = new TransformBuilder()
    .translate(-centerX, -centerY)
    .scale(${JSON.stringify(request.scaleX)}, ${JSON.stringify(request.scaleY)})
    .rotate(${JSON.stringify((request.rotationDegrees * Math.PI) / 180)})
    .translate(centerX + ${JSON.stringify(request.translateX)}, centerY + ${JSON.stringify(request.translateY)})
    .transform;
  doc.applyTransform(transform, selection);
  console.log(resultMarker + JSON.stringify({ transformed: true, before, after: [...selection.nodes].map(summarizeNode), ...documentState(doc) }));
`,
  );
}

export function buildSetFillScript(documentSessionUuid: string, colorValue: string): string {
  const color = parseHexColour(colorValue);
  return withDocument(
    documentSessionUuid,
    `
  const { RGBA8 } = require('/colours');
  const selection = doc.selection;
  if (!selection || selection.length === 0) throw new Error('Select at least one layer before changing its fill.');
  doc.setBrushFillDescriptor(RGBA8(${color.r}, ${color.g}, ${color.b}, ${color.a}), selection);
  console.log(resultMarker + JSON.stringify({ updated: true, color: ${JSON.stringify(colorValue.toUpperCase())}, nodes: [...selection.nodes].map(summarizeNode), ...documentState(doc) }));
`,
  );
}

export function buildAddLiveEffectScript(request: AddLiveEffectRequest): string {
  let setup: string;
  if (request.effect === "exposure") {
    setup = `
  const { ExposureAdjustmentRasterNodeDefinition, ExposureAdjustmentParameters } = require('/nodes');
  const parameters = new ExposureAdjustmentParameters();
  parameters.exposure = ${JSON.stringify(request.amount ?? 0)};
  const definition = ExposureAdjustmentRasterNodeDefinition.create(parameters);`;
  } else if (request.effect === "gaussian_blur") {
    setup = `
  const { GaussianBlurFilterRasterNodeDefinition, GaussianBlurFilterParameters } = require('/nodes');
  const parameters = new GaussianBlurFilterParameters();
  parameters.radius = ${JSON.stringify(request.amount ?? 0)};
  const definition = GaussianBlurFilterRasterNodeDefinition.create(parameters);`;
  } else {
    setup = `
  const { InvertAdjustmentRasterNodeDefinition } = require('/nodes');
  const definition = InvertAdjustmentRasterNodeDefinition.create();`;
  }
  return withDocument(
    request.documentSessionUuid,
    `
  const { AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
${setup}
  const target = doc.selection.firstNode;
  if (!target || doc.selection.length !== 1) throw new Error('Select exactly one layer before adding a live effect.');
  definition.userDescription = ${JSON.stringify(request.name ?? request.effect)};
  const builder = AddChildNodesCommandBuilder.create();
  builder.addNode(definition);
  builder.setInsertionTarget(target);
  const command = builder.createCommand(true, NodeChildType.Enclosure);
  doc.executeCommand(command);
  const node = command.newNodes[0];
  console.log(resultMarker + JSON.stringify({ created: true, effect: ${JSON.stringify(request.effect)}, amount: ${JSON.stringify(request.amount ?? null)}, node: summarizeNode(node), ...documentState(doc) }));
`,
  );
}

export function buildListExportPresetsScript(): string {
  return wrapScript(`
  const { FileExportOptions } = require('/document');
  console.log(resultMarker + JSON.stringify({ presets: [...FileExportOptions.allPresetNames] }));
  `);
}

export function buildUndoScript(documentSessionUuid: string, expectedHistoryPosition: number): string {
  return withDocument(
    documentSessionUuid,
    `
  const expectedHistoryPosition = ${JSON.stringify(expectedHistoryPosition)};
  const previousHistoryPosition = doc.history.position;
  if (previousHistoryPosition !== expectedHistoryPosition) {
    throw new Error('The document history changed before undo. Expected position ' + expectedHistoryPosition + ', found ' + previousHistoryPosition + '.');
  }
  if (!doc.history.canUndo) throw new Error('This document has no operation to undo.');
  const undoneDescription = doc.history.undoDescription;
  doc.undo(false);
  console.log(resultMarker + JSON.stringify({
    undone: true,
    sessionUuid: doc.sessionUuid,
    previousHistoryPosition,
    undoneDescription,
    ...documentState(doc)
  }));
`,
  );
}

export function buildExportDocumentScript(
  documentSessionUuid: string,
  stagingPath: string,
  preset: string,
  area: ExportArea,
): string {
  const areaFactory = {
    whole_document: "createForWholeDocument",
    current_spread: "createForCurrentSpread",
    current_page: "createForCurrentPage",
  }[area];
  return withDocument(
    documentSessionUuid,
    `
  const { FileExportOptions, FileExportArea } = require('/document');
  const availablePresets = FileExportOptions.allPresetNames;
  const requestedPreset = ${JSON.stringify(preset)};
  if (!availablePresets.includes(requestedPreset)) throw new Error('Export preset is unavailable: ' + requestedPreset);
  const options = FileExportOptions.createWithPresetName(requestedPreset);
  const exportArea = FileExportArea.${areaFactory}();
  const records = doc.export(${JSON.stringify(stagingPath)}, options, exportArea, null);
  const results = records.all.map((record) => ({
    path: record.path,
    success: record.isSuccess,
    hasWarnings: record.hasWarnings,
    warning: record.hasWarnings ? record.warningMessage : null,
    error: record.isSuccess ? null : record.errorMessage
  }));
  console.log(resultMarker + JSON.stringify({ exported: true, preset: requestedPreset, area: ${JSON.stringify(area)}, records: results }));
`,
  );
}
