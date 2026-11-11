import { fileURLToPath } from "node:url";
import { bootstrapZeroCurve, buildTLPCurve, loadMarketSnapshot, NMD_TERMS_DEFAULTS } from "@alm/kernel";
import { computeKeyRateDurations } from "../keyRate";
import { computeEnvironmentDurations } from "../effectiveDuration";
import { makeCoa, makePortfolio, fixedPosition, mortgagePosition, nmdPosition, nmdBetaPosition } from "./fixtures";

const MARKET = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const ZERO_TLP = buildTLPCurve([{ tYears: 1, spread: 0 }]);

async function main() {
  const base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
  const book = makePortfolio([
    fixedPosition("F1", { notional: 5_000_000, coupon: 0.05, maturityMonths: 60 }),
    mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 }),
    nmdPosition("D1", { notional: 3_000_000, nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: 0 } }),
    nmdBetaPosition("B1", { notional: 2_000_000 }),
  ]);
  const coa = makeCoa();
  const famInputs = coa.families.map((family) => ({ family, positions: book.positions.filter((p) => p.familyId === family.id) }));
  for (const bump of [25, 10]) {
    const kr = computeKeyRateDurations({ portfolio: book, scenarioId: "S0", curve: base, tlp: ZERO_TLP, horizonMonths: 360, bumpBp: bump });
    const env = computeEnvironmentDurations(famInputs, base, ZERO_TLP, 360, bump, "all-in");
    console.log(`bump=${bump}: sum=${kr.sum.toFixed(6)} par=${kr.parallelReference.toFixed(6)} engineSameBump=${env.effectiveDurationEquity.toFixed(6)} relToEngine=${(Math.abs(kr.parallelReference-env.effectiveDurationEquity)/Math.abs(env.effectiveDurationEquity)).toExponential(3)}`);
    console.log(`  res=${kr.convergence.residualYears.toExponential(3)} resHalf=${kr.convergence.residualYearsAtHalvedBump.toExponential(3)} ratio=${kr.convergence.ratio?.toFixed(3)} conv=${kr.convergence.converged} res/|sum|=${(Math.abs(kr.convergence.residualYears)/Math.abs(kr.sum)).toExponential(2)}`);
  }
  const env100 = computeEnvironmentDurations(famInputs, base, ZERO_TLP, 360, 100, "all-in");
  console.log(`engine(100)=${env100.effectiveDurationEquity.toFixed(6)} eve0=${env100.eve.toFixed(2)}`);
}
main();
