// apps/server/src/__tests__/runPlanStore.test.ts
/**
 * Studio S2: the run-plan store. Append-only; parseRunPlan is the shape gate
 * only, and the stored document is the plan exactly as the request carried it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

/** A vanilla plan whose keys are deliberately NOT in parseRunPlan's order: note sits before inputs. */
function planDoc(planId: string, label = "Store test plan") {
  return {
    schemaVersion: "1.4.0", planId, label, authoredBy: "person", asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    note: "key order test: note before inputs",
    inputs: { marketSnapshot: SEED_IDS.market, positionBook: SEED_IDS.vanillaPortfolio, routingPolicy: SEED_IDS.routingPolicy, assumptionSets: [SEED_IDS.vanillaAssumptions] },
    stages: [
      { id: "st-curve", component: "alm-yield-curve", kind: "curve", consumes: ["MarketSnapshot"], produces: ["ZeroCurve"] },
      { id: "st-term", component: "engine.rate-path", kind: "term-structure", consumes: ["ZeroCurve"], produces: ["RatePath", "DiscountFactorPath"], dependsOn: ["st-curve"] },
    ],
    scenarios: [{ ref: "regulatory-grid-v1#S0" }],
    reports: [{ id: "r-mgmt", view: "managementView", metrics: ["nii"] }],
    validationRules: { typeGate: ["T1"], routingGate: ["R1"] },
  };
}

describe("run-plan store", () => {
  it("stores the plan verbatim with 201, key order kept", async () => {
    const plan = planDoc("store-test-1");
    const r = await api<{ id: string; contentHash: string; label: string; positionBook: string; asOf: string }>(
      t.base, "POST", "/api/run-plans", { plan },
    );
    expect(r.status).toBe(201);
    expect(r.body.id).toBe("store-test-1");
    expect(r.body.positionBook).toBe(SEED_IDS.vanillaPortfolio);
    const bytes = readFileSync(join(t.storeRoot, "run-plans", "store-test-1.json"), "utf8");
    expect(bytes).toBe(`${JSON.stringify(plan, null, 2)}\n`);
  });

  it("answers an identical re-save with 200 and the stored meta", async () => {
    const plan = planDoc("store-test-2");
    const first = await api<{ contentHash: string }>(t.base, "POST", "/api/run-plans", { plan });
    const again = await api<{ contentHash: string }>(t.base, "POST", "/api/run-plans", { plan });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.contentHash).toBe(first.body.contentHash);
  });

  it("refuses changed content under an existing id with 409", async () => {
    await api(t.base, "POST", "/api/run-plans", { plan: planDoc("store-test-3") });
    const r = await api<{ error: { code: string } }>(t.base, "POST", "/api/run-plans", { plan: planDoc("store-test-3", "changed label") });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("conflict");
  });

  it("refuses a malformed plan with 422 and stores nothing", async () => {
    const r = await api<{ error: { code: string } }>(t.base, "POST", "/api/run-plans", { plan: { schemaVersion: "1.4.0", planId: "store-bad" } });
    expect(r.status).toBe(422);
    const read = await api(t.base, "GET", "/api/run-plans/store-bad");
    expect(read.status).toBe(404);
  });

  it("refuses a body without a plan with 422", async () => {
    const r = await api(t.base, "POST", "/api/run-plans", { nope: true });
    expect(r.status).toBe(422);
  });

  it("lists and reads stored plans verbatim; an unknown id is 404", async () => {
    const plan = planDoc("store-test-4");
    await api(t.base, "POST", "/api/run-plans", { plan });
    const list = await api<Array<{ id: string }>>(t.base, "GET", "/api/run-plans");
    expect(list.status).toBe(200);
    expect(list.body.map((m) => m.id)).toContain("store-test-4");
    const read = await api(t.base, "GET", "/api/run-plans/store-test-4");
    expect(read.status).toBe(200);
    // The router's json kind writes JSON.stringify(value) plus a trailing newline.
    expect(Object.keys(JSON.parse(read.text) as object)).toEqual(Object.keys(plan));
    expect(read.text).toBe(`${JSON.stringify(plan)}\n`);
    expect((await api(t.base, "GET", "/api/run-plans/no-such-plan")).status).toBe(404);
  });
});
