// apps/server/src/__tests__/pluginCatalogRoute.test.ts
/**
 * Studio S2: the plugin catalog read and the validate reply's notImplemented.
 * Both are served verbatim; nothing here is computed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CATALOG, COMPONENT_ALIASES } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

interface Reply {
  components: Array<{ id: string; kind: string }>;
  stageKinds: Array<{ id: string }>;
  mounted: Array<{ id: string; aliases: string[]; kind: string | null }>;
}

describe("GET /api/catalog/plugins", () => {
  it("serves the catalog components and stage kinds verbatim", async () => {
    const r = await api<Reply>(t.base, "GET", "/api/catalog/plugins");
    expect(r.status).toBe(200);
    const file = JSON.parse(readFileSync(join(repoRoot(), "docs", "harness", "catalog.json"), "utf8"));
    expect(r.body.components).toEqual(file.components);
    expect(r.body.stageKinds).toEqual(file.stageKinds);
  });

  it("lists every mounted plugin with its aliases and declared kind", async () => {
    const r = await api<Reply>(t.base, "GET", "/api/catalog/plugins");
    expect(r.body.mounted.map((m) => m.id).sort()).toEqual([...BUILTIN_CATALOG.keys()].sort());
    const prepay = r.body.mounted.find((m) => m.id === "engine.behavioral.prepay")!;
    expect(prepay.aliases).toEqual(COMPONENT_ALIASES["engine.behavioral.prepay"]);
    const contractual = r.body.mounted.find((m) => m.id === "engine.contractual")!;
    expect(contractual.kind).toBe("contractual-cashflow");
    expect(contractual.aliases).toEqual([]);
  });
});

describe("POST /api/plans/validate notImplemented", () => {
  it("returns the compiler's tag for a catalog-only stage nothing reads", async () => {
    const plan = {
      schemaVersion: "1.4.0", planId: "PLAN-TAG-1", label: "tag probe", authoredBy: "person", asOf: "2026-03-31",
      grid: { horizonMonths: 360 },
      inputs: { marketSnapshot: SEED_IDS.market, positionBook: SEED_IDS.vanillaPortfolio, routingPolicy: SEED_IDS.routingPolicy, assumptionSets: [SEED_IDS.vanillaAssumptions] },
      stages: [
        { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"], params: { dayCount: "ACT/360" } },
        { id: "st-tlp", component: "alm-tlp-overlay", kind: "curve", consumes: ["ZeroCurve", "MarketSnapshot"], produces: ["FundingCurve"], params: { dayCount: "ACT/360" }, dependsOn: ["st-curve"] },
        { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
        { id: "st-cashflow", component: "engine.contractual", kind: "contractual-cashflow", consumes: ["Position", "RatePath"], produces: ["Cashflow", "RepricingSchedule"], dependsOn: ["st-term"] },
        { id: "st-nii", component: "alm-nii", kind: "metric", consumes: ["Cashflow"], produces: ["NiiResult"], dependsOn: ["st-cashflow"] },
        { id: "st-eve", component: "alm-eve", kind: "metric", consumes: ["Cashflow", "ZeroCurve", "FundingCurve", "Position"], produces: ["EveResult"], dependsOn: ["st-curve", "st-tlp", "st-cashflow"] },
        { id: "st-gap", component: "alm-gap-analytics", kind: "metric", consumes: ["Cashflow", "RepricingSchedule", "Position"], produces: ["GapResult"], dependsOn: ["st-cashflow"] },
        { id: "st-ftp", component: "alm-ftp", kind: "metric", consumes: ["Cashflow", "ZeroCurve"], produces: ["FtpResult"], dependsOn: ["st-cashflow", "st-curve"] },
      ],
      scenarios: [{ ref: "regulatory-grid-v1#S0" }, { ref: "regulatory-grid-v1#S100" }],
      reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii", "eve"] }],
      validationRules: { typeGate: ["T1", "T2", "T3", "T4", "T5"], routingGate: ["R1", "R2", "R3", "R4"] },
    };
    const r = await api<{ compile: { passed: boolean }; notImplemented: Array<{ layer: string; reason: string }> }>(
      t.base, "POST", "/api/plans/validate", { plan },
    );
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(true);
    expect(r.body.notImplemented.map((n) => n.layer)).toContain("plan.stage.st-ftp");
  });
});
