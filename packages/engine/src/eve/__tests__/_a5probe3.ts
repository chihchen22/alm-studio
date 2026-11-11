import { fileURLToPath } from "node:url";
import { bootstrapZeroCurve, buildTLPCurve, loadMarketSnapshot, NMD_TERMS_DEFAULTS } from "@alm/kernel";
import { computeKeyRateDurations } from "../keyRate";
import { makePortfolio, nmdPosition } from "./fixtures";

const MARKET = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const ZERO_TLP = buildTLPCurve([{ tYears: 1, spread: 0 }]);

async function main() {
  const base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
  const noAmp = makePortfolio([
    nmdPosition("D1", {
      notional: 3_000_000,
      nmdParams: { ...NMD_TERMS_DEFAULTS.nmdParams, regimeAlpha: 0 },
    }),
  ]);
  for (const bump of [25, 10]) {
    const kr = computeKeyRateDurations({ portfolio: noAmp, scenarioId: "S0", curve: base, tlp: ZERO_TLP, horizonMonths: 360, bumpBp: bump });
    console.log(`noAmp bump=${bump}: sum=${kr.sum.toFixed(6)} par=${kr.parallelReference.toFixed(6)} res=${kr.convergence.residualYears.toExponential(3)} resHalf=${kr.convergence.residualYearsAtHalvedBump.toExponential(3)} ratio=${kr.convergence.ratio?.toFixed(3)} conv=${kr.convergence.converged}`);
  }
}
main();
