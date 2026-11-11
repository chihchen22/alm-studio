/**
 * Acceptance check: floater-reset-banding (honesty defect D1).
 *
 * Anchor: HAND COMPUTATION. A reset at
 * kernel schedule month m happens m-1 months from as-of (the kernel reads
 * rateAt(m-1)), i.e. bucket m-2 for the first reset strictly after the month-1
 * origination reset. So, banded on the nine-band scheme:
 *
 *   monthly   (next reset month 2)  -> bucket 0  -> band 0 (0-1M)
 *   quarterly (next reset month 4)  -> bucket 2  -> band 1 (1-3M)
 *   annual    (next reset month 13) -> bucket 11 -> band 3 (6-12M)
 *
 * The check runs a hand-built three-floater book through the FULL run pipeline
 * (createEngine().run(), not the gap module in isolation) and asserts the band
 * placement and conservation: total repricing balance equals total liquidity
 * balance (nothing double-counted, nothing dropped).
 */
import { FLOATING_LOAN_DEFAULTS, type FloatingLoanTerms } from "@alm/kernel";
import type { Position, RunResult } from "@alm/engine";
import { baseScenario, emptySet, runSmallBook, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

const NOTIONAL = 1_000_000;

function floater(id: string, resetFrequencyMonths: number): Position {
  const terms: FloatingLoanTerms = {
    ...FLOATING_LOAN_DEFAULTS,
    id,
    notional: NOTIONAL,
    maturityMonths: 60,
    amortType: "bullet",
    resetFrequencyMonths,
  };
  return { id, familyId: "FLOAT", coaNodeId: "coa-FLOAT", terms };
}

function floatRows(result: RunResult, kind: "repricing" | "liquidity") {
  const ladder = result.gap[kind].find((g) => g.scenarioId === "S0")!;
  return ladder.byCoaNode.find((n) => n.coaNodeId === "coa-FLOAT")!.rows;
}

export const floaterBandingCheck: CapabilityCheck = {
  capabilityId: "floater-reset-banding",
  title: "D1: floaters band by their actual next reset",
  run({ market }) {
    const lines: CheckLine[] = [];
    const set = emptySet();
    const book = smallBook(
      "accept-floaters",
      [{ id: "FLOAT", side: "asset", instrumentType: "floating-loan" }],
      [floater("fl-monthly", 1), floater("fl-quarterly", 3), floater("fl-annual", 12)],
    );
    const result = runSmallBook(book, market, [baseScenario(set.id)], [set], "accept-floater-1");
    const repr = floatRows(result, "repricing");
    const liq = floatRows(result, "liquidity");

    // Hand-computed placement: one full notional in each of bands 0, 1, 3.
    const bandAssets = repr.map((r) => r.assets);
    const want = [NOTIONAL, NOTIONAL, 0, NOTIONAL, 0, 0, 0, 0, 0];
    const placed = bandAssets.every((v, i) => Math.abs(v - want[i]) <= 1e-6);
    lines.push({
      id: "band-placement",
      status: placed ? "pass" : "fail",
      detail:
        `three-floater book (monthly/quarterly/annual bullets, $1M each): repricing bands ` +
        `[${bandAssets.map((v) => v.toFixed(0)).join(", ")}] vs hand-computed ` +
        `[${want.join(", ")}] — 0-1M / 1-3M / 6-12M (anchor: reset at schedule month m is ` +
        `bucket m-2; computable on paper from the kernel reset ladder and the 9-band scheme)`,
    });

    const reprTotal = repr.reduce((a, r) => a + r.assets, 0);
    const liqTotal = liq.reduce((a, r) => a + r.assets, 0);
    const relGap = Math.abs(reprTotal - liqTotal) / Math.max(1, liqTotal);
    lines.push({
      id: "conservation",
      status: relGap <= 1e-9 ? "pass" : "fail",
      detail:
        `repricing band total $${reprTotal.toFixed(2)} vs liquidity band total ` +
        `$${liqTotal.toFixed(2)} — relative gap ${relGap.toExponential(2)} <= 1e-9 ` +
        `(anchor: every principal dollar reprices exactly once)`,
    });

    return { lines, observedNotImplemented: result.notImplemented.map((t) => t.layer) };
  },
};
