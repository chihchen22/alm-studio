// apps/server/src/__tests__/seedHousing.test.ts
/**
 * The two housing demonstration sets and the three
 * plans on macro-demo-v1, proven on a scratch store seeded by the real
 * seedStore(). Section A's hashes were measured on unmodified source and are
 * never re-pinned: the sets and plans are additions, and no existing seeded
 * document changes. market/macro-demo-v1 and the seven assumption-set rows
 * were measured on the unmodified code before the slice 4 edits; the rest are
 * the seedMacroFactors.test.ts literals (the unmodified code).
 * OSS slice S1 re-pinned the demo run-plan literals once: the demo routing policy's id is now
 * model-map-default-v1; with that id read back as the old one every re-pinned document hashes to its measured
 * literal.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, RunPlan } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform; let store: FileStore;
beforeAll(async () => { t = await bootTestPlatform(); store = new FileStore(t.storeRoot); await seedStore(store, repoRoot()); }, 300_000);
afterAll(() => t.close());

describe("A. no existing seeded document changed (measured on unmodified source; never re-pin)", () => {
  const PINS: Array<[Parameters<FileStore["getMeta"]>[0], string, string]> = [
    ["market", "market-public-2026-03-31", "6d0501f30b0e59a93bb1294e68d5ed6041d473a264d5790e5da1dbdfa3a60731"],
    ["market", "rate-indices-demo-v1", "347674669bbc746208745bf97c683a81c5da643c5adad33d116a7d3238cc2e00"],
    ["market", "tlp-shock-demo-v1", "abc80918c85cd6753cb9e499b47d4768b072b125cafffc56886d5a6253ad5d0a"],
    ["market", "vol-shock-demo-v1", "f9737f2aae0c8b7d9c86dd3fbd49f280019cd47c6011c571bb206c3ff73e95f6"],
    ["market", "macro-demo-v1", "ae5eb8168698198edfafdf940166ae10f93f6cf0f0b4b56af2bd1c1092322b31"],
    ["assumption-sets", "demo-behavioral-v1", "7b65f5629022b720de7a79819718a75545a56d06c5d966f963a2f61a058175a2"],
    ["assumption-sets", "decay-shock-demo-v1", "e56cd4ac7b0db7a50a9e1ebc4e6c7fb5fa4a5cbf1a705abdbaf81dcd485b8f0a"],
    ["assumption-sets", "liquidity-squeeze-demo-v1", "375a5e416377d4aa570729fe9ae238b674c1aea7e01da117bfe3531d0857975e"],
    ["assumption-sets", "liquidity-stress-demo-v1", "0fa826ef1b0fa6da26b6bc87783a027f6a794e8ba7f67446b44f6d3b1e3ef90a"],
    ["assumption-sets", "loan-repricing-demo-v1", "92427c026c7923812e5ef6f353dde04821a07f5846819621eff974e5b5b49b77"],
    ["assumption-sets", "stress-illustrative-v1", "028320264c4809bca785ea578eb479930668f140077d99a67bd0168f8564f200"],
    ["assumption-sets", "vanilla-empty-v1", "08f5b852e66bd0149c33562e1ebea5e4ee9391abf981fbc892129bdad1d5eef2"],
    ["run-plans", "plan-synthetic-2500-v1", "5e2826755621ffc6d9123bc567fded1cbfa09d14d4870cf55a9443c99feafbee"],
    ["run-plans", "plan-synthetic-2500-hedged-v1", "7c652b11735b6880fe79edea963732e4f15a1ea79a21fa088a6eff3d953abab1"],
    ["run-plans", "plan-vanilla-book-v1", "ba2f810982cb33e6f70383fe9de2c1c5b485a430ee4f1b22aaade38968b632d3"],
    ["run-plans", "plan-synthetic-2500-loan-repricing-v1", "199b5e6db5a5892ff6be654db7931a3339f45300111741d39359537a20a45f3d"],
    ["run-plans", "plan-synthetic-lcr-liabilities-v1", "0519ff6678c5e795ff0384406d2d76059fa22a708c5bb3c25d80f5303333b4e5"],
    ["run-plans", "plan-synthetic-2500-indexed-v1", "ef82c01f2c1660b14b8a2098bf2d21427b0d7fd9d2c046d20a5104475310acfc"],
  ];
  for (const [c, id, h] of PINS) it(`${c}/${id}`, () => expect(store.getMeta(c, id).contentHash).toBe(h));
});

describe("B. the housing sets and plans", () => {
  it("the two sets bind, carry two-figure housing values and map both families", async () => {
    // Restated by hand from the parameterization of record.
    const want = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
    for (const [id, series] of [["housing-demo-v1", "hpi-down-30"], ["housing-flat-demo-v1", "hpi-flat"]] as const) {
      const s = store.getDocument<AssumptionSet>("assumption-sets", id).doc;
      expect(s.macroBindings).toEqual([{ seriesId: series, feeder: "prepay-housing", familyId: "mortgages" }, { seriesId: series, feeder: "prepay-housing", familyId: "mbs" }]);
      const carriers = s.bindings.filter((b) => (b.overlay as { housing?: unknown }).housing !== undefined).map((b) => b.familyId);
      expect(carriers).toEqual(["mortgages", "mbs"]);
      for (const b of s.bindings) {
        const h = (b.overlay as { housing?: Record<string, number> }).housing;
        if (h === undefined) continue;
        expect(h).toEqual(want);
        for (const v of Object.values(h)) expect(Number(v.toPrecision(2))).toBe(v);
      }
      // Bound through the engine: the served set carries the engine-filled content hash.
      const served = (await api<AssumptionSet>(t.base, "GET", `/api/assumption-sets/${id}`)).body;
      expect(typeof served.contentHash).toBe("string");
    }
  });
  it("the existing six plans keep their measured hashes and three plans are appended", () => {
    // The six hashes are Section A. listMeta lists by id, not in seed order, so the seed order is read from SEED_IDS.
    expect([...SEED_IDS.runPlans].slice(-3)).toEqual(["plan-synthetic-2500-macro-unmapped-v1", "plan-synthetic-2500-housing-v1", "plan-synthetic-2500-housing-flat-v1"]);
    expect([...SEED_IDS.runPlans].slice(0, 6)).toEqual(["plan-synthetic-2500-v1", "plan-synthetic-2500-hedged-v1", "plan-vanilla-book-v1", "plan-synthetic-2500-loan-repricing-v1", "plan-synthetic-lcr-liabilities-v1", "plan-synthetic-2500-indexed-v1"]);
    expect(store.listMeta("run-plans").map((m) => m.id).sort()).toEqual([...SEED_IDS.runPlans].sort());
  });
  it("the three plans run the synthetic book on macro-demo-v1 under the demo, housing and flat sets", () => {
    const got = ["plan-synthetic-2500-macro-unmapped-v1", "plan-synthetic-2500-housing-v1", "plan-synthetic-2500-housing-flat-v1"].map((id) => {
      const p = store.getDocument<RunPlan>("run-plans", id).doc;
      return [p.planId, p.inputs.marketSnapshot, p.inputs.positionBook, p.inputs.assumptionSets];
    });
    expect(got).toEqual([
      ["plan-synthetic-2500-macro-unmapped-v1", "macro-demo-v1", "synthetic-2500-v1", ["demo-behavioral-v1"]],
      ["plan-synthetic-2500-housing-v1", "macro-demo-v1", "synthetic-2500-v1", ["housing-demo-v1"]],
      ["plan-synthetic-2500-housing-flat-v1", "macro-demo-v1", "synthetic-2500-v1", ["housing-flat-demo-v1"]],
    ]);
  });
});
