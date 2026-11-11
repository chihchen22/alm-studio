/**
 * The shared HQLA buffer and the US Level 2 caps.
 *
 * Every expectation is restated by hand. The caps (12 CFR 249.21):
 *   excess2B = max(0, L2B - (15/85)(L1 + L2A))
 *   excess2  = max(0, L2A + L2B - (2/3) L1)
 *   HQLA     = L1 + L2A + L2B - max(excess2B, excess2)
 */
import { describe, expect, it } from "vitest";
import type { PortfolioSpec } from "../../contracts/position";
import type { FamilyCashflows } from "../../contracts/results";
import { bufferLevels, cappedHqla, classifyBufferFamilies, hasBufferFamily, HQLA_HAIRCUT } from "../hqlaBuffer";
import { SURVIVAL_STRESS_DEMO } from "../survivalHorizon";

function book(defs: Array<{ id: string; side: "asset" | "liability"; tags: Array<string | undefined> }>): PortfolioSpec {
  return {
    id: "PF-BUF",
    label: "test",
    asOf: "2026-01-01",
    coa: {
      families: defs.map((d) => ({ id: d.id, label: d.id, side: d.side, instrumentType: "fixed-loan", coaNodeId: `N-${d.id}` })),
      nodes: [],
    },
    positions: defs.flatMap((d) =>
      d.tags.map((tag, i) => ({
        id: `${d.id}-${i}`,
        familyId: d.id,
        coaNodeId: `N-${d.id}`,
        terms: {},
        ...(tag === undefined ? {} : { dimensions: { "hqla-level": tag } }),
      })),
    ),
  } as unknown as PortfolioSpec;
}

function fam(familyId: string, balance0: number): FamilyCashflows {
  return { familyId, series: { balance: [balance0], principal: [0], interest: [0] } } as FamilyCashflows;
}

describe("cappedHqla", () => {
  it("leaves levels below both caps whole", () => {
    // L2 = 30 <= 66.667; L2B = 10 <= (15/85) * 120 = 21.18
    expect(cappedHqla({ l1: 100, l2a: 20, l2b: 10 })).toBeCloseTo(130, 12);
  });

  it("binds the 40 percent Level 2 cap: HQLA = L1 / 0.6", () => {
    // excess2 = 170 - 66.6667 = 103.3333; HQLA = 270 - 103.3333 = 166.6667
    expect(cappedHqla({ l1: 100, l2a: 170, l2b: 0 })).toBeCloseTo(500 / 3, 12);
  });

  it("binds the 15 percent Level 2B cap: HQLA = (L1 + L2A) / 0.85", () => {
    // excess2B = 50 - (15/85) * 100 = 32.3529; excess2 = 0; HQLA = 150 - 32.3529 = 117.6471
    expect(cappedHqla({ l1: 100, l2a: 0, l2b: 50 })).toBeCloseTo(10000 / 85, 12);
  });

  it("takes the larger excess, never the sum, when both caps bind", () => {
    // excess2B = 60 - (15/85) * 150 = 33.5294; excess2 = 110 - 66.6667 = 43.3333
    // max 43.3333 -> HQLA = 210 - 43.3333 = 166.6667 (the sum would give 133.14)
    expect(cappedHqla({ l1: 100, l2a: 50, l2b: 60 })).toBeCloseTo(500 / 3, 12);
  });

  it("is zero on an empty buffer", () => {
    expect(cappedHqla({ l1: 0, l2a: 0, l2b: 0 })).toBe(0);
  });
});

describe("classifyBufferFamilies and bufferLevels", () => {
  it("sums post-haircut as-of balances by level", () => {
    const b = book([
      { id: "CASH", side: "asset", tags: ["l1", "l1"] },
      { id: "MBS", side: "asset", tags: ["l2a"] },
      { id: "MUNI", side: "asset", tags: ["l2b"] },
      { id: "LOANS", side: "asset", tags: [undefined] },
      { id: "DDA", side: "liability", tags: [undefined] },
    ]);
    const classes = classifyBufferFamilies(b)!;
    expect(hasBufferFamily(classes)).toBe(true);
    const levels = bufferLevels([fam("CASH", 100), fam("MBS", 200), fam("MUNI", 40), fam("LOANS", 80), fam("DDA", 1000)], classes);
    // 100 * 1; 200 * 0.85 = 170; 40 * 0.5 = 20
    expect(levels).toEqual({ l1: 100, l2a: 170, l2b: 20 });
  });

  it("refuses a family that mixes tagged and untagged positions", () => {
    expect(classifyBufferFamilies(book([{ id: "CASH", side: "asset", tags: ["l1", undefined] }]))).toBeUndefined();
  });

  it("refuses an unknown level and a tagged liability", () => {
    expect(classifyBufferFamilies(book([{ id: "CASH", side: "asset", tags: ["l3"] }]))).toBeUndefined();
    expect(classifyBufferFamilies(book([{ id: "DDA", side: "liability", tags: ["l1"] }]))).toBeUndefined();
  });

  it("reports no buffer family on an untagged book", () => {
    const classes = classifyBufferFamilies(book([{ id: "LOANS", side: "asset", tags: [undefined] }]))!;
    expect(hasBufferFamily(classes)).toBe(false);
  });
});

describe("haircut tables", () => {
  it("keeps the LCR haircuts and the survival-horizon haircuts identical", () => {
    // Two constants kept separate on purpose; this only guards against drift.
    expect(HQLA_HAIRCUT).toEqual(SURVIVAL_STRESS_DEMO.haircut);
  });
});
