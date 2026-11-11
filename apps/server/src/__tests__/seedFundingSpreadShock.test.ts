/**
 * The seeded funding spread shock (tlp-shock-demo-v1)
 * and what a run on it moves. The shock is the public market pack with +50 bp on
 * every TLP node except t = 0, derived through the engine's deriveMarketSnapshot,
 * so it must equal what the market derive route writes for the same body (C), and
 * it must leave every earlier seeded document byte-identical (A). The seeded
 * end-to-end pair runs the stored plan twice, once on each market (F, G): only
 * EVE and FTP move; NII, cash flows and gaps are bit-identical, and swap legs
 * do not move.
 *
 * Everything runs from a scratch store seeded by the real seedStore(). Expected
 * values are restated here as literals, never read back from the seed. The hash
 * literals in A were measured on the unmodified code, BEFORE this
 * slice, and are never re-pinned.
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore, FUNDING_SPREAD_SHOCK_OPS } from "../../scripts/seed-store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BASE_ID = "market-public-2026-03-31";
const SHOCK_ID = "tlp-shock-demo-v1";
const SHOCK_LABEL = "TLP +50 bp on every node of the public market pack (demonstration values)";

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
  const NO_CHANGE: Array<[Parameters<FileStore["getMeta"]>[0], string, string]> = [
    ["market", BASE_ID, "6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731"],
    ["run-plans", "plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
    ["run-plans", "plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
    ["assumption-sets", "demo-behavioral-v1", "7b65f5629022b720de7a79819718a75545a56d06c5d966f963a2f61a058175a2"],
    ["plans", "balance-shock-demo-v1", "ce32aff9ac9b7aca932a9c51ba252a51edc856f261eafd48810a6490808e2e08"],
  ];
  for (const [collection, id, hash] of NO_CHANGE) {
    it(`${collection}/${id} still stores the measured bytes`, () => {
      expect(store.getMeta(collection, id).contentHash).toBe(hash);
    });
  }
});

describe("B: the seeded tlp-shock-demo-v1", () => {
  it("carries the +50 bp nodes, no term-funding quotes, the derivation record, its meta and its store hash", () => {
    const doc = store.getDocument<Json>("market", SHOCK_ID).doc;
    expect(doc.tlpNodes.map((n: Json) => [n.tYears, n.spread])).toEqual([
      [0, 0],
      [0.083333, 0.007],
      [0.25, 0.007],
      [0.5, 0.0075],
      [1, 0.0075],
      [2, 0.008],
      [3, 0.0085],
      [5, 0.0095],
      [7, 0.0105],
      [10, 0.0115],
      [20, 0.014],
      [30, 0.015],
    ]);
    expect(doc.termFundingCurveQuotes).toEqual([]);
    expect(doc.derivedFrom).toEqual({
      baseId: BASE_ID,
      baseContentHash: "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651",
      ops: [{ op: "add", value: 50 }],
    });
    const meta = store.getMeta("market", SHOCK_ID) as Json;
    expect(meta.derivedFromMarketId).toBe(BASE_ID);
    expect(meta.seeded).toBe(true);
    expect(meta.label).toBe(SHOCK_LABEL);
    expect(meta.derivedOpCount).toBe(1);
    expect(meta.contentHash).toBe("abc80918c85cd6753cb9e499b47d4768b072b125cafffc56886d5a6253ad5d0a");
  });
});

describe("C: the derive route agrees with the seed", () => {
  it("POST /api/market/derive with the seed request answers 200 unchanged", async () => {
    const r = await api<{ outcome: string }>(t.base, "POST", "/api/market/derive", {
      baseId: BASE_ID,
      ops: FUNDING_SPREAD_SHOCK_OPS,
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
  it("lists the base with no lineage key, the derived market with it, and the curve point counts", async () => {
    const r = await api<Json[]>(t.base, "GET", "/api/catalog/markets");
    expect(r.status).toBe(200);
    // Re-expectation: the listing orders by as-of then id, so the seeded macro-demo-v1 (same as-of)
    // sorts ahead of the base; the base is read by id, and it is the first market that is not derived.
    expect(r.body.map((x) => x.id).slice(0, 2)).toEqual(["macro-demo-v1", BASE_ID]);
    const baseRow = r.body.find((x) => x.id === BASE_ID)!;
    expect(r.body.find((x) => !("derivedFromMarketId" in x))!.id).toBe(BASE_ID);
    expect(Object.keys(baseRow)).not.toContain("derivedFromMarketId");
    const derived = r.body.find((x) => x.id === SHOCK_ID)!;
    expect(derived.derivedFromMarketId).toBe(BASE_ID);
    expect(baseRow.curvePoints).toBe(34);
    expect(derived.curvePoints).toBe(23);
    const snap = await api<Json>(t.base, "GET", `/api/catalog/markets/${SHOCK_ID}`);
    expect(snap.status).toBe(200);
    expect(snap.body.curves["term-funding"]).toEqual([]);
    expect(snap.body.curves.tlp).toHaveLength(12);
  });
});

describe("F and G: seeded end-to-end, base market against shocked market", () => {
  const settle = async (runId: string): Promise<void> => {
    const done = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      120_000,
    );
    expect(done.state).toBe("done");
  };
  const runPlan = async (plan: Json): Promise<Json> => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan });
    expect(r.status).toBe(202);
    await settle(r.body.runId);
    return JSON.parse(readFileSync(join(t.storeRoot, "runs", r.body.runId, "result.json"), "utf8")) as Json;
  };
  /** Run the stored plan on its own market (A) and again with the shocked market (B). */
  const pair = async (id: string): Promise<{ a: Json; b: Json }> => {
    const stored = (await api<Json>(t.base, "GET", `/api/run-plans/${id}`)).body;
    const a = await runPlan(stored);
    const b = await runPlan({
      ...stored,
      planId: `${id}-tlp50`,
      inputs: { ...stored.inputs, marketSnapshot: SHOCK_ID },
    });
    return { a, b };
  };
  const s0 = (r: Json, block: "eve" | "nii"): Json =>
    r[block].byScenario.find((s: Json) => s.scenarioId === "S0")!;
  const cashRow = (r: Json): Json => r.ftp.byFamily.find((f: Json) => f.familyId === "cash")!;

  it("F: EVE and FTP move on plan-synthetic-2500-v1; NII, cash flows and gaps do not", async () => {
    const { a, b } = await pair("plan-synthetic-2500-v1");
    for (const r of [a, b]) {
      expect(r.schemaVersion).toBe("1.13.0");
      expect(r.eve.discountBasis).toBe("all-in");
    }
    // On curve default 2 (was 574278133.2521524); deltas Step 1
    expect(s0(a, "eve").eve).toBe(571500248.9115896);
    // On curve default 2 (was 517300097.20969963); deltas Step 1
    expect(s0(b, "eve").eve).toBe(513876496.63558006);
    // On curve default 2 (was 5455804855.724018); deltas Step 1
    expect(s0(a, "eve").pvAssets).toBe(5451836250.204959);
    // On curve default 2 (was 5317638426.437527); deltas Step 1
    expect(s0(b, "eve").pvAssets).toBe(5313060998.1768055);
    // On curve default 2 (was 4881526722.471866); deltas Step 1
    expect(s0(a, "eve").pvLiabilities).toBe(4880336001.293369);
    // On curve default 2 (was 4800338329.227827); deltas Step 1
    expect(s0(b, "eve").pvLiabilities).toBe(4799184501.541225);
    expect(s0(b, "eve").eve).toBe(s0(b, "eve").pvAssets - s0(b, "eve").pvLiabilities);

    expect(b.nii).toEqual(a.nii);
    expect(b.cashflows).toEqual(a.cashflows);
    expect(b.gap).toEqual(a.gap);
    for (const r of [a, b]) {
      // On curve default 2 (was 19970928.460970417); deltas Step 1
      expect(s0(r, "nii").totalNet12).toBe(20002005.278397486);
      // On curve default 2 (was 36828603.06086734); deltas Step 1
      expect(s0(r, "nii").totalNet24).toBe(37237177.026589304);
    }

    // On curve default 2 (was 0.03687424566038073); deltas Step 1
    expect(cashRow(a).irFtpRate).toBe(0.036841542420644295);
    // On curve default 2 (was 0.03687424566038073); deltas Step 1
    expect(cashRow(b).irFtpRate).toBe(0.036841542420644295);
    // On curve default 2 (was 0.002006337538470476); deltas Step 1
    expect(cashRow(a).lpFtpRate).toBe(0.002006330025652366);
    // On curve default 2 (was 0.00702364460087812); deltas Step 1
    expect(cashRow(b).lpFtpRate).toBe(0.007023618302541022);
    expect(a.ftp.allInBasis).toBe("risk-free-plus-tlp");
    expect(b.ftp.allInBasis).toBe("risk-free-plus-tlp");
    // On curve default 2 (was 0.0004075336466028625); deltas Step 1
    expect(a.ftp.book.bookNimRate).toBe(0.0003643042414312814);
    // On curve default 2 (was 0.00019717458950524645); deltas Step 1
    expect(b.ftp.book.bookNimRate).toBe(0.000152620658810005);
    expect(b.provenance.inputsHash).not.toBe(a.provenance.inputsHash);
  }, 120_000);

  it("G: on the hedged plan pvDerivatives is equal across the pair in every scenario and NII does not move", async () => {
    const { a, b } = await pair("plan-synthetic-2500-hedged-v1");
    expect(a.eve.byScenario.length).toBeGreaterThan(0);
    for (let i = 0; i < a.eve.byScenario.length; i++) {
      expect(b.eve.byScenario[i].pvDerivatives, a.eve.byScenario[i].scenarioId).toBe(a.eve.byScenario[i].pvDerivatives);
    }
    // The seeded swaps are struck at par on the old curve and stay so: off par by a hair on curve default 2 (was 3104.47671032566); deltas Step 1
    expect(s0(a, "eve").pvDerivatives).toBe(7136.825637284055);
    // The seeded swaps are struck at par on the old curve and stay so: off par by a hair on curve default 2 (was 3104.47671032566); deltas Step 1
    expect(s0(b, "eve").pvDerivatives).toBe(7136.825637284055);
    // On curve default 2 (was 574281237.7288628); deltas Step 1
    expect(s0(a, "eve").eve).toBe(571507385.737227);
    // On curve default 2 (was 517303201.68640995); deltas Step 1
    expect(s0(b, "eve").eve).toBe(513883633.46121734);
    expect(b.nii).toEqual(a.nii);
  }, 120_000);
});
