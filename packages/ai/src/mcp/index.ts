/**
 * MCP server surface (m15): the engine's typed tool surface exposed over the
 * Model Context Protocol. A thin adapter over EngineTools plus the m13 compiler
 * and m14 explain composer; it computes nothing itself.
 */
export { createMcpServer, MCP_SERVER_INFO, type McpServerDeps } from "./server";
export { TOOL_DEFINITIONS, TOOL_NAMES, type ToolDefinition, type ToolName } from "./schemas";
