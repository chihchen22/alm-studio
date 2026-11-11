/**
 * Piece 7b (slice 1 review finding): GET /api/assumption-sets carries a set's
 * macroBindings, so the Macro factors readers card can name the series each
 * stored set maps. An unmapped row carries no key. Runs on a scratch store
 * seeded by the real seedStore(); expected values restated here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet } from "@alm/engine";
import { buildDemoAssumptions } from "@alm/data/src/demo/request";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
const MB = [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }];
interface Row { id: string; macroBindings?: unknown }

describe("assumption-set listing and macroBindings", () => {
  it("a stored mapped set lists its mapping; the seeded demo set lists none", async () => {
    const demo = buildDemoAssumptions();
    const mapped: AssumptionSet = {
      ...demo, id: "housing-list-test", label: "housing list test",
      bindings: demo.bindings.map((b) => (b.familyId === "mbs" && b.overlay.kind === "prepay" ? { ...b, overlay: { ...b.overlay, housing: { ...H } } } : b)),
      macroBindings: MB as AssumptionSet["macroBindings"],
    };
    const posted = await api<unknown>(t.base, "POST", "/api/assumption-sets", mapped);
    expect(posted.status).toBe(201);
    const rows = (await api<Row[]>(t.base, "GET", "/api/assumption-sets")).body;
    expect(rows.find((r) => r.id === "housing-list-test")!.macroBindings).toEqual([{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "mbs" }]);
    expect("macroBindings" in rows.find((r) => r.id === "demo-behavioral-v1")!).toBe(false);
  });
});
