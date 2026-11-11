/**
 * @alm/ai: the AI-native surface.
 *
 * The frozen tool-surface types, plus the three built layers that sit over the
 * engine: the natural-language AssumptionCompiler (m13), the explain composer
 * (m14), and the MCP server over the whole surface (m15). None computes a
 * balance-sheet number; the engine's deterministic core owns every figure.
 */
export { createAssumptionCompiler, type CandidateAuthor } from "./compiler";
export { composeAnswer } from "./explain";
export {
  createMcpServer,
  MCP_SERVER_INFO,
  type McpServerDeps,
  TOOL_DEFINITIONS,
  TOOL_NAMES,
  type ToolDefinition,
  type ToolName,
} from "./mcp";
export type {
  AssumptionCompiler,
  CompileAssumptionsInput,
  CompiledAssumptionSet,
  EngineTools,
  ExplainQuery,
  Explanation,
  ResultQuery,
  ResultSlice,
  ScenarioSpec,
} from "@alm/engine";
