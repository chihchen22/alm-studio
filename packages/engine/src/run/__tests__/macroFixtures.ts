// packages/engine/src/run/__tests__/macroFixtures.ts (Piece 7b run-level helpers; slice 4 reuses them)
import type { MarketSnapshot } from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { ShardsOption } from "../shard/staticPass";
import { deriveMarketSnapshot } from "../../market/deriveMarketSnapshot";
import { DEFAULT_GENERATOR_CONFIG, generatePortfolio } from "../../../../../data/src";
import { buildDemoAssumptions } from "../../../../../data/src/demo/request";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import { resolveDefaultContext } from "../engine";
import { loadMarket, makeRunRequest, regulatoryScenarios } from "./fixtures";

export const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
export const ramp = (end: number): number[] => Array.from({ length: 360 }, (_, i) => Number((1 + (end - 1) * Math.min(1, (i + 1) / 24)).toPrecision(12)));
const proj = (id: string, values: number[]) => ({ op: "set-macro-series", id, label: `${id} (authored projection)`, kind: "index", role: "projection",
  unit: "ratio to 2026-03", firstMonth: "2026-04", values, source: { authored: true, note: "Synthetic." } });
export async function macroMarket(): Promise<MarketSnapshot> {
  const base = await loadMarket();
  return deriveMarketSnapshot(base, [proj("hpi-flat", new Array(360).fill(1)), proj("hpi-down-30", ramp(0.7)), proj("hpi-up-15", ramp(1.15)),
    proj("hpi-c025", new Array(360).fill(0.25)), proj("hpi-c4", new Array(360).fill(4))], { baseId: "market-public-2026-03-31" }).snapshot;
}
export const syntheticBook = (): PortfolioSpec =>
  generatePortfolio({ ...DEFAULT_GENERATOR_CONFIG, portfolioId: "synthetic-2500-v1", portfolioLabel: "synthetic", targetPositions: 2500 });
export function housingSet(id: string, seriesId: string | null): AssumptionSet {
  const demo = buildDemoAssumptions();
  if (seriesId === null) return { ...demo, id };
  return { ...demo, id,
    bindings: demo.bindings.map((b) => (b.overlay.kind === "prepay" && b.overlay.model === "four-factor-cpr" ? { ...b, overlay: { ...b.overlay, housing: { ...H } } } : b)),
    macroBindings: ["mortgages", "mbs"].map((familyId) => ({ seriesId, feeder: "prepay-housing" as const, familyId })) };
}
export function runOn(
  market: MarketSnapshot,
  set: AssumptionSet,
  opts: { shards?: ShardsOption; scenarioSets?: Record<string, AssumptionSet>; book?: PortfolioSpec; context?: Partial<RunPipelineContext> } = {},
): RunResult {
  const book = opts.book ?? syntheticBook();
  // One copy of each scenario set (a set shared by several scenarios is listed once).
  const extra = [...new Map(Object.values(opts.scenarioSets ?? {}).filter((s) => s.id !== set.id).map((s) => [s.id, s] as const)).values()];
  const request = makeRunRequest(market, {
    portfolioId: book.id, assumptionSets: [set, ...extra], grid: { horizonMonths: 360, asOf: book.asOf },
    scenarios: regulatoryScenarios(set.id).map((s) => ({ ...s, assumptionSetId: opts.scenarioSets?.[s.id]?.id ?? set.id })),
  });
  return buildRunResult(request, book, { ...resolveDefaultContext(), ...(opts.context ?? {}), ...(opts.shards !== undefined ? { shards: opts.shards } : {}) });
}
export const stripTimes = (r: RunResult): unknown => { const { provenance, ...rest } = r; const { timestamps: _t, ...p } = provenance as unknown as Record<string, unknown>; return { ...rest, provenance: p }; };
