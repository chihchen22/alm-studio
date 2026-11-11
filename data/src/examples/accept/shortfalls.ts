/**
 * Acceptance check: typed-shortfalls-contract (F1+F3 contract hygiene).
 *
 * Anchor: the arithmetic identity carried BY the typed slot. A 60-month bullet
 * family run dynamically against a -5%/month growth target cannot follow the
 * target down (the strategy only originates, never sells), so the sweep clamps
 * and reports a shortfall. Since schemaVersion 1.1.0 that lands TYPED in
 * `ScenarioNII.shortfalls` with family and magnitude, and
 * balanceGapEnd === achievedBalanceEnd - targetBalanceEnd holds to the bit
 * (the fields mirror the dynamic projection verbatim; nothing recomputed).
 * The former free-text `run.shortfall.*` register tag must be GONE, and the
 * static base scenario must carry no `shortfalls` key at all.
 *
 * Register note: the dynamic scenario is NOT rate-only, so attribution
 * declines it with the typed `attribution.SDYN` tag (the multi-driver peel is a declared stretch, not built). That tag is
 * declared on this capability's register entry; stage 4 asserts it appears.
 */
import { FIXED_LOAN_DEFAULTS, type FixedLoanTerms } from "@alm/kernel";
import type { Position, Scenario } from "@alm/engine";
import { baseScenario, emptySet, runSmallBook, smallBook } from "./handBooks";
import type { CapabilityCheck, CheckLine } from "./types";

export const shortfallsCheck: CapabilityCheck = {
  capabilityId: "typed-shortfalls-contract",
  title: "F1+F3: typed reinvestment shortfall, free-text tag gone",
  run({ market }) {
    const lines: CheckLine[] = [];
    const set = emptySet();
    const terms: FixedLoanTerms = {
      ...FIXED_LOAN_DEFAULTS,
      id: "fx-1",
      notional: 1_000_000,
      maturityMonths: 60,
      amortType: "bullet",
    };
    const positions: Position[] = [{ id: "fx-1", familyId: "FIXED", coaNodeId: "coa-FIXED", terms }];
    const book = smallBook("accept-shortfall", [{ id: "FIXED", side: "asset", instrumentType: "fixed-loan" }], positions);
    const dyn: Scenario = {
      id: "SDYN",
      label: "dynamic, declining target",
      rateSpec: { kind: "parallel", shockBp: 100 },
      assumptionSetId: set.id,
      newBusiness: { mode: "dynamic", rules: [{ familyId: "FIXED", reinvest: "growth", monthlyGrowthRate: -0.05 }] },
    };
    const result = runSmallBook(book, market, [baseScenario(set.id), dyn], [set], "accept-shortfall-1");

    const dynNii = result.nii.byScenario.find((s) => s.scenarioId === "SDYN");
    const sf = dynNii?.shortfalls?.[0];
    if (!sf || dynNii?.shortfalls?.length !== 1) {
      lines.push({
        id: "typed-slot",
        status: "fail",
        detail: `expected exactly one typed shortfall on the dynamic scenario; got ${dynNii?.shortfalls?.length ?? "none"}`,
      });
    } else {
      const identity = sf.balanceGapEnd === sf.achievedBalanceEnd - sf.targetBalanceEnd;
      const ok = sf.familyId === "FIXED" && sf.reinvest === "growth" && sf.clampedBuckets > 0 && identity;
      lines.push({
        id: "typed-slot",
        status: ok ? "pass" : "fail",
        detail:
          `dynamic under-hit lands typed: family ${sf.familyId}, rule ${sf.reinvest}, ` +
          `clampedBuckets ${sf.clampedBuckets}, balanceGapEnd $${sf.balanceGapEnd.toFixed(2)} ` +
          `=== achieved - target to the bit: ${identity} (anchor: a bullet cannot follow a ` +
          `-5%/month target without disposals — the under-hit is an arithmetic certainty, and ` +
          `the slot mirrors the dynamic projection verbatim)`,
      });
    }

    const freeText = result.notImplemented.filter((t) => t.layer.startsWith("run.shortfall"));
    lines.push({
      id: "free-text-tag-gone",
      status: freeText.length === 0 ? "pass" : "fail",
      detail: `pre-1.1.0 free-text run.shortfall.* register tags present: ${freeText.length} (must be 0 — the typed slot supersedes them)`,
    });

    const baseNii = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    lines.push({
      id: "static-shape-unchanged",
      status: "shortfalls" in baseNii ? "fail" : "pass",
      detail: `the static base scenario carries no "shortfalls" key (the field appears only on a dynamic under-hit, so the static grid's serialized shape is unchanged)`,
    });

    return { lines, observedNotImplemented: result.notImplemented.map((t) => t.layer) };
  },
};
