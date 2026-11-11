/**
 * The CSV column contract must be GENERATED from the kernel term interfaces,
 * not hand-copied. These tests pin the generation mechanics (field discovery,
 * enum resolution through the AmortType alias, param-block classification,
 * exclusion of derived fields) without pinning the kernel's exact field list
 * beyond what other modules already rely on: if the kernel gains a field, the
 * contract must gain the column with no edit here.
 */
import { describe, expect, it } from "vitest";
import { getCsvColumnContract, META_COLUMNS, renderColumnContractMarkdown } from "../columnContract";

describe("getCsvColumnContract", () => {
  const contract = getCsvColumnContract();

  it("covers exactly the five frozen kernel instrument types", () => {
    expect(contract.contracts.map((c) => c.termsType).sort()).toEqual([
      "fixed-loan",
      "floating-loan",
      "mortgage",
      "nmd",
      "nmd-b",
    ]);
  });

  it("derives base columns from InstrumentTermsBase, excluding id and type", () => {
    const names = contract.baseColumns.map((c) => c.name);
    expect(names).toContain("notional");
    expect(names).toContain("maturityMonths");
    expect(names).toContain("originationOffsetMonths");
    expect(names).not.toContain("id");
    expect(names).not.toContain("type");
  });

  it("resolves the AmortType alias to an enum column", () => {
    const amort = contract.baseColumns.find((c) => c.name === "amortType");
    expect(amort?.kind).toBe("enum");
    expect(amort?.enumValues).toEqual(["level-pay", "bullet"]);
    expect(amort?.required).toBe(true);
  });

  it("classifies the inline side union as an optional enum", () => {
    const side = contract.baseColumns.find((c) => c.name === "side");
    expect(side?.kind).toBe("enum");
    expect(side?.enumValues).toEqual(["asset", "liability"]);
    expect(side?.required).toBe(false);
  });

  it("picks up every scalar field of FloatingLoanTerms from source", () => {
    const float = contract.contracts.find((c) => c.termsType === "floating-loan")!;
    expect(float.interfaceName).toBe("FloatingLoanTerms");
    expect(float.columns.map((c) => c.name)).toEqual([
      "indexTenorMonths",
      "margin",
      "resetFrequencyMonths",
    ]);
    expect(float.columns.every((c) => c.kind === "number" && c.required)).toBe(true);
  });

  it("classifies object-typed fields as param blocks, never CSV columns", () => {
    const mortgage = contract.contracts.find((c) => c.termsType === "mortgage")!;
    expect(mortgage.paramBlocks).toEqual([
      expect.objectContaining({ field: "cprParams", typeName: "MBSParams" }),
    ]);
    const nmdB = contract.contracts.find((c) => c.termsType === "nmd-b")!;
    expect(nmdB.paramBlocks.map((b) => `${b.field}:${b.typeName}`).sort()).toEqual([
      "nmdParams:NMDParams",
      "sCurve:BetaSCurveParams",
    ]);
    // A param block must never leak into the column list.
    for (const t of contract.contracts) {
      const colNames = new Set(t.columns.map((c) => c.name));
      for (const b of t.paramBlocks) expect(colNames.has(b.field)).toBe(false);
    }
  });

  it("keeps meta columns disjoint from term columns and term columns unique", () => {
    const all = new Set(contract.termColumnNames);
    expect(all.size).toBe(contract.termColumnNames.length);
    for (const m of META_COLUMNS) expect(all.has(m)).toBe(false);
  });

  it("carries the kernel JSDoc through to the contract", () => {
    const coupon = contract.contracts
      .find((c) => c.termsType === "fixed-loan")!
      .columns.find((c) => c.name === "coupon");
    expect(coupon?.doc).toMatch(/coupon/i);
  });

  it("renders deterministic markdown with one section per terms type", () => {
    const md = renderColumnContractMarkdown();
    expect(md).toBe(renderColumnContractMarkdown());
    for (const t of contract.contracts) {
      expect(md).toContain(`#### \`${t.termsType}\` (\`${t.interfaceName}\`)`);
    }
  });
});
