/**
 * Studio slice S3a-1 follow-up (ruling 2026-11-04): a non-rate-sensitive balance is held at book. Every
 * expected value is written by hand from the position: a $37.5M asset held 360 months earns 0, repays 0, sits in no
 * gap band and is worth exactly $37.5M at base and at +200 bp. A second book adds a fixed loan beside it, so value
 * moves only by the loan's own change. The values are invented round numbers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { createEngine, resolveDefaultContext } from "../../run";
import { clearPortfolios } from "../../portfolio/registry";
import { loadMarket } from "../../run/__tests__/fixtures";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import type { Scenario } from "../../contracts/scenario";
import { NonRateInstrument, validateNonRateTerms, type NonRateTerms } from "..";
import { lowerBalancePlan } from "../../plan/lowerBalancePlan";

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarket();
});

const nr = (id: string, notional: number): NonRateTerms => ({ id, type: "non-rate-sensitive", label: "Premises", notional, maturityMonths: 360, originationOffsetMonths: 0, amortType: "bullet", side: "asset" });
const COA = (withLoan: boolean): PortfolioSpec["coa"] => ({
  schemaVersion: "1.0.0",
  nodes: [
    { id: "a", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "a-nr", label: "Premises", parentId: "a", side: "asset", isLeaf: true, familyId: "NR", order: 0 },
    ...(withLoan ? [{ id: "a-ln", label: "Loans", parentId: "a", side: "asset" as const, isLeaf: true, familyId: "LN", order: 1 }] : []),
  ],
  families: [
    { id: "NR", label: "Premises", side: "asset", instrumentType: "non-rate-sensitive", coaNodeId: "a-nr" },
    ...(withLoan ? [{ id: "LN", label: "Loans", side: "asset" as const, instrumentType: "fixed-loan" as const, coaNodeId: "a-ln" }] : []),
  ],
});

const EMPTY_SET = { schemaVersion: "1.0.0", id: "empty", label: "empty", bindings: [] };
function run(book: PortfolioSpec): RunResult {
  const scenarios: Scenario[] = [
    { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: "empty", newBusiness: { mode: "static", rules: [] } },
    { id: "S200", label: "+200", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "empty", newBusiness: { mode: "static", rules: [] } },
  ];
  clearPortfolios();
  const engine = createEngine(resolveDefaultContext());
  engine.loadPortfolio(book);
  return engine.run({
    runId: "NR-1", portfolioId: book.id, marketSnapshot: market, scenarios, assumptionSets: [EMPTY_SET],
    grid: { horizonMonths: 360, asOf: book.asOf }, seed: "1",
    timestamps: { startedAt: "2026-11-04T00:00:00.000Z", finishedAt: "2026-11-04T00:00:01.000Z" },
  });
}

describe("a non-rate-sensitive balance (S3a-1 follow-up)", () => {
  it("the instrument holds its book value every month and pays and repays nothing", () => {
    const rows = new NonRateInstrument(nr("p", 37_500_000)).generateCashflows();
    expect(rows).toHaveLength(360);
    expect(rows.every((r) => r.balance === 37_500_000 && r.principalPaid === 0 && r.interestPaid === 0)).toBe(true);
    expect(() => validateNonRateTerms({ ...nr("p", 1), originationOffsetMonths: -2 })).toThrow(/originationOffsetMonths must be 0/);
    expect(() => validateNonRateTerms({ ...nr("p", 0) })).toThrow(/positive/);
  });

  it("a one-position book: NII 0, no gap entry in either ladder, EVE equal to book at base and at +200 bp", () => {
    const book: PortfolioSpec = { id: "nr-only", label: "nr", asOf: "2026-03-31", coa: COA(false), positions: [{ id: "p", familyId: "NR", coaNodeId: "a-nr", terms: nr("p", 37_500_000) }] };
    const r = run(book);
    for (const s of r.nii.byScenario) expect(s.totalNet12, s.scenarioId).toBe(0);
    for (const ladder of [...r.gap.repricing, ...r.gap.liquidity]) {
      expect(ladder.rows.every((row) => row.assets === 0 && row.liabilities === 0), `${ladder.kind} ${ladder.scenarioId}`).toBe(true);
    }
    const eve = new Map(r.eve.byScenario.map((s) => [s.scenarioId, s]));
    expect(eve.get("S0")!.pvAssets).toBe(37_500_000);
    expect(eve.get("S200")!.pvAssets).toBe(37_500_000);
    expect(eve.get("S0")!.eve).toBe(37_500_000);
    expect(eve.get("S200")!.deltaEveVsBase).toBe(0);
  });

  it("beside a fixed loan it adds the same book value to base and to shocked value", () => {
    const loan = { id: "l", type: "fixed-loan" as const, notional: 10_000_000, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet" as const, side: "asset" as const, coupon: 0.05 };
    const withNr: PortfolioSpec = { id: "nr-loan", label: "nr", asOf: "2026-03-31", coa: COA(true), positions: [{ id: "p", familyId: "NR", coaNodeId: "a-nr", terms: nr("p", 37_500_000) }, { id: "l", familyId: "LN", coaNodeId: "a-ln", terms: loan }] };
    const loanOnly: PortfolioSpec = { ...withNr, id: "loan-only", positions: [withNr.positions[1]!] };
    const a = run(withNr);
    const b = run(loanOnly);
    for (const id of ["S0", "S200"]) {
      const ea = a.eve.byScenario.find((s) => s.scenarioId === id)!.eve;
      const eb = b.eve.byScenario.find((s) => s.scenarioId === id)!.eve;
      expect(ea - eb, id).toBeCloseTo(37_500_000, 6);
    }
    // NII: the loan's own, the book balance adds nothing.
    expect(a.nii.byScenario[0]!.totalNet12).toBeCloseTo(b.nii.byScenario[0]!.totalNet12, 6);
  });

  it("a balance target on it is refused: it does not run off", () => {
    const coa = COA(false);
    expect(() => lowerBalancePlan({ schemaVersion: "1.0.0", id: "bp", label: "bp", asOf: "2026-03-31", targets: [{ familyId: "NR", path: [{ month: 1, balance: 37_500_000 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } }], unlistedFamilies: "runoff" }, new Map([["NR", 37_500_000]]), 360, "2026-03-31", coa)).toThrow(/non-rate-sensitive: it is held at book value and does not run off/);
  });
});
