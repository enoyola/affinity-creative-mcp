import { describe, expect, it } from "vitest";
import {
  buildAddLayerScript,
  buildAddShapeScript,
  buildAddTextScript,
  buildExportDocumentScript,
  buildFindTextScript,
  buildPlaceImageScript,
  buildReplaceTextScript,
  buildSelectLayerScript,
  buildSetFillScript,
  buildTransformSelectionScript,
  buildUndoScript,
  parseHexColour,
  type AddTextRequest,
  type TextReplaceRequest,
  type TextSearchRequest,
} from "../src/editing-scripts.js";
import { ERROR_MARKER, RESULT_MARKER } from "../src/scripts.js";

const SESSION = 'session-"quoted"\nsecond-line';

function artisticText(overrides: Partial<AddTextRequest> = {}): AddTextRequest {
  return {
    documentSessionUuid: SESSION,
    text: "Hello",
    x: 10,
    y: 20,
    kind: "artistic",
    fontSize: 48,
    color: "#12345678",
    alignment: "left",
    ...overrides,
  };
}

function textSearch(overrides: Partial<TextSearchRequest> = {}): TextSearchRequest {
  return {
    documentSessionUuid: SESSION,
    searchText: "XYZ",
    caseSensitive: true,
    wholeWord: false,
    ...overrides,
  };
}

function textReplacement(overrides: Partial<TextReplaceRequest> = {}): TextReplaceRequest {
  return {
    ...textSearch(),
    replacementText: "ABC",
    expectedHistoryPosition: 0,
    expectedMatchCount: 2,
    expectedMatchFingerprint: "v1-0123456789abcdef",
    ...overrides,
  };
}

describe("Affinity editing script generation", () => {
  it("parses six- and eight-digit colours and rejects every other notation", () => {
    expect(parseHexColour("#00aAfF")).toEqual({ r: 0, g: 170, b: 255, a: 255 });
    expect(parseHexColour("#10203040")).toEqual({ r: 16, g: 32, b: 48, a: 64 });

    for (const value of ["red", "#fff", "#12345g", "123456", "#123456789", "#12 3456"]) {
      expect(() => parseHexColour(value)).toThrow(/#RRGGBB or #RRGGBBAA/);
      try {
        parseHexColour(value);
      } catch (error) {
        expect(error).toMatchObject({ code: "INVALID_COLOUR" });
      }
    }
  });

  it("emits fixed shape/layer APIs and JSON-escapes all string values", () => {
    const layerName = 'Badge "primary"\nlayer';
    const layerScript = buildAddLayerScript({ documentSessionUuid: SESSION, name: layerName });
    const shapeScript = buildAddShapeScript({
      documentSessionUuid: SESSION,
      shape: "ellipse",
      x: 12.5,
      y: -8,
      width: 320,
      height: 180,
      fill: "#01020304",
      stroke: "#A0B0C0",
      strokeWidth: 6,
      name: layerName,
    });

    expect(layerScript).toContain(`const requestedSessionUuid = ${JSON.stringify(SESSION)};`);
    expect(layerScript).toContain(`ContainerNodeDefinition.create(${JSON.stringify(layerName)})`);
    expect(layerScript).toContain("AddChildNodesCommandBuilder.create()");
    expect(shapeScript).toContain(`definition.userDescription = ${JSON.stringify(layerName)};`);
    expect(shapeScript).toContain("ShapeEllipse.create()");
    expect(shapeScript).toContain("ShapeNodeDefinition.create(");
    expect(shapeScript).toContain("RGBA8(1, 2, 3, 4)");
    expect(shapeScript).toContain("RGBA8(160, 176, 192, 255)");
    expect(shapeScript).toContain("doc.executeCommand(command)");

    for (const script of [layerScript, shapeScript]) {
      expect(script).toContain(JSON.stringify(RESULT_MARKER));
      expect(script).toContain(JSON.stringify(ERROR_MARKER));
      expect(script).not.toContain("eval(");
      expect(script).not.toContain("child_process");
      expect(script).not.toContain("saveAs(");
    }
  });

  it("uses fixed text APIs, preserves text literally, and validates frame dimensions", () => {
    const text = 'First line\n"quoted" \\ slash ${notCode}';
    const name = 'Headline "A"';
    const artScript = buildAddTextScript(artisticText({ text, name, alignment: "center" }));
    const frameScript = buildAddTextScript(
      artisticText({ kind: "frame", frameWidth: 640, frameHeight: 360, alignment: "justify" }),
    );

    expect(artScript).toContain(`story.addText(${JSON.stringify(text)})`);
    expect(artScript).toContain(`definition.userDescription = ${JSON.stringify(name)};`);
    expect(artScript).toContain("ArtTextNodeDefinition.createFromStoryBuilder(");
    expect(artScript).toContain("setToArtisticTextDefaultStyle(doc.dpi, doc.format)");
    expect(artScript).not.toContain("doc.rasterFormat");
    expect(artScript).toContain("ParagraphAlignXType.Centre");
    expect(artScript).toContain("RGBA8(18, 52, 86, 120)");
    expect(frameScript).toContain("FrameTextNodeDefinition.createFromStoryBuilder(");
    expect(frameScript).toContain("width: 640, height: 360");
    expect(frameScript).toContain("ParagraphAlignXType.JustifyAll");

    for (const request of [
      artisticText({ kind: "frame" }),
      artisticText({ kind: "frame", frameWidth: 100 }),
      artisticText({ kind: "frame", frameWidth: 0, frameHeight: 100 }),
      artisticText({ kind: "frame", frameWidth: 100, frameHeight: -1 }),
    ]) {
      expect(() => buildAddTextScript(request)).toThrow(/positive frameWidth and frameHeight/);
      try {
        buildAddTextScript(request);
      } catch (error) {
        expect(error).toMatchObject({ code: "FRAME_DIMENSIONS_REQUIRED" });
      }
    }
  });

  it("rejects invalid colours before generating a native script", () => {
    expect(() =>
      buildAddShapeScript({
        documentSessionUuid: SESSION,
        shape: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fill: "blue",
      }),
    ).toThrow(/#RRGGBB/);
    expect(() =>
      buildAddShapeScript({
        documentSessionUuid: SESSION,
        shape: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        fill: "#000000",
        stroke: "rgb(1, 2, 3)",
      }),
    ).toThrow(/#RRGGBB/);
    expect(() => buildAddTextScript(artisticText({ color: "#abcd" }))).toThrow(/#RRGGBB/);
    expect(() => buildSetFillScript(SESSION, "transparent")).toThrow(/#RRGGBB/);
  });

  it("keeps file placement, transforms, and export on fixed SDK operations", () => {
    const stagedImagePath = '/Users/test/Desktop/image "one"\n.png';
    const exportPath = '/Users/test/Desktop/export "one".png';
    const placeScript = buildPlaceImageScript({
      documentSessionUuid: SESSION,
      stagedImagePath,
      x: 25,
      y: 50,
      width: 800,
      name: "Placed image",
    });
    const transformScript = buildTransformSelectionScript({
      documentSessionUuid: SESSION,
      translateX: 5,
      translateY: -10,
      scaleX: 2,
      scaleY: 0.5,
      rotationDegrees: 90,
    });
    const exportScript = buildExportDocumentScript(SESSION, exportPath, "PNG", "current_page");

    expect(placeScript).toContain(`Bitmap.loadFromFile(${JSON.stringify(stagedImagePath)}, doc.format)`);
    expect(placeScript).toContain("ImageNodeDefinition.create(doc.format)");
    expect(transformScript).toContain("new TransformBuilder()");
    expect(transformScript).toContain(`.rotate(${JSON.stringify(Math.PI / 2)})`);
    expect(exportScript).toContain(`const requestedPreset = ${JSON.stringify("PNG")};`);
    expect(exportScript).toContain(`doc.export(${JSON.stringify(exportPath)}, options, exportArea, null)`);
    expect(exportScript).toContain("FileExportArea.createForCurrentPage()");

    for (const script of [placeScript, transformScript, exportScript]) {
      expect(script).not.toContain("eval(");
      expect(script).not.toContain("child_process");
    }
  });

  it("uses the displayed layer name consistently and guards undo with history position", () => {
    const selectScript = buildSelectLayerScript(SESSION, "AFFINITY_MCP_RESULT: layer", 1);
    const undoScript = buildUndoScript(SESSION, 42);

    expect(selectScript).toContain("displayName(node) === requestedName");
    expect(selectScript).toContain(JSON.stringify("AFFINITY_MCP_RESULT: layer"));
    expect(undoScript).toContain("const expectedHistoryPosition = 42");
    expect(undoScript).toContain("previousHistoryPosition !== expectedHistoryPosition");
    expect(undoScript).toContain("doc.history.canUndo");
    expect(undoScript).toContain("doc.history.undoDescription");
  });

  it("JSON-escapes literal text-search inputs and keeps find read-only", () => {
    const searchText = '"; globalThis.injected = true; //\nAFFINITY_MCP_ERROR:${notCode}';
    const layerNames = ['Headline "quoted"', "Second\nline", "🙂 emoji"];
    const script = buildFindTextScript(textSearch({
      searchText,
      caseSensitive: false,
      wholeWord: true,
      layerNames,
    }));

    expect(script).toContain(`const requestedSessionUuid = ${JSON.stringify(SESSION)};`);
    expect(script).toContain(`searchText: ${JSON.stringify(searchText)}`);
    expect(script).toContain(`caseSensitive: false`);
    expect(script).toContain(`wholeWord: true`);
    expect(script).toContain(`layerNames: ${JSON.stringify(layerNames)}`);
    expect(script).toContain(JSON.stringify(RESULT_MARKER));
    expect(script).toContain(JSON.stringify(ERROR_MARKER));
    expect(script).not.toContain("eval(");
    expect(script).not.toContain("DocumentCommand");
    expect(script).not.toContain("executeCommand(");
    expect(script).not.toContain("node.setText(");
  });

  it("maps text through glyph boundaries so emoji offsets become valid Story ranges", () => {
    const script = buildFindTextScript(textSearch({ searchText: "🙂" }));

    expect(script).toContain("const glyphs = [...storyInterface.glyphs]");
    expect(script).toContain("const piece = glyph.isCharGlyph === true ? glyph.string : ''");
    expect(script).toContain("searchBoundaries.set(segmentSearch.length");
    expect(script).toContain("storyPosition: storyPosition + 1");
    expect(script).toContain("const startBoundary = searchBoundaries.get(found)");
    expect(script).toContain("const endBoundary = searchBoundaries.get(found + needle.length)");
    expect(script).toContain("begin: startBoundary.storyPosition");
    expect(script).toContain("end: endBoundary.storyPosition");
    expect(script).toContain("cursor = found + Math.max(needle.length, 1)");
  });

  it("replaces guarded ranges in reverse order as one compound, undoable command", () => {
    const replacementText = 'ABC"); globalThis.injected = true; //\n🙂';
    const script = buildReplaceTextScript(textReplacement({
      replacementText,
      expectedHistoryPosition: 0,
      expectedMatchCount: 3,
      expectedMatchFingerprint: "v1-fedcba9876543210",
      layerNames: ['Text "A"', "Text\nB"],
    }));

    expect(script).toContain("const { Selection, TextSelection } = require('/selections')");
    expect(script).toContain("const { CompoundCommandBuilder, DocumentCommand } = require('/commands')");
    expect(script).toContain("const { StoryRange } = require('affinity:story')");
    expect(script).toContain("right.layerIndex - left.layerIndex || right.begin - left.begin");
    expect(script).toContain("const compound = CompoundCommandBuilder.create()");
    expect(script).toContain("const selection = Selection.create(doc, match.node)");
    expect(script).toContain("TextSelection.create([new StoryRange(match.begin, match.end)])");
    expect(script).toContain("selection.addSubSelectionForNode(match.node, textSelection)");
    expect(script).toContain(`const replacementText = ${JSON.stringify(replacementText)};`);
    expect(script).toContain("DocumentCommand.createSetText(selection, replacementText)");
    expect(script).toContain("doc.executeCommand(compound.createCommand())");
    expect(script).toContain("doc.history.position !== previousHistoryPosition + 1");
    expect(script).toContain("Affinity text readback did not match the complete planned replacement");
    expect(script).toContain("visibleTextState(updatedNode).text === expected.expectedText");
    expect(script).toContain("doc.undo(false)");
    expect(script).toContain("MAX_TEXT_GLYPHS = 500000");
    expect(script).toContain("document.isReadOnly === true");
    expect(script.match(/doc\.executeCommand\(/g)).toHaveLength(1);

    const historyGuard = script.indexOf("doc.history.position !== expectedHistoryPosition");
    const fingerprintGuard = script.indexOf("report.matchFingerprint !== expectedMatchFingerprint");
    const commandCreation = script.indexOf("const compound = CompoundCommandBuilder.create()");
    expect(historyGuard).toBeGreaterThan(-1);
    expect(fingerprintGuard).toBeGreaterThan(historyGuard);
    expect(commandCreation).toBeGreaterThan(fingerprintGuard);

    expect(script).not.toContain("node.setText(");
    expect(script).not.toContain("StoryBuilder");
    expect(script).not.toContain("eval(");
    expect(script).not.toContain("save()");
    expect(script).not.toContain("saveAs(");
  });
});
