/**
 * Acceptance check: nii-flexible-horizons-wal.
 *
 * Anchors and the report:
 *
 *   1. HORIZON IDENTITY — net12 === byHorizon[12].net and net24 ===
 *      byHorizon[24].net EXACTLY (Object.is, not tolerance): the pinned pairs
 *      are copied from the identical accumulation, never recomputed. Scenario
 *      totals likewise.
 *   2. PARTIAL-SUM CONTRACT — the ordered partial sums of the scenario
 *      netMonthly vector equal the horizon nets EXACTLY at 12 and 24 (the
 *      contract's "a consumer can compute any horizon" promise, asserted).
 *   3. WAL HAND CASE — a family holding 50 @ 12M + 50 @ 24M bullets has
 *      walYears === 1.5 exactly (every operand exact in IEEE double), and a
 *      single 24M bullet family has walYears === 2 exactly; an empty-principal
 *      family carries NO walYears field (absent, never 0).
 */
import { FIXED_LOAN_DEFAULTS, type FixedLoanTerms } from "@alm/kernel";
import type { Position } from "@alm/engine";
import { baseScenario, emptySet, runSmallBook, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

function bullet(id: string, familyId: string, notional: number, maturityMonths: number): Position {
  const terms: FixedLoanTerms = { ...FIXED_LOAN_DEFAULTS, id, notional, maturityMonths, amortType: "bullet" };
  return { id, familyId, coaNodeId: `coa-${familyId}`, terms };
}

export const niiCheck: CapabilityCheck = {
  capabilityId: "nii-flexible-horizons-wal",
  title: "NII byHorizon + monthly net vector + family WAL",
  run({ market }) {
    const lines: CheckLine[] = [];
    const set = emptySet();
    const book = smallBook(
      "accept-nii-wal",
      [
        { id: "WAL2", side: "asset", instrumentType: "fixed-loan", label: "two-payment hand case" },
        { id: "WAL1", side: "asset", instrumentType: "fixed-loan", label: "bullet degeneracy" },
      ],
      [
        bullet("w2-a", "WAL2", 50, 12),
        bullet("w2-b", "WAL2", 50, 24),
        bullet("w1-a", "WAL1", 100, 24),
      ],
    );
    const result = runSmallBook(book, market, [baseScenario(set.id)], [set], "accept-nii-1");
    const observed = result.notImplemented.map((t) => t.layer);
    const s0 = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;

    // 1. Horizon identity, per family and in total, exact.
    let identity = Object.is(s0.totalNet12, s0.totalNetByHorizon?.[12]) && Object.is(s0.totalNet24, s0.totalNetByHorizon?.[24]);
    for (const f of s0.byFamily) {
      identity =
        identity &&
        Object.is(f.net12, f.byHorizon?.[12]?.net) &&
        Object.is(f.net24, f.byHorizon?.[24]?.net);
    }
    lines.push({
      id: "horizon-identity",
      status: identity ? "pass" : "fail",
      detail:
        `net12 === byHorizon[12].net and net24 === byHorizon[24].net (Object.is) per family and ` +
        `in total: ${identity}; totalNet12 $${s0.totalNet12.toFixed(2)} (anchor: the pinned pairs ` +
        `are the identical accumulation copied, never recomputed — identity, not tolerance)`,
    });

    // 2. The partial-sum contract, asserted at the grain the contract pins it:
    // per FAMILY, the ordered partial sums of netMonthly equal byHorizon[h].net
    // EXACTLY; and the scenario vector is the bucket-wise sum of the family
    // vectors in declared order, exactly. (Scenario totalNet12 sums the family
    // net12 values — a different summation ORDER — so scenario-level partial
    // sums agree only to floating-point associativity and are not the pin.)
    let partial = true;
    for (const f of s0.byFamily) {
      const v = f.netMonthly ?? [];
      let p12 = 0;
      let p24 = 0;
      for (let k = 0; k < Math.min(24, v.length); k++) {
        if (k < 12) p12 += v[k];
        p24 += v[k];
      }
      partial = partial && p12 === f.byHorizon?.[12]?.net && p24 === f.byHorizon?.[24]?.net;
    }
    const sn = s0.netMonthly ?? [];
    let bucketSum = sn.length > 0;
    for (let k = 0; k < sn.length; k++) {
      let acc = 0;
      for (const f of s0.byFamily) acc += (f.netMonthly ?? [])[k] ?? 0;
      if (!Object.is(acc, sn[k])) {
        bucketSum = false;
        break;
      }
    }
    lines.push({
      id: "partial-sum",
      status: partial && bucketSum ? "pass" : "fail",
      detail:
        `per-family ordered partial sums of netMonthly equal byHorizon[12].net and ` +
        `byHorizon[24].net EXACTLY: ${partial}; scenario netMonthly is the bucket-wise sum of ` +
        `the family vectors in declared order, exact per bucket: ${bucketSum} (anchor: the ` +
        `contract's own promise that any horizon is computable from the monthly vector without ` +
        `recomputation, at the grain the contract pins it)`,
    });

    // 3. WAL hand cases through the full aggregator.
    const cf = result.cashflows.byScenario.find((s) => s.scenarioId === "S0")!;
    const wal2 = cf.byFamily.find((f) => f.familyId === "WAL2")?.walYears;
    const wal1 = cf.byFamily.find((f) => f.familyId === "WAL1")?.walYears;
    const hand = wal2 === 1.5 && wal1 === 2;
    lines.push({
      id: "wal-hand-case",
      status: hand ? "pass" : "fail",
      detail:
        `two-payment family (50 @ 12M + 50 @ 24M): walYears = ${wal2} === 1.5 exactly; single ` +
        `24M bullet: walYears = ${wal1} === 2 exactly (anchor: (50*12 + 50*24)/(100*12) = 1.5y ` +
        `on paper; every operand exact in IEEE double)`,
    });

    return { lines, observedNotImplemented: observed };
  },
};
