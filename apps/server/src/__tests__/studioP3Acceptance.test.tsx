// apps/server/src/__tests__/studioP3Acceptance.test.tsx
/**
 * ALM Studio Piece 3 acceptance on a freshly seeded test platform. Item 1 on the seeded market: a
 * parallel 300 bp preview moves every node by 300 bp. Item 6: a twist and a
 * tenor-knot shock built with the Studio form model, added to the seeded
 * vanilla plan with the Studio edit, checked, saved under a new id and run; the
 * run's EVE lists both, and the stored rate document's curve for each equals
 * the preview's shocked nodes, so the preview shows the curve the run ran on.
 * Expected values and field paths are restated here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateDocument, RunPlan, RunResult, ScenarioLibrary } from "@alm/engine";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { blankForm, checkForm, libraryIds, takenIds, type ShockForm } from "../../../studio/src/scenarios/shockForm";
import { addInlineScenario } from "../../../studio/src/scenarios/scenarioEdits";

let t: TestPlatform;
/** The shipped scenario libraries, read once, as the builder reads them. */
let libraries: ScenarioLibrary[];
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  const lib = await api<ScenarioLibrary[]>(t.base, "GET", "/api/plans/library");
  expect(lib.status).toBe(200);
  libraries = lib.body;
});
afterAll(() => t.close());

const MARKET = "market-public-2026-03-31";
const PLAN = "plan-vanilla-book-v1";
const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), 600_000);

type Nodes = { t: number[]; z: number[]; df: number[] };
type Preview = { base: Nodes; shocked: Nodes; shiftBp: number[] };
async function preview(rateSpec: unknown): Promise<Preview> {
  const r = await api<Preview>(t.base, "POST", "/api/scenarios/preview", { marketSnapshot: MARKET, rateSpec });
  expect(r.status).toBe(200);
  return r.body;
}

/** A form built with the Studio model and added with the Studio edit; a form the model refuses fails the test with its errors. */
function build(plan: RunPlan, over: Partial<ShockForm>): RunPlan {
  const c = checkForm({ ...blankForm(), ...over }, takenIds(plan, { kind: "new" }), libraryIds(libraries));
  if (!c.ok) throw new Error(JSON.stringify(c.errors));
  return addInlineScenario(plan, c.label === undefined ? { id: c.id, rateSpec: c.rateSpec } : { id: c.id, label: c.label, rateSpec: c.rateSpec });
}

describe("ALM Studio P3 acceptance", () => {
  it("item 1: a parallel 300 bp preview on the seeded market moves every node by 300 bp", async () => {
    const p = await preview({ kind: "parallel", shockBp: 300 });
    expect(p.shiftBp).toHaveLength(p.base.t.length);
    for (const s of p.shiftBp) expect(Math.abs(s - 300)).toBeLessThanOrEqual(1e-9);
    p.base.z.forEach((z, i) => expect(Math.abs(p.shocked.z[i]! - (z + 0.03)), `node ${i}`).toBeLessThanOrEqual(1e-12));
  });

  it("item 6: two built shocks run, the EVE lists them, and the stored curves equal the previews", async () => {
    const stored = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
    let plan: RunPlan = { ...stored, planId: "plan-vanilla-p3-accept", label: "P3 acceptance" };
    plan = build(plan, { shape: "twist", twist: { shortBp: "-50", pivotYears: "2", longBp: "75" }, id: "TW-50-75", label: "Twist -50 at 0y, +75 long, pivot 2y" });
    plan = build(plan, { shape: "custom", knots: [{ key: 0, tenorYears: "1", shockBp: "25" }, { key: 1, tenorYears: "5", shockBp: "50" }, { key: 2, tenorYears: "10", shockBp: "-25" }], nextKey: 3, id: "KN-1-5-10" });

    // Restated: the two specs the form must produce, as the plan must store them.
    const twist = { kind: "twist", shortBp: -50, longBp: 75, pivotYears: 2 };
    const knots = { kind: "custom", shocks: [{ tenorYears: 1, shockBp: 25 }, { tenorYears: 5, shockBp: 50 }, { tenorYears: 10, shockBp: -25 }] };
    expect(plan.scenarios.slice(-2)).toEqual([
      { id: "TW-50-75", label: "Twist -50 at 0y, +75 long, pivot 2y", rateSpec: twist },
      { id: "KN-1-5-10", rateSpec: knots },
    ]);

    const v = await api<{ compile: { passed: boolean } }>(t.base, "POST", "/api/plans/validate", { plan });
    expect(v.body.compile).toMatchObject({ passed: true });
    expect((await api(t.base, "POST", "/api/run-plans", { plan })).status).toBe(201);

    const run = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label: "p3 acceptance" });
    expect(run.status).toBe(202);
    expect((await finished(run.body.runId)).state).toBe("done");

    const result = (await api<RunResult>(t.base, "GET", `/api/runs/${run.body.runId}/result`)).body;
    const eveIds = result.eve.byScenario.map((s) => s.scenarioId);
    expect(eveIds).toContain("TW-50-75");
    expect(eveIds).toContain("KN-1-5-10");

    const rates = (await api<RateDocument>(t.base, "GET", `/api/runs/${run.body.runId}/rates`)).body;
    for (const [id, spec] of [["TW-50-75", twist], ["KN-1-5-10", knots]] as const) {
      const want = (await preview(spec)).shocked;
      const got = rates.scenarios.find((s) => s.scenarioId === id)!.curve;
      expect(got.t, id).toEqual(want.t);
      got.z.forEach((z, i) => expect(Math.abs(z - want.z[i]!), `${id} node ${i}`).toBeLessThanOrEqual(1e-12));
    }
  }, 700_000);
});
