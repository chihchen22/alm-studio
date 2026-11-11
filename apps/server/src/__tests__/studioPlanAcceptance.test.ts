// apps/server/src/__tests__/studioPlanAcceptance.test.ts
/**
 * Studio S2 acceptance (spec 2026-09-25-studio-s2-design.md Section 6).
 * Item 2: the three live edits on the seeded synthetic plan produce the
 * structured fields the canvas paints from. Item 3: a plan that went through
 * the store runs the same as the plan posted directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

interface Reply {
  type: { failures: Array<{ rule: string; stageId: string | null }> };
  routing: { failures: unknown[] };
  compile: { passed: boolean; error?: string };
  notImplemented?: Array<{ layer: string }>;
  runLog?: Array<{ t: string; ids?: Record<string, string> }>;
}
type Stage = { id: string; component: string; dependsOn?: string[] };
type Plan = { planId: string; stages: Stage[] };

const synthetic = async () => (await api<Plan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
const validate = async (plan: Plan) => (await api<Reply>(t.base, "POST", "/api/plans/validate", { plan })).body;
const stage = (p: Plan, id: string) => p.stages.find((s) => s.id === id)!;

describe("the gate demo on plan-synthetic-2500-v1", () => {
  it("removing the st-term wire into st-cashflow names st-cashflow under T1", async () => {
    const p = await synthetic();
    stage(p, "st-cashflow").dependsOn = stage(p, "st-cashflow").dependsOn!.filter((d) => d !== "st-term");
    const r = await validate(p);
    expect(r.type.failures).toContainEqual(expect.objectContaining({ rule: "T1", stageId: "st-cashflow" }));
  });

  it("swapping st-ftp to alm-ftp compiles and tags st-ftp not implemented", async () => {
    const p = await synthetic();
    stage(p, "st-ftp").component = "alm-ftp";
    const r = await validate(p);
    expect(r.compile.passed).toBe(true);
    expect(r.notImplemented!.map((n) => n.layer)).toContain("plan.stage.st-ftp");
  });

  it("swapping st-decay to alm-competing-risks-prepay is a plan-wide refusal with no stage id", async () => {
    const p = await synthetic();
    stage(p, "st-decay").component = "alm-competing-risks-prepay";
    const r = await validate(p);
    expect(r.compile).toMatchObject({ passed: false, error: "UnlicensedBindingError" });
    expect((r.runLog ?? []).filter((e) => e.t === "refuse" && e.ids?.stageId !== undefined)).toEqual([]);
  });
});

describe("a stored plan runs the same as the plan posted directly", () => {
  it("same planHash, deep-equal eve and nii", async () => {
    const original = (await api<Plan>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1")).body;
    const plan = { ...original, planId: "plan-vanilla-book-v1-parity" };
    expect((await api(t.base, "POST", "/api/run-plans", { plan })).status).toBe(201);
    const stored = (await api<Plan>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1-parity")).body;

    const run = async (p: Plan, label: string) => {
      const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: p, label });
      expect(r.status).toBe(202);
      const done = await waitFor(
        () => api<{ state: string }>(t.base, "GET", `/api/runs/${r.body.runId}`).then((x) => x.body),
        (s) => s.state === "done" || s.state === "error",
        90_000,
      );
      expect(done.state).toBe("done");
      return r.body.runId;
    };
    const a = await run(plan, "direct");
    const b = await run(stored, "through the store");

    // GET /api/runs/:id does not carry the plan identity, so the hash is read
    // from the stored request (the path planRoutes.test.ts reads).
    const hash = (id: string): unknown =>
      JSON.parse(readFileSync(join(t.storeRoot, "runs", id, "request.json"), "utf8")).request?.plan?.planHash;
    const section = async (id: string, s: string) => {
      const r = await api(t.base, "GET", `/api/runs/${id}/result/${s}`);
      expect(r.status).toBe(200);
      return r.body;
    };
    expect(await section(a, "eve")).toEqual(await section(b, "eve"));
    expect(await section(a, "nii")).toEqual(await section(b, "nii"));
    const ha = hash(a);
    const hb = hash(b);
    expect(typeof ha).toBe("string");
    expect((ha as string).length).toBeGreaterThan(0);
    expect(typeof hb).toBe("string");
    expect(hb).toBe(ha);
  }, 240_000);
});
