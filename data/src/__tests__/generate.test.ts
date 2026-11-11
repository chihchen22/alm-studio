/**
 * Generator acceptance tests.
 *
 * Test-first: these encode the definition of done before the generator exists.
 *   - Same master seed reproduces the fixture content-hash byte-for-byte.
 *   - A different seed changes it.
 *   - Assets minus liabilities reconciles to the equity node at t=0.
 *   - Family count is 8 to 12; every position maps to a leaf COA node and a
 *     valid family; the instrument-type mix matches the mapping.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import type { EngineInstrumentType } from "@alm/engine";
import {
  DEFAULT_GENERATOR_CONFIG,
  FAMILY_GEN_SPECS,
  computeBalanceSheetTotals,
  generatePortfolio,
} from "../generate";

/**
 * Position count under the cds flip: targetPositions counts DRAWS; the
 * cd family's draws (weight 0.06 of 100,000 = 6,000) fold into ONE cohort-book
 * position, so the emitted book carries 100,000 - 6,000 + 1 positions.
 */
const CD_DRAWS = Math.floor(
  (FAMILY_GEN_SPECS.find((f) => f.id === "cds")?.weight ?? 0) *
    DEFAULT_GENERATOR_CONFIG.targetPositions,
);
const EXPECTED_POSITIONS = DEFAULT_GENERATOR_CONFIG.targetPositions - CD_DRAWS + 1;

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(here, "../../fixtures/portfolio.fixture.json");

describe("chart of accounts", () => {
  const spec = generatePortfolio(DEFAULT_GENERATOR_CONFIG);

  test("family count is within the 8..12 band", () => {
    expect(spec.coa.families.length).toBeGreaterThanOrEqual(8);
    expect(spec.coa.families.length).toBeLessThanOrEqual(12);
  });

  test("has exactly one equity plug node with no family", () => {
    const equity = spec.coa.nodes.filter((n) => n.side === "equity");
    expect(equity).toHaveLength(1);
    expect(equity[0].isLeaf).toBe(false);
    expect(equity[0].familyId).toBeUndefined();
  });

  test("every leaf node carries a family; every family points at a leaf", () => {
    const leavesById = new Map(spec.coa.nodes.filter((n) => n.isLeaf).map((n) => [n.id, n]));
    for (const n of leavesById.values()) {
      expect(n.familyId).toBeDefined();
    }
    for (const fam of spec.coa.families) {
      const node = leavesById.get(fam.coaNodeId);
      expect(node, `family ${fam.id} must map to a leaf node`).toBeDefined();
      expect(node!.familyId).toBe(fam.id);
    }
  });
});

describe("positions", () => {
  const spec = generatePortfolio(DEFAULT_GENERATOR_CONFIG);

  test("position count is roughly 100k (draws minus the cd fold, exactly)", () => {
    expect(spec.positions.length).toBe(EXPECTED_POSITIONS);
    expect(spec.positions.length).toBeGreaterThanOrEqual(90_000);
    expect(spec.positions.length).toBeLessThanOrEqual(110_000);
  });

  test("every position maps to a valid leaf COA node and a valid family", () => {
    const leafIds = new Set(spec.coa.nodes.filter((n) => n.isLeaf).map((n) => n.id));
    const familyById = new Map(spec.coa.families.map((f) => [f.id, f]));
    for (const p of spec.positions) {
      const fam = familyById.get(p.familyId);
      expect(fam, `unknown family ${p.familyId}`).toBeDefined();
      expect(leafIds.has(p.coaNodeId)).toBe(true);
      expect(p.coaNodeId).toBe(fam!.coaNodeId);
    }
  });

  test("instrument-type mix matches the mapping plus the cd arm", () => {
    const familyType = new Map<string, EngineInstrumentType>(
      spec.coa.families.map((f) => [f.id, f.instrumentType]),
    );
    const allowed: EngineInstrumentType[] = [
      "fixed-loan",
      "floating-loan",
      "mortgage",
      "nmd",
      "nmd-b",
      "cd",
    ];
    for (const p of spec.positions) {
      expect(p.terms.type).toBe(familyType.get(p.familyId));
      expect(allowed).toContain(p.terms.type);
    }
    // ADR-020 scope pin: the cds family is the ONLY cd family; FHLB and
    // borrowings stay contractual bullets.
    expect(familyType.get("cds")).toBe("cd");
    expect(familyType.get("fhlb")).toBe("fixed-loan");
    expect(familyType.get("borrowings")).toBe("fixed-loan");
  });

  test("the cds family folds into one cohort-book position that conserves its draws", () => {
    const cds = spec.positions.filter((p) => p.familyId === "cds");
    expect(cds).toHaveLength(1);
    const terms = cds[0].terms;
    if (terms.type !== "cd") throw new Error("cds position must carry cd terms");
    // Cohorts walk at real dollar sizes: stylized balances times the kernel
    // walk scale re-sum to the position notional (scaling is exact up to the
    // one whole-dollar rounding of the notional itself).
    let stylized = 0;
    for (const c of terms.cohorts) stylized += c.balance;
    // The kernel's CD walk scale (1e7 before a kernel re-sync changed it).
    const walkDollars = stylized * 5e5;
    expect(Math.abs(walkDollars - terms.notional)).toBeLessThan(1);
    // Every cohort is a valid kernel cell: bucket-member term, 1 <= mtm <= term.
    for (const c of terms.cohorts) {
      expect([1, 2, 3, 6, 9, 12, 18, 24, 36, 48, 60]).toContain(c.termMonths);
      expect(c.monthsToMaturity).toBeGreaterThanOrEqual(1);
      expect(c.monthsToMaturity).toBeLessThanOrEqual(c.termMonths);
      expect(c.balance).toBeGreaterThan(0);
      expect(Number.isFinite(c.contractRate)).toBe(true);
    }
  });

  test("all notionals are finite and positive", () => {
    for (const p of spec.positions) {
      expect(Number.isFinite(p.terms.notional)).toBe(true);
      expect(p.terms.notional).toBeGreaterThan(0);
    }
  });

  test("position ids are unique and family-prefixed", () => {
    const ids = new Set<string>();
    for (const p of spec.positions) {
      expect(p.id.startsWith(`${p.familyId}-`)).toBe(true);
      expect(ids.has(p.id)).toBe(false);
      ids.add(p.id);
    }
    expect(ids.size).toBe(spec.positions.length);
  });
});

describe("conservation (balance sheet balances at t=0)", () => {
  const spec = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
  const totals = computeBalanceSheetTotals(spec);

  test("assets minus liabilities equals the equity plug, and equity is positive", () => {
    expect(totals.assets - totals.liabilities).toBe(totals.equity);
    expect(totals.equity).toBeGreaterThan(0);
  });

  test("equity lands near the configured capital ratio", () => {
    const ratio = totals.equity / totals.assets;
    const target = DEFAULT_GENERATOR_CONFIG.capitalRatio;
    expect(Math.abs(ratio - target)).toBeLessThan(0.005);
  });

  test("totals attach to the single equity node", () => {
    expect(spec.coa.nodes.some((n) => n.id === totals.equityNodeId && n.side === "equity")).toBe(
      true,
    );
  });
});

describe("determinism", () => {
  test("same master seed reproduces byte-identical content", () => {
    const a = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
    const b = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
    expect(contentHash(a)).toBe(contentHash(b));
  });

  test("changing the master seed changes the content hash", () => {
    const base = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
    const bumped = generatePortfolio({ ...DEFAULT_GENERATOR_CONFIG, masterSeed: DEFAULT_GENERATOR_CONFIG.masterSeed + 1 });
    expect(contentHash(bumped)).not.toBe(contentHash(base));
  });

  test("per-family streams are independent: reordering families does not perturb a family's draws", () => {
    // Regenerate with the family catalogue reversed; each family draws from its
    // own PCG32 stream keyed by streamId, so a given family's positions must be
    // identical regardless of catalogue order.
    const forward = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
    const reversed = generatePortfolio({
      ...DEFAULT_GENERATOR_CONFIG,
      families: [...FAMILY_GEN_SPECS].reverse(),
    });
    const pick = (positions: typeof forward.positions, famId: string) =>
      positions.filter((p) => p.familyId === famId).map((p) => p.id);
    const famId = FAMILY_GEN_SPECS[0].id;
    expect(pick(reversed.positions, famId)).toEqual(pick(forward.positions, famId));
  });
});

describe("committed fixture", () => {
  test("regeneration reproduces the committed content hash", () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      contentHash: string;
      positionCount: number;
      totals: { assets: number; liabilities: number; equity: number };
    };
    const spec = generatePortfolio(DEFAULT_GENERATOR_CONFIG);
    expect(contentHash(spec)).toBe(fixture.contentHash);
    expect(spec.positions.length).toBe(fixture.positionCount);
    const totals = computeBalanceSheetTotals(spec);
    expect(totals.assets).toBe(fixture.totals.assets);
    expect(totals.liabilities).toBe(fixture.totals.liabilities);
    expect(totals.equity).toBe(fixture.totals.equity);
  });
});

describe("targetDollars (Task 8)", () => {
  // Three families: a targeted asset, an untargeted asset, a targeted liability, an untargeted liability.
  const base = DEFAULT_GENERATOR_CONFIG;
  const pick = (id: string) => {
    const f = FAMILY_GEN_SPECS.find((x) => x.id === id);
    if (f === undefined) throw new Error(`no family ${id}`);
    return f;
  };
  const config = {
    ...base,
    portfolioId: "target-dollars-test",
    targetPositions: 2000,
    capitalRatio: 0.05,
    families: [
      { ...pick("fixed-loans"), weight: 0.4, targetDollars: 1_000_000_000 },
      { ...pick("mortgages"), weight: 0.2 },
      { ...pick("mma"), weight: 0.3, targetDollars: 600_000_000 },
      { ...pick("dda"), weight: 0.1 },
    ],
  };

  test("a family that carries targetDollars sums to the target exactly, in whole dollars", () => {
    const spec = generatePortfolio(config);
    const sum = (fam: string) =>
      spec.positions.filter((p) => p.familyId === fam).reduce((a, p) => a + p.terms.notional, 0);
    expect(sum("fixed-loans")).toBe(1_000_000_000);
    expect(sum("mma")).toBe(600_000_000);
    for (const p of spec.positions) expect(Number.isInteger(p.terms.notional)).toBe(true);
  });

  test("liability conservation leaves the targeted family alone and scales the rest to the capital ratio", () => {
    const spec = generatePortfolio(config);
    const t = computeBalanceSheetTotals(spec);
    const sum = (fam: string) =>
      spec.positions.filter((p) => p.familyId === fam).reduce((a, p) => a + p.terms.notional, 0);
    expect(sum("mma")).toBe(600_000_000);
    expect(Math.abs((t.assets - t.liabilities) / t.assets - 0.05)).toBeLessThan(1e-6);
  });

  test("a mortgage family's original balance follows its rescaled notional", () => {
    const spec = generatePortfolio({
      ...config,
      families: [{ ...pick("mortgages"), weight: 1, targetDollars: 500_000_000 }],
    });
    for (const p of spec.positions) {
      if (p.terms.type === "mortgage") expect(p.terms.originalBalance).toBe(p.terms.notional);
    }
  });

  test("the draw order is untouched: the same positions in the same order, each scaled by one family factor", () => {
    const plain = generatePortfolio({ ...config, families: config.families.map((f) => ({ ...f, targetDollars: undefined })) });
    const scaled = generatePortfolio(config);
    const a = plain.positions.filter((p) => p.familyId === "fixed-loans");
    const b = scaled.positions.filter((p) => p.familyId === "fixed-loans");
    expect(b.map((p) => p.id)).toEqual(a.map((p) => p.id));
    const k = b[0].terms.notional / a[0].terms.notional;
    for (let i = 0; i < a.length; i += 97) expect(Math.abs(b[i].terms.notional / a[i].terms.notional - k)).toBeLessThan(1e-3);
  });

  test("a CD family cannot carry a dollar target", () => {
    expect(() =>
      generatePortfolio({ ...config, families: [{ ...pick("cds"), weight: 1, targetDollars: 1_000_000 }] }),
    ).toThrow(/cds.*targetDollars/);
  });

  // When every liability family is targeted nothing can scale, so the book must add up by itself.
  const allTargeted = (liab: number) => ({
    ...config,
    capitalRatio: 0.05,
    families: [
      { ...pick("fixed-loans"), weight: 0.6, targetDollars: 1_000_000_000 },
      { ...pick("mma"), weight: 0.4, targetDollars: liab },
    ],
  });

  test("every liability family targeted and the equity ratio off capitalRatio: refused in a sentence naming capitalRatio", () => {
    expect(() => generatePortfolio(allTargeted(900_000_000))).toThrow(/capitalRatio/);
    expect(() => generatePortfolio(allTargeted(900_000_000))).toThrow(/0\.05/);
  });

  test("every liability family targeted and the book adding up to capitalRatio is accepted", () => {
    const spec = generatePortfolio(allTargeted(950_000_000));
    const t = computeBalanceSheetTotals(spec);
    expect(t.assets).toBe(1_000_000_000);
    expect(t.liabilities).toBe(950_000_000);
  });

  test("an untargeted liability family keeps the scaling path and no refusal", () => {
    expect(() => generatePortfolio(config)).not.toThrow();
  });

  test("a non-positive target is refused", () => {
    expect(() =>
      generatePortfolio({ ...config, families: [{ ...pick("fixed-loans"), weight: 1, targetDollars: 0 }] }),
    ).toThrow(/targetDollars/);
  });
});
