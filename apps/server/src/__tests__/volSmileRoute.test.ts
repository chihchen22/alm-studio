// apps/server/src/__tests__/volSmileRoute.test.ts
// GET /api/market/:id/vol-smile, a read-only SABR smile
// preview of one expiry row of the short-rate volatility surface. Nothing is stored and no run reads it.
// The Hagan beta = 0 form and the heuristic's rule are restated here by hand, never imported, so the test
// does not borrow its expected values from the code it checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
let store: FileStore;
let base: MarketSnapshot;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  base = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
}, 120_000);
afterAll(() => t.close());

interface SmilePoint { strike: number; isAtm: boolean; normalVol: number; modelVol: number; residualBp: number }
interface SmileReply {
  marketId: string;
  expiryYears: number;
  underlyingTau: number;
  forward: number;
  heuristic: { alpha: number; beta: number; rho: number; nu: number };
  params: { alpha: number; beta: number; rho: number; nu: number };
  points: SmilePoint[];
  curve: { strike: number; modelVol: number }[];
  note: string;
}
interface Problem { error: { code: string; message: string; detail?: unknown } }

const smile = <T = SmileReply>(id: string, query: string) =>
  api<T>(t.base, "GET", `/api/market/${id}/vol-smile${query}`);

/** Hagan et al. 2002, beta = 0 (normal) form, restated by hand. */
function hagan(f: number, k: number, T: number, alpha: number, rho: number, nu: number): number {
  const h = 1 + ((2 - 3 * rho * rho) * nu * nu / 24) * T;
  if (Math.abs(f - k) < 1e-7) return alpha * h;
  const z = (nu / alpha) * (f - k);
  const x = Math.log((Math.sqrt(1 - 2 * rho * z + z * z) + z - rho) / (1 - rho));
  return alpha * (z / x) * h;
}

const NOTE =
  "Constructed illustrative short-rate volatility surface. Nothing is stored, nothing is hashed, " +
  "no derive op writes a SABR value, and no run reads the result: the HW calibration reads the at-the-money " +
  "column as before and the wings stay unread. The heuristic is one surface-wide parameter set, so the " +
  "residuals show how far one smile sits from each row.";

describe("GET /api/market/:id/vol-smile", () => {
  it("the public pack's 5Y row: 25 strike points plus the ATM point at the forward, a curve and residuals", async () => {
    const r = await smile(SEED_IDS.market, "?expiryYears=5");
    expect(r.status).toBe(200);
    const b = r.body;
    expect(b.marketId).toBe("market-public-2026-03-31");
    expect(b.expiryYears).toBe(5);
    expect(b.underlyingTau).toBe(0.25);
    // The 5Y x 5.25Y forward of the platform default curve on the public pack (probe, 2026-10-17).
    expect(b.forward).toBeCloseTo(0.04634142250842466, 12);

    // The heuristic, restated: alpha is 1.05 times the mean of all 390 stored vols; the row carries
    // strikes at or below -1% and at or above 4%, so rho -0.35 and nu 0.95.
    expect(base.capQuotes.length).toBe(390);
    const mean = base.capQuotes.reduce((s, q) => s + q.normalVol, 0) / base.capQuotes.length;
    expect(b.heuristic.alpha).toBeCloseTo(1.05 * mean, 15);
    expect(b.heuristic).toMatchObject({ beta: 0, rho: -0.35, nu: 0.95 });
    expect(b.params).toEqual(b.heuristic);

    expect(b.points).toHaveLength(26);
    const strikes = b.points.filter((p) => !p.isAtm);
    const atm = b.points.filter((p) => p.isAtm);
    expect(strikes).toHaveLength(25);
    expect(atm).toHaveLength(1);
    expect(atm[0]!.strike).toBe(b.forward);
    expect(atm[0]!.normalVol).toBe(0.005984);
    expect(strikes[0]).toMatchObject({ strike: -0.02, normalVol: 0.008521 });
    expect(strikes[24]).toMatchObject({ strike: 0.07, normalVol: 0.007304 });
    // Sorted by strike, the ATM point in its place between 4.5% and 5%.
    const ks = b.points.map((p) => p.strike);
    expect([...ks].sort((x, y) => x - y)).toEqual(ks);

    const { alpha, rho, nu } = b.heuristic;
    for (const p of b.points) {
      const m = hagan(b.forward, p.strike, 5, alpha, rho, nu);
      expect(p.modelVol).toBeCloseTo(m, 14);
      expect(p.residualBp).toBeCloseTo((m - p.normalVol) * 1e4, 9);
    }
    // At the forward the closed form reads alpha times the higher-order term.
    expect(atm[0]!.modelVol).toBeCloseTo(alpha * (1 + ((2 - 3 * 0.35 * 0.35) * 0.95 * 0.95 / 24) * 5), 15);

    // The curve: a 5 bp grid from -2% to 7%, 181 points.
    expect(b.curve).toHaveLength(181);
    expect(b.curve[0]!.strike).toBe(-0.02);
    expect(b.curve[180]!.strike).toBe(0.07);
    for (let i = 0; i < b.curve.length; i++) {
      expect(b.curve[i]!.strike).toBeCloseTo(-0.02 + i * 0.0005, 12);
      expect(b.curve[i]!.modelVol).toBeCloseTo(hagan(b.forward, b.curve[i]!.strike, 5, alpha, rho, nu), 14);
    }
    expect(b.note).toBe(NOTE);
    expect(r.text).not.toMatch(/NaN|null|Infinity/);
  });

  it("overrides replace the heuristic's values one by one; the heuristic is still reported", async () => {
    const r = await smile(SEED_IDS.market, "?expiryYears=5&alpha=0.008&nu=0.5");
    expect(r.status).toBe(200);
    expect(r.body.params).toEqual({ alpha: 0.008, beta: 0, rho: -0.35, nu: 0.5 });
    expect(r.body.heuristic.nu).toBe(0.95);
    const p = r.body.points[0]!;
    expect(p.modelVol).toBeCloseTo(hagan(r.body.forward, -0.02, 5, 0.008, -0.35, 0.5), 14);
  });

  it("a missing expiry is 422 listing the 15 stored expiries", async () => {
    const r = await smile<Problem>(SEED_IDS.market, "?expiryYears=11");
    expect(r.status).toBe(422);
    const expiries = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30];
    expect(r.body.error.detail).toEqual({ expiries });
    expect(r.body.error.message).toBe(
      "expiryYears 11 is not an expiry row of the short-rate volatility surface; the rows are 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 15, 20, 25, 30 years",
    );
  });

  it("an expiry within 1e-9 of a row reads that row", async () => {
    const r = await smile(SEED_IDS.market, "?expiryYears=5.0000000001");
    expect(r.status).toBe(200);
    expect(r.body.expiryYears).toBe(5);
  });

  it("nu 0 is 422 in words and no NaN reaches the reply", async () => {
    const r = await smile<Problem>(SEED_IDS.market, "?expiryYears=5&nu=0");
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("nu must be a number greater than 0; got 0");
    expect(r.text).not.toMatch(/NaN/);
  });

  it("an in-range override whose residual overflows is 422 in words; no 200 reply carries a null", async () => {
    for (const nu of ["1e103", "2e103"]) {
      const r = await smile<Problem>(SEED_IDS.market, `?expiryYears=5&nu=${nu}`);
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/^the preview cannot be computed: the residual at strike -?[0-9.e-]+ is not a finite number$/);
      expect(r.text).not.toMatch(/null|NaN|Infinity/);
    }
    // Large but non-overflowing overrides still answer 200 with no null standing in for a number.
    for (const nu of ["1e50", "1e100"]) {
      const r = await smile(SEED_IDS.market, `?expiryYears=5&nu=${nu}`);
      expect(r.status).toBe(200);
      expect(r.text).not.toMatch(/null|NaN|Infinity/);
    }
  });

  it.each([
    ["?alpha=0.01", "expiryYears is required: the expiry row, in years, of the short-rate volatility surface"],
    ["?expiryYears=five", "expiryYears must be a number of years; got \"five\""],
    ["?expiryYears=5&alpha=0", "alpha must be a number greater than 0; got 0"],
    ["?expiryYears=5&alpha=-0.01", "alpha must be a number greater than 0; got -0.01"],
    ["?expiryYears=5&rho=1", "rho must be a number greater than -1 and less than 1; got 1"],
    ["?expiryYears=5&rho=-1", "rho must be a number greater than -1 and less than 1; got -1"],
    ["?expiryYears=5&nu=-1", "nu must be a number greater than 0; got -1"],
    ["?expiryYears=5&nu=abc", "nu must be a number greater than 0; got \"abc\""],
    ["?expiryYears=5&alpha=", "alpha must be a number greater than 0; got \"\""],
    ["?expiryYears=5&rho=NaN", "rho must be a number greater than -1 and less than 1; got \"NaN\""],
  ])("%s is 422 in words", async (query, message) => {
    const r = await smile<Problem>(SEED_IDS.market, query);
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(message);
    expect(r.text).not.toMatch(/NaN(?!\\")/);
  });

  it("a market the curve builder refuses is 422 in the builder's words, never a 500", async () => {
    store.putDocument("market", "mk-vs-bad", { ...base, curveDefault: 2 }, { label: "bad marker" });
    const r = await smile<Problem>("mk-vs-bad", "?expiryYears=5");
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      "The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.",
    );
  });

  it("a stored document that is not a market is 422, never a 500; an unknown id is 404", async () => {
    store.putDocument("market", "mk-vs-null", null, { label: "null document" });
    const r = await smile<Problem>("mk-vs-null", "?expiryYears=5");
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe("the stored market document carries no short-rate volatility surface");
    expect((await smile("no-such", "?expiryYears=5")).status).toBe(404);
  });

  it("the stored market bytes are unchanged after calls", async () => {
    const docPath = join(t.storeRoot, "market", `${SEED_IDS.market}.json`);
    const metaPath = join(t.storeRoot, "market", `${SEED_IDS.market}.meta.json`);
    const before = [readFileSync(docPath), readFileSync(metaPath)];
    expect((await smile(SEED_IDS.market, "?expiryYears=5")).status).toBe(200);
    expect((await smile(SEED_IDS.market, "?expiryYears=10&alpha=0.009&rho=0.2&nu=0.4")).status).toBe(200);
    expect((await smile(SEED_IDS.market, "?expiryYears=5&nu=0")).status).toBe(422);
    expect(readFileSync(docPath).equals(before[0]!)).toBe(true);
    expect(readFileSync(metaPath).equals(before[1]!)).toBe(true);
  });
});
