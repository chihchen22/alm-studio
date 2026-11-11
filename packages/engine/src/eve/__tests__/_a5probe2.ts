import { fileURLToPath } from "node:url";
import { bootstrapZeroCurve, buildTLPCurve, loadMarketSnapshot } from "@alm/kernel";
import { computeKeyRateDurations } from "../keyRate";
import { makePortfolio, mortgagePosition, nmdPosition } from "./fixtures";

const MARKET = fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const ZERO_TLP = buildTLPCurve([{ tYears: 1, spread: 0 }]);

async function main() {
  const base = bootstrapZeroCurve(await loadMarketSnapshot(MARKET));
  const books = {
    mortOnly: makePortfolio([mortgagePosition("M1", { notional: 4_000_000, originalBalance: 4_000_000 })]),
    nmdOnly: makePortfolio([nmdPosition("D1", { notional: 3_000_000 })]),
  };
  for (const [name, book] of Object.entries(books)) {
    for (const bump of [50, 25, 10, 5]) {
      const kr = computeKeyRateDurations({ portfolio: book, scenarioId: "S0", curve: base, tlp: ZERO_TLP, horizonMonths: 360, bumpBp: bump });
      console.log(`${name} bump=${bump}: sum=${kr.sum.toFixed(6)} par=${kr.parallelReference.toFixed(6)} res=${kr.convergence.residualYears.toExponential(3)} resHalf=${kr.convergence.residualYearsAtHalvedBump.toExponential(3)} ratio=${kr.convergence.ratio?.toFixed(3)} conv=${kr.convergence.converged}`);
    }
  }
}
main();
