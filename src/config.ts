import os from "node:os";
import path from "node:path";

export interface AffinityMcpConfig {
  appPath: string;
  bundleId: string;
  endpoint: URL;
  allowedRoots: string[];
  stagingDirectory: string;
  connectorWaitMs: number;
  nativeCallTimeoutMs: number;
}

const DEFAULT_APP_PATH = "/Applications/Affinity.app";
const DEFAULT_BUNDLE_ID = "com.canva.affinity";
const DEFAULT_ENDPOINT = "http://localhost:6767/sse";

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AffinityMcpConfig {
  const rawRoots = env.AFFINITY_MCP_ALLOWED_ROOTS;
  const allowedRoots = (rawRoots ? rawRoots.split(path.delimiter) : [process.cwd()])
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => path.resolve(root));

  const endpoint = new URL(env.AFFINITY_MCP_ENDPOINT ?? DEFAULT_ENDPOINT);
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("AFFINITY_MCP_ENDPOINT must be a loopback HTTP URL.");
  }

  return {
    appPath: path.resolve(env.AFFINITY_APP_PATH ?? DEFAULT_APP_PATH),
    bundleId: env.AFFINITY_BUNDLE_ID ?? DEFAULT_BUNDLE_ID,
    endpoint,
    allowedRoots,
    stagingDirectory: path.resolve(env.AFFINITY_MCP_STAGING_DIR ?? path.join(os.homedir(), "Desktop")),
    connectorWaitMs: parsePositiveInteger(env.AFFINITY_MCP_CONNECTOR_WAIT_MS, 15_000),
    nativeCallTimeoutMs: parsePositiveInteger(env.AFFINITY_MCP_CALL_TIMEOUT_MS, 60_000),
  };
}
