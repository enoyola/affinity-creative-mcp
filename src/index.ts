#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { AffinityNativeBridge } from "./native-bridge.js";
import { createMcpServer } from "./server.js";
import { AffinityService } from "./service.js";

const config = loadConfig();
const native = new AffinityNativeBridge(config);
const service = await AffinityService.create(config, native);
const server = createMcpServer(service);

const shutdown = async () => {
  await service.close().catch(() => undefined);
  await server.close().catch(() => undefined);
};

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

await server.connect(new StdioServerTransport());
