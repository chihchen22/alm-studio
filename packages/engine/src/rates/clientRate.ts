/**
 * The flat-carry client-rate row. Pure: one binding, one scenario's
 * path, one row. It imports only the error leaf, the contracts and the kernel,
 * never `rateDocument.ts`, which imports it.
 *
 *   clientRate[k] = B(k) + totalSpreadBp / 1e4,   B(k) = path.forwardRateAt(k, 10)
 *
 * Index k is month k + 1, the same seam as the kernel Mortgage's
 * `mortgageRateAt(m) = forwardRateAt(m - 1, 10) + spread`. The benchmark is a
 * 10-year forward par yield on the curve's own quote convention (Treasury CMT on
 * a semiannual_bond curve), recorded on the row as read off the shocked curve.
 * No floor and no cap is applied. The only public client-rate model is flat
 * carry (ruling 2026-08-22).
 *
 * Units: engine rates are decimals, the kernel client-rate functions take
 * percent. The conversion happens in this one function and nowhere else.
 */
import { assembleClientRate, flatCarry, type RatePath, type ZeroCurve } from "@alm/kernel";
import type { AssumptionSet, OverlayBinding } from "../contracts/assumptions";
import type { ClientRateRow } from "../contracts/rateDocument";
import { ClientRateBenchmarkError } from "./errors";

/**
 * The tenor the kernel Mortgage refinance incentive reads. The kernel's own
 * constant is unexported inside the vendored math tree, which may not be edited,
 * so a test holds the two together.
 */
export const CLIENT_RATE_BENCHMARK_TENOR_YEARS = 10;

/**
 * Build one client-rate row. The binding's overlay must be a loan-client-rate;
 * instrument compatibility is enforced at bind and resolve, not here. Throws
 * ClientRateBenchmarkError, naming the first month, when the benchmark is not
 * finite at some step.
 */
export function clientRateRow(
  set: AssumptionSet,
  binding: OverlayBinding,
  path: RatePath,
  curve: ZeroCurve,
  horizonMonths: number,
  scenarioId: string,
): ClientRateRow {
  const overlay = binding.overlay;
  if (overlay.kind !== "loan-client-rate") {
    throw new Error(`clientRateRow: binding for family ${binding.familyId} is a ${overlay.kind} overlay, not loan-client-rate`);
  }
  const totalSpreadBp = overlay.totalSpreadBp;

  const benchmark = new Array<number>(horizonMonths);
  const benchmarkPct = new Array<number | null>(horizonMonths);
  for (let k = 0; k < horizonMonths; k++) {
    const b = path.forwardRateAt(k, CLIENT_RATE_BENCHMARK_TENOR_YEARS);
    benchmark[k] = b;
    // The kernel boundary: decimal to percent, a missing point to null.
    benchmarkPct[k] = Number.isFinite(b) ? b * 100 : null;
  }
  const spreadPct = flatCarry(totalSpreadBp / 100, horizonMonths);
  const assembled = assembleClientRate(benchmarkPct, spreadPct);

  const clientRate = new Array<number>(horizonMonths);
  for (let k = 0; k < horizonMonths; k++) {
    const v = assembled[k];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      throw new ClientRateBenchmarkError(binding.familyId, scenarioId, k + 1);
    }
    clientRate[k] = v / 100;
  }

  return {
    assumptionSetId: set.id,
    familyId: binding.familyId,
    ...(binding.selector !== undefined ? { selector: binding.selector } : {}),
    model: "flat-carry",
    curveConvention: curve.convention,
    benchmarkTenorYears: CLIENT_RATE_BENCHMARK_TENOR_YEARS,
    totalSpreadBp,
    benchmark,
    clientRate,
  };
}
