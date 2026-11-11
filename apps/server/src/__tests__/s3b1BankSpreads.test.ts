/**
 * Quillfield Bank version 1.1 (ruling 2026-11-04): the loans carry round discount spreads, one
 * per family, read only on the spread-consistent basis. Every value is stated here by hand, from the data note's table
 * (docs/oss/mid-size-bank.md, "Discount spreads (version 1.1)"), never read back from the file under test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { repoRoot } from "../config";

const bank = JSON.parse(readFileSync(join(repoRoot(), "examples", "mid-size-bank-v1.json"), "utf8")) as PortfolioSpec;

const SPREAD_BP: Record<string, number> = {
  "mb-ci-floating": 150,
  "mb-ci-fixed": 150,
  "mb-cre-fixed": 125,
  "mb-cre-construction": 125,
  "mb-cre-multifamily": 100,
  "mb-resi-mortgages": 75,
  "mb-heloc": 150,
  "mb-consumer": 300,
  "mb-other-loans": 200,
};

describe("Quillfield Bank version 1.1", () => {
  // Version 1.2 adds the floaters' funding tenors and keeps every spread below.
  // Version 1.3 adds the liquidity tags and values, and keeps them too.
  it("is labelled version 1.3 since S3d-1 and keeps its id", () => {
    expect(bank.id).toBe("mid-size-bank-v1");
    expect(bank.label).toContain("version 1.3");
  });

  it("gives every loan its family's spread and nothing else a spread", () => {
    for (const p of bank.positions) {
      expect(p.discountSpreadBp, p.id).toBe(SPREAD_BP[p.familyId]);
    }
    // Twelve loan positions in the nine families.
    expect(bank.positions.filter((p) => p.discountSpreadBp !== undefined)).toHaveLength(12);
  });

  it("holds one spread per family, as the spread-consistent basis needs", () => {
    const byFamily = new Map<string, Set<number>>();
    for (const p of bank.positions) if (p.discountSpreadBp !== undefined) (byFamily.get(p.familyId) ?? byFamily.set(p.familyId, new Set()).get(p.familyId)!).add(p.discountSpreadBp);
    for (const [f, s] of byFamily) expect(s.size, f).toBe(1);
  });
});
