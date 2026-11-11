// apps/studio/src/results/readouts.ts
/**
 * Shared reads of the SEG, EVE, NII and Instruments tabs. Pure. Small pieces of arithmetic live here, each
 * named and each restated in a test: the largest absolute value of the bank SEG series (a selection, not a sum) and
 * the 200bp pair duration (from stored scenario PVs). Every other figure the tabs print is a stored field.
 */
import type { RunResult, ScenarioEVE } from "@alm/engine";
import type { RunDetail } from "@alm/reader";

/** The bank SEG series' largest absolute value. `index` is the series index; `month` = index + 1. */
export interface BankPeak {
  value: number;
  index: number;
  month: number;
}

/** First of equal magnitudes wins, as an argmax does. Null for an empty series. */
export function bankSegPeak(segBank: readonly number[]): BankPeak | null {
  if (segBank.length === 0) return null;
  let at = 0;
  for (let i = 1; i < segBank.length; i++) if (Math.abs(segBank[i]!) > Math.abs(segBank[at]!)) at = i;
  return { value: segBank[at]!, index: at, month: at + 1 };
}

/** The base-rate scenario among `ids`: the run detail's base spec when stored, else the first id. */
export function baseScenarioId(detail: RunDetail, ids: readonly string[]): string | null {
  const base = detail.scenarios.find((s) => s.rateSpec.kind === "base" && ids.includes(s.id));
  return base?.id ?? ids[0] ?? null;
}

export interface PairDuration {
  upId: string;
  downId: string;
  assets: number;
  liabilities: number;
  gap: number;
}

/**
 * The parallel plus and minus 200bp scenario ids of a run: the SRP31 parallel pair when present, else the stored
 * parallel plus and minus 200bp pair.
 */
function pairIds(result: RunResult, detail: RunDetail): { up: string; down: string } | null {
  const have = new Set(result.eve.byScenario.map((s) => s.scenarioId));
  if (have.has("SRP-PUP") && have.has("SRP-PDN")) return { up: "SRP-PUP", down: "SRP-PDN" };
  const parallel = (bp: number) => detail.scenarios.find((s) => s.rateSpec.kind === "parallel" && s.rateSpec.shockBp === bp && have.has(s.id))?.id;
  const up = parallel(200);
  const down = parallel(-200);
  if (up !== undefined && down !== undefined) return { up, down };
  return null;
}

/**
 * D = (PV(-200) - PV(+200)) / (2 x PV(0) x 0.02) for assets and for liabilities; the duration gap is
 * D_A - (PV_L / PV_A) x D_L. Null when a leg or the base is missing, or a base PV is zero.
 */
export function pairDuration(result: RunResult, detail: RunDetail): PairDuration | null {
  const ids = pairIds(result, detail);
  if (ids === null) return null;
  const byId = new Map<string, ScenarioEVE>(result.eve.byScenario.map((s) => [s.scenarioId, s]));
  const baseId = baseScenarioId(detail, result.eve.byScenario.map((s) => s.scenarioId));
  const base = baseId === null ? undefined : byId.get(baseId);
  const up = byId.get(ids.up);
  const down = byId.get(ids.down);
  if (base === undefined || up === undefined || down === undefined || base.pvAssets === 0 || base.pvLiabilities === 0) return null;
  const assets = (down.pvAssets - up.pvAssets) / (2 * base.pvAssets * 0.02);
  const liabilities = (down.pvLiabilities - up.pvLiabilities) / (2 * base.pvLiabilities * 0.02);
  return { upId: ids.up, downId: ids.down, assets, liabilities, gap: assets - (base.pvLiabilities / base.pvAssets) * liabilities };
}
