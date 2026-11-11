// apps/server/src/__tests__/seedLcrLiabilities.test.ts
/**
 * Studio Piece 5b-1: the seed writes one liability book (the lcr book's
 * lcr-category positions, nothing else) and one contractual run plan on it.
 * The book is built through the seed's own builders, never hand-written.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateDimensions, type PortfolioSpec, type RunPlan } from "@alm/engine";
import { buildLcrLiabilityPortfolio, buildLcrPortfolio, LIQUIDITY_TAXONOMY, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";

const BOOK = "synthetic-lcr-liabilities-v1";
const PLAN = "plan-synthetic-lcr-liabilities-v1";

describe("buildLcrLiabilityPortfolio", () => {
  const book = buildLcrLiabilityPortfolio();
  const src = buildLcrPortfolio();

  it("keeps exactly the lcr-category positions of the lcr book, unchanged, in book order", () => {
    // Independent loop over the source positions.
    const expected: PortfolioSpec["positions"] = [];
    for (const p of src.positions) {
      if (p.dimensions !== undefined && p.dimensions["lcr-category"] !== undefined) expected.push(p);
    }
    expect(expected.length).toBe(726);
    expect(src.positions.length).toBe(2351);
    expect(book.positions.length).toBe(726);
    expect(book.positions[0]!.id).toBe("dda-0");
    // Two builder calls make two object graphs, so identity cannot hold across them: deep equality, position by position.
    for (let i = 0; i < expected.length; i += 1) expect(book.positions[i]).toEqual(expected[i]);
  });

  it("holds dda 375, mma 300, cds 1, fhlb 25, borrowings 25, in four lcr categories", () => {
    const byFamily: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const p of book.positions) {
      byFamily[p.familyId] = (byFamily[p.familyId] ?? 0) + 1;
      const c = p.dimensions!["lcr-category"] as string;
      byCategory[c] = (byCategory[c] ?? 0) + 1;
    }
    expect(byFamily).toEqual({ dda: 375, mma: 300, cds: 1, fhlb: 25, borrowings: 25 });
    expect(byCategory).toEqual({ "retail-stable": 376, "retail-other": 300, "secured-gse": 25, "wholesale-financial": 25 });
  });

  it("carries the id, label, taxonomy, chart of accounts and as-of date as decided", () => {
    expect(book.id).toBe("synthetic-lcr-liabilities-v1");
    expect(book.label).toBe("Synthetic liability book (726 LCR-tagged liability positions of synthetic-2500-lcr-v1, seeded)");
    expect(book.taxonomy).toBe(LIQUIDITY_TAXONOMY);
    expect(book.taxonomy!.id).toBe("liquidity-tags-v1");
    expect(book.coa).toEqual(src.coa);
    expect(book.asOf).toBe(src.asOf);
    expect(validateDimensions(book)).toEqual([]);
  });
});

describe("seeded platform", () => {
  let t: TestPlatform;
  beforeAll(async () => {
    t = await bootTestPlatform();
    await seedStore(new FileStore(t.storeRoot), repoRoot());
  });
  afterAll(() => t.close());

  const TERMINAL = ["done", "error", "cancelled", "interrupted"];

  it("lists the book as seeded with 726 positions", async () => {
    const list = await api<Array<{ id: string; positionCount: number }>>(t.base, "GET", "/api/portfolios");
    const row = list.body.find((r) => r.id === BOOK);
    expect(row).toBeDefined();
    expect(row!.positionCount).toBe(726);
    // The portfolios listing does not serve the seeded flag; the stored meta does.
    expect(new FileStore(t.storeRoot).getMeta("portfolios", BOOK)?.seeded).toBe(true);
    const full = await api<PortfolioSpec>(t.base, "GET", `/api/portfolios/${BOOK}`);
    expect(full.body.positions).toHaveLength(726);
  });

  it("stores the plan: vanilla contractual graph on the book, no views, no taxonomy field", async () => {
    const plan = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
    const vanilla = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1")).body;
    expect(plan.label).toBe("Synthetic liability book, contractual only, regulatory grid");
    expect(plan.inputs).toEqual({
      marketSnapshot: "market-public-2026-03-31",
      positionBook: "synthetic-lcr-liabilities-v1",
      routingPolicy: "model-map-default-v1",
      assumptionSets: ["vanilla-empty-v1"],
    });
    expect(Object.keys(plan.inputs)).toEqual(["marketSnapshot", "positionBook", "routingPolicy", "assumptionSets"]);
    expect("views" in plan).toBe(false);
    expect("dimensionTaxonomy" in plan.inputs).toBe(false);
    expect(plan.stages).toEqual(vanilla.stages);
    expect(plan.scenarios).toEqual(vanilla.scenarios);
    expect(plan.reports).toEqual(vanilla.reports);
    expect(plan.validationRules).toEqual(vanilla.validationRules);
  });

  it("validates clean", async () => {
    const plan = (await api(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
    const r = await api<{
      type: { failures: unknown[] };
      routing: { failures: unknown[] };
      compile: { passed: boolean };
      notImplemented: unknown[];
    }>(t.base, "POST", "/api/plans/validate", { plan });
    expect(r.status).toBe(200);
    expect(r.body.compile).toEqual({ passed: true });
    expect(r.body.type.failures).toEqual([]);
    expect(r.body.routing.failures).toEqual([]);
    expect(r.body.notImplemented).toEqual([]);
  });

  it("applies liquidity-funding-demo-v1 to the book with no untagged position", async () => {
    const r = await api<Record<string, unknown>>(t.base, "POST", "/api/hierarchies/liquidity-funding-demo-v1/apply", { bookId: BOOK });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({
      id: "synthetic-lcr-liabilities-v1--liquidity-funding-demo-v1",
      taxonomyId: "liquidity-tags-v1--liquidity-funding-demo-v1",
      positionCount: 726,
      untaggedPositionIds: [],
      tags: ["liquidity-funding-demo-v1.funding", "liquidity-funding-demo-v1.bucket"],
    });
  });

  it("runs the plan to done", async () => {
    const plan = (await api(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
    const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan });
    expect(r.status).toBe(202);
    const st = await waitFor(
      () => api<{ state: string }>(t.base, "GET", "/api/runs/" + r.body.runId).then((x) => x.body),
      (s) => TERMINAL.includes(s.state),
      300_000,
    );
    expect(st.state).toBe("done");
  }, 320_000);
});
