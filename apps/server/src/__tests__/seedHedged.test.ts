import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootstrapZeroCurve, type MarketSnapshot, type ZeroCurve } from "@alm/kernel";
import type { PortfolioSpec } from "@alm/engine";
import type { SwapTerms } from "@alm/engine/src/swap";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { HEDGE_SWAPS, SEED_IDS, seedStore } from "../../scripts/seed-store";

let storeRoot: string;
let store: FileStore;
beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-hedged-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot());
}, 180_000);
afterAll(() => {
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // The OS temp cleaner owns the leftovers.
  }
});

const book = (id: string) => store.getDocument<PortfolioSpec>("portfolios", id).doc;

/** Engine-convention par, restated. */
function par(c: ZeroCurve, months: number): number {
  let a = 0;
  for (let m = 1; m <= months; m++) a += c.discountFactor(m / 12);
  return (12 * (1 - c.discountFactor(months / 12))) / a;
}

describe("synthetic-2500-hedged-v1", () => {
  it("carries synthetic-2500-v1's positions unchanged and first", () => {
    const base = book(SEED_IDS.syntheticPortfolio);
    const hedged = book(SEED_IDS.hedgedPortfolio);
    expect(hedged.positions.slice(0, base.positions.length)).toEqual(base.positions);
    expect(hedged.positions.length).toBe(base.positions.length + 3);
  });

  it("holds three pay-fixed swaps at 24, 60 and 120 months in one derivative swap family", () => {
    const hedged = book(SEED_IDS.hedgedPortfolio);
    const fam = hedged.coa.families.find((f) => f.instrumentType === "swap")!;
    expect([fam.side, fam.instrumentType]).toEqual(["derivative", "swap"]);
    const swaps = hedged.positions.filter((p) => p.terms.type === "swap").map((p) => p.terms as SwapTerms);
    expect(swaps.map((s) => [s.maturityMonths, s.direction])).toEqual([
      [24, "pay-fixed"],
      [60, "pay-fixed"],
      [120, "pay-fixed"],
    ]);
    expect(hedged.positions.filter((p) => p.terms.type === "swap").every((p) => p.familyId === fam.id)).toBe(true);
  });

  it("stores each swap's maturity, notional and fixed rate exactly as HEDGE_SWAPS specifies (Ledger L3)", () => {
    const hedged = book(SEED_IDS.hedgedPortfolio);
    const stored = hedged.positions
      .filter((p) => p.terms.type === "swap")
      .map((p) => p.terms as SwapTerms)
      .map((s) => [s.maturityMonths, s.notional, s.fixedRate]);
    // The seed writes what the spec says...
    expect(stored).toEqual(HEDGE_SWAPS.map((s) => [s.tenorMonths, s.notional, s.fixedRate]));
    // ...and the spec is the Ledger L3 hedge, restated here, not imported.
    expect(stored).toEqual([
      [24, 325_000_000, 0.0376],
      [60, 325_000_000, 0.03888],
      [120, 325_000_000, 0.04262],
    ]);
  });

  it("strikes every fixed rate within half a basis point of par on the stored as-of curve", () => {
    const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    const curve = bootstrapZeroCurve(market);
    for (const s of HEDGE_SWAPS) {
      expect(Math.abs(s.fixedRate - par(curve, s.tenorMonths)), `${s.tenorMonths}m: ${s.fixedRate} vs par ${par(curve, s.tenorMonths)}`).toBeLessThanOrEqual(0.5e-4);
    }
  });

  it("reports the same assets, liabilities and equity as synthetic-2500-v1, and the swap notional on its own line", () => {
    const a = store.getMeta("portfolios", SEED_IDS.syntheticPortfolio).intake as Record<string, number>;
    const b = store.getMeta("portfolios", SEED_IDS.hedgedPortfolio).intake as Record<string, number>;
    expect([b.assets, b.liabilities, b.equity]).toEqual([a.assets, a.liabilities, a.equity]);
    expect(b.swapNotional).toBe(HEDGE_SWAPS.reduce((s, x) => s + x.notional, 0));
    expect("swapNotional" in a).toBe(false);
  });
});
