/**
 * The seeded decay shock (decay-shock-demo-v1) and its
 * slate. The set is the demo set run through deriveAssumptionSet with three
 * scale ops on dda nmd-decay, so it must be exactly what the derive route
 * writes for the same body (D2), must move only the dda family when run (D4),
 * and must stay current across re-seeds (D6). Everything runs from a scratch
 * store seeded by the real seedStore(). Expected values are restated here, never
 * read back from the seed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

const FIXED_STAMP = "2026-08-02T00:00:00.000Z";
const SET_ID = "decay-shock-demo-v1";
const BASE_ID = "demo-behavioral-v1";
const SLATE_ID = "regulatory-grid-decay-shock";
const LABEL = "Deposit decay +25% on the demo set (demonstration values, NOT calibrated)";
const DDA = { familyId: "dda", kind: "nmd-decay" };
const OPS = [
  { target: DDA, path: "params.closureSteady", op: "scale", value: 1.25 },
  { target: DDA, path: "params.closureInitial", op: "scale", value: 1.25 },
  { target: DDA, path: "params.maxRateDecay", op: "scale", value: 1.25 },
];

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
});
afterAll(() => t.close());

const setDoc = (id: string) => store.getDocument<AssumptionSet>("assumption-sets", id).doc;
const ddaParams = (set: AssumptionSet) => {
  const b = set.bindings.find((x) => x.familyId === "dda")!;
  return (b.overlay as unknown as { params: Record<string, number> }).params;
};

describe("seeded decay shock set", () => {
  it("D1: label, bindings, derivation record and meta are exactly as designed", () => {
    const set = setDoc(SET_ID);
    const demo = setDoc(BASE_ID);
    const demoMeta = store.getMeta("assumption-sets", BASE_ID);
    expect(set.label).toBe(LABEL);
    expect(set.bindings).toHaveLength(4);
    expect(set.derivedFrom!.baseId).toBe(BASE_ID);
    expect(set.derivedFrom!.baseContentHash).toBe(demoMeta.bindingsContentHash);
    expect(set.derivedFrom!.ops).toEqual(OPS);
    const p = ddaParams(set);
    expect(p.closureSteady).toBe(0.9375);
    expect(p.closureInitial).toBe(2.5);
    expect(p.maxRateDecay).toBe(3.75);
    expect(p.maxRateGrowth).toBe(-1);
    for (const i of [0, 1, 3]) expect(set.bindings[i]).toEqual(demo.bindings[i]);
    const meta = store.getMeta("assumption-sets", SET_ID);
    expect(meta.derivedFromSetId).toBe(BASE_ID);
    expect(meta.derivedOpCount).toBe(3);
    expect(meta.seeded).toBe(true);
  });

  it("D2: the derive route answers 200 unchanged for the same base, ops, id and label", async () => {
    const r = await api<{ outcome: string }>(t.base, "POST", "/api/assumption-sets/derive", {
      baseId: BASE_ID,
      ops: OPS,
      id: SET_ID,
      label: LABEL,
    });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe("unchanged");
  });
});

describe("seeded decay shock slate", () => {
  it("D3: five scenarios, each bound to the shock set", () => {
    const slate = store.getDocument<SlateDoc>("scenario-slates", SLATE_ID).doc;
    expect(slate.label).toBe("Regulatory grid (deposit decay shock, demonstration values)");
    expect(slate.scenarios.map((s) => s.id)).toEqual(["S0", "S100", "S-100", "S200", "S-200"]);
    for (const s of slate.scenarios) expect(s.assumptionSetId).toBe(SET_ID);
  });
});

function compose(runId: string, scenarios: Scenario[], sets: AssumptionSet[]): { request: RunRequest; portfolio: PortfolioSpec } {
  const portfolioMeta = store.getMeta("portfolios", "synthetic-2500-v1");
  const request: RunRequest = {
    runId,
    portfolioId: "synthetic-2500-v1",
    marketSnapshot: store.getDocument<MarketSnapshot>("market", "market-public-2026-03-31").doc,
    scenarios,
    assumptionSets: sets,
    grid: { horizonMonths: 360, asOf: portfolioMeta.asOf as string },
    seed: "platform-0",
    timestamps: { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP },
  };
  return { request, portfolio: store.getDocument<PortfolioSpec>("portfolios", "synthetic-2500-v1").doc };
}
const ctx = () => ({ ...resolveDefaultContext(), durationMode: "base-only" as const, shards: "auto" as const });
const baseOf = (slateId: string) =>
  store.getDocument<SlateDoc>("scenario-slates", slateId).doc.scenarios.filter((s) => s.id === "S0");

describe("running the decay shock", () => {
  it("D4: only the dda family moves; every other EVE and NII family row is bit-identical", () => {
    const demo = compose("decay-demo", baseOf("regulatory-grid-demo"), [setDoc(BASE_ID)]);
    const shock = compose("decay-shock", baseOf(SLATE_ID), [setDoc(SET_ID)]);
    const a = buildRunResult(demo.request, demo.portfolio, ctx());
    const b = buildRunResult(shock.request, shock.portfolio, ctx());

    const eveA = a.eve.byScenario.find((s) => s.scenarioId === "S0")!.byFamily;
    const eveB = b.eve.byScenario.find((s) => s.scenarioId === "S0")!.byFamily;
    const niiA = a.nii.byScenario.find((s) => s.scenarioId === "S0")!.byFamily;
    const niiB = b.nii.byScenario.find((s) => s.scenarioId === "S0")!.byFamily;
    expect(eveA.map((f) => f.familyId)).toEqual(eveB.map((f) => f.familyId));
    expect(niiA.map((f) => f.familyId)).toEqual(niiB.map((f) => f.familyId));

    for (let i = 0; i < eveA.length; i++) {
      if (eveA[i].familyId === "dda") continue;
      expect(eveB[i], `eve ${eveA[i].familyId}`).toEqual(eveA[i]);
    }
    for (let i = 0; i < niiA.length; i++) {
      if (niiA[i].familyId === "dda") continue;
      expect(niiB[i], `nii ${niiA[i].familyId}`).toEqual(niiA[i]);
    }
    // The shock's footprint is the dda EVE row. dda is non-interest-bearing, so
    // its NII row is zero under both sets; decay changes the balance, not an
    // interest cost of zero. The NII loop above still pins every other family.
    const ddaEve = (rows: typeof eveA) => rows.find((f) => f.familyId === "dda")!.pv;
    expect(ddaEve(eveB)).not.toBe(ddaEve(eveA));
  });

  it("D5: S0 on the demo set beside S100 on the shock set declines attribution for S100", () => {
    const s0 = baseOf("regulatory-grid-demo")[0];
    const s100 = store.getDocument<SlateDoc>("scenario-slates", SLATE_ID).doc.scenarios.find((s) => s.id === "S100")!;
    const { request, portfolio } = compose("decay-attr", [s0, s100], [setDoc(BASE_ID), setDoc(SET_ID)]);
    const result = buildRunResult(request, portfolio, ctx());
    expect(result.notImplemented.map((n) => n.layer)).toContain("attribution.S100");
  });
});

describe("re-seeding", () => {
  it("D6: a second seed leaves both new documents current", async () => {
    const report = await seedStore(store, repoRoot());
    expect(report.stale).toEqual([]);
    expect(report.written).toEqual([]);
    expect(report.skipped).toContain(`assumption-sets/${SET_ID}`);
    expect(report.skipped).toContain(`scenario-slates/${SLATE_ID}`);
  }, 60_000);
});
