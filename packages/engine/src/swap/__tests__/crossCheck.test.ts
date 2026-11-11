// packages/engine/src/swap/__tests__/crossCheck.test.ts
/**
 * The cross-check, engine half.
 *
 * Every expected value is restated from discount factors (./fixtures.ts) or
 * taken from the UNHEDGED run of the same book, never from the swap folds.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { buildTLPCurve, DEFAULT_TLP_CURVE, type MarketSnapshot, type TLPCurve, type ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { computeEveChannels } from "../../eve/channels";
import { computeKeyRateDurations } from "../../eve/keyRate";
import { quoteTenorsOf } from "../../curveBuilder/quoteTenors";
import { projectInstrument } from "../../instrument/projectInstrument";
import { buildCellPlan } from "../../portfolio/cells";
import { SwapFamilyMappingError } from "../../run/executorErrors";
import { loadMarket, regulatoryScenarios, twoSidedBook } from "../../run/__tests__/fixtures";
import { buildBaseCurve } from "../../scenario/rateEnvironment";
import { engineParRate, hedgedBook, N_SWAP, runBook, swapPosition, swapTerms, SWAP_FAMILY_ID } from "./fixtures";

/** Ledger L2. */
const PAR_TOLERANCE_PER_100 = 1e-9;
/**
 * Ledger L4, ruling T16a. One measured probe of the combined three-swap book
 * (1,000,000 each) on cleanBook: cap = 0.5 * unhedged / -perMillionShift, 1.1999
 * million at 2y and 0.8014 million at 5y, floored to 0.1 million. The 10y node is
 * negative on this book (-1.6289), so it takes no cap. Measured on the kernel
 * curve (curve default 1), before B4; the 800,000 notional is kept on curve
 * default 2, where the test still finds 2y and 5y falling and staying positive.
 */
const KRD_HEDGE_NOTIONAL = 800_000;

let market: MarketSnapshot;
let base: ZeroCurve;
let tlp: TLPCurve;
beforeAll(async () => {
  market = await loadMarket();
  base = buildBaseCurve(market);
  tlp = market.tlpNodes.length > 0 ? buildTLPCurve(market.tlpNodes) : DEFAULT_TLP_CURVE;
});

/** The fixture book without the Non-IB NMD, whose regime amplifier makes key rates refuse. */
function cleanBook(id: string): PortfolioSpec {
  const b = twoSidedBook(id);
  return { ...b, positions: b.positions.filter((p) => p.id !== "D1") };
}
const krd = (b: PortfolioSpec) =>
  computeKeyRateDurations({ portfolio: b, scenarioId: "S0", curve: base, tlp, horizonMonths: 360, discountBasis: "all-in" });
// The key-rate nodes are the curve's quote tenors (quoteTenorsOf), as production reads them; the default curve now
// carries 360 dense nodes, so a node is chosen by its tenor, not by an index into base.t. Deltas Step 1.
const nodeNear = (years: number) => {
  const tenors = quoteTenorsOf(base);
  return tenors.reduce((best, t, i) => (Math.abs(t - years) < Math.abs(tenors[best]! - years) ? i : best), 0);
};
/** The three pay-fixed par swaps at 24, 60 and 120 months, each at `notional`, in one family. */
const threeSwapHedge = (id: string, notional: number, b0: PortfolioSpec, direction: "pay-fixed" | "receive-fixed" = "pay-fixed") =>
  hedgedBook(
    id,
    [24, 60, 120].map((m) =>
      swapPosition(`H${m}`, SWAP_FAMILY_ID, { maturityMonths: m, fixedRate: engineParRate(base, m), notional, direction }),
    ),
    [SWAP_FAMILY_ID],
    b0,
  );

describe("invariant 1: a par swap is worth ~0 on the risk-free curve", () => {
  it("at 24, 60 and 120 months, within PAR_TOLERANCE_PER_100 per 100 notional", () => {
    for (const m of [24, 60, 120]) {
      const pv = projectInstrument({
        terms: swapTerms(`par-${m}`, { notional: 100, maturityMonths: m, fixedRate: engineParRate(base, m) }) as never,
        familyId: SWAP_FAMILY_ID,
        side: "derivative",
        marketSnapshot: market,
        scenarios: [regulatoryScenarios()[0]!],
        horizonMonths: 360,
      }).byScenario[0]!.pvRiskFree;
      expect(Math.abs(pv), `${m}m: PV per 100 = ${pv}`).toBeLessThanOrEqual(PAR_TOLERANCE_PER_100);
    }
  });
});

describe("invariant 2: an offset pair nets to exactly 0 everywhere", () => {
  let unhedged: RunResult;
  let offset: RunResult;
  let oneFamily: RunResult;
  beforeAll(() => {
    unhedged = runBook(market, twoSidedBook("PF-X2-0"));
    offset = runBook(
      market,
      hedgedBook(
        "PF-X2-1",
        [
          swapPosition("SWP", "SWAPS-PAY", { direction: "pay-fixed", fixedRate: 0.045 }),
          swapPosition("SWR", "SWAPS-REC", { direction: "receive-fixed", fixedRate: 0.045 }),
        ],
        ["SWAPS-PAY", "SWAPS-REC"],
      ),
    );
    oneFamily = runBook(
      market,
      hedgedBook("PF-X2-2", [
        swapPosition("SWP", SWAP_FAMILY_ID, { direction: "pay-fixed", fixedRate: 0.045 }),
        swapPosition("SWR", SWAP_FAMILY_ID, { direction: "receive-fixed", fixedRate: 0.045 }),
      ]),
    );
  }, 300_000);

  it("EVE, delta EVE and equity duration are bit-identical in every scenario (two families)", () => {
    for (const a of unhedged.eve.byScenario) {
      const b = offset.eve.byScenario.find((s) => s.scenarioId === a.scenarioId)!;
      expect([b.eve, b.deltaEveVsBase, b.effectiveDurationEquity, b.pvDerivatives], a.scenarioId).toEqual([
        a.eve,
        a.deltaEveVsBase,
        a.effectiveDurationEquity,
        0,
      ]);
    }
  });

  it("NII totals and the monthly vector are bit-identical in every scenario (two families)", () => {
    for (const a of unhedged.nii.byScenario) {
      const b = offset.nii.byScenario.find((s) => s.scenarioId === a.scenarioId)!;
      expect([b.totalNet12, b.totalNet24, b.derivativesNet12], a.scenarioId).toEqual([a.totalNet12, a.totalNet24, 0]);
      expect(b.netMonthly, a.scenarioId).toEqual(a.netMonthly);
    }
  });

  it("every gap bucket of both ladders is bit-identical in every scenario (two families)", () => {
    for (const kind of ["repricing", "liquidity"] as const) {
      for (const a of unhedged.gap[kind]) {
        const b = offset.gap[kind].find((x) => x.scenarioId === a.scenarioId)!;
        expect(b.rows, `${kind}/${a.scenarioId}`).toEqual(a.rows);
      }
    }
  });

  it("every key rate is bit-identical (two families, amplifier-free book)", () => {
    const b0 = cleanBook("PF-X2-3");
    const b1 = hedgedBook(
      "PF-X2-4",
      [
        swapPosition("SWP", "SWAPS-PAY", { direction: "pay-fixed", fixedRate: 0.045 }),
        swapPosition("SWR", "SWAPS-REC", { direction: "receive-fixed", fixedRate: 0.045 }),
      ],
      ["SWAPS-PAY", "SWAPS-REC"],
      b0,
    );
    const k0 = krd(b0);
    const k1 = krd(b1);
    expect(k1.nodes).toEqual(k0.nodes);
    expect([k1.sum, k1.parallelReference]).toEqual([k0.sum, k0.parallelReference]);
  });

  it("in ONE family the pair nets only to rounding, and within 1e-9 of notional", () => {
    for (const a of unhedged.eve.byScenario) {
      const b = oneFamily.eve.byScenario.find((s) => s.scenarioId === a.scenarioId)!;
      expect(Math.abs(b.pvDerivatives!), `${a.scenarioId}: ${b.pvDerivatives}`).toBeLessThanOrEqual(1e-9 * N_SWAP);
    }
  });
});

describe("invariant 4 (key-rate half): pay-fixed swaps lower the 2, 5 and 10 year nodes", () => {
  it("on the amplifier-free book, 2y and 5y fall and stay positive; 10y falls (signed direction only)", () => {
    const b0 = cleanBook("PF-X4-0");
    const b1 = threeSwapHedge("PF-X4-1", KRD_HEDGE_NOTIONAL, b0);
    const k0 = krd(b0);
    const k1 = krd(b1);
    for (const years of [2, 5]) {
      const j = nodeNear(years);
      expect(k0.nodes[j]!.tenorYears).toBe(years);
      const before = k0.nodes[j]!.duration;
      const after = k1.nodes[j]!.duration;
      expect(after, `${years}y node ${k0.nodes[j]!.tenorYears}: unhedged ${before} hedged ${after}`).toBeLessThan(before);
      expect(after, `${years}y node overshot to ${after}`).toBeGreaterThan(0);
    }
    // On this amplifier-free test book the 10y node is already negative, so the
    // pay-fixed 10y swap moves it further from zero, which INCREASES the 10y
    // exposure. Disclosed on the limitations page; this is not a hedge-reduction claim,
    // and nothing here asserts that |10y| gets smaller.
    const j10 = nodeNear(10);
    expect(k0.nodes[j10]!.tenorYears).toBe(10);
    const before10 = k0.nodes[j10]!.duration;
    const after10 = k1.nodes[j10]!.duration;
    expect(
      after10,
      `10y node ${k0.nodes[j10]!.tenorYears}: unhedged ${before10} hedged ${after10}; the node is already negative on this test book, so ` +
        `the pay-fixed swap moves it further from zero and increases the 10y exposure (disclosed in LIMITATIONS, not a hedge-reduction claim)`,
    ).toBeLessThan(before10);
  });
});

describe("invariant 5: the mapping refuses", () => {
  function refusalOf(book: PortfolioSpec): string {
    try {
      buildCellPlan(book, undefined);
      return "ADMITTED";
    } catch (err) {
      return err instanceof SwapFamilyMappingError ? "REFUSED" : `OTHER ${String(err)}`;
    }
  }
  it("a swap in a loan family, a loan in a swap family, and a swap family on the asset side", () => {
    const b = twoSidedBook("PF-X5");
    const swapInLoan: PortfolioSpec = { ...b, positions: [{ ...b.positions[0]!, terms: swapTerms(b.positions[0]!.id) }, ...b.positions.slice(1)] };
    const hb = hedgedBook("PF-X5b", []);
    const loanInSwap: PortfolioSpec = { ...hb, positions: [{ ...hb.positions[0]!, familyId: SWAP_FAMILY_ID, coaNodeId: `node-${SWAP_FAMILY_ID}` }, ...hb.positions.slice(1)] };
    const hs = hedgedBook("PF-X5c", [swapPosition("SW1")]);
    const assetSide: PortfolioSpec = { ...hs, coa: { ...hs.coa, families: hs.coa.families.map((f) => (f.id === SWAP_FAMILY_ID ? { ...f, side: "asset" as const } : f)) } };
    expect([refusalOf(swapInLoan), refusalOf(loanInSwap), refusalOf(assetSide)]).toEqual(["REFUSED", "REFUSED", "REFUSED"]);
  });
});

describe("invariant 7: the drill's PV is the swap's EVE contribution", () => {
  const drillOf = (rate: number) =>
    projectInstrument({
      terms: swapTerms("D1", { fixedRate: rate }) as never,
      familyId: SWAP_FAMILY_ID,
      side: "derivative",
      marketSnapshot: market,
      scenarios: regulatoryScenarios(),
      horizonMonths: 360,
    });

  it("equals the one-position swap family's pv in every scenario", () => {
    const rate = engineParRate(base, 60) + 0.0025;
    const run = runBook(market, hedgedBook("PF-X7", [swapPosition("D1", SWAP_FAMILY_ID, { fixedRate: rate })]));
    for (const s of drillOf(rate).byScenario) {
      const fam = run.eve.byScenario.find((x) => x.scenarioId === s.scenarioId)!.byFamily.find((f) => f.familyId === SWAP_FAMILY_ID)!;
      expect(Math.abs(s.pvRiskFree - fam.pv), `${s.scenarioId}: drill ${s.pvRiskFree} run ${fam.pv}`).toBeLessThanOrEqual(1e-9 * N_SWAP);
    }
  }, 180_000);

  it("end to end: in a book holding only that swap, the drill's pvRiskFree equals the run's pvDerivatives (horizon 360 past the 60-month maturity)", () => {
    const rate = engineParRate(base, 60) + 0.0025;
    const empty: PortfolioSpec = { ...twoSidedBook("PF-X7b"), positions: [] };
    const run = runBook(market, hedgedBook("PF-X7b", [swapPosition("D1", SWAP_FAMILY_ID, { fixedRate: rate })], [SWAP_FAMILY_ID], empty));
    for (const s of drillOf(rate).byScenario) {
      const e = run.eve.byScenario.find((x) => x.scenarioId === s.scenarioId)!;
      expect(Math.abs(s.pvRiskFree - e.pvDerivatives!), `${s.scenarioId}: drill ${s.pvRiskFree} run pvDerivatives ${e.pvDerivatives}`).toBeLessThanOrEqual(
        1e-9 * N_SWAP,
      );
    }
  }, 180_000);
});

describe("T7a: every derivative key is gated by family", () => {
  const channelsOf = (b: PortfolioSpec) =>
    computeEveChannels({ portfolio: b, scenarios: regulatoryScenarios(), baseCurve: base, tlp, horizonMonths: 360, discountBasis: "all-in" });

  it("the unhedged book carries no pvDerivatives, no derivativesNet*, no derivativesDelta", () => {
    const b = twoSidedBook("PF-T7A-0");
    const run = runBook(market, b);
    for (const s of run.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(false);
    for (const s of run.nii.byScenario) {
      expect(["derivativesNet12", "derivativesNet24", "derivativesNetByHorizon"].filter((k) => k in s), s.scenarioId).toEqual([]);
    }
    for (const row of channelsOf(b).byScenario) expect("derivativesDelta" in row, row.scenarioId).toBe(false);
  });

  it("the hedged book carries every one of them", () => {
    const b = hedgedBook("PF-T7A-1", [swapPosition("SW1")]);
    const run = runBook(market, b);
    for (const s of run.eve.byScenario) expect("pvDerivatives" in s, s.scenarioId).toBe(true);
    for (const s of run.nii.byScenario) {
      expect(["derivativesNet12", "derivativesNet24", "derivativesNetByHorizon"].filter((k) => k in s), s.scenarioId).toEqual([
        "derivativesNet12",
        "derivativesNet24",
        "derivativesNetByHorizon",
      ]);
    }
    for (const row of channelsOf(b).byScenario) expect("derivativesDelta" in row, row.scenarioId).toBe(true);
  });
});
