/**
 * The spread consistency refusal. Where a four-factor prepay
 * binding and a loan-client-rate binding apply to the same position, the client
 * total spread must equal secSpread + primSpread (both in bp). Mismatch messages
 * are asserted with toContain only, on restated substrings.
 */
import { describe, expect, it } from "vitest";
import { MORTGAGE_DEFAULTS, type MortgageTerms } from "@alm/kernel";
import type { AssumptionSet, BehavioralOverlay, OverlayBinding } from "../../contracts/assumptions";
import type { ChartOfAccounts } from "../../contracts/chartOfAccounts";
import type { DimensionTaxonomy } from "../../contracts/dimensions";
import type { PortfolioSpec } from "../../contracts/position";
import { checkBindingOverlap } from "../../projection/static/applyOverlays";
import { bindAssumptions } from "../bindAssumptions";
import { ClientRateSpreadMismatchError, resolveAssumptions } from "../resolveAssumptions";

const COA: ChartOfAccounts = {
  schemaVersion: "1.0.0",
  nodes: [
    { id: "assets", label: "Total Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
    { id: "mortgages", label: "Mortgages", parentId: "assets", side: "asset", isLeaf: true, familyId: "mortgages", order: 0 },
    { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "loans", order: 1 },
  ],
  families: [
    { id: "mortgages", label: "Mortgages", side: "asset", instrumentType: "mortgage", coaNodeId: "mortgages" },
    { id: "loans", label: "Loans", side: "asset", instrumentType: "mortgage", coaNodeId: "loans" },
  ],
};

const SEG: DimensionTaxonomy = {
  schemaVersion: "1.0.0",
  id: "TAX-SEG",
  label: "segment",
  dimensions: [{ id: "segment", label: "Segment", values: ["retail", "private"] }],
};

const prepay = (sec: number, prim: number): BehavioralOverlay => ({
  kind: "prepay",
  model: "four-factor-cpr",
  params: { ...MORTGAGE_DEFAULTS.cprParams, secSpread: sec, primSpread: prim },
});
const constantCpr: BehavioralOverlay = { kind: "prepay", model: "constant-cpr", annualCpr: 0.1 };
const clientRate = (totalSpreadBp: number): BehavioralOverlay =>
  ({ kind: "loan-client-rate", model: "flat-carry", totalSpreadBp }) as unknown as BehavioralOverlay;

const bind = (familyId: string, overlay: BehavioralOverlay, selector?: OverlayBinding["selector"]): OverlayBinding => ({
  familyId,
  overlay,
  modelVersion: "v1",
  ...(selector === undefined ? {} : { selector }),
});

const setOf = (...bindings: OverlayBinding[]): AssumptionSet => ({
  schemaVersion: "1.0.0",
  id: "demo-x",
  label: "demo x",
  bindings,
});

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

const MISMATCH_260 = "total spread 260 bp vs prepay 250 (120 + 130) bp";

describe("whole-family pairs at bindAssumptions and resolveAssumptions", () => {
  it("binds and resolves clean when the client spread equals sec + prim (250 = 120 + 130)", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(250)));
    expect(() => bindAssumptions(set)).not.toThrow();
    expect(() => resolveAssumptions(set, COA.families)).not.toThrow();
  });

  it("does not depend on binding order", () => {
    const set = setOf(bind("mortgages", clientRate(260)), bind("mortgages", prepay(120, 130)));
    expect(thrown(() => bindAssumptions(set))).toBeInstanceOf(ClientRateSpreadMismatchError);
  });

  it("260 against 120 + 130 is refused by bindAssumptions, unwrapped", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(260)));
    const err = thrown(() => bindAssumptions(set));
    expect(err).toBeInstanceOf(ClientRateSpreadMismatchError);
    const e = err as ClientRateSpreadMismatchError;
    expect(e.name).toBe("ClientRateSpreadMismatchError");
    expect(e.message).toContain(MISMATCH_260);
    expect(e.message).toContain("family mortgages");
    expect(e.message).toContain("assumption set demo-x");
    expect(e.message).not.toContain(" selector ");
    expect(e.setId).toBe("demo-x");
    expect(e.familyId).toBe("mortgages");
    expect(e.selectorText).toBeUndefined();
    expect(e.totalSpreadBp).toBe(260);
    expect(e.secSpread).toBe(120);
    expect(e.primSpread).toBe(130);
  });

  it("260 against 120 + 130 is refused by resolveAssumptions", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(260)));
    const err = thrown(() => resolveAssumptions(set, COA.families));
    expect(err).toBeInstanceOf(ClientRateSpreadMismatchError);
    expect((err as Error).message).toContain(MISMATCH_260);
    expect((err as Error).message).toContain("family mortgages");
  });

  it("a decimal slip, 0.025 bp, is refused and the message shows it", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(0.025)));
    const err = thrown(() => bindAssumptions(set));
    expect(err).toBeInstanceOf(ClientRateSpreadMismatchError);
    expect((err as Error).message).toContain("total spread 0.025 bp vs prepay 250 (120 + 130) bp");
  });

  it("a difference inside 1e-9 bp passes and one outside is refused", () => {
    const near = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(250 + 5e-10)));
    expect(() => bindAssumptions(near)).not.toThrow();
    const far = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(250 + 5e-9)));
    expect(thrown(() => bindAssumptions(far))).toBeInstanceOf(ClientRateSpreadMismatchError);
  });

  it("control: 260 with constant-cpr binds and resolves clean", () => {
    const set = setOf(bind("mortgages", constantCpr), bind("mortgages", clientRate(260)));
    expect(() => bindAssumptions(set)).not.toThrow();
    expect(() => resolveAssumptions(set, COA.families)).not.toThrow();
  });

  it("control: 260 on a family with no prepay binding binds and resolves clean", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("loans", clientRate(260)));
    expect(() => bindAssumptions(set)).not.toThrow();
    expect(() => resolveAssumptions(set, COA.families)).not.toThrow();
  });
});

function book(): PortfolioSpec {
  const terms = (id: string): MortgageTerms => ({ ...MORTGAGE_DEFAULTS, id });
  return {
    id: "PF-X",
    label: "x",
    asOf: "2026-01-01",
    coa: COA,
    taxonomy: SEG,
    positions: [
      { id: "M-RETAIL", familyId: "mortgages", coaNodeId: "mortgages", terms: terms("M-RETAIL"), dimensions: { segment: "retail" } },
      { id: "M-PRIVATE", familyId: "mortgages", coaNodeId: "mortgages", terms: terms("M-PRIVATE"), dimensions: { segment: "private" } },
    ],
  };
}

describe("per-position pairs at checkBindingOverlap", () => {
  it("a selected 260 client-rate binding over a whole-family 120/130 prepay throws for a matching position", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(260), { segment: ["retail"] }));
    const err = thrown(() => checkBindingOverlap(book(), set));
    expect(err).toBeInstanceOf(ClientRateSpreadMismatchError);
    const msg = (err as Error).message;
    expect(msg).toContain(MISMATCH_260);
    expect(msg).toContain("family mortgages");
    expect(msg).toContain(" selector ");
    expect(msg).toContain("segment");
    expect(msg).toContain("retail");
    expect((err as ClientRateSpreadMismatchError).selectorText).toBeDefined();
  });

  it("the selector clause falls back to the prepay binding's selector when only it has one", () => {
    const set = setOf(bind("mortgages", prepay(120, 130), { segment: ["private"] }), bind("mortgages", clientRate(260)));
    const err = thrown(() => checkBindingOverlap(book(), set));
    expect(err).toBeInstanceOf(ClientRateSpreadMismatchError);
    expect((err as Error).message).toContain(" selector ");
    expect((err as Error).message).toContain("private");
  });

  it("passes when the selector excludes every position the prepay binding governs with a different spread", () => {
    // Prepay 120/130 is selected to retail only; the client 260 is selected to private only.
    const set = setOf(
      bind("mortgages", prepay(120, 130), { segment: ["retail"] }),
      bind("mortgages", clientRate(260), { segment: ["private"] }),
    );
    expect(() => checkBindingOverlap(book(), set)).not.toThrow();
  });

  it("passes when the selected spread equals sec + prim", () => {
    const set = setOf(bind("mortgages", prepay(120, 130)), bind("mortgages", clientRate(250), { segment: ["retail"] }));
    expect(() => checkBindingOverlap(book(), set)).not.toThrow();
  });
});
