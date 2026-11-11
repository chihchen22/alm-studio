// apps/server/src/__tests__/validatePlanHash.test.ts
/**
 * Studio S3a: POST /api/plans/validate echoes the compiled plan's hash on a
 * successful compile, so the confirm sheet can show it before the run. A
 * refused compile carries none.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseRunPlan, planHash } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

type Stage = { id: string; component: string; dependsOn?: string[] };
type Plan = { planId: string; stages: Stage[] };
interface Reply {
  compile: { passed: boolean; error?: string };
  planHash?: string;
  profileHash?: string;
}

describe("POST /api/plans/validate planHash", () => {
  it("carries the compiled plan's hash on a successful compile", async () => {
    const plan = (await api<Plan>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1")).body;
    const r = await api<Reply>(t.base, "POST", "/api/plans/validate", { plan });
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(true);
    expect(r.body.planHash).toBe(planHash(parseRunPlan(plan)));
    expect(typeof r.body.profileHash).toBe("string");
  });

  it("carries no planHash when the compile refuses", async () => {
    const plan = (await api<Plan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const decay = plan.stages.find((s) => s.id === "st-decay");
    if (decay === undefined) throw new Error("seeded synthetic plan has no st-decay stage");
    decay.component = "alm-competing-risks-prepay";
    const r = await api<Reply>(t.base, "POST", "/api/plans/validate", { plan });
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.error).toBe("UnlicensedBindingError");
    expect("planHash" in r.body).toBe(false);
  });
});
