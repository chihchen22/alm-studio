/**
 * The drill route and a typed floater that names a
 * rate index. The index lives on a derived market (saved through the 6c derive
 * route with the three demonstration set-index ops); the drill resolves the
 * index against the market named by marketId. Expected values are restated from
 * the approved design: the base path's month-1 reset on the public pack is
 * 0.03711187832875318 (the default curve, first node at exactly 1/12; was
 * 0.03711187754093537, measured on the unmodified engine), the prime-demo basis
 * is 0.03, and the floater margin is 0.0125.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;
beforeAll(async () => {
  tp = await bootTestPlatform();
  await seedStore(new FileStore(tp.storeRoot), repoRoot());
  const saved = await api(tp.base, "POST", "/api/market/derive", {
    baseId: BASE,
    ops: SEED_OPS,
    id: "idx-test-v1",
  });
  if (saved.status !== 201) throw new Error(`setup derive failed: ${saved.text}`);
}, 300_000);
afterAll(async () => {
  await tp.close();
});

const BASE = "market-public-2026-03-31";
const PATH = "/api/instrument/project";
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];

interface Drill {
  byScenario: Array<{ rows: Array<{ month: number; couponRate: number; interest: number }> }>;
}
interface Err {
  error: { code: string; message: string };
}

const floater = (extra: Record<string, unknown> = {}) => ({
  id: "idx-floater",
  type: "floating-loan",
  notional: 1_000_000,
  maturityMonths: 12,
  originationOffsetMonths: 0,
  amortType: "bullet",
  margin: 0.0125,
  resetFrequencyMonths: 1,
  indexTenorMonths: 1,
  ...extra,
});
const request = (terms: Record<string, unknown>, marketId: string) => ({
  instrument: { terms, familyId: "typed", side: "asset" },
  marketId,
  scenarios: { parallelShockBp: 0 },
  horizonMonths: 12,
});

describe("the drill on a typed floater naming a rate index", () => {
  it("prices month 1 on the index (benchmark reset plus basis plus margin) on a market that carries it", async () => {
    const r = await api<Drill>(tp.base, "POST", PATH, request(floater({ rateIndexId: "prime-demo" }), "idx-test-v1"));
    expect(r.status, r.text).toBe(200);
    const row = r.body.byScenario[0]!.rows[0]!;
    expect(row.month).toBe(1);
    // R(0) on the default curve (was 0.03711187754093537, coupon 0.07961187754093537); interpolation, deltas Step 1
    expect(row.couponRate).toBeCloseTo(0.07961187832875318, 15);
    expect(row.interest).toBeCloseTo((1_000_000 * (0.03711187832875318 + 0.03 + 0.0125)) / 12, 9);
  });

  it("the same floater with no index stays on the one-month benchmark plus margin", async () => {
    const r = await api<Drill>(tp.base, "POST", PATH, request(floater(), BASE));
    expect(r.status, r.text).toBe(200);
    // R(0) on the default curve (was 0.03711187754093537); interpolation, deltas Step 1
    expect(r.body.byScenario[0]!.rows[0]!.couponRate).toBeCloseTo(0.03711187832875318 + 0.0125, 15);
  });

  it("answers 422 on a market that does not carry the index, naming it", async () => {
    const r = await api<Err>(tp.base, "POST", PATH, request(floater({ rateIndexId: "prime-demo" }), BASE));
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain('names rate index "prime-demo"');
    expect(r.body.error.message).toContain("it carries none");
  });

  it("answers 400 for a rateIndexId that is not an index id string", async () => {
    const r = await api<Err>(tp.base, "POST", PATH, request(floater({ rateIndexId: 7 }), "idx-test-v1"));
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("body.instrument.terms.rateIndexId: expected a lowercase rate index id");
    const bad = await api<Err>(tp.base, "POST", PATH, request(floater({ rateIndexId: "Prime" }), "idx-test-v1"));
    expect(bad.status).toBe(400);
  });

  it("answers 400 for a non-floating type that names an index", async () => {
    const r = await api<Err>(
      tp.base,
      "POST",
      PATH,
      request(
        {
          id: "fx",
          type: "fixed-loan",
          notional: 1_000_000,
          maturityMonths: 12,
          originationOffsetMonths: 0,
          amortType: "bullet",
          coupon: 0.05,
          rateIndexId: "prime-demo",
        },
        "idx-test-v1",
      ),
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("rateIndexId is read on floating-loan terms only");
  });
});
