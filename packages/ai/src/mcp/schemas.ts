/**
 * Tool definitions for the MCP surface: the seven typed tools the server lists
 * and dispatches. Each carries a JSON Schema for its input so an MCP client sees
 * a typed contract on tools/list.
 *
 * The schemas mirror the frozen engine contracts (tools.ts, run.ts, position.ts,
 * scenario.ts, assumptions.ts) at the depth the adapter enforces: every
 * top-level field the dispatcher reads is typed and required here, and the
 * matching runtime guard in validate.ts rejects the same shapes this schema
 * rejects. Deeply nested kernel payloads (the market snapshot, chart of
 * accounts, instrument terms, behavioral params) are declared as opaque objects
 * rather than re-expanded by hand: their shape is fixed by the kernel and engine
 * contracts, and duplicating those types as JSON Schema here would only invite
 * drift. Semantic validation of those payloads stays where the engine already
 * does it (bindAssumptions, defineScenario, run), surfacing as a tool error.
 */

/** The seven tool names, stable identifiers the client calls by. */
export const TOOL_NAMES = {
  loadPortfolio: "loadPortfolio",
  defineScenario: "defineScenario",
  bindAssumptions: "bindAssumptions",
  run: "run",
  queryResults: "queryResults",
  explain: "explain",
  compileAssumptions: "compileAssumptions",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** A JSON Schema object, loose enough to author the tool contracts by hand. */
export type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
};

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: JsonSchema;
}

const str = { type: "string" } as const;
const num = { type: "number" } as const;
/** An opaque nested payload whose shape is fixed by a kernel/engine contract. */
const opaque = (description: string) => ({ type: "object", description });

/** AssumptionSet shape, shared by bindAssumptions and the compiler inputs. */
const assumptionSetSchema: JsonSchema = {
  type: "object",
  properties: {
    schemaVersion: str,
    id: str,
    label: str,
    bindings: { type: "array", items: opaque("An OverlayBinding (assumptions.ts).") },
    contentHash: str,
  },
  required: ["schemaVersion", "id", "label", "bindings"],
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: TOOL_NAMES.loadPortfolio,
    description:
      "Register a portfolio (PortfolioSpec) in the engine's in-memory store and return a PortfolioHandle. Side effect: writes the store keyed by id; a repeated id overwrites.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        label: str,
        asOf: str,
        coa: opaque("A ChartOfAccounts (chartOfAccounts.ts)."),
        positions: { type: "array", items: opaque("A Position (position.ts).") },
      },
      required: ["id", "label", "asOf", "coa", "positions"],
    },
  },
  {
    name: TOOL_NAMES.defineScenario,
    description:
      "Build a Scenario from a ScenarioSpec (rate spec, assumption-set reference, new-business strategy). Pure; no side effect.",
    inputSchema: {
      type: "object",
      properties: {
        id: str,
        label: str,
        rateSpec: opaque(
          "A RateSpec. This MCP surface accepts three kinds: {kind:'base'} | " +
            "{kind:'parallel',shockBp} | {kind:'twist',shortBp,longBp,pivotYears}. The engine's " +
            "fourth kind, {kind:'custom',shocks:[{tenorYears,shockBp},...]} (a per-tenor shock " +
            "vector, tenors strictly ascending), is REJECTED here by the runtime guard; submit " +
            "custom-vector scenarios through the platform HTTP route instead.",
        ),
        assumptionSetId: str,
        newBusiness: opaque("A NewBusinessStrategy: {mode:'static'|'dynamic', rules:[]}."),
      },
      required: ["id", "label", "rateSpec", "assumptionSetId", "newBusiness"],
    },
  },
  {
    name: TOOL_NAMES.bindAssumptions,
    description:
      "Validate and normalize an AssumptionSet, filling its contentHash. Pure; runs no behavioral model. Rejects a malformed set.",
    inputSchema: assumptionSetSchema,
  },
  {
    name: TOOL_NAMES.run,
    description:
      "Execute a run over the registered portfolio and return the full RunResult. Deterministic given the request and seed. Side effect: caches the result by runId for queryResults and explain.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str,
        portfolioId: str,
        marketSnapshot: opaque("A kernel MarketSnapshot."),
        scenarios: { type: "array", items: opaque("A Scenario (scenario.ts).") },
        assumptionSets: { type: "array", items: assumptionSetSchema },
        grid: {
          type: "object",
          properties: { horizonMonths: num, asOf: str },
          required: ["horizonMonths", "asOf"],
        },
        seed: str,
        timestamps: {
          type: "object",
          properties: { startedAt: str, finishedAt: str },
          required: ["startedAt", "finishedAt"],
        },
      },
      required: [
        "runId",
        "portfolioId",
        "marketSnapshot",
        "scenarios",
        "assumptionSets",
        "grid",
        "seed",
        "timestamps",
      ],
    },
  },
  {
    name: TOOL_NAMES.queryResults,
    description:
      "Read a JSON slice of an already-computed run. Pure; reads the cache and never recomputes. Throws on an unknown runId.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str,
        metric: {
          type: "string",
          enum: ["nii", "eve", "repricing-gap", "liquidity-gap", "cashflows"],
        },
        scenarioId: str,
        familyId: str,
      },
      required: ["runId", "metric"],
    },
  },
  {
    name: TOOL_NAMES.explain,
    description:
      "Narrate a headline movement from the run's attribution decomposition. Pure; reads the cache. Answers ONLY from attribution; returns supported=false when the decomposition cannot support the question.",
    inputSchema: {
      type: "object",
      properties: {
        runId: str,
        metric: { type: "string", enum: ["nii-12m", "nii-24m", "eve"] },
        scenarioId: str,
      },
      required: ["runId", "metric", "scenarioId"],
    },
  },
  {
    name: TOOL_NAMES.compileAssumptions,
    description:
      "The NL compiler surface: given the client-authored candidate AssumptionSet plus the instruction, base set, and family catalogue, validate the candidate, diff it against the base, and write the show-before-run rationale. Computes no balance-sheet number; the candidate is authored by the client, never a number this tool invents.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: str,
        base: assumptionSetSchema,
        families: { type: "array", items: opaque("A ProductFamilyDef (chartOfAccounts.ts).") },
        candidate: {
          ...assumptionSetSchema,
          description: "The client-authored candidate AssumptionSet to validate and diff.",
        },
      },
      required: ["instruction", "base", "families", "candidate"],
    },
  },
];
