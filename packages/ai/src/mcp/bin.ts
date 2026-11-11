/**
 * Stdio entry point for the MCP server.
 *
 * Runs the tool surface over stdio so any MCP client (Claude Code, the MCP
 * inspector) can drive the engine. A thin bin: build the server over a fresh
 * engine and connect the stdio transport. Run with:
 *
 *   npx tsx packages/ai/src/mcp/bin.ts
 *
 * The process starts empty; a client loads a portfolio, then runs and queries.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Startup failure: report on stderr and exit non-zero. stdout is the JSON-RPC
  // channel and must never carry diagnostics.
  process.stderr.write(`mcp server failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
