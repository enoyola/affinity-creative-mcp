import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AffinityMcpConfig } from "../src/config.js";
import type { LaunchResult, NativeBridgeLike } from "../src/native-bridge.js";
import { RESULT_MARKER } from "../src/scripts.js";

export function testConfig(root: string, stagingDirectory: string): AffinityMcpConfig {
  return {
    appPath: "/Applications/Affinity.app",
    bundleId: "com.canva.affinity",
    endpoint: new URL("http://127.0.0.1:6767/sse"),
    allowedRoots: [root],
    stagingDirectory,
    connectorWaitMs: 10,
    nativeCallTimeoutMs: 60_000,
  };
}

export class FakeNativeBridge implements NativeBridgeLike {
  readonly scripts: string[] = [];
  launchResult: LaunchResult = {
    appRunning: true,
    nativeConnectorReady: true,
    endpoint: "http://127.0.0.1:6767/sse",
  };

  async launch(): Promise<LaunchResult> {
    return this.launchResult;
  }

  async executeScript(script: string): Promise<CallToolResult> {
    this.scripts.push(script);
    const match = script.match(/createdDocument\.saveAs\(("(?:\\.|[^"\\])*")\);/);
    if (match?.[1] === undefined) throw new Error("The generated script did not contain a parseable staging path.");
    const stagingPath = JSON.parse(match[1]) as string;
    await mkdir(path.dirname(stagingPath), { recursive: true }).catch(() => undefined);
    await writeFile(stagingPath, Buffer.from("fake editable Affinity document\n", "utf8"));
    return {
      content: [
        {
          type: "text",
          text: `${RESULT_MARKER}${JSON.stringify({
            path: stagingPath,
            widthPixels: 1920,
            heightPixels: 1080,
            dpi: 300,
            sessionUuid: "fake-session",
          })}`,
        },
      ],
    };
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    return { content: [{ type: "text", text: JSON.stringify({ name, args }) }] };
  }

  async close(): Promise<void> {}
}
