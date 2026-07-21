import { constants as fsConstants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { McpFailure } from "./errors.js";

const AFFINITY_EXTENSION = ".af";

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export class PathPolicy {
  readonly roots: string[];

  private constructor(roots: string[]) {
    this.roots = roots;
  }

  static async create(configuredRoots: string[]): Promise<PathPolicy> {
    if (configuredRoots.length === 0) {
      throw new McpFailure("NO_ALLOWED_ROOTS", "At least one allowed output root must be configured.");
    }

    const roots: string[] = [];
    for (const configuredRoot of configuredRoots) {
      try {
        const canonical = await realpath(configuredRoot);
        const info = await lstat(canonical);
        if (!info.isDirectory()) throw new Error("not a directory");
        await access(canonical, fsConstants.R_OK | fsConstants.W_OK);
        roots.push(canonical);
      } catch (error) {
        throw new McpFailure("INVALID_ALLOWED_ROOT", `Allowed root is unavailable or not writable: ${configuredRoot}`, {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return new PathPolicy([...new Set(roots)]);
  }

  async resolveNewAffinityFile(requestedPath: string): Promise<string> {
    return this.resolveNewFile(requestedPath, [AFFINITY_EXTENSION]);
  }

  async resolveExistingFile(requestedPath: string, allowedExtensions?: readonly string[]): Promise<string> {
    if (!path.isAbsolute(requestedPath)) {
      throw new McpFailure("ABSOLUTE_PATH_REQUIRED", "The file path must be absolute.");
    }
    if (requestedPath.includes("\0")) {
      throw new McpFailure("INVALID_PATH", "The file path contains an invalid null byte.");
    }

    let candidate: string;
    try {
      candidate = await realpath(requestedPath);
      const info = await lstat(candidate);
      if (!info.isFile()) throw new Error("path is not a regular file");
      await access(candidate, fsConstants.R_OK);
    } catch (error) {
      throw new McpFailure("INPUT_FILE_UNAVAILABLE", "The input file does not exist or is not readable.", {
        inputPath: requestedPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    if (!this.roots.some((root) => isWithin(root, candidate))) {
      throw new McpFailure("PATH_OUTSIDE_ALLOWED_ROOTS", "The requested file is outside the configured allowed roots.", {
        inputPath: candidate,
        allowedRoots: this.roots,
      });
    }

    this.assertExtension(candidate, allowedExtensions);
    return candidate;
  }

  async resolveExistingWritableFile(requestedPath: string, allowedExtensions?: readonly string[]): Promise<string> {
    const candidate = await this.resolveExistingFile(requestedPath, allowedExtensions);
    try {
      await access(candidate, fsConstants.W_OK);
    } catch (error) {
      throw new McpFailure("INPUT_FILE_NOT_WRITABLE", "The file is not writable.", {
        inputPath: candidate,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    return candidate;
  }

  async resolveNewFile(requestedPath: string, allowedExtensions?: readonly string[]): Promise<string> {
    if (!path.isAbsolute(requestedPath)) {
      throw new McpFailure("ABSOLUTE_PATH_REQUIRED", "The output path must be absolute.");
    }
    if (requestedPath.includes("\0")) {
      throw new McpFailure("INVALID_PATH", "The output path contains an invalid null byte.");
    }

    this.assertExtension(requestedPath, allowedExtensions);

    let canonicalParent: string;
    try {
      canonicalParent = await realpath(path.dirname(requestedPath));
      const parentInfo = await lstat(canonicalParent);
      if (!parentInfo.isDirectory()) throw new Error("parent is not a directory");
    } catch (error) {
      throw new McpFailure("PARENT_DIRECTORY_MISSING", "The output directory must already exist.", {
        parent: path.dirname(requestedPath),
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const candidate = path.join(canonicalParent, path.basename(requestedPath));
    if (!this.roots.some((root) => isWithin(root, candidate))) {
      throw new McpFailure("PATH_OUTSIDE_ALLOWED_ROOTS", "The requested output path is outside the configured allowed roots.", {
        outputPath: candidate,
        allowedRoots: this.roots,
      });
    }

    try {
      await lstat(candidate);
      throw new McpFailure("OUTPUT_EXISTS", "Refusing to overwrite an existing file.", { outputPath: candidate });
    } catch (error) {
      if (error instanceof McpFailure) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }

    return candidate;
  }

  private assertExtension(filePath: string, allowedExtensions?: readonly string[]): void {
    if (allowedExtensions === undefined || allowedExtensions.length === 0) return;
    const normalizedAllowed = new Set(allowedExtensions.map((extension) => extension.toLowerCase()));
    const extension = path.extname(filePath).toLowerCase();
    if (!normalizedAllowed.has(extension)) {
      throw new McpFailure("INVALID_EXTENSION", `Expected one of these file extensions: ${[...normalizedAllowed].join(", ")}.`, {
        extension,
        allowedExtensions: [...normalizedAllowed],
      });
    }
  }
}
