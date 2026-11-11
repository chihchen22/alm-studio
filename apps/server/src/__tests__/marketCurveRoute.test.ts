// apps/server/src/__tests__/marketCurveRoute.test.ts
// B4 Task 9, fix round 1: GET /api/market/:id/curve-default, the curve a stored market builds as the
// server stamps it (engine curveDefaultStampOf), so the Studio names it without running the engine in the
// browser. `builds` is what a run on the market builds (a curveSetup block wins); `default` is what it
// builds with the block set aside. A market the engine refuses reads `{kind: "refused", reason}`. The
// snapshot route itself stays verbatim. Every value is restated by hand.
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

const curveOf = (id: string) => api<Record<string, unknown>>(t.base, "GET", `/api/market/${id}/curve-default`);

describe("GET /api/market/:id/curve-default", () => {
  it("the public market builds platform default version 2", async () => {
    const r = await curveOf(SEED_IDS.market);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ marketId: "market-public-2026-03-31", builds: { kind: "default", version: 2 }, default: { kind: "default", version: 2 } });
  });

  it("a market marked curveDefault: 1 builds version 1 with no reason", async () => {
    store.putDocument("market", "mk-mc-marked", { ...base, curveDefault: 1 }, { label: "marked v1" });
    const r = await curveOf("mk-mc-marked");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ marketId: "mk-mc-marked", builds: { kind: "default", version: 1 }, default: { kind: "default", version: 1 } });
  });

  it("a market version 2 cannot take falls back to version 1 with the reason", async () => {
    store.putDocument("market", "mk-mc-fallback", { ...base, curveQuotes: [{ ...base.curveQuotes[0]!, term: "3W", tYears: 0.0575 }, ...base.curveQuotes] }, { label: "3W quote" });
    const r = await curveOf("mk-mc-fallback");
    expect(r.status).toBe(200);
    const fallback = { kind: "default", version: 1, reason: "quote 3W at 0.0575 years is not within 0.0001 years of a whole month" };
    expect(r.body).toEqual({ marketId: "mk-mc-fallback", builds: fallback, default: fallback });
  });

  it("a curveSetup block wins for builds, with its label; default sets it aside", async () => {
    const block = { id: "ust-lz", label: "UST linear", baseCurve: "UST", interpolation: "linear-zero", dayCount: "ACT/365", compounding: "semi-annual", inputs: [{ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04 }] };
    store.putDocument("market", "mk-mc-setup", { ...base, curveSetup: block }, { label: "with a setup" });
    const r = await curveOf("mk-mc-setup");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ marketId: "mk-mc-setup", builds: { kind: "setup", id: "ust-lz", label: "UST linear" }, default: { kind: "default", version: 2 } });
  });

  it("a marker the engine refuses reads refused with the engine's sentence, never a 500", async () => {
    store.putDocument("market", "mk-mc-bad", { ...base, curveDefault: 2 }, { label: "bad marker" });
    const r = await curveOf("mk-mc-bad");
    expect(r.status).toBe(200);
    const refused = {
      kind: "refused",
      reason: "The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.",
    };
    expect(r.body).toEqual({ marketId: "mk-mc-bad", builds: refused, default: refused });
  });

  it("a stored market document that is JSON null reads refused, never a 500", async () => {
    store.putDocument("market", "mk-mc-null", null, { label: "null document" });
    const r = await curveOf("mk-mc-null");
    expect(r.status).toBe(200);
    const refused = { kind: "refused", reason: "the stored market document is not an object" };
    expect(r.body).toEqual({ marketId: "mk-mc-null", builds: refused, default: refused });
  });

  it("an unknown id is 404, and the snapshot route stays verbatim", async () => {
    expect((await curveOf("no-such")).status).toBe(404);
    const snap = await api<Record<string, unknown>>(t.base, "GET", `/api/market/${SEED_IDS.market}`);
    expect("builds" in snap.body).toBe(false);
    expect("curveDefault" in snap.body).toBe(false);
  });
});
