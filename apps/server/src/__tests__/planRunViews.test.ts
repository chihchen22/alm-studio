// apps/server/src/__tests__/planRunViews.test.ts
/**
 * Studio Piece 5b-0: a planned run carries its compiled views into the stored
 * request, so the result's views block groups the run. A run that declares no
 * view stores the same request and computes the same result as before, and
 * POST /api/runs (no plan) never carries views.
 *
 * The NO CHANGE literals below were measured on the unmodified code, BEFORE the
 * run-path change. They are never re-pinned to a post-change value, with one
 * exception: OSS slice S1 gave the demo routing policy a neutral id,
 * which moves each demo plan's hash and the policy's own; the request and result
 * literals of N1 and N2 were re-pinned once.
 */
import { createHash } from "node:crypto";
import { withSourceKernelRef } from "@alm/engine/src/provenance/publicCopy";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticPortfolio, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const readRun = (runId: string, file: "request.json" | "result.json"): Json =>
  JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, file), "utf8")) as Json;

const norm = (stored: Json): string => {
  stored.request.runId = "RUN";
  return sha(JSON.stringify(stored));
};
const normResult = (r: Json): string => {
  // The digests pinned below were taken at schema 1.8.0. The build bumps the envelope to 1.9.0
  // (additive), so the version string is put back before hashing: the pins then prove that no number,
  // key or order moved, and only the string did.
  r.schemaVersion = "1.8.0";
  r.provenance.runId = "RUN";
  r.provenance.timestamps = { startedAt: "", finishedAt: "" };
  // withSourceKernelRef: in a release tree the kernel reference is set to the one the pins were recorded with.
  return sha(JSON.stringify(withSourceKernelRef(r)));
};

const settle = async (runId: string): Promise<void> => {
  const done = await waitFor(
    () => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body),
    (s) => s.state === "done" || s.state === "error",
    120_000,
  );
  expect(done.state).toBe("done");
};

const runPlan = async (plan: unknown): Promise<string> => {
  const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan });
  expect(r.status).toBe(202);
  await settle(r.body.runId);
  return r.body.runId;
};

const storedPlan = async (id: string): Promise<Json> =>
  (await api<Json>(t.base, "GET", `/api/run-plans/${id}`)).body;

const VIEWS = [{ id: "view-1", label: "By side", groupBy: ["side"] }];

const unordered = <T extends { key: Record<string, string> }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => (a.key.side ?? "").localeCompare(b.key.side ?? ""));

describe("views carried (planned run)", () => {
  // Independent restatement from the seeded synthetic book: side of each
  // position's family, from the chart of accounts, counted position by position.
  const book = buildSyntheticPortfolio();
  const sideOf = new Map(book.coa.families.map((f) => [f.id, f.side]));
  const count = { asset: 0, liability: 0 } as Record<string, number>;
  const familiesBySide = { asset: new Set<string>(), liability: new Set<string>() } as Record<string, Set<string>>;
  for (const p of book.positions) {
    const side = sideOf.get(p.familyId)!;
    count[side] = (count[side] ?? 0) + 1;
    familiesBySide[side]!.add(p.familyId);
  }

  it("restates the book: asset 1625 in 6 families, liability 726 in 5", () => {
    expect(count.asset).toBe(1625); // cash 25, investments 100, fixed-loans 375, floating-loans 300, mortgages 750, mbs 75
    expect(count.liability).toBe(726); // dda 375, mma 300, cds 1, fhlb 25, borrowings 25
    expect(familiesBySide.asset!.size).toBe(6);
    expect(familiesBySide.liability!.size).toBe(5);
  });

  let runId = "";
  let planHash = "";
  let plan: Json;

  it("V1: the stored request, planDocument and result all carry the view", async () => {
    plan = { ...(await storedPlan("plan-synthetic-2500-v1")), views: VIEWS };
    const v = await api<{ compile: { passed: boolean }; planHash: string }>(
      t.base,
      "POST",
      "/api/plans/validate",
      { plan },
    );
    expect(v.body.compile.passed).toBe(true);
    planHash = v.body.planHash;
    expect(typeof planHash).toBe("string");

    runId = await runPlan(plan);
    const stored = readRun(runId, "request.json");
    expect(Object.keys(stored.request)).toEqual([
      "runId",
      "portfolioId",
      "marketSnapshot",
      "scenarios",
      "assumptionSets",
      "grid",
      "views",
      "seed",
      "timestamps",
      "plan",
    ]);
    expect(stored.request.views).toEqual(VIEWS);
    expect(stored.planDocument.views).toEqual(VIEWS);

    const result = readRun(runId, "result.json");
    expect(result.schemaVersion).toBe("1.13.0");
    expect(result.provenance.planHash).toBe(planHash);
    expect(result.views).toHaveLength(1);
    expect(result.views[0].viewId).toBe("view-1");
    expect(result.views[0].label).toBe("By side");
    expect(result.views[0].groupBy).toEqual(["side"]);
    const groups = unordered<{ key: Record<string, string>; positionCount: number; cellIds: string[] }>(
      result.views[0].groups,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]!.key).toEqual({ side: "asset" });
    expect(groups[0]!.positionCount).toBe(1625);
    expect(groups[0]!.cellIds).toHaveLength(6);
    expect(groups[1]!.key).toEqual({ side: "liability" });
    expect(groups[1]!.positionCount).toBe(726);
    expect(groups[1]!.cellIds).toHaveLength(5);
  }, 150_000);

  it("V2: the pivot route answers the same groups", async () => {
    const r = await api<{ rows: Array<{ key: Record<string, string>; positionCount: number }> }>(
      t.base,
      "GET",
      `/api/runs/${runId}/pivot?view=view-1&metric=balance&scenarioId=S0`,
    );
    expect(r.status).toBe(200);
    const rows = unordered(r.body.rows).map((x) => ({ key: x.key, positionCount: x.positionCount }));
    expect(rows).toEqual([
      { key: { side: "asset" }, positionCount: 1625 },
      { key: { side: "liability" }, positionCount: 726 },
    ]);
  });
});

describe("no change for a run that declares no views", () => {
  // Literals measured on the unmodified code before the change.
  it("N1: plan-vanilla-book-v1 stores and computes what it did", async () => {
    const runId = await runPlan(await storedPlan("plan-vanilla-book-v1"));
    const stored = readRun(runId, "request.json");
    expect(Object.keys(stored.request)).toEqual([
      "runId",
      "portfolioId",
      "marketSnapshot",
      "scenarios",
      "assumptionSets",
      "grid",
      "seed",
      "timestamps",
      "plan",
    ]);
    expect(norm(stored)).toBe("9e9fb08605a7909865196d948d503e5fac9e062d7c2a7a9ab34aa039c4e37a75");
    const result = readRun(runId, "result.json");
    expect("views" in result).toBe(false);
    // Normalized result digest on curve default 2: numbers and the provenance curve stamp moved, no key or order (was 19a45218f515f129d563560cf5bf1e86d296ae4097cac16cb285193916f2d92c); deltas Step 1
    expect(normResult(result)).toBe("597b21689d7f3a042881037c82f8fd5add05f917c3e444e01073edb3b6eef3b1");
  }, 150_000);

  it("N2: plan-synthetic-2500-v1 stores and computes what it did", async () => {
    const runId = await runPlan(await storedPlan("plan-synthetic-2500-v1"));
    const stored = readRun(runId, "request.json");
    expect("views" in stored.request).toBe(false);
    expect(norm(stored)).toBe("1f2f40615e481be89ab9bda5267ea75b223cd8af6f1a3eee5881df545c4b77d4");
    const result = readRun(runId, "result.json");
    expect("views" in result).toBe(false);
    // Normalized result digest on curve default 2: numbers and the provenance curve stamp moved, no key or order (was 059c8171bf98c16da3ee612a122da46abc83564eb7daa2e1d125f7a00cd28c54); deltas Step 1
    expect(normResult(result)).toBe("00c11a9d960e31975761c2530a730912b8e58e4144fca542775ecf2c23906705");
  }, 150_000);

  const PLAIN = {
    portfolioId: "vanilla-book-v1",
    marketId: "market-public-2026-03-31",
    scenarioSlateId: "regulatory-grid-vanilla",
    assumptionSetIds: ["vanilla-empty-v1"],
  };
  const PLAIN_KEYS = [
    "runId",
    "portfolioId",
    "marketSnapshot",
    "scenarios",
    "assumptionSets",
    "grid",
    "seed",
    "timestamps",
  ];

  it("N3: POST /api/runs on vanilla-book-v1 stores and computes what it did", async () => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", PLAIN);
    expect(r.status).toBe(202);
    await settle(r.body.runId);
    const stored = readRun(r.body.runId, "request.json");
    expect(Object.keys(stored.request)).toEqual(PLAIN_KEYS);
    expect(norm(stored)).toBe("33e4746c1fbd5583b8b8e13da844ecae531ee17b6394257ea795067bdf9f0d2c");
    const result = readRun(r.body.runId, "result.json");
    expect("views" in result).toBe(false);
    // Normalized result digest on curve default 2: numbers and the provenance curve stamp moved, no key or order (was 4970796776f7d1e4179316b772b2629210340f18d99079bdccabc3d1f8a35baf); deltas Step 1
    expect(normResult(result)).toBe("644d0077f3c97013298a6af2a6d861e188b319f7b5f6bb320df3981122840a1c");
  }, 150_000);

  it("N4: a views key in a raw POST /api/runs body is ignored", async () => {
    const r = await api<{ runId: string }>(t.base, "POST", "/api/runs", { ...PLAIN, views: VIEWS });
    expect(r.status).toBe(202);
    await settle(r.body.runId);
    const stored = readRun(r.body.runId, "request.json");
    expect(Object.keys(stored.request)).toEqual(PLAIN_KEYS);
    expect("views" in stored.request).toBe(false);
    expect(norm(stored)).toBe("33e4746c1fbd5583b8b8e13da844ecae531ee17b6394257ea795067bdf9f0d2c");
    const result = readRun(r.body.runId, "result.json");
    expect("views" in result).toBe(false);
    // Normalized result digest on curve default 2: numbers and the provenance curve stamp moved, no key or order (was 4970796776f7d1e4179316b772b2629210340f18d99079bdccabc3d1f8a35baf); deltas Step 1
    expect(normResult(result)).toBe("644d0077f3c97013298a6af2a6d861e188b319f7b5f6bb320df3981122840a1c");
  }, 150_000);
});
