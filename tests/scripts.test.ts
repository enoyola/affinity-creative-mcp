import { describe, expect, it } from "vitest";
import { buildCreateDocumentScript, normalizeDocumentRequest } from "../src/scripts.js";

describe("document request normalization", () => {
  it("defaults to an RGB/8 Photo canvas in pixels", () => {
    const request = normalizeDocumentRequest({ width: 1920, height: 1080, outputPath: "/tmp/example.af" });
    expect(request).toMatchObject({
      workspace: "photo",
      width: 1920,
      height: 1080,
      unit: "px",
      dpi: 300,
      rasterFormat: "RGBA8",
      pages: 1,
      createsArtboard: false,
      createsMultiPageDocument: false,
    });
  });

  it("maps Designer and Publisher semantics", () => {
    const designer = normalizeDocumentRequest({ workspace: "designer", width: 1000, height: 1000, outputPath: "/tmp/d.af" });
    const publisher = normalizeDocumentRequest({
      workspace: "publisher",
      width: 210,
      height: 297,
      unit: "mm",
      pages: 8,
      facingPages: true,
      outputPath: "/tmp/p.af",
    });
    expect(designer.createsArtboard).toBe(true);
    expect(publisher).toMatchObject({ createsMultiPageDocument: true, pages: 8, facingPages: true });
  });

  it("rejects fractional pixels and non-Publisher multi-page requests", () => {
    expect(() => normalizeDocumentRequest({ width: 10.5, height: 10, outputPath: "/tmp/a.af" })).toThrow(/whole numbers/);
    expect(() => normalizeDocumentRequest({ workspace: "photo", width: 10, height: 10, pages: 2, outputPath: "/tmp/a.af" })).toThrow(
      /publisher/i,
    );
  });

  it("rejects documents that exceed the native resource guardrails", () => {
    expect(() => normalizeDocumentRequest({ width: 200_000, height: 200_000, outputPath: "/tmp/huge.af" })).toThrow(/resource limits/);
    expect(() =>
      normalizeDocumentRequest({ workspace: "publisher", width: 210, height: 297, unit: "mm", pages: 501, outputPath: "/tmp/huge.af" }),
    ).toThrow(/between 1 and 500/);
  });
});

describe("Affinity script generation", () => {
  it("uses fixed SDK operations and JSON-escapes the staging path", () => {
    const request = normalizeDocumentRequest({ workspace: "designer", width: 2048, height: 2048, transparent: true, outputPath: "/tmp/a.af" });
    const stagingPath = '/tmp/a "quoted" path.af';
    const script = buildCreateDocumentScript(request, stagingPath);
    expect(script).toContain("NewDocumentOptions.createDefault()");
    expect(script).toContain("options.createArtboard = true");
    expect(script).toContain("options.isTransparentBackground = true");
    expect(script).toContain(`createdDocument.saveAs(${JSON.stringify(stagingPath)})`);
    expect(script).toContain("path: createdDocument.path");
    expect(script).toContain("sessionUuid: createdDocument.sessionUuid");
    expect(script).not.toContain(".close(");
    expect(script).not.toContain("child_process");
  });
});
