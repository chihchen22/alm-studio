/**
 * The seeded volatility shock (vol-shock-demo-v1) and
 * what a run on it moves. The shock is the public market pack with every
 * constructed short-rate volatility times 1.5, derived through the engine's
 * deriveMarketSnapshot, so it must equal what the market derive route writes for
 * the same body (C), and it must leave every earlier seeded document
 * byte-identical (A).
 *
 * The seeded end-to-end proof has two halves. Deterministic (F): the stored plans
 * run twice, once per market, and every result block is identical, because no
 * deterministic number reads a volatility; only provenance.inputsHash and the
 * plan identity differ. Stochastic (G): the calibrated Hull-White sigma and the
 * fit error scale by exactly the factor, the mean reversion a does not move, and
 * the EVE distribution widens at equal mean. The 12-month NII distribution does
 * NOT move on the vanilla book: its 12-month income does not depend on the rate
 * path. The seeded proof therefore shows an EVE effect only, and the page copy
 * says so.
 *
 * Everything runs from a scratch store seeded by the real seedStore(). Expected
 * values are restated here as literals, never read back from the seed. The hash
 * literals in A were measured on the unmodified code, BEFORE this
 * slice, and are never re-pinned. The distribution literals in G were measured
 * in an engine probe (runStochastic on the vanilla book, horizon 360, seed
 * 20260331, 64 paths) and are never re-pinned; if the route disagrees, stop and
 * report. B4 (curve default 2) re-pinned the F and G literals once, each with a row; the same probe on a
 * curveDefault: 1 market reproduces every old literal.
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore, VOL_SHOCK_DEMO_OPS } from "../../scripts/seed-store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "vol-shock-demo-v1";
const SHOCK_LABEL = "Constructed short-rate volatilities times 1.5 at every expiry of the public market pack (demonstration values)";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("A: nothing seeded earlier moved", () => {
  // Measured on the unmodified code; never re-pin.
  const NO_CHANGE: Array<[Parameters<FileStore["getMeta"]>[0], string, string]> = [
    ["market", BASE_ID, "6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731"],
    ["market", "tlp-shock-demo-v1", "abc80918c85cd6753cb9e499b47d4768b072b125cafffc56886d5a6253ad5d0a"],
    ["market", "rate-indices-demo-v1", "347674669bbc746208745bf97c683a81c5da643c5adad33d116a7d3238cc2e00"],
    ["run-plans", "plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
    ["run-plans", "plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
  ];
  for (const [collection, id, hash] of NO_CHANGE) {
    it(`${collection}/${id} still stores the measured bytes`, () => {
      expect(store.getMeta(collection, id).contentHash).toBe(hash);
    });
  }
});

describe("B: the seeded vol-shock-demo-v1", () => {
  it("carries the x1.5 ATM column, every other block of the base unchanged, the derivation record, its meta and its store hash", () => {
    const doc = store.getDocument<Json>("market", SHOCK_ID).doc;
    const base = store.getDocument<Json>("market", BASE_ID).doc;
    const atm = doc.capQuotes.filter((q: Json) => q.isAtm).map((q: Json) => [q.expiryYears, q.normalVol]);
    expect(atm).toEqual([
      [1, 0.0095175],
      [2, 0.009318],
      [3, 0.0091755],
      [4, 0.009066],
      [5, 0.008976],
      [6, 0.0088995],
      [7, 0.008835],
      [8, 0.0087765],
      [9, 0.008724],
      [10, 0.0086775],
      [12, 0.008595],
      [15, 0.008493],
      [20, 0.008358],
      [25, 0.008253],
      [30, 0.008166],
    ]);
    expect(doc.capQuotes).toHaveLength(390);
    expect(doc.swaptionATMQuotes).toEqual(base.swaptionATMQuotes);
    expect(doc.tlpNodes).toEqual(base.tlpNodes);
    expect(doc.curveQuotes).toEqual(base.curveQuotes);
    expect(doc.termFundingCurveQuotes).toEqual(base.termFundingCurveQuotes);
    expect(doc.termFundingCurveQuotes).toHaveLength(11);
    expect(doc.derivedFrom).toEqual({
      baseId: BASE_ID,
      baseContentHash: "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651",
      ops: [{ op: "scale-short-rate-vol", value: 1.5 }],
    });
    const meta = store.getMeta("market", SHOCK_ID) as Json;
    expect(meta.derivedFromMarketId).toBe(BASE_ID);
    expect(meta.seeded).toBe(true);
    expect(meta.label).toBe(SHOCK_LABEL);
    expect(meta.derivedOpCount).toBe(1);
    expect(meta.contentHash).toBe("f9737f2aae0c8b7d9c86dd3fbd49f280019cd47c6011c571bb206c3ff73e95f6");
  });
});

describe("C: the derive route agrees with the seed", () => {
  it("POST /api/market/derive with the seed request answers 200 unchanged", async () => {
    const r = await api<{ outcome: string }>(t.base, "POST", "/api/market/derive", {
      baseId: BASE_ID,
      ops: VOL_SHOCK_DEMO_OPS,
      id: SHOCK_ID,
      label: SHOCK_LABEL,
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("unchanged");
  });
});

describe("D: re-seeding", () => {
  it("a second seed writes nothing and reports nothing stale", async () => {
    const report = await seedStore(store, repoRoot());
    expect(report.written).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.skipped).toContain(`market/${SHOCK_ID}`);
  }, 60_000);
});

describe("E: the catalog mirror", () => {
  it("lists the derived market with its lineage and 34 curve points, and serves a 390-point cap surface", async () => {
    const r = await api<Json[]>(t.base, "GET", "/api/catalog/markets");
    expect(r.status).toBe(200);
    const derived = r.body.find((x) => x.id === SHOCK_ID)!;
    expect(derived.derivedFromMarketId).toBe(BASE_ID);
    // A vol-only derive keeps the base's curve and the 11 term-funding quotes, so the count equals the base's 34.
    expect(derived.curvePoints).toBe(34);
    const snap = await api<Json>(t.base, "GET", `/api/catalog/markets/${SHOCK_ID}`);
    expect(snap.status).toBe(200);
    expect(snap.body.capVolSurface).toHaveLength(390);
    const oneYearAtm = snap.body.capVolSurface.find((p: Json) => p.expiryYears === 1 && p.isAtm === true);
    expect(oneYearAtm.normalVol).toBe(0.0095175);
  });
});

describe("F: deterministic identity, base market against volatility-shocked market", () => {
  const settle = async (runId: string): Promise<void> => {
    const done = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      120_000,
    );
    expect(done.state).toBe("done");
  };
  const runPlan = async (plan: Json): Promise<{ result: Json; rates: Json }> => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan });
    expect(r.status).toBe(202);
    await settle(r.body.runId);
    const dir = join(t.storeRoot, "runs", r.body.runId);
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Json;
    const rates = JSON.parse(readFileSync(join(dir, "rates.json"), "utf8")) as Json;
    return { result, rates };
  };
  const pair = async (id: string): Promise<{ a: Json; b: Json; ratesA: Json; ratesB: Json }> => {
    const stored = (await api<Json>(t.base, "GET", `/api/run-plans/${id}`)).body;
    const a = await runPlan(stored);
    const b = await runPlan({
      ...stored,
      planId: `${id}-vol15`,
      inputs: { ...stored.inputs, marketSnapshot: SHOCK_ID },
    });
    return { a: a.result, b: b.result, ratesA: a.rates, ratesB: b.rates };
  };
  const s0 = (r: Json, block: "eve" | "nii"): Json => r[block].byScenario.find((s: Json) => s.scenarioId === "S0")!;
  const IDENTITY_MAY_DIFFER = new Set(["runId", "timestamps", "inputsHash", "planId", "planHash"]);

  const assertIdentical = (a: Json, b: Json, ratesA: Json, ratesB: Json): void => {
    expect(a.schemaVersion).toBe("1.13.0");
    expect(b.schemaVersion).toBe("1.13.0");
    const keys = Object.keys(a).filter((k) => k !== "provenance");
    expect(keys.length).toBeGreaterThan(3);
    for (const k of keys) expect(b[k], `top-level block ${k}`).toEqual(a[k]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
    const differing = Object.keys(a.provenance).filter((k) => JSON.stringify(a.provenance[k]) !== JSON.stringify(b.provenance[k]));
    expect(differing).toContain("inputsHash");
    // runLog carries the plan id on its entries; it may differ only by the "-vol15" suffix this test puts on the planId.
    const rest = differing.filter((k) => k !== "runLog");
    for (const k of rest) expect(IDENTITY_MAY_DIFFER.has(k), `provenance key ${k} differs`).toBe(true);
    if (differing.includes("runLog")) {
      expect(JSON.stringify(b.provenance.runLog).split("-vol15").join("")).toBe(JSON.stringify(a.provenance.runLog));
    }
    expect(b.provenance.inputsHash).not.toBe(a.provenance.inputsHash);
    const ra = { ...ratesA };
    const rb = { ...ratesB };
    delete ra.runId;
    delete rb.runId;
    expect(rb).toEqual(ra);
  };

  it("plan-synthetic-2500-v1: every result block is identical, only provenance identity differs", async () => {
    const { a, b, ratesA, ratesB } = await pair("plan-synthetic-2500-v1");
    assertIdentical(a, b, ratesA, ratesB);
    for (const r of [a, b]) {
      // Seeded synthetic-2500 base EVE on curve default 2 (was 574278133.2521524); deltas Step 1
      expect(s0(r, "eve").eve).toBe(571500248.9115896);
      // Seeded synthetic-2500 NII 12m on curve default 2 (was 19970928.460970417); deltas Step 1
      expect(s0(r, "nii").totalNet12).toBe(20002005.278397486);
    }
  }, 120_000);

  it("plan-synthetic-2500-hedged-v1: every result block is identical, only provenance identity differs", async () => {
    const { a, b, ratesA, ratesB } = await pair("plan-synthetic-2500-hedged-v1");
    assertIdentical(a, b, ratesA, ratesB);
    // Seeded hedged base EVE on curve default 2; the hedge strikes are off par by a hair, not re-struck (was 574281237.7288628); deltas Step 1
    for (const r of [a, b]) expect(s0(r, "eve").eve).toBe(571507385.737227);
  }, 120_000);
});

describe("G and H: stochastic, base market against volatility-shocked market", () => {
  const submit = (marketId: string, extra: Record<string, unknown> = {}) =>
    api<{ runId: string }>(t.base, "POST", "/api/runs", {
      portfolioId: "vanilla-book-v1",
      marketId,
      scenarioSlateId: "regulatory-grid-vanilla",
      assumptionSetIds: ["vanilla-empty-v1"],
      mode: "stochastic",
      stochastic: { nPaths: 64 },
      ...extra,
    });
  const envelopeOf = async (marketId: string): Promise<Json> => {
    const sub = await submit(marketId);
    expect(sub.status).toBe(202);
    const done = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${sub.body.runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      240_000,
    );
    expect(done.state).toBe("done");
    const env = await api<Json>(t.base, "GET", `/api/runs/${sub.body.runId}/stochastic`);
    expect(env.status).toBe(200);
    return env.body;
  };

  it("G: sigma and the fit error scale by 1.5, a does not move, EVE widens at equal mean, NII-12m does not move", async () => {
    const A = await envelopeOf(BASE_ID);
    const B = await envelopeOf(SHOCK_ID);
    for (const e of [A, B]) {
      // A fresh envelope is 0.3.0 (was 0.2.0).
      expect(e.schemaVersion).toBe("0.3.0");
      expect(e.calibration.source).toBe("cap-atm-calibration");
      expect(e.calibration.rmseGateBreached).toBe(false);
      expect(e.calibration.nQuotes).toBe(15);
    }
    // The HW fit on the default curve's forwards (was 0.010742488); deltas Step 1
    expect(Math.abs(A.calibration.a - 0.010724117)).toBeLessThan(1e-8);
    // The HW fit on the default curve's forwards (was 0.0061184513); deltas Step 1
    expect(Math.abs(A.calibration.sigma - 0.0061164844)).toBeLessThan(1e-9);
    // The HW fit on the default curve's forwards (was 0.8924967); deltas Step 1
    expect(Math.abs(A.calibration.rmseBp - 0.9009947)).toBeLessThan(1e-6);

    expect(Math.abs(B.calibration.sigma / A.calibration.sigma - 1.5) / 1.5).toBeLessThan(1e-6);
    expect(Math.abs(B.calibration.a - A.calibration.a)).toBeLessThan(1e-7);
    expect(Math.abs(B.calibration.rmseBp / A.calibration.rmseBp - 1.5) / 1.5).toBeLessThan(1e-6);

    // Relative bound 1e-9 on each standard deviation.
    // EVE stdev on curve default 2 (was 6855510.898898505); deltas Step 1
    expect(Math.abs(A.eveDistribution.stdev - 6843610.473478725) / 6843610.473478725).toBeLessThan(1e-9);
    // EVE stdev on curve default 2 (was 10289688.848804412); deltas Step 1
    expect(Math.abs(B.eveDistribution.stdev - 10271827.171520496) / 10271827.171520496).toBeLessThan(1e-9);
    const widening = B.eveDistribution.stdev / A.eveDistribution.stdev;
    expect(widening).toBeGreaterThan(1.45);
    expect(widening).toBeLessThan(1.55);

    // The martingale identity on the vanilla book's path-independent flows: the mean does not move.
    // The mean is the deterministic base EVE on curve default 2 (martingale identity) (was 121065587.8506); deltas Step 1
    expect(Math.abs(A.eveDistribution.mean - 120866072.2693) / 120866072.2693).toBeLessThan(1e-9);
    expect(Math.abs(B.eveDistribution.mean - A.eveDistribution.mean) / A.eveDistribution.mean).toBeLessThan(1e-9);

    // The vanilla book's 12-month income is path independent, so the shock does not move its distribution.
    expect(Math.abs(A.nii12mDistribution.stdev - 5.632109537858176e-9)).toBeLessThan(1e-15);
    expect(Math.abs(B.nii12mDistribution.stdev - 5.632109537858176e-9)).toBeLessThan(1e-15);
    expect(Math.abs(B.nii12mDistribution.stdev - A.nii12mDistribution.stdev)).toBeLessThan(1e-15);
  }, 480_000);

  it("H: a modelParams override on the shocked market is refused with 422 naming the market and its base", async () => {
    const r = await submit(SHOCK_ID, { stochastic: { nPaths: 64, modelParams: { a: 0.03, sigma: 0.01, reason: "probe" } } });
    expect(r.status).toBe(422);
    const message = (r.body as unknown as { error: { message: string } }).error.message;
    expect(message).toContain(`market "${SHOCK_ID}" carries a short-rate volatility shock`);
    expect(message).toContain(`(applied in market "${SHOCK_ID}" on base "${BASE_ID}")`);
  }, 60_000);
});
