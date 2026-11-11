/**
 * The seed writes the ILLUSTRATIVE liquidity stress set and its
 * slate. The four stress fields (closureSteady, closureInitial, maxRateDecay,
 * maxRateGrowth) are RESTATED here from the spec, not read from the builder,
 * so a drift in them fails this file; the rest of the params is the kernel's
 * `NMD_DEFAULTS`, which both the builder and this test spread.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NMD_DEFAULTS } from "@alm/kernel";
import type { AssumptionSet, Scenario } from "@alm/engine";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";

let storeRoot: string;
let store: FileStore;

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-seed-liq-"));
  store = new FileStore(storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);

afterAll(() => {
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking; the OS temp cleaner owns the leftovers.
  }
});

function stressed(percentPerMonth: number) {
  return { ...NMD_DEFAULTS, closureSteady: percentPerMonth, closureInitial: percentPerMonth, maxRateDecay: 0, maxRateGrowth: 0 };
}

describe("seeded liquidity stress", () => {
  it("writes the set with exactly the two deposit decay bindings", () => {
    expect(SEED_IDS.liquidityAssumptions).toBe("liquidity-stress-demo-v1");
    const set = store.getDocument<AssumptionSet>("assumption-sets", "liquidity-stress-demo-v1").doc;
    expect(set.label).toMatch(/ILLUSTRATIVE/);
    expect(set.label).toMatch(/NOT calibrated/);
    expect(set.bindings.map((b) => ({ familyId: b.familyId, overlay: b.overlay, modelVersion: b.modelVersion }))).toEqual([
      { familyId: "dda", overlay: { kind: "nmd-decay", params: stressed(5) }, modelVersion: "kernel-nmd-decay-1" },
      { familyId: "mma", overlay: { kind: "nmd-decay", params: stressed(10) }, modelVersion: "kernel-nmd-decay-1" },
    ]);
    expect(typeof set.contentHash).toBe("string");
  });

  it("writes the slate: three scenarios on the set, static mode", () => {
    expect(SEED_IDS.liquiditySlate).toBe("liquidity-grid-stress");
    const slate = store.getDocument<{ id: string; label: string; scenarios: Scenario[] }>(
      "scenario-slates",
      "liquidity-grid-stress",
    ).doc;
    expect(slate.scenarios).toEqual([
      { id: "LIQ-S0", label: "Liquidity stress, base rates", rateSpec: { kind: "base" }, assumptionSetId: "liquidity-stress-demo-v1", newBusiness: { mode: "static", rules: [] } },
      { id: "LIQ-S200", label: "Liquidity stress, +200bp", rateSpec: { kind: "parallel", shockBp: 200 }, assumptionSetId: "liquidity-stress-demo-v1", newBusiness: { mode: "static", rules: [] } },
      { id: "LIQ-S-200", label: "Liquidity stress, -200bp", rateSpec: { kind: "parallel", shockBp: -200 }, assumptionSetId: "liquidity-stress-demo-v1", newBusiness: { mode: "static", rules: [] } },
    ]);
  });

  it("is idempotent: a second seed writes nothing new", async () => {
    const second = await seedStore(store, repoRoot());
    expect(second.written).toEqual([]);
  });
});
