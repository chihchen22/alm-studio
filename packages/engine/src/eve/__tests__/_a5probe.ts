import { fileURLToPath } from "node:url";
import { bootstrapZeroCurve, buildTLPCurve, buildWarmupSOFR1M, loadMarketSnapshot } from "@alm/kernel";
import { computeKeyRateDurations, collectSidedPositions, regeneratedEve } from "../keyRate";
import { computeEnvironmentDurations } from "../effectiveDuration";
import { makeCoa, makePortfolio, fixedPosition, mortgagePosition, nmdPosition, nmdBetaPosition } from "./fixtures";

const MARKET = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const ZERO_TLP = buildTLPCurve([{ tYears: 1, spread: 0 }]);
const HORIZON = 360;

async function main() {
  const base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
  const books: Record<string, ReturnType<typeof makePortfolio>> = {
    fixedOnly: makePortfolio([fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 })]),
    mortOnly: makePortfolio([mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 })]),
    nmdOnly: makePortfolio([nmdPosition("D1", { notional: 3_000_000 })]),
    nmdBOnly: makePortfolio([nmdBetaPosition("B1", { notional: 2_000_000 })]),
    full: makePortfolio([
      fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
      mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
      nmdPosition("D1", { notional: 3_000_000 }),
      nmdBetaPosition("B1", { notional: 2_000_000 }),
    ]),
  };
  for (const [name, book] of Object.entries(books)) {
    const kr = computeKeyRateDurations({ portfolio: book, scenarioId: "S0", curve: base, tlp: ZERO_TLP, horizonMonths: HORIZON });
    const coa = makeCoa();
    const famInputs = coa.families.map((family) => ({ family, positions: book.positions.filter((p) => p.familyId === family.id) }));
    const env = computeEnvironmentDurations(famInputs, base, ZERO_TLP, HORIZON, 100, "all-in");
    const env25 = computeEnvironmentDurations(famInputs, base, ZERO_TLP, HORIZON, 25, "all-in");
    const eve0 = regeneratedEve(collectSidedPositions(book), base, ZERO_TLP, "all-in", HORIZON, buildWarmupSOFR1M(), 0);
    console.log(`== ${name}: eve0=${eve0.toFixed(2)} envEve=${env.eve.toFixed(2)}`);
    console.log(`   sum=${kr.sum.toFixed(6)} par(25)=${kr.parallelReference.toFixed(6)} engine(100)=${env.effectiveDurationEquity.toFixed(6)} engine(25)=${env25.effectiveDurationEquity.toFixed(6)}`);
    console.log(`   residual=${kr.convergence.residualYears} residualHalf=${kr.convergence.residualYearsAtHalvedBump} ratio=${kr.convergence.ratio} converged=${kr.convergence.converged}`);
    console.log(`   nodes=${kr.nodes.map(n=>`${n.tenorYears}:${n.duration.toFixed(4)}`).join(" ")}`);
  }
}
main();
