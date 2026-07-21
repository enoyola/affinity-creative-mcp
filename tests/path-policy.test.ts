import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PathPolicy } from "../src/path-policy.js";

const cleanups: string[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function fixture(): Promise<{ base: string; root: string; outside: string; policy: PathPolicy }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "affinity-mcp-paths-"));
  cleanups.push(base);
  const root = path.join(base, "allowed");
  const outside = path.join(base, "outside");
  await Promise.all([mkdir(root), mkdir(outside)]);
  return { base, root, outside, policy: await PathPolicy.create([root]) };
}

describe("PathPolicy", () => {
  it("accepts a new Affinity file inside an allowed root", async () => {
    const { root, policy } = await fixture();
    await expect(policy.resolveNewAffinityFile(path.join(root, "new.af"))).resolves.toBe(path.join(await realpath(root), "new.af"));
  });

  it("rejects overwrite, invalid extension, and relative paths", async () => {
    const { root, policy } = await fixture();
    await writeFile(path.join(root, "exists.af"), "data");
    await expect(policy.resolveNewAffinityFile(path.join(root, "exists.af"))).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(policy.resolveNewAffinityFile(path.join(root, "image.png"))).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
    await expect(policy.resolveNewAffinityFile(path.join(root, "legacy.afdesign"))).rejects.toMatchObject({ code: "INVALID_EXTENSION" });
    await expect(policy.resolveNewAffinityFile("relative.af")).rejects.toMatchObject({ code: "ABSOLUTE_PATH_REQUIRED" });
  });

  it("rejects traversal through a symlinked parent", async () => {
    const { root, outside, policy } = await fixture();
    await symlink(outside, path.join(root, "escape"));
    await expect(policy.resolveNewAffinityFile(path.join(root, "escape", "outside.af"))).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOTS",
    });
  });

  it("accepts existing readable and writable files inside an allowed root", async () => {
    const { root, policy } = await fixture();
    const input = path.join(root, "Existing.AF");
    await writeFile(input, "affinity document");

    const canonical = await realpath(input);
    await expect(policy.resolveExistingFile(input, [".af"])).resolves.toBe(canonical);
    await expect(policy.resolveExistingWritableFile(input, [".AF"])).resolves.toBe(canonical);
  });

  it("rejects unavailable existing files, wrong extensions, and symlink escapes", async () => {
    const { root, outside, policy } = await fixture();
    const wrongExtension = path.join(root, "image.gif");
    const outsideFile = path.join(outside, "outside.af");
    await Promise.all([writeFile(wrongExtension, "image"), writeFile(outsideFile, "outside")]);
    await symlink(outsideFile, path.join(root, "linked.af"));

    await expect(policy.resolveExistingFile(path.join(root, "missing.af"), [".af"])).rejects.toMatchObject({
      code: "INPUT_FILE_UNAVAILABLE",
    });
    await expect(policy.resolveExistingFile(wrongExtension, [".png", ".jpg"])).rejects.toMatchObject({
      code: "INVALID_EXTENSION",
    });
    await expect(policy.resolveExistingFile(path.join(root, "linked.af"), [".af"])).rejects.toMatchObject({
      code: "PATH_OUTSIDE_ALLOWED_ROOTS",
    });
  });

  it("rejects an existing file that is not writable", async () => {
    const { root, policy } = await fixture();
    const input = path.join(root, "locked.af");
    await writeFile(input, "read only");
    await chmod(input, 0o444);

    await expect(policy.resolveExistingFile(input, [".af"])).resolves.toBe(await realpath(input));
    await expect(policy.resolveExistingWritableFile(input, [".af"])).rejects.toMatchObject({ code: "INPUT_FILE_NOT_WRITABLE" });
  });

  it("validates new export paths without overwriting existing outputs", async () => {
    const { root, policy } = await fixture();
    const png = path.join(root, "preview.PNG");
    const pdf = path.join(root, "proof.pdf");

    await expect(policy.resolveNewFile(png, [".png"])).resolves.toBe(path.join(await realpath(root), "preview.PNG"));
    await expect(policy.resolveNewFile(pdf, [".pdf"])).resolves.toBe(path.join(await realpath(root), "proof.pdf"));
    await writeFile(png, "existing export");
    await expect(policy.resolveNewFile(png, [".png"])).rejects.toMatchObject({ code: "OUTPUT_EXISTS" });
    await expect(policy.resolveNewFile(path.join(root, "preview.webp"), [".png", ".jpg"])).rejects.toMatchObject({
      code: "INVALID_EXTENSION",
    });
  });
});
