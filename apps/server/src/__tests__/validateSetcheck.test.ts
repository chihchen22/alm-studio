// apps/server/src/__tests__/validateSetcheck.test.ts
/**
 * Set Check: POST /api/plans/validate takes optional `candidateSets`, unsaved
 * drafts of assumption sets. Each candidate is bound (shape, bounds,
 * duplicates) and stands in for the stored set with the same id while the plan
 * compiles. Nothing is stored. A malformed candidate is the same 422 the Save
 * route answers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet } from "@alm/engine";
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

interface Reply {
  compile: { passed: boolean; detail?: string; error?: string };
  routing: { passed: boolean; failures: Array<{ rule?: string; code?: string; message?: string }> };
}
type Listing = Array<{ id: string; contentHash: string }>;

// The seeded synthetic plan reads the demo set; the plan and set ids are restated here, not imported.
const PLAN = "plan-synthetic-2500-v1";
const SET = "demo-behavioral-v1";

const plan = async () => (await api<unknown>(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
const stored = async () => (await api<AssumptionSet>(t.base, "GET", `/api/assumption-sets/${SET}`)).body;
/** A draft as Studio posts it: the stored set's id, no contentHash (the engine fills it). */
const draftOf = (set: AssumptionSet, bindings: AssumptionSet["bindings"]): AssumptionSet => {
  const { contentHash: _drop, ...rest } = set as AssumptionSet & { contentHash?: string };
  return { ...rest, bindings };
};
const validate = async (candidateSets: unknown) =>
  api<Reply>(t.base, "POST", "/api/plans/validate", { plan: await plan(), candidateSets });

describe("POST /api/plans/validate candidateSets (Set Check)", () => {
  it("passes a draft that only relabels the set", async () => {
    const set = await stored();
    const r = await validate([{ ...draftOf(set, set.bindings), label: "Demo, relabelled" }]);
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(true);
  });

  it("refuses a draft with a binding no stage licenses: UnlicensedBindingError naming the set and the family", async () => {
    const set = await stored();
    const beta = set.bindings.find((b) => b.familyId === "mma" && b.overlay.kind === "deposit-beta");
    if (beta === undefined) throw new Error("seeded demo set has no mma deposit-beta binding");
    // A deposit-beta binding on dda: st-beta selects mma only, so no stage licenses it.
    const r = await validate([draftOf(set, [...set.bindings, { ...beta, familyId: "dda" }])]);
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.error).toBe("UnlicensedBindingError");
    expect(r.body.compile.detail).toContain('"demo-behavioral-v1"');
    expect(r.body.compile.detail).toContain("dda");
  });

  it("refuses a draft that removes the mma beta binding at routing rule R3 on st-beta", async () => {
    const set = await stored();
    const without = set.bindings.filter((b) => !(b.familyId === "mma" && b.overlay.kind === "deposit-beta"));
    expect(without.length).toBe(set.bindings.length - 1);
    const r = await validate([draftOf(set, without)]);
    expect(r.status).toBe(200);
    expect(r.body.compile.passed).toBe(false);
    expect(r.body.compile.error).toBe("PlanRejected");
    expect(r.body.compile.detail).toContain("R3@st-beta");
    expect(r.body.routing.passed).toBe(false);
  });

  it("the same plan with no candidate still passes: the stored set is untouched", async () => {
    const r = await api<Reply>(t.base, "POST", "/api/plans/validate", { plan: await plan() });
    expect(r.body.compile.passed).toBe(true);
  });

  it("stores nothing: the set list and the stored set are the same after every check", async () => {
    const before = (await api<Listing>(t.base, "GET", "/api/assumption-sets")).body;
    const setBefore = await stored();
    const set = await stored();
    await validate([draftOf(set, set.bindings.filter((b) => !(b.familyId === "mma" && b.overlay.kind === "deposit-beta")))]);
    await validate([{ ...draftOf(set, set.bindings), label: "Demo, relabelled" }]);
    expect((await api<Listing>(t.base, "GET", "/api/assumption-sets")).body).toEqual(before);
    expect(await stored()).toEqual(setBefore);
  });

  it("answers a malformed draft with the 422 the Save route gives the same body", async () => {
    const set = await stored();
    const bad = { ...draftOf(set, set.bindings), bindings: "not a list" };
    const r = await validate([bad]);
    expect(r.status).toBe(422);
    const save = await api(t.base, "POST", "/api/assumption-sets", bad);
    expect(save.status).toBe(422);
    expect(r.body).toEqual(save.body);
  });

  it("answers a draft of a set the plan does not read with a 422 naming it, not a pass that checked nothing", async () => {
    const set = await stored();
    const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/plans/validate", {
      plan: await plan(),
      candidateSets: [{ ...draftOf(set, set.bindings), id: "not-read-by-plan" }],
    });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('candidate set \\"not-read-by-plan\\" is not one plan \\"plan-synthetic-2500-v1\\" reads');
  });

  it("answers candidateSets that is not a list with a 422", async () => {
    const r = await validate({ id: SET });
    expect(r.status).toBe(422);
  });
});
