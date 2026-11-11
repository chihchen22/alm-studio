/**
 * The Workbench's stochastic submission body, a pure function so
 * the one rule it carries is unit-tested: a Hull-White post writes NO `model` key (the server then stores
 * no key in request.json, exactly as before the slice), and a BGM post names `bgm-lmm-2f`.
 */
import type { StochasticModel } from "@alm/engine";
import type { SubmitRunBody } from "@alm/reader";

export interface StochasticPicks {
  portfolioId: string;
  marketId: string;
  scenarioSlateId: string;
  assumptionSetIds: readonly string[];
  nPaths: number;
  model: StochasticModel;
}

export function stochasticBodyOf(p: StochasticPicks): SubmitRunBody {
  return {
    portfolioId: p.portfolioId,
    marketId: p.marketId,
    scenarioSlateId: p.scenarioSlateId,
    assumptionSetIds: [...p.assumptionSetIds],
    mode: "stochastic",
    stochastic: p.model === "bgm-lmm-2f" ? { nPaths: p.nPaths, model: p.model } : { nPaths: p.nPaths },
  };
}
