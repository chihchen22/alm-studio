/**
 * Runtime input validation for the MCP tool boundary.
 *
 * The rule the acceptance fixes: a malformed call is REJECTED, never coerced.
 * Every guard here checks a value's kind and throws McpError(InvalidParams) on a
 * mismatch; nothing is parsed, cast up, or defaulted. The guards enforce exactly
 * the top-level fields the schemas in schemas.ts advertise, so a client that
 * passes a shape tools/list rejected also fails here at call time.
 *
 * Depth is deliberate: the adapter validates the structure it dispatches on and
 * hands the still-opaque kernel payloads (market snapshot, chart of accounts,
 * instrument terms, behavioral params) to the engine, whose own validators
 * (bindAssumptions, defineScenario, run) own the deep semantic checks. A failure
 * there surfaces as a tool error, so an invalid payload is still rejected, just
 * one layer down. No path coerces.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { AssumptionSet } from "@alm/engine";
import type { ExplainQuery, ResultQuery, ScenarioSpec } from "@alm/engine";
import type { PortfolioSpec } from "@alm/engine";
import type { RunRequest } from "@alm/engine";
import type { CompileAssumptionsInput } from "@alm/engine";

/** Reject with the JSON-RPC InvalidParams code so the client sees a hard rejection. */
function reject(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

function asRecord(x: unknown, ctx: string): Record<string, unknown> {
  if (typeof x !== "object" || x === null || Array.isArray(x)) {
    reject(`${ctx}: expected an object`);
  }
  return x as Record<string, unknown>;
}

function requireString(o: Record<string, unknown>, key: string, ctx: string): string {
  const v = o[key];
  if (typeof v !== "string") reject(`${ctx}.${key}: expected a string`);
  return v as string;
}

function requireNumber(o: Record<string, unknown>, key: string, ctx: string): number {
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v)) reject(`${ctx}.${key}: expected a finite number`);
  return v as number;
}

function requireObject(o: Record<string, unknown>, key: string, ctx: string): Record<string, unknown> {
  const v = o[key];
  return asRecord(v, `${ctx}.${key}`);
}

function requireArray(o: Record<string, unknown>, key: string, ctx: string): unknown[] {
  const v = o[key];
  if (!Array.isArray(v)) reject(`${ctx}.${key}: expected an array`);
  return v as unknown[];
}

function requireEnum<T extends string>(o: Record<string, unknown>, key: string, allowed: readonly T[], ctx: string): T {
  const v = o[key];
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    reject(`${ctx}.${key}: expected one of ${allowed.map((a) => `"${a}"`).join(", ")}`);
  }
  return v as T;
}

function optionalString(o: Record<string, unknown>, key: string, ctx: string): void {
  const v = o[key];
  if (v !== undefined && typeof v !== "string") reject(`${ctx}.${key}: expected a string when present`);
}

/** Validate the top-level AssumptionSet shape (deep param checks are the engine's). */
function validateAssumptionSetShape(x: unknown, ctx: string): void {
  const o = asRecord(x, ctx);
  requireString(o, "schemaVersion", ctx);
  requireString(o, "id", ctx);
  requireString(o, "label", ctx);
  requireArray(o, "bindings", ctx);
  optionalString(o, "contentHash", ctx);
}

export function validateLoadPortfolio(args: unknown): PortfolioSpec {
  const ctx = "loadPortfolio";
  const o = asRecord(args, ctx);
  requireString(o, "id", ctx);
  requireString(o, "label", ctx);
  requireString(o, "asOf", ctx);
  requireObject(o, "coa", ctx);
  requireArray(o, "positions", ctx);
  return args as PortfolioSpec;
}

export function validateDefineScenario(args: unknown): ScenarioSpec {
  const ctx = "defineScenario";
  const o = asRecord(args, ctx);
  requireString(o, "id", ctx);
  requireString(o, "label", ctx);
  const rateSpec = requireObject(o, "rateSpec", ctx);
  requireEnum(rateSpec, "kind", ["base", "parallel", "twist"], `${ctx}.rateSpec`);
  requireString(o, "assumptionSetId", ctx);
  const nb = requireObject(o, "newBusiness", ctx);
  requireEnum(nb, "mode", ["static", "dynamic"], `${ctx}.newBusiness`);
  requireArray(nb, "rules", `${ctx}.newBusiness`);
  return args as ScenarioSpec;
}

export function validateBindAssumptions(args: unknown): AssumptionSet {
  validateAssumptionSetShape(args, "bindAssumptions");
  return args as AssumptionSet;
}

export function validateRun(args: unknown): RunRequest {
  const ctx = "run";
  const o = asRecord(args, ctx);
  requireString(o, "runId", ctx);
  requireString(o, "portfolioId", ctx);
  requireObject(o, "marketSnapshot", ctx);
  requireArray(o, "scenarios", ctx);
  const sets = requireArray(o, "assumptionSets", ctx);
  sets.forEach((s, i) => validateAssumptionSetShape(s, `${ctx}.assumptionSets[${i}]`));
  const grid = requireObject(o, "grid", ctx);
  requireNumber(grid, "horizonMonths", `${ctx}.grid`);
  requireString(grid, "asOf", `${ctx}.grid`);
  requireString(o, "seed", ctx);
  const ts = requireObject(o, "timestamps", ctx);
  requireString(ts, "startedAt", `${ctx}.timestamps`);
  requireString(ts, "finishedAt", `${ctx}.timestamps`);
  return args as RunRequest;
}

export function validateQueryResults(args: unknown): ResultQuery {
  const ctx = "queryResults";
  const o = asRecord(args, ctx);
  requireString(o, "runId", ctx);
  requireEnum(o, "metric", ["nii", "eve", "repricing-gap", "liquidity-gap", "cashflows"], ctx);
  optionalString(o, "scenarioId", ctx);
  optionalString(o, "familyId", ctx);
  return args as ResultQuery;
}

export function validateExplain(args: unknown): ExplainQuery {
  const ctx = "explain";
  const o = asRecord(args, ctx);
  requireString(o, "runId", ctx);
  requireEnum(o, "metric", ["nii-12m", "nii-24m", "eve"], ctx);
  requireString(o, "scenarioId", ctx);
  return args as ExplainQuery;
}

/** The compile tool input: the frozen CompileAssumptionsInput plus a client-authored candidate. */
export interface CompileToolInput {
  input: CompileAssumptionsInput;
  candidate: AssumptionSet;
}

export function validateCompileAssumptions(args: unknown): CompileToolInput {
  const ctx = "compileAssumptions";
  const o = asRecord(args, ctx);
  requireString(o, "instruction", ctx);
  validateAssumptionSetShape(o.base, `${ctx}.base`);
  requireArray(o, "families", ctx);
  validateAssumptionSetShape(o.candidate, `${ctx}.candidate`);
  return {
    input: {
      instruction: o.instruction as string,
      base: o.base as AssumptionSet,
      families: o.families as CompileAssumptionsInput["families"],
    },
    candidate: o.candidate as AssumptionSet,
  };
}
