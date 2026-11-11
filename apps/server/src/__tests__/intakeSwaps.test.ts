// apps/server/src/__tests__/intakeSwaps.test.ts
/**
 * Intake admits the engine-side types. Piece 8 refused every swap here ("seed-only");
 * this file now holds the truth for all of them, one block per type: a valid row on the JSON and the CSV path,
 * then each refusal, each named by row and field. Every expected value is written out by hand from the terms in the
 * test, never read back from the intake code. The values are invented round numbers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChartOfAccounts, Position } from "@alm/engine";
import { parsePositionsCsv } from "../intake/positionsCsv";
import { parsePositionsJson } from "../intake/positionsJson";
import type { RowError } from "../intake/validationReport";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import { nmdBetaPosition, validSpec } from "../intake/__tests__/fixtures";

/** A chart with every family the types need: a swap (derivative), a cd book, a commitment, a floating liability. */
const COA: ChartOfAccounts = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "a", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "a-loans", label: "Loans", parentId: "a", side: "asset", isLeaf: true, familyId: "loans", order: 0 },
    { id: "a-lines", label: "Undrawn lines", parentId: "a", side: "asset", isLeaf: true, familyId: "lines", order: 1 },
    { id: "l", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
    { id: "l-cds", label: "CDs", parentId: "l", side: "liability", isLeaf: true, familyId: "cds", order: 0 },
    { id: "l-adv", label: "Floating advances", parentId: "l", side: "liability", isLeaf: true, familyId: "advances", order: 1 },
    { id: "l-dda", label: "Checking", parentId: "l", side: "liability", isLeaf: true, familyId: "dda", order: 2 },
    { id: "d", label: "Derivatives", parentId: null, side: "derivative", isLeaf: false, order: 2 },
    { id: "d-swaps", label: "Swaps", parentId: "d", side: "derivative", isLeaf: true, familyId: "swaps", order: 0 },
  ],
  families: [
    { id: "loans", label: "Loans", side: "asset", instrumentType: "fixed-loan", coaNodeId: "a-loans" },
    { id: "lines", label: "Undrawn lines", side: "asset", instrumentType: "commitment", coaNodeId: "a-lines" },
    { id: "cds", label: "CDs", side: "liability", instrumentType: "cd", coaNodeId: "l-cds" },
    { id: "advances", label: "Floating advances", side: "liability", instrumentType: "floating-loan", coaNodeId: "l-adv" },
    { id: "dda", label: "Checking", side: "liability", instrumentType: "nmd", coaNodeId: "l-dda" },
    { id: "swaps", label: "Swaps", side: "derivative", instrumentType: "swap", coaNodeId: "d-swaps" },
  ],
};

const swap = (over: Record<string, unknown> = {}): Position => ({
  id: "sw1", familyId: "swaps", coaNodeId: "d-swaps",
  terms: { id: "sw1", type: "swap", notional: 50_000_000, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet", direction: "pay-fixed", fixedRate: 0.035, ...over } as Position["terms"],
});
const cd = (over: Record<string, unknown> = {}): Position => ({
  id: "cd1", familyId: "cds", coaNodeId: "l-cds",
  terms: {
    id: "cd1", type: "cd", notional: 30_000_000, maturityMonths: 10, originationOffsetMonths: 0, amortType: "bullet", side: "liability",
    cohorts: [{ termMonths: 12, monthsToMaturity: 10, balance: 40, contractRate: 0.04 }, { termMonths: 6, monthsToMaturity: 2, balance: 20, contractRate: 0.035 }],
    ...over,
  } as Position["terms"],
});
const line = (over: Record<string, unknown> = {}): Position => ({
  id: "ln1", familyId: "lines", coaNodeId: "a-lines",
  terms: { id: "ln1", type: "commitment", notional: 20_000_000, maturityMonths: 24, originationOffsetMonths: 0, amortType: "bullet", side: "asset", draw: { rampRates: [0.02, 0.01], steadyRate: 0.005 }, ...over } as Position["terms"],
});
const advance = (over: Record<string, unknown> = {}): Position => ({
  id: "fa1", familyId: "advances", coaNodeId: "l-adv",
  terms: { id: "fa1", type: "floating-loan", notional: 10_000_000, maturityMonths: 24, originationOffsetMonths: 0, amortType: "bullet", side: "liability", indexTenorMonths: 1, margin: 0.002, resetFrequencyMonths: 1, ...over } as Position["terms"],
});
const book = (positions: Position[], coa: ChartOfAccounts = COA, extra: Record<string, unknown> = {}) => ({ id: "s3a1-book", label: "S3a-1 intake book", asOf: "2026-03-31", coa, positions, ...extra });

function errorsOf(out: ReturnType<typeof parsePositionsJson>): RowError[] {
  expect("errors" in out, JSON.stringify(out).slice(0, 400)).toBe(true);
  return (out as { errors: RowError[] }).errors;
}
const cols = (errors: readonly RowError[]) => errors.map((e) => `${e.row ?? "-"}:${e.column ?? "-"}`).sort();

describe("swaps", () => {
  it("a valid swap imports on the JSON path, stored as written, with no warning", () => {
    const spec = book([swap({ floatMargin: 0.001, resetFrequencyMonths: 3 })]);
    const out = parsePositionsJson(JSON.parse(JSON.stringify(spec)));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if (!("portfolio" in out)) return;
    expect(out.portfolio).toEqual(spec);
    expect(out.warnings).toEqual([]);
  });
  it("each refusal names the row and the field", () => {
    const e = errorsOf(parsePositionsJson(book([swap({ direction: "sideways", fixedRate: "4%", side: "asset", amortType: "level-pay" })])));
    expect(cols(e)).toEqual(["1:amortType", "1:direction", "1:fixedRate", "1:side"]);
    expect(cols(errorsOf(parsePositionsJson(book([swap({ maturityMonths: 0 })]))))).toEqual(["1:maturityMonths"]);
    expect(cols(errorsOf(parsePositionsJson(book([swap({ resetFrequencyMonths: 61 })]))))).toEqual(["1:resetFrequencyMonths"]);
    expect(cols(errorsOf(parsePositionsJson(book([swap({ originationOffsetMonths: -3 })]))))).toEqual(["1:originationOffsetMonths"]);
    const noDir = swap();
    delete (noDir.terms as unknown as Record<string, unknown>).direction;
    expect(errorsOf(parsePositionsJson(book([noDir])))).toEqual([{ row: 1, positionId: "sw1", column: "direction", message: 'required field "direction" is missing' }]);
  });
  it("a derivative family must be a swap family, and a swap family must be derivative", () => {
    const bad: ChartOfAccounts = { ...COA, families: COA.families.map((f) => (f.id === "swaps" ? { ...f, side: "liability" as const } : f)) };
    const e = errorsOf(parsePositionsJson(book([swap()], bad)));
    expect(e.some((x) => x.column === "coa.families" && /"swaps"/.test(x.message))).toBe(true);
  });
  it("the CSV path reads a swap row with a blank side and refuses a stated one", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,side,direction,fixedRate,floatMargin";
    const ok = parsePositionsCsv([header, "sw1,swaps,d-swaps,swap,50000000,60,0,bullet,,receive-fixed,0.0325,0.001"].join("\n"), COA, { portfolioId: "c1", label: "c1", asOf: "2026-03-31" });
    expect("portfolio" in ok, JSON.stringify(ok)).toBe(true);
    if ("portfolio" in ok) {
      expect(ok.portfolio.positions[0]!.terms).toEqual({ id: "sw1", type: "swap", notional: 50_000_000, maturityMonths: 60, originationOffsetMonths: 0, amortType: "bullet", direction: "receive-fixed", fixedRate: 0.0325, floatMargin: 0.001 });
    }
    const bad = parsePositionsCsv([header, "sw1,swaps,d-swaps,swap,50000000,60,0,bullet,liability,upward,,"].join("\n"), COA, { portfolioId: "c2", label: "c2", asOf: "2026-03-31" });
    expect(cols(errorsOf(bad))).toEqual(["2:direction", "2:fixedRate", "2:side"]);
  });
});

describe("cd cohort books", () => {
  it("a valid cd book imports on the JSON path, stored as written", () => {
    const spec = book([cd()]);
    const out = parsePositionsJson(JSON.parse(JSON.stringify(spec)));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) expect(out.portfolio).toEqual(spec);
  });
  it("each refusal names the cohort and the field", () => {
    expect(cols(errorsOf(parsePositionsJson(book([cd({ cohorts: [] })]))))).toEqual(["1:cohorts"]);
    expect(cols(errorsOf(parsePositionsJson(book([cd({ notional: 20_000_000, cohorts: [{ termMonths: 7, monthsToMaturity: 5, balance: 40, contractRate: 0.04 }], maturityMonths: 5 })]))))).toEqual(["1:cohorts[0].termMonths"]);
    expect(cols(errorsOf(parsePositionsJson(book([cd({ notional: 20_000_000, cohorts: [{ termMonths: 12, monthsToMaturity: 13, balance: 40, contractRate: 0.04 }], maturityMonths: 13 })]))))).toEqual(["1:cohorts[0].monthsToMaturity"]);
    expect(cols(errorsOf(parsePositionsJson(book([cd({ cohorts: [{ termMonths: 12, monthsToMaturity: 10, balance: "40", contractRate: 0.04, rate: 1 }] })]))))).toEqual(["1:cohorts[0].balance", "1:cohorts[0].rate"]);
    expect(cols(errorsOf(parsePositionsJson(book([cd({ maturityMonths: 12 })]))))).toEqual(["1:maturityMonths"]);
  });
  it("the CSV path builds one book from its cohort rows, balances in the kernel's walk units", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths,originationOffsetMonths,amortType,termMonths,contractRate";
    const out = parsePositionsCsv(
      [header, "cd1,cds,l-cds,cd,Retail CDs,20000000,10,0,bullet,12,0.04", "cd1,cds,l-cds,cd,,10000000,2,0,bullet,6,0.035"].join("\n"),
      COA, { portfolioId: "c3", label: "c3", asOf: "2026-03-31" },
    );
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if (!("portfolio" in out)) return;
    expect(out.portfolio.positions).toHaveLength(1);
    // 20,000,000 and 10,000,000 dollars over the kernel's walk scale of 500,000 dollars a unit are 40 and 20 units.
    expect(out.portfolio.positions[0]!.terms).toEqual({
      id: "cd1", type: "cd", label: "Retail CDs", notional: 30_000_000, maturityMonths: 10, originationOffsetMonths: 0, amortType: "bullet", side: "liability",
      cohorts: [{ termMonths: 12, monthsToMaturity: 10, balance: 40, contractRate: 0.04 }, { termMonths: 6, monthsToMaturity: 2, balance: 20, contractRate: 0.035 }],
    });
    expect(out.warnings).toEqual(["side filled from the owning family for 1 position"]);
  });
  it("a bad cohort row is refused on its own line and column", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,termMonths,contractRate";
    const out = parsePositionsCsv(
      [header, "cd1,cds,l-cds,cd,20000000,10,0,bullet,12,0.04", "cd1,cds,l-cds,cd,10000000,8,0,bullet,7,0.035", "cd1,loans,a-loans,cd,10000000,2,0,bullet,6,0.03"].join("\n"),
      COA, { portfolioId: "c4", label: "c4", asOf: "2026-03-31" },
    );
    // Every problem at once: the second row's term is not a kernel term bucket, the third row names another family.
    expect(cols(errorsOf(out))).toEqual(["3:termMonths", "4:family_id"]);
    const out2 = parsePositionsCsv([header, "cd1,cds,l-cds,cd,20000000,10,0,bullet,12,0.04", "cd1,cds,l-cds,cd,10000000,8,0,bullet,7,0.035"].join("\n"), COA, { portfolioId: "c5", label: "c5", asOf: "2026-03-31" });
    expect(cols(errorsOf(out2))).toEqual(["3:termMonths"]);
  });
});

describe("cd book notional against its cohorts (S3a-1 fix round M3, L6)", () => {
  // The fixture's cohorts: 40 + 20 units, times the walk scale of 500,000 dollars a unit, are 30,000,000 dollars.
  it("a notional that is not the cohorts' sum is refused on the JSON path, naming the sum in dollars", () => {
    const e = errorsOf(parsePositionsJson(book([cd({ notional: 50_000_000 })])));
    expect(e).toEqual([{ row: 1, positionId: "cd1", column: "notional", message: 'field "notional" (50000000) must be the cd book\'s cohorts added up: their balances times the walk scale of $500,000 a unit come to $30,000,000' }]);
  });
  it("within half a percent it imports (30,100,000 is 0.33 percent off)", () => {
    expect("portfolio" in parsePositionsJson(book([cd({ notional: 30_100_000 })]))).toBe(true);
    expect(cols(errorsOf(parsePositionsJson(book([cd({ notional: 30_200_000 })]))))).toEqual(["1:notional"]);
  });
  it("a non-positive cohort balance is refused against that cohort", () => {
    const e = errorsOf(parsePositionsJson(book([cd({ notional: 20_000_000, cohorts: [{ termMonths: 12, monthsToMaturity: 10, balance: 40, contractRate: 0.04 }, { termMonths: 6, monthsToMaturity: 2, balance: 0, contractRate: 0.035 }] })])));
    expect(cols(e)).toEqual(["1:cohorts[1].balance"]);
  });
  it("on the CSV path a cohort row's negative dollars are refused on that row", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,termMonths,contractRate";
    const out = parsePositionsCsv([header, "cd1,cds,l-cds,cd,20000000,10,0,bullet,12,0.04", "cd1,cds,l-cds,cd,-30000000,2,0,bullet,6,0.035"].join("\n"), COA, { portfolioId: "c9", label: "c9", asOf: "2026-03-31" });
    expect(cols(errorsOf(out))).toEqual(["3:notional"]);
  });
});

describe("commitments", () => {
  it("a valid commitment imports on the JSON path; the import's sums leave the undrawn line out", async () => {
    const spec = book([line(), advance()]);
    const out = parsePositionsJson(JSON.parse(JSON.stringify(spec)));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) expect(out.portfolio).toEqual(spec);
  });
  it("each refusal names the row and the field", () => {
    expect(cols(errorsOf(parsePositionsJson(book([line({ draw: { rampRates: [0.02, 1.5], steadyRate: 0 } })]))))).toEqual(["1:draw.rampRates[1]"]);
    expect(cols(errorsOf(parsePositionsJson(book([line({ draw: { rampRates: [], steadyRate: -0.1 } })]))))).toEqual(["1:draw.steadyRate"]);
    expect(cols(errorsOf(parsePositionsJson(book([line({ draw: undefined })]))))).toEqual(["1:draw"]);
    expect(cols(errorsOf(parsePositionsJson(book([line({ side: "liability" })]))))).toEqual(["1:side"]);
    expect(cols(errorsOf(parsePositionsJson(book([line({ maturityMonths: 2.5 })]))))).toEqual(["1:maturityMonths"]);
  });
  it("a commitment family's side is asset", () => {
    const bad: ChartOfAccounts = { ...COA, families: COA.families.map((f) => (f.id === "lines" ? { ...f, side: "liability" as const } : f)) };
    expect(errorsOf(parsePositionsJson(book([line({ side: "asset" })], bad))).some((x) => x.column === "coa.families")).toBe(true);
  });
  it("the CSV path reads the draw path from two columns, and says when a line has none", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,drawRampRates,drawSteadyRate";
    const out = parsePositionsCsv([header, "ln1,lines,a-lines,commitment,20000000,24,0,bullet,0.02|0.01,0.005", "ln2,lines,a-lines,commitment,5000000,12,0,bullet,,"].join("\n"), COA, { portfolioId: "c6", label: "c6", asOf: "2026-03-31" });
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if (!("portfolio" in out)) return;
    expect((out.portfolio.positions[0]!.terms as unknown as { draw: unknown }).draw).toEqual({ rampRates: [0.02, 0.01], steadyRate: 0.005 });
    expect((out.portfolio.positions[1]!.terms as unknown as { draw: unknown }).draw).toEqual({ rampRates: [], steadyRate: 0 });
    expect(out.warnings).toContain("1 commitment carries no draw path, so it draws nothing until an assumption set binds a draw model");
    const bad = parsePositionsCsv([header, "ln1,lines,a-lines,commitment,20000000,24,0,bullet,0.02|x,0.005", "ln2,lines,a-lines,commitment,5000000,12,0,bullet,,2"].join("\n"), COA, { portfolioId: "c7", label: "c7", asOf: "2026-03-31" });
    expect(cols(errorsOf(bad))).toEqual(["2:drawRampRates", "3:drawSteadyRate"]);
  });
});

describe("non-rate-sensitive balances (S3a-1 follow-up)", () => {
  const NR_COA: ChartOfAccounts = {
    ...COA,
    nodes: [...COA.nodes, { id: "a-nr", label: "Premises", parentId: "a", side: "asset", isLeaf: true, familyId: "premises", order: 9 }, { id: "l-nr", label: "Other liabilities", parentId: "l", side: "liability", isLeaf: true, familyId: "other-liab", order: 9 }],
    families: [...COA.families, { id: "premises", label: "Premises", side: "asset", instrumentType: "non-rate-sensitive", coaNodeId: "a-nr" }, { id: "other-liab", label: "Other liabilities", side: "liability", instrumentType: "non-rate-sensitive", coaNodeId: "l-nr" }],
  };
  const nr = (over: Record<string, unknown> = {}): Position => ({
    id: "nr1", familyId: "premises", coaNodeId: "a-nr",
    terms: { id: "nr1", type: "non-rate-sensitive", notional: 5_000_000, maturityMonths: 360, originationOffsetMonths: 0, amortType: "bullet", side: "asset", ...over } as unknown as Position["terms"],
  });
  it("a valid asset and a valid liability balance import on the JSON path with no warning", () => {
    const liab: Position = { id: "nr2", familyId: "other-liab", coaNodeId: "l-nr", terms: { id: "nr2", type: "non-rate-sensitive", notional: 2_000_000, maturityMonths: 360, originationOffsetMonths: 0, amortType: "bullet" } as unknown as Position["terms"] };
    const out = parsePositionsJson(book([nr(), liab], NR_COA));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) expect(out.warnings).toEqual([]);
  });
  it("each refusal names the row and the field", () => {
    expect(cols(errorsOf(parsePositionsJson(book([nr({ notional: -1 })], NR_COA))))).toEqual(["1:notional"]);
    expect(cols(errorsOf(parsePositionsJson(book([nr({ maturityMonths: 0 })], NR_COA))))).toEqual(["1:maturityMonths"]);
    expect(cols(errorsOf(parsePositionsJson(book([nr({ amortType: "level-pay" })], NR_COA))))).toEqual(["1:amortType"]);
    expect(cols(errorsOf(parsePositionsJson(book([nr({ side: "liability" })], NR_COA))))).toEqual(["1:side"]);
  });
  it("the CSV path reads a plain row, the side filled from the family", () => {
    const header = "position_id,family_id,coa_node_id,terms_type,label,notional,maturityMonths,originationOffsetMonths,amortType";
    const out = parsePositionsCsv([header, "nr1,premises,a-nr,non-rate-sensitive,Premises and equipment,5000000,360,0,bullet"].join("\n"), NR_COA, { portfolioId: "c10", label: "c10", asOf: "2026-03-31" });
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) expect(out.portfolio.positions[0]!.terms).toEqual({ id: "nr1", type: "non-rate-sensitive", label: "Premises and equipment", notional: 5_000_000, maturityMonths: 360, originationOffsetMonths: 0, amortType: "bullet", side: "asset" });
  });
});

describe("floating liabilities and the two engine-extension fields", () => {
  it("a floating advance on a liability family imports, with its funding tenor read, not warned about", () => {
    const out = parsePositionsJson(book([advance({ fundingTenorMonths: 12 })]));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
    if ("portfolio" in out) expect(out.warnings).toEqual([]);
  });
  it("fundingTenorMonths is refused off a floater or when not a whole month count", () => {
    expect(cols(errorsOf(parsePositionsJson(book([advance({ fundingTenorMonths: 0 })]))))).toEqual(["1:fundingTenorMonths"]);
    const loan: Position = { id: "fx1", familyId: "loans", coaNodeId: "a-loans", terms: { id: "fx1", type: "fixed-loan", notional: 1e6, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", side: "asset", coupon: 0.05, fundingTenorMonths: 12 } as unknown as Position["terms"] };
    expect(cols(errorsOf(parsePositionsJson(book([loan]))))).toEqual(["1:fundingTenorMonths"]);
  });
  it("linearDecay on an nmd deposit is read, and refused when its months differ from the maturity", () => {
    const dda = (over: Record<string, unknown>): Position => ({
      id: "d1", familyId: "dda", coaNodeId: "l-dda",
      terms: { id: "d1", type: "nmd", notional: 1e7, maturityMonths: 60, originationOffsetMonths: 0, amortType: "level-pay", side: "liability", depositRate: 0, beta: 0,
        nmdParams: { closureSteady: 1, closureInitial: 1, closureTauMonths: 12, burnoutLambda: 0, maxRateDecay: 1, maxRateGrowth: 0, logisticK: 1, logisticMidpoint: 0, maPeriod: 12, regimeAlpha: 0, balanceSize: 1e6, sens: { gMin: 0.5, gMax: 1, bStar: 1e6, kappaB: 1 }, buckets: [{ label: "all", repBalance: 1e5, share: 1 }] }, ...over } as unknown as Position["terms"],
    });
    const ok = parsePositionsJson(book([dda({ linearDecay: { horizonMonths: 60 } })]));
    expect("portfolio" in ok, JSON.stringify(ok)).toBe(true);
    if ("portfolio" in ok) expect(ok.warnings).toEqual([]);
    expect(cols(errorsOf(parsePositionsJson(book([dda({ linearDecay: { horizonMonths: 48 } })]))))).toEqual(["1:linearDecay.horizonMonths"]);
  });
});

describe("the overlay-written groups on a raw position (S3a-1 fix round, open item 3)", () => {
  const loanCOA: ChartOfAccounts = COA;
  const loan = (over: Record<string, unknown>): Position => ({ id: "fx1", familyId: "loans", coaNodeId: "a-loans", terms: { id: "fx1", type: "fixed-loan", notional: 1e6, maturityMonths: 60, originationOffsetMonths: 0, amortType: "level-pay", side: "asset", coupon: 0.05, ...over } as unknown as Position["terms"] });
  it("prepay on a fixed loan is read, so it is checked, never warned about as ignored", () => {
    const ok = parsePositionsJson(book([loan({ prepay: { annualCpr: 0.08, stressAnnualCpr: 0.12 } })], loanCOA));
    expect("portfolio" in ok, JSON.stringify(ok)).toBe(true);
    if ("portfolio" in ok) expect(ok.warnings).toEqual([]);
    expect(cols(errorsOf(parsePositionsJson(book([loan({ prepay: { annualCpr: 3 } })], loanCOA))))).toEqual(["1:prepay.annualCpr"]);
    expect(cols(errorsOf(parsePositionsJson(book([loan({ prepay: { annualCpr: 0.05, speed: 1 } })], loanCOA))))).toEqual(["1:prepay.speed"]);
  });
  it("depositSlotting and fullBeta on an nmd-b deposit are checked: a slotting with no full form, or a malformed form, is refused", () => {
    expect(cols(errorsOf(parsePositionsJson(validSpec([nmdBetaPosition("b1", { depositSlotting: "frozen" })]))))).toEqual(["1:depositSlotting"]);
    expect(cols(errorsOf(parsePositionsJson(validSpec([nmdBetaPosition("b1", { depositSlotting: "sideways" })]))))).toEqual(["1:depositSlotting"]);
    const e = errorsOf(parsePositionsJson(validSpec([nmdBetaPosition("b1", { fullBeta: { alphaPct: "x" } })])));
    expect(e.length).toBeGreaterThan(0);
    expect(e.every((x) => x.column?.startsWith("fullBeta"))).toBe(true);
  });
  it("on a type that does not read it, the field keeps its warning: stored, ignored by the engine", () => {
    const out = parsePositionsJson(book([{ ...advance(), terms: { ...(advance().terms as object), prepay: { annualCpr: 0.08 } } as Position["terms"] }]));
    expect("portfolio" in out).toBe(true);
    if ("portfolio" in out) expect(out.warnings).toEqual(['position "fa1": unrecognized terms field "prepay" stored verbatim, ignored by the engine']);
  });
});

describe("liquidityRole tags", () => {
  const tagged = (role: string): Position => ({ ...advance(), dimensions: { liquidityRole: role } });
  const taxonomy = { schemaVersion: "1.0.0", id: "roles", label: "Roles", dimensions: [{ id: "liquidityRole", label: "Liquidity role" }] };
  it("one of the five roles imports", () => {
    const out = parsePositionsJson(book([tagged("wholesale")], COA, { taxonomy }));
    expect("portfolio" in out, JSON.stringify(out)).toBe(true);
  });
  it("a role must fit the side: none on a swap or an undrawn line, an asset role on an asset, a liability role on a liability (fix round L2)", () => {
    const tag = (p: Position, role: string): Position => ({ ...p, dimensions: { liquidityRole: role } });
    expect(cols(errorsOf(parsePositionsJson(book([tag(swap(), "wholesale")], COA, { taxonomy }))))).toEqual(["1:dimensions.liquidityRole"]);
    expect(cols(errorsOf(parsePositionsJson(book([tag(line(), "inflow-asset")], COA, { taxonomy }))))).toEqual(["1:dimensions.liquidityRole"]);
    expect(cols(errorsOf(parsePositionsJson(book([tag(advance(), "inflow-asset")], COA, { taxonomy }))))).toEqual(["1:dimensions.liquidityRole"]);
    const loan: Position = { id: "fx1", familyId: "loans", coaNodeId: "a-loans", terms: { id: "fx1", type: "fixed-loan", notional: 1e6, maturityMonths: 12, originationOffsetMonths: 0, amortType: "bullet", side: "asset", coupon: 0.05 } as Position["terms"] };
    expect(cols(errorsOf(parsePositionsJson(book([tag(loan, "nib-pool")], COA, { taxonomy }))))).toEqual(["1:dimensions.liquidityRole"]);
    expect("portfolio" in parsePositionsJson(book([tag(loan, "hqla-stock")], COA, { taxonomy }))).toBe(true);
  });
  it("any other value is refused by row and field", () => {
    const e = errorsOf(parsePositionsJson(book([tagged("hot-money")], COA, { taxonomy })));
    expect(cols(e)).toEqual(["1:dimensions.liquidityRole"]);
    const csv = parsePositionsCsv(
      ["position_id,family_id,coa_node_id,terms_type,notional,maturityMonths,originationOffsetMonths,amortType,indexTenorMonths,margin,resetFrequencyMonths,dim.liquidityRole", "fa1,advances,l-adv,floating-loan,1e7,24,0,bullet,1,0.002,1,brokered"].join("\n"),
      COA, { portfolioId: "c8", label: "c8", asOf: "2026-03-31" },
    );
    expect(cols(errorsOf(csv))).toEqual(["2:dim.liquidityRole"]);
  });
});

describe("over HTTP", () => {
  let tp: TestPlatform;
  beforeAll(async () => {
    tp = await bootTestPlatform();
  }, 60_000);
  afterAll(async () => {
    await tp.close();
  });
  it("POST /api/portfolios/import stores a book with a swap, a cd book and a commitment; the sums leave both off-balance lines out", async () => {
    const spec = book([swap(), cd(), line(), advance()]);
    const r = await api<{ id: string }>(tp.base, "POST", "/api/portfolios/import", { ...spec, id: "s3a1-http" });
    expect(r.status, r.text).toBe(201);
    const list = await api<Array<{ id: string; intakeStats?: { assets: number; liabilities: number } }>>(tp.base, "GET", "/api/portfolios");
    const row = list.body.find((p) => p.id === "s3a1-http");
    // Assets: none on the balance sheet (the line is off it). Liabilities: the cd book 30,000,000 plus the advance 10,000,000.
    expect(row?.intakeStats).toMatchObject({ assets: 0, liabilities: 40_000_000 });
    const back = await api<unknown>(tp.base, "GET", "/api/portfolios/s3a1-http");
    expect(back.body).toEqual({ ...spec, id: "s3a1-http" });
  });
});
