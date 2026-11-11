/**
 * Piece 8, Task 3 probe (not a test): engine-convention par versus the
 * kernel's annual ACT/360 swap rate, and the PV per 100 notional at each.
 * Run: cd packages/engine && npx tsx src/swap/__tests__/_parProbe.ts
 */
import { fileURLToPath } from "node:url";
import { DeterministicRatePath, loadMarketSnapshot, pvCashflows } from "@alm/kernel";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { SwapInstrument } from "../swapInstrument";

async function main(): Promise<void> {
  const snapshot = await loadMarketSnapshot(
    fileURLToPath(new URL("../../../../kernel/public/market_public.json", import.meta.url)),
  );
  const curve = buildBaseCurve(snapshot);
  const path = new DeterministicRatePath(curve, 360);
  const df = (t: number): number => curve.discountFactor(t);
  for (const months of [24, 60, 120]) {
    let annuity = 0;
    for (let m = 1; m <= months; m++) annuity += df(m / 12);
    const enginePar = (12 * (1 - df(months / 12))) / annuity;
    const kernelPar = curve.forwardSwapRate(0, months / 12);
    const pvPer100 = (rate: number): number =>
      pvCashflows(
        new SwapInstrument({
          id: `probe-${months}`,
          type: "swap",
          notional: 100,
          maturityMonths: months,
          originationOffsetMonths: 0,
          amortType: "bullet",
          direction: "pay-fixed",
          fixedRate: rate,
        }).generateCashflows(path),
        df,
      );
    console.log(
      JSON.stringify({
        months,
        enginePar,
        kernelPar,
        parGapBp: (kernelPar - enginePar) * 1e4,
        pvPer100AtEnginePar: pvPer100(enginePar),
        pvPer100AtKernelPar: pvPer100(kernelPar),
        pvPer100AtEngineParRoundedToBp: pvPer100(Math.round(enginePar * 1e4) / 1e4),
      }),
    );
  }
}

void main();
