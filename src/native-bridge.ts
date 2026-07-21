import { execFile } from "node:child_process";
import net from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ErrorCode, McpError, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AffinityMcpConfig } from "./config.js";
import { McpFailure } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface LaunchResult {
  appRunning: boolean;
  nativeConnectorReady: boolean;
  endpoint: string;
}

export interface NativeBridgeLike {
  launch(): Promise<LaunchResult>;
  executeScript(script: string): Promise<CallToolResult>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

function socketHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function endpointCandidates(endpoint: URL): URL[] {
  const hostnames = [endpoint.hostname, "[::1]", "127.0.0.1", "localhost"];
  const seen = new Set<string>();
  const candidates: URL[] = [];

  for (const hostname of hostnames) {
    const candidate = new URL(endpoint.href);
    candidate.hostname = hostname;
    if (seen.has(candidate.href)) continue;
    seen.add(candidate.href);
    candidates.push(candidate);
  }

  return candidates;
}

export function isPortOpen(hostname: string, port: number, timeoutMs = 350): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: socketHostname(hostname), port });
    const finish = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function findReadyEndpoint(endpoint: URL, timeoutMs = 350): Promise<URL | undefined> {
  const candidates = endpointCandidates(endpoint);
  const checks = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      open: await isPortOpen(candidate.hostname, Number(candidate.port || "80"), timeoutMs),
    })),
  );
  return checks.find((check) => check.open)?.candidate;
}

export async function isEndpointReady(endpoint: URL, timeoutMs = 350): Promise<boolean> {
  return (await findReadyEndpoint(endpoint, timeoutMs)) !== undefined;
}

async function waitForEndpoint(endpoint: URL, waitMs: number): Promise<URL | undefined> {
  const deadline = Date.now() + waitMs;
  do {
    const readyEndpoint = await findReadyEndpoint(endpoint);
    if (readyEndpoint !== undefined) return readyEndpoint;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return undefined;
}

function nativeErrorText(result: CallToolResult): string {
  return result.content
    .filter((item): item is Extract<(typeof result.content)[number], { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("\n");
}

export class AffinityNativeBridge implements NativeBridgeLike {
  private client: Client | undefined;
  private transport: SSEClientTransport | undefined;
  private connecting: Promise<Client> | undefined;
  private preambleRead = false;
  private scriptTail: Promise<void> = Promise.resolve();

  constructor(private readonly config: AffinityMcpConfig) {}

  private invalidate(client: Client): void {
    if (this.client !== client) return;
    this.client = undefined;
    this.transport = undefined;
    this.preambleRead = false;
  }

  async launch(): Promise<LaunchResult> {
    try {
      await execFileAsync("/usr/bin/open", ["-b", this.config.bundleId]);
    } catch (error) {
      throw new McpFailure("AFFINITY_LAUNCH_FAILED", "Affinity could not be launched.", {
        bundleId: this.config.bundleId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    const readyEndpoint = await waitForEndpoint(this.config.endpoint, this.config.connectorWaitMs);
    return {
      appRunning: true,
      nativeConnectorReady: readyEndpoint !== undefined,
      endpoint: readyEndpoint?.href ?? this.config.endpoint.href,
    };
  }

  private async connect(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    if (this.connecting !== undefined) return this.connecting;

    this.connecting = (async () => {
      const readyEndpoint = await findReadyEndpoint(this.config.endpoint);
      if (readyEndpoint === undefined) {
        throw new McpFailure(
          "AFFINITY_CONNECTOR_DISABLED",
          "Affinity's native MCP connector is not reachable. In Affinity, open Settings > Model Context Protocol and enable both 'Enable Affinity MCP' and 'Access files on your Desktop'.",
          {
            endpoint: this.config.endpoint.href,
            attemptedEndpoints: endpointCandidates(this.config.endpoint).map((candidate) => candidate.href),
          },
        );
      }

      const client = new Client({ name: "affinity-creative-mcp-bridge", version: "0.3.0" }, { capabilities: {} });
      const transport = new SSEClientTransport(readyEndpoint);
      try {
        await client.connect(transport);
      } catch (error) {
        await transport.close().catch(() => undefined);
        throw new McpFailure("AFFINITY_CONNECTION_FAILED", "Could not connect to Affinity's native MCP endpoint.", {
          endpoint: readyEndpoint.href,
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      this.client = client;
      this.transport = transport;
      client.onclose = () => this.invalidate(client);
      return client;
    })();

    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private async callRaw(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    const client = await this.connect();
    let result: CallToolResult;
    try {
      result = (await client.callTool(
        { name, arguments: args },
        undefined,
        { timeout: this.config.nativeCallTimeoutMs, maxTotalTimeout: this.config.nativeCallTimeoutMs },
      )) as CallToolResult;
    } catch (error) {
      this.invalidate(client);
      await client.close().catch(() => undefined);
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) {
        throw new McpFailure("AFFINITY_CALL_TIMEOUT", `Affinity did not finish tool '${name}' within the configured timeout.`, {
          timeoutMs: this.config.nativeCallTimeoutMs,
          cause: error.message,
        });
      }
      throw new McpFailure("AFFINITY_CONNECTION_LOST", `The connection to Affinity was lost while calling '${name}'. The next call will reconnect.`, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    if (result.isError === true) {
      throw new McpFailure("AFFINITY_TOOL_ERROR", `Affinity tool '${name}' failed.`, { output: nativeErrorText(result) });
    }
    return result;
  }

  private async ensurePreamble(): Promise<void> {
    if (this.preambleRead) return;
    let lastError: unknown;
    for (const filename of ["preamble", "preamble.md"]) {
      try {
        await this.callRaw("read_sdk_documentation_topic", { filename });
        this.preambleRead = true;
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw new McpFailure("AFFINITY_PREAMBLE_UNAVAILABLE", "Affinity's required scripting preamble could not be read.", {
      cause: lastError instanceof Error ? lastError.message : String(lastError),
    });
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return this.callRaw(name, args);
  }

  async executeScript(script: string): Promise<CallToolResult> {
    const previous = this.scriptTail;
    let release!: () => void;
    this.scriptTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      await this.ensurePreamble();
      return await this.callRaw("execute_script", { script });
    } finally {
      release();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    this.preambleRead = false;
    if (client !== undefined) await client.close();
  }
}
