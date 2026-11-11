/**
 * The MCP server over the typed tool surface (architecture Section 10).
 *
 * A thin adapter, nothing more: it lists the seven tools with their schemas and
 * dispatches each call to the engine's EngineTools, the m13 assumption compiler,
 * and the m14 explain composer. It computes no balance-sheet number itself; every
 * figure a client receives was produced by the engine's deterministic core.
 *
 * The division of labor the contracts encode is preserved verbatim here:
 *  - loadPortfolio / defineScenario / bindAssumptions / run / queryResults /
 *    explain forward to the single injected EngineTools instance, so run()'s
 *    result cache is the same one queryResults and explain read from.
 *  - compileAssumptions runs the deterministic compiler remainder over a
 *    client-authored candidate: validate, diff, rationale. The natural-language
 *    authoring is the client's job, exactly as m13 designed the seam.
 *  - explain narrates ONLY the attribution the run computed, and its text is the
 *    m14 composition of the engine's structured Explanation.
 *
 * Malformed input is rejected, not coerced (validate.ts). Deterministic: no
 * clock and no randomness live on any path here.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { createEngine, type EngineTools } from "@alm/engine";
import { createAssumptionCompiler } from "../compiler";
import { composeAnswer } from "../explain";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "./schemas";
import {
  validateBindAssumptions,
  validateCompileAssumptions,
  validateDefineScenario,
  validateExplain,
  validateLoadPortfolio,
  validateQueryResults,
  validateRun,
} from "./validate";

/** Server metadata advertised on the initialize handshake. */
export const MCP_SERVER_INFO = { name: "alm-studio", version: "0.1.0" } as const;

/** Dependencies the server adapts. Defaults to a fresh engine when none is given. */
export interface McpServerDeps {
  /** The single EngineTools instance every tool call shares (so the run cache persists). */
  tools?: EngineTools;
}

/** A tool result carrying both the human-readable text and the typed object. */
function ok(structured: Record<string, unknown>, text: string): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Build the MCP server. Registers the tools/list and tools/call handlers over
 * the injected EngineTools; returns the low-level Server ready to connect to a
 * transport. Construction has no side effect beyond wiring.
 */
export function createMcpServer(deps: McpServerDeps = {}): Server {
  const tools = deps.tools ?? createEngine();

  const server = new Server(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions:
      "ALM Studio engine tool surface. Load a portfolio, define scenarios, bind assumptions, run, then query and explain results. This server never computes a number outside the engine.",
  });

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case TOOL_NAMES.loadPortfolio: {
        const handle = tools.loadPortfolio(validateLoadPortfolio(args));
        return ok(handle as unknown as Record<string, unknown>, JSON.stringify(handle));
      }
      case TOOL_NAMES.defineScenario: {
        const scenario = tools.defineScenario(validateDefineScenario(args));
        return ok(scenario as unknown as Record<string, unknown>, JSON.stringify(scenario));
      }
      case TOOL_NAMES.bindAssumptions: {
        const set = tools.bindAssumptions(validateBindAssumptions(args));
        return ok(set as unknown as Record<string, unknown>, JSON.stringify(set));
      }
      case TOOL_NAMES.run: {
        const result = tools.run(validateRun(args));
        return ok(result as unknown as Record<string, unknown>, JSON.stringify(result.provenance));
      }
      case TOOL_NAMES.queryResults: {
        const slice = tools.queryResults(validateQueryResults(args));
        return ok(slice as unknown as Record<string, unknown>, JSON.stringify(slice));
      }
      case TOOL_NAMES.explain: {
        const explanation = tools.explain(validateExplain(args));
        // The engine produced the structured Explanation; m14 narrates it. The
        // narration reads attribution figures verbatim and computes nothing.
        const prose = composeAnswer(explanation);
        return ok(explanation as unknown as Record<string, unknown>, prose);
      }
      case TOOL_NAMES.compileAssumptions: {
        const { input, candidate } = validateCompileAssumptions(args);
        // The client authored the candidate; the compiler owns only the
        // deterministic remainder (validate + diff + rationale). Feeding the
        // candidate through the author seam keeps that boundary exact.
        const compiler = createAssumptionCompiler(() => candidate);
        const compiled = compiler.compile(input);
        return ok(compiled as unknown as Record<string, unknown>, compiled.rationale);
      }
      default:
        // Unknown tool name: a hard rejection, never a fabricated result.
        throw new Error(`unknown tool "${name}"`);
    }
  });

  return server;
}
