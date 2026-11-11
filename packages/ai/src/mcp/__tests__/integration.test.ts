/**
 * MCP server integration acceptance (m15).
 *
 * Drives the server through an in-process client over a linked in-memory
 * transport pair, so no external process is needed:
 *  - tools/list returns the seven tools, each with a typed object input schema.
 *  - A full generate -> run -> query -> explain cycle over the m12 fixture book
 *    returns, for run/query/explain, the SAME payload a direct EngineTools call
 *    returns (the adapter computes nothing of its own).
 *  - explain's text is the m14 composition of the engine's structured Explanation.
 *  - A malformed call is rejected, not coerced (wrong-typed field, bad enum).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MarketSnapshot } from "@alm/kernel";
import { createEngine } from "@alm/engine";
import { clearPortfolios } from "@alm/engine/src/portfolio/registry";
import {
  baseAssumptions,
  loadMarket,
  makeCoa,
  makeRunRequest,
  twoSidedBook,
} from "@alm/engine/src/run/__tests__/fixtures";
import { composeAnswer } from "../../explain";
import { createMcpServer } from "../server";
import { TOOL_DEFINITIONS, TOOL_NAMES } from "../schemas";

/** Strip undefined optional fields so both sides compare across the wire. */
function normalize<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** A connected client over a linked in-memory pair against a server on `deps`. */
async function connect(tools = createEngine()): Promise<Client> {
  const server = createMcpServer({ tools });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Read the typed object a tool returned. */
function structured(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return result.structuredContent as Record<string, unknown>;
}

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

describe("MCP server — tools/list", () => {
  it("lists the seven tools, each with a typed object input schema", async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(
      Object.values(TOOL_NAMES).slice().sort(),
    );
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.description).toBeTruthy();
    }
  });
});

describe("MCP server — generate/run/query/explain cycle equals direct EngineTools", () => {
  it("drives the full cycle and matches a direct engine call at each step", async () => {
    clearPortfolios();
    const client = await connect();
    // An independent direct EngineTools instance to check the adapter against.
    // Both share the global portfolio registry once loadPortfolio has run.
    const ref = createEngine();

    // load
    const handleRes = await client.callTool({
      name: TOOL_NAMES.loadPortfolio,
      arguments: twoSidedBook() as unknown as Record<string, unknown>,
    });
    expect(structured(handleRes)).toMatchObject({ id: "PF-RUN", positionCount: 4 });

    // generate: the NL compiler surface over a client-authored candidate. Here
    // the candidate reproduces the base set (a no-op edit), so the run reconciles
    // exactly and diff.deltas is empty, while still exercising validate+hash.
    const genRes = await client.callTool({
      name: TOOL_NAMES.compileAssumptions,
      arguments: {
        instruction: "keep the calibrated base unchanged",
        base: baseAssumptions(),
        families: makeCoa().families,
        candidate: baseAssumptions(),
      } as unknown as Record<string, unknown>,
    });
    const compiled = structured(genRes) as {
      assumptionSet: ReturnType<typeof baseAssumptions>;
      diff: { deltas: unknown[] };
      rationale: string;
    };
    expect(compiled.assumptionSet.contentHash).toBeDefined();
    expect(compiled.diff.deltas).toEqual([]);
    expect(compiled.rationale).toBeTruthy();

    // run: feed the compiled (validated, hashed) set into the request.
    const req = makeRunRequest(market, { assumptionSets: [compiled.assumptionSet] });
    const expectedRun = ref.run(req);
    const runRes = await client.callTool({
      name: TOOL_NAMES.run,
      arguments: req as unknown as Record<string, unknown>,
    });
    expect(structured(runRes)).toEqual(normalize(expectedRun));
    // The headline honesty invariant survives the round trip.
    expect((structured(runRes) as { notImplemented: unknown[] }).notImplemented).toEqual([]);

    // query: a slice equals the direct sliceResult.
    const expectedSlice = ref.queryResults({ runId: req.runId, metric: "nii", scenarioId: "S200" });
    const queryRes = await client.callTool({
      name: TOOL_NAMES.queryResults,
      arguments: { runId: req.runId, metric: "nii", scenarioId: "S200" },
    });
    expect(structured(queryRes)).toEqual(normalize(expectedSlice));

    // explain: structured Explanation equals the direct call; text is the m14 prose.
    const explainQuery = { runId: req.runId, metric: "eve", scenarioId: "S200" } as const;
    const expectedExpl = ref.explain(explainQuery);
    const explainRes = await client.callTool({
      name: TOOL_NAMES.explain,
      arguments: explainQuery,
    });
    expect(structured(explainRes)).toEqual(normalize(expectedExpl));
    const text = (explainRes.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toBe(composeAnswer(expectedExpl));
  });
});

describe("MCP server — malformed calls are rejected, not coerced", () => {
  it("rejects a run whose seed is a number instead of a string", async () => {
    const client = await connect();
    const bad = { ...makeRunRequest(market), seed: 42 };
    await expect(
      client.callTool({ name: TOOL_NAMES.run, arguments: bad as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/seed: expected a string/);
  });

  it("rejects a queryResults with an unknown metric", async () => {
    const client = await connect();
    await expect(
      client.callTool({ name: TOOL_NAMES.queryResults, arguments: { runId: "X", metric: "bogus" } }),
    ).rejects.toThrow(/metric: expected one of/);
  });

  it("rejects a bindAssumptions missing its bindings array", async () => {
    const client = await connect();
    await expect(
      client.callTool({
        name: TOOL_NAMES.bindAssumptions,
        arguments: { schemaVersion: "1.0.0", id: "X", label: "no bindings" },
      }),
    ).rejects.toThrow(/bindings: expected an array/);
  });
});
