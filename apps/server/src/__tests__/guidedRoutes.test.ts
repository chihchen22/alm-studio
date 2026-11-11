/**
 * The guided Analysis path's reads: the example books, the two position templates,
 * the published behavioral defaults and their preview curves.
 *
 * Expected values are worked by hand from the file contents and the kernel's documented formulas, never read back
 * from the route under test: the CSV template's totals are its typed notionals summed by side, the mortgage default
 * is the kernel's published parameter list restated here, the CPR at the S-curve's inflection is
 * minCpr + (maxCpr - minCpr) / 2, and the beta at a zero rate is betaMin + (betaMax - betaMin) / (1 + exp(k * m)).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../config";
import { planSeedDocuments } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const plan = await planSeedDocuments(repoRoot());
  // The example bank's chart beside the demo chart; the v2 CSV template is written against it.
  for (const id of ["demo-coa-v1", "mid-size-bank-coa-v1"]) {
    const coa = plan.find((d) => d.collection === "coa" && d.id === id);
    if (coa === undefined) throw new Error(`the demo plan carries no coa/${id}`);
    tp.platform.context.store.putDocument("coa", coa.id, coa.doc, coa.meta);
  }
}, 120_000);

afterAll(async () => {
  await tp.close();
});

describe("example books", () => {
  it("lists the example book with its id, as-of date and 11 positions", async () => {
    const r = await api<Array<{ id: string; asOf: string; positionCount: number }>>(tp.base, "GET", "/api/guided/examples");
    expect(r.status).toBe(200);
    const row = r.body.find((x) => x.id === "example-book-v1");
    expect(row).toMatchObject({ id: "example-book-v1", asOf: "2026-03-31", positionCount: 11 });
  });
  it("serves one book as the file holds it, and 404s an unknown id", async () => {
    const r = await api<{ id: string; positions: unknown[] }>(tp.base, "GET", "/api/guided/examples/example-book-v1");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(JSON.parse(readFileSync(join(repoRoot(), "examples", "example-book-v1.json"), "utf8")));
    expect((await api(tp.base, "GET", "/api/guided/examples/no-such-book")).status).toBe(404);
    expect((await api(tp.base, "GET", "/api/guided/examples/positions-template-v1")).status).toBe(404);
  });
  it("Studio slice S3a-1: lists the examples in file order, only the bank with a finished analysis, and 404s an analysis the small book lacks", async () => {
    const r = await api<Array<{ id: string; positionCount: number; analysis: boolean }>>(tp.base, "GET", "/api/guided/examples");
    // Studio slice S3c-1 adds the deposit desk, which ships demos and no finished analysis.
    expect(r.body.map((x) => [x.id, x.positionCount, x.analysis])).toEqual([["example-book-v1", 11, false], ["mid-size-bank-v1", 29, true], ["quillfield-deposit-desk-v1", 3, false]]);
    expect((await api(tp.base, "GET", "/api/guided/examples/example-book-v1/analysis")).status).toBe(404);
    const a = await api<{ bookId: string; nmdWarmup: { kind: string; series: { valuesPct: number[] } } }>(tp.base, "GET", "/api/guided/examples/mid-size-bank-v1/analysis");
    expect(a.body.bookId).toBe("mid-size-bank-v1");
    // The history is the series file's values, as the file holds them.
    const file = JSON.parse(readFileSync(join(repoRoot(), "examples", "sofr-monthly-v1.json"), "utf8")) as { valuesPct: number[] };
    expect(a.body.nmdWarmup.series.valuesPct).toEqual(file.valuesPct);
  });
});

describe("position templates", () => {
  it("the CSV template (v2, Studio slice S3a-1) downloads and imports on the CSV path against the example bank's stored chart with no error", async () => {
    const dl = await api(tp.base, "GET", "/api/guided/templates/positions.csv");
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toMatch(/text\/csv/);
    expect(dl.headers.get("content-disposition")).toMatch(/positions-template-v2\.csv/);
    const imp = await api<{ positionCount: number; id: string }>(
      tp.base, "POST", "/api/portfolios/import?format=csv&coaId=mid-size-bank-coa-v1&label=Template&portfolioId=template-check&asOf=2026-03-31",
      dl.text, { "content-type": "text/csv" },
    );
    expect(imp.status, imp.text).toBe(201);
    // 14 rows, the three cd rows one cohort book: 12 positions.
    expect(imp.body.positionCount).toBe(12);
    const list = await api<Array<{ id: string; intakeStats?: { assets: number; liabilities: number; equity: number } }>>(tp.base, "GET", "/api/portfolios");
    const stats = list.body.find((p) => p.id === "template-check")!.intakeStats!;
    // By hand: assets 40 + 10 (premises, held at book) + 30 + 40 + 60 + 110 = 290 million (the 50 million undrawn line is
    // off the balance sheet); liabilities 90 + 100 + (20 + 30 + 10) + 10 = 260 million (the 25 million swap is in neither);
    // equity +30 million.
    expect(stats.assets).toBe(290_000_000);
    expect(stats.liabilities).toBe(260_000_000);
    expect(stats.equity).toBe(30_000_000);
    expect(Math.sign(stats.equity)).toBe(1);
  });
  it("the v1 CSV template still imports against demo-coa-v1, as before", async () => {
    const text = readFileSync(join(repoRoot(), "examples", "positions-template-v1.csv"), "utf8");
    const imp = await api<{ positionCount: number }>(tp.base, "POST", "/api/portfolios/import?format=csv&coaId=demo-coa-v1&label=Template&portfolioId=template-v1-check&asOf=2026-03-31", text, { "content-type": "text/csv" });
    expect(imp.status, imp.text).toBe(201);
    expect(imp.body.positionCount).toBe(8);
  });
  it("the JSON template is the example bank, byte for byte, as a download", async () => {
    const dl = await api(tp.base, "GET", "/api/guided/templates/positions.json");
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-disposition")).toMatch(/mid-size-bank-v1\.json/);
    expect(dl.text).toBe(readFileSync(join(repoRoot(), "examples", "mid-size-bank-v1.json"), "utf8"));
  });
});

describe("published behavioral defaults", () => {
  it("Studio slice S3a-1: the beta S-curve row says it is an illustrative textbook default, not fitted to any data; the others say default, not fitted", async () => {
    const r = await api<{ models: Array<{ key: string; badge: string; source: string }> }>(tp.base, "GET", "/api/guided/behavior-models");
    expect(r.body.models.map((m) => [m.key, m.badge])).toEqual([
      ["prepayment/mortgage", "default, not fitted"],
      ["decay/nmd", "default, not fitted"],
      ["decay/nmd-b", "default, not fitted"],
      ["repricing/nmd-b", "illustrative textbook default, not fitted to any data"],
    ]);
    expect(r.body.models[3]!.source).toMatch(/round illustrative textbook values, not fitted to any data/);
    expect(r.body.models[3]!.source).not.toMatch(/SSRN|in-sample|estimate/);
  });
  it("lists four models, each for the instrument types its default is published for", async () => {
    const r = await api<{ models: Array<{ key: string; role: string; instrumentTypes: string[]; modelVersion: string; overlay: { kind: string; model?: string; params: Record<string, unknown> } }> }>(
      tp.base, "GET", "/api/guided/behavior-models",
    );
    expect(r.status).toBe(200);
    expect(r.body.models.map((m) => [m.key, m.role, m.instrumentTypes.join(","), m.overlay.kind])).toEqual([
      ["prepayment/mortgage", "prepayment", "mortgage", "prepay"],
      ["decay/nmd", "decay", "nmd", "nmd-decay"],
      ["decay/nmd-b", "decay", "nmd-b", "nmd-decay"],
      ["repricing/nmd-b", "repricing", "nmd-b", "deposit-beta"],
    ]);
    expect(new Set(r.body.models.map((m) => m.modelVersion))).toEqual(new Set(["published-default-v1"]));
    // The kernel's published mortgage defaults, restated by hand.
    expect(r.body.models[0]!.overlay).toEqual({
      kind: "prepay",
      model: "four-factor-cpr",
      params: { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2.0, maxCpr: 65.0, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 },
    });
    // The kernel's published beta S-curve, restated by hand.
    expect(r.body.models[3]!.overlay.params).toEqual({ betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1.0 });
    // The interest-bearing deposit's decay is its own published set, not the non-interest one (one-sided: no inflow).
    expect(r.body.models[2]!.overlay.params.maxRateGrowth).toBe(0);
    expect(r.body.models[1]!.overlay.params.maxRateGrowth).toBe(-1);
  });
});

describe("behavior preview", () => {
  const prepay = { kind: "prepay", model: "four-factor-cpr", params: { secSpread: 120, primSpread: 130, wac: 6.5, minCpr: 2, maxCpr: 65, steepness: 2.5, inflection: 50, seasoningRamp: 30, seasonalityAmp: 20, burnoutDecay: 0.1 } };
  it("draws CPR by incentive from -300 to +400 bp, at the midpoint of the S-curve at its inflection", async () => {
    const r = await api<{ xUnit: string; points: Array<[number, number]> }>(tp.base, "POST", "/api/guided/behavior-preview", { overlay: prepay });
    expect(r.status).toBe(200);
    expect(r.body.xUnit).toBe("bp");
    expect(r.body.points.length).toBe(71);
    expect(r.body.points[0]![0]).toBe(-300);
    expect(r.body.points[70]![0]).toBe(400);
    const at50 = r.body.points.find((p) => p[0] === 50)!;
    expect(at50[1]).toBeCloseTo(2 + (65 - 2) / 2, 12);
  });
  it("draws beta by rate, at a zero rate betaMin + (betaMax - betaMin) / (1 + exp(k m))", async () => {
    const overlay = { kind: "deposit-beta", params: { betaMin: 0.45, betaMax: 0.8, k: 0.55, m: 4.0, lambda: 1 } };
    const r = await api<{ points: Array<[number, number]> }>(tp.base, "POST", "/api/guided/behavior-preview", { overlay });
    expect(r.status).toBe(200);
    expect(r.body.points.length).toBe(33);
    expect(r.body.points[0]![1]).toBeCloseTo(0.45 + 0.35 / (1 + Math.exp(0.55 * 4.0)), 12);
    expect(r.body.points[32]![0]).toBe(8);
  });
  it("draws the share of balance left by month, starting at 100 percent", async () => {
    const models = await api<{ models: Array<{ overlay: unknown }> }>(tp.base, "GET", "/api/guided/behavior-models");
    const r = await api<{ points: Array<[number, number]>; xUnit: string }>(tp.base, "POST", "/api/guided/behavior-preview", { overlay: models.body.models[1]!.overlay, ratePct: 4 });
    expect(r.status, r.text).toBe(200);
    expect(r.body.xUnit).toBe("month");
    expect(r.body.points.length).toBe(121);
    expect(r.body.points[0]).toEqual([0, 100]);
    const last = r.body.points[120]![1];
    expect(last).toBeGreaterThan(0);
    // By the kernel's documented decay: month 1 closes at least closureInitial (2 percent of the balance; the rate
    // incentive is floored at zero), so at most 98 percent is left; and a balance only ever decays, never grows.
    expect(r.body.points[1]![1]).toBeLessThanOrEqual(98 + 1e-9);
    for (let m = 1; m <= 120; m++) expect(r.body.points[m]![1]).toBeLessThanOrEqual(r.body.points[m - 1]![1] + 1e-9);
  });
  it("refuses a model it does not draw and values the schema refuses, in words", async () => {
    const cd = await api<{ error: { message: string } }>(tp.base, "POST", "/api/guided/behavior-preview", { overlay: { kind: "cd-rollover", renewalProbability: 0.5, offeredSpreadBp: 10, termMonths: 12 } });
    expect(cd.status).toBe(422);
    expect(cd.body.error.message).toMatch(/no preview for a cd-rollover overlay/);
    const bad = await api<{ error: { message: string } }>(tp.base, "POST", "/api/guided/behavior-preview", { overlay: { ...prepay, params: { ...prepay.params, steepness: "x" } } });
    expect(bad.status).toBe(422);
    expect((await api(tp.base, "POST", "/api/guided/behavior-preview", { nothing: true })).status).toBe(400);
  });
});
