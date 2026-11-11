// apps/server/src/__tests__/studioP5bAcceptance.test.tsx
/**
 * ALM Studio Piece 5b acceptance on a freshly seeded test platform: the Plan
 * page's Book picker and Views card, driven along the author's click path. The
 * Studio model functions build each plan; the real routes validate, store and
 * run it; the stored artifacts and the pivot route answer. Every expected count
 * is restated here with an independent loop over the served book, never read
 * from the code under test.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PivotResult, RunResult } from "@alm/engine";
import { buildDemoTaxonomy, seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { PlanDoc } from "../../../studio/src/plan/planGraph";
import { addView, viewDimensionOptions } from "../../../studio/src/plan/planViews";
import { bookChoices, bookNote, withBook } from "../../../studio/src/plan/planBook";
import { editCount, editsText, nextEditId, planEditSummary, withPlanId } from "../../../studio/src/plan/planEdits";
import { runButton } from "../../../studio/src/pages/plan/PlanPage";
import { ViewsCard } from "../../../studio/src/pages/plan/ViewsCard";
import { PivotTable, viewPick } from "../../../studio/src/pages/results/ViewsTab";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BASE_BOOK = "synthetic-lcr-liabilities-v1";
const PLAN = "plan-synthetic-lcr-liabilities-v1";
const HIER = "liquidity-funding-demo-v1";
const COPY = `${BASE_BOOK}--${HIER}`;
const FUNDING = `${HIER}.funding`;
const BUCKET = `${HIER}.bucket`;
const NO_COPY_NOTE = `No re-tagged copy of ${BASE_BOOK} is stored; apply a hierarchy to it on Hierarchies and mapping to make one.`;

const get = async <T = Json,>(path: string): Promise<T> => (await api<T>(t.base, "GET", path)).body;
const ids = (rows: Array<{ id: string }>): string[] => rows.map((r) => r.id);

interface Validate {
  compile: { passed: boolean; error?: string; detail?: string };
  runLog?: Array<{ t: string; error?: string; ids?: Json }>;
}
const validate = async (plan: PlanDoc): Promise<Validate> => (await api<Validate>(t.base, "POST", "/api/plans/validate", { plan })).body;

const refuseIds = (v: Validate): Json | undefined => v.runLog?.find((e) => e.t === "refuse" && e.ids?.layer === "plan/views")?.ids;

const readRun = (runId: string, file: "request.json" | "result.json"): Json =>
  JSON.parse(readFileSync(join(t.storeRoot, "runs", runId, file), "utf8")) as Json;

const apply = (bookId: string) => api<Json>(t.base, "POST", `/api/hierarchies/${HIER}/apply`, { bookId });

let loaded: PlanDoc;
let copyTaxonomy: Json;

describe("T1: the seeded plan and the picker before any apply", () => {
  it("lists the seeded plan on the seeded liability book, and the picker has one option", async () => {
    const list = await get<Array<{ id: string; positionBook?: string; seeded?: boolean; planId?: string }>>("/api/run-plans");
    const row = list.find((r) => (r.id ?? r.planId) === PLAN);
    expect(row).toBeDefined();
    expect(row!.positionBook).toBe(BASE_BOOK);
    expect(row!.seeded).toBe(true);
    loaded = await get<PlanDoc>(`/api/run-plans/${PLAN}`);
    expect(loaded.planId).toBe(PLAN);
    expect(loaded.inputs.positionBook).toBe(BASE_BOOK);

    const books = ids(await get<Array<{ id: string }>>("/api/portfolios"));
    const hierarchies = ids(await get<Array<{ id: string }>>("/api/hierarchies"));
    expect(hierarchies).toContain(HIER);
    const choices = bookChoices(BASE_BOOK, books, hierarchies);
    expect(choices.options).toEqual([{ id: BASE_BOOK, hierarchyId: null }]);
    expect(bookNote(choices)).toBe(NO_COPY_NOTE);
  });
});

describe("T2: the Views card offers, the validate gate decides", () => {
  it("offers four ids on the base book; lcr-category validates, hqla-level is offered then refused with P3 at dda-0", async () => {
    const book = await get<Json>(`/api/portfolios/${BASE_BOOK}`);
    expect(book.positions).toHaveLength(726);
    expect(viewDimensionOptions(book.taxonomy).map((o) => o.id)).toEqual(["hqla-level", "lcr-category", "productFamily", "side"]);

    const good = await validate(addView(loaded, "By LCR category", ["lcr-category"]));
    expect(good.compile).toEqual({ passed: true });

    const bad = await validate(addView(loaded, "HQLA", ["hqla-level"]));
    expect(bad.compile.passed).toBe(false);
    expect(bad.compile.error).toBe("ViewDefinitionError");
    expect(refuseIds(bad)).toEqual({
      layer: "plan/views",
      planId: PLAN,
      rule: "P3",
      viewId: "view-1",
      dimension: "hqla-level",
      positionId: "dda-0",
    });
  });
});

describe("T3: Hierarchies step, apply to the liability book", () => {
  it("answers 201 with 726 tagged positions, lists the copy at once, and the picker offers it", async () => {
    // Independent restatement: every position of the base book carries lcr-category.
    const book = await get<Json>(`/api/portfolios/${BASE_BOOK}`);
    let carrying = 0;
    const untagged: string[] = [];
    for (const p of book.positions as Json[]) {
      if (p.dimensions?.["lcr-category"] !== undefined) carrying += 1;
      else untagged.push(p.id);
    }
    expect(carrying).toBe(726);
    expect(untagged).toEqual([]);

    const r = await apply(BASE_BOOK);
    expect(r.status).toBe(201);
    expect(r.body.id).toBe(COPY);
    expect(r.body.taxonomyId).toBe("liquidity-tags-v1--liquidity-funding-demo-v1");
    expect(r.body.positionCount).toBe(726);
    expect(r.body.untaggedPositionIds).toEqual([]);

    const books = ids(await get<Array<{ id: string }>>("/api/portfolios"));
    expect(books).toContain(COPY);
    const hierarchies = ids(await get<Array<{ id: string }>>("/api/hierarchies"));
    const choices = bookChoices(BASE_BOOK, books, hierarchies);
    expect(choices.options).toEqual([
      { id: BASE_BOOK, hierarchyId: null },
      { id: COPY, hierarchyId: HIER },
    ]);
    expect(bookNote(choices)).toBe(`${BASE_BOOK} and 1 re-tagged copy`);
  });
});

describe("T4: the options each book offers", () => {
  it("offers the two level tags on the copy, in declared order, with their labels", async () => {
    copyTaxonomy = (await get<Json>(`/api/portfolios/${COPY}`)).taxonomy;
    const options = viewDimensionOptions(copyTaxonomy as never);
    expect(options.map((o) => o.id)).toEqual(["hqla-level", "lcr-category", FUNDING, BUCKET, "productFamily", "side"]);
    const label = (id: string) => options.find((o) => o.id === id)!.label;
    expect(label(FUNDING)).toBe("Liquidity funding hierarchy over the LCR category tag (demonstration values): Funding source");
    expect(label(BUCKET)).toBe("Liquidity funding hierarchy over the LCR category tag (demonstration values): Run-off bucket");
  });

  it("offers the demo taxonomy's own ids, and only the two derived ids when the book declares no taxonomy", async () => {
    expect(viewDimensionOptions(buildDemoTaxonomy(repoRoot())).map((o) => o.id)).toEqual([
      "productFamily",
      "side",
      "managementView",
      "regulatoryView",
      "rateType",
      "behavioralClass",
      "governanceTier",
      "disposition",
      "segment",
    ]);
    const plain = await get<Json>("/api/portfolios/synthetic-2500-v1");
    expect(plain.taxonomy).toBeUndefined();
    expect(viewDimensionOptions(plain.taxonomy).map((o) => o.id)).toEqual(["productFamily", "side"]);
  });
});

describe("T5: inputs.dimensionTaxonomy on a book switch", () => {
  const inputsOf = (book: string): PlanDoc["inputs"] => ({
    marketSnapshot: loaded.inputs.marketSnapshot,
    positionBook: book,
    routingPolicy: loaded.inputs.routingPolicy,
    dimensionTaxonomy: "liquidity-tags-v1",
    assumptionSets: loaded.inputs.assumptionSets,
  });

  it("refuses a kept field on the copy, drops it on a Studio switch, and restores it on the way back", async () => {
    const start: PlanDoc = { ...loaded, inputs: inputsOf(BASE_BOOK) };
    expect((await validate(start)).compile).toEqual({ passed: true });

    const kept = await validate({ ...start, inputs: inputsOf(COPY) });
    expect(kept.compile.passed).toBe(false);
    expect(kept.compile.error).toBe("TaxonomyMismatchError");
    expect(kept.compile.detail).toBe(
      'plan inputs.dimensionTaxonomy names "liquidity-tags-v1" but the position book carries taxonomy ' +
        '"liquidity-tags-v1--liquidity-funding-demo-v1"; the book is the source, so name its taxonomy id or drop the plan field',
    );

    const switched = withBook(start, start, COPY);
    expect(switched.inputs.positionBook).toBe(COPY);
    expect("dimensionTaxonomy" in switched.inputs).toBe(false);
    expect((await validate(switched)).compile).toEqual({ passed: true });
    expect(planEditSummary(start, switched).taxonomyDropped).toBe(true);

    const back = withBook(switched, start, BASE_BOOK);
    expect(back.inputs).toEqual(start.inputs);
    expect(editCount(planEditSummary(start, back))).toBe(0);
    expect((await validate(back)).compile).toEqual({ passed: true });
  });
});

describe("T6: P3 on the applied copy of the whole lcr book", () => {
  it("applies with 1625 untagged positions, and a level view on it is refused at cash-0", async () => {
    const lcr = await get<Json>("/api/portfolios/synthetic-2500-lcr-v1");
    // Independent restatement: positions without lcr-category are the 1625 asset positions.
    const without: string[] = [];
    for (const p of lcr.positions as Json[]) if (p.dimensions?.["lcr-category"] === undefined) without.push(p.id);
    expect(lcr.positions).toHaveLength(2351);
    expect(without).toHaveLength(1625);
    expect(without[0]).toBe("cash-0");

    const r = await apply("synthetic-2500-lcr-v1");
    expect(r.status).toBe(201);
    expect(r.body.positionCount).toBe(2351);
    expect(r.body.untaggedPositionIds).toHaveLength(1625);
    expect(r.body.untaggedPositionIds[0]).toBe("cash-0");

    // plan-synthetic-2500-v1 pointed at the lcr book stands in for a hand-written plan.
    const stored = await get<PlanDoc>("/api/run-plans/plan-synthetic-2500-v1");
    const onLcr: PlanDoc = { ...stored, inputs: { ...stored.inputs, positionBook: "synthetic-2500-lcr-v1" } };
    const onCopy = withBook(onLcr, onLcr, "synthetic-2500-lcr-v1--liquidity-funding-demo-v1");
    const v = await validate(addView(onCopy, "Funding source", [FUNDING]));
    expect(v.compile.passed).toBe(false);
    expect(v.compile.error).toBe("ViewDefinitionError");
    expect(refuseIds(v)).toEqual({
      layer: "plan/views",
      planId: "plan-synthetic-2500-v1",
      rule: "P3",
      viewId: "view-1",
      dimension: FUNDING,
      positionId: "cash-0",
    });
  });
});

describe("T7: P1 and P2 are refused by the gate and never offered", () => {
  it("refuses a multi-valued id on the liability copy (P2) and an undeclared id on synthetic-2500-v1 (P1)", async () => {
    const onCopy = withBook(loaded, loaded, COPY);
    const p2 = await validate(addView(onCopy, "Classes", ["behavioralClasses"]));
    expect(p2.compile.passed).toBe(false);
    expect(refuseIds(p2)).toMatchObject({ planId: PLAN, rule: "P2", dimension: "behavioralClasses" });
    expect(viewDimensionOptions(copyTaxonomy as never).map((o) => o.id)).not.toContain("behavioralClasses");

    const stored = await get<PlanDoc>("/api/run-plans/plan-synthetic-2500-v1");
    const p1 = await validate(addView(stored, "LCR", ["lcr-category"]));
    expect(p1.compile.passed).toBe(false);
    expect(refuseIds(p1)).toMatchObject({ planId: "plan-synthetic-2500-v1", rule: "P1", dimension: "lcr-category" });
    const plain = await get<Json>("/api/portfolios/synthetic-2500-v1");
    expect(viewDimensionOptions(plain.taxonomy).map((o) => o.id)).not.toContain("lcr-category");
  });
});

describe("T8: derived dimensions validate on the copy", () => {
  it("accepts a view by productFamily then side", async () => {
    const onCopy = withBook(loaded, loaded, COPY);
    expect((await validate(addView(onCopy, "By family and side", ["productFamily", "side"]))).compile).toEqual({ passed: true });
  });
});

describe("T9: end to end, switch the book, add a view, save as, run, read the Views tab", () => {
  it("groups the 726 positions into the four funding and bucket groups", async () => {
    const p = addView(withBook(loaded, loaded, COPY), "Funding then bucket", [FUNDING, BUCKET]);
    const summary = planEditSummary(loaded, p);
    expect(summary.stageIds.size).toBe(0);
    expect(summary.views).toBe(true);
    expect(summary.book).toBe(true);
    expect(summary.taxonomyDropped).toBe(false);
    expect(editsText(summary)).toBe("views changed; book changed");
    expect(editCount(summary)).toBe(2);
    expect(runButton(editCount(summary)).disabled).toBe(true);
    expect((await validate(p)).compile).toEqual({ passed: true });

    const listed = await get<Array<{ id: string }>>("/api/run-plans");
    const saveId = nextEditId(loaded.planId, new Set(ids(listed)));
    expect(saveId).toBe("plan-synthetic-lcr-liabilities-v1-edit-1");
    const saved = await api(t.base, "POST", "/api/run-plans", { plan: withPlanId(p, saveId) });
    expect(saved.status).toBe(201);
    const stored = await get<PlanDoc>(`/api/run-plans/${saveId}`);
    expect(runButton(editCount(planEditSummary(stored, stored))).disabled).toBe(false);

    const run = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: stored });
    expect(run.status).toBe(202);
    const runId = run.body.runId;
    const done = await waitFor(
      () => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body),
      (s) => s.state === "done" || s.state === "error",
      120_000,
    );
    expect(done.state).toBe("done");

    const request = readRun(runId, "request.json");
    expect(request.request.portfolioId).toBe(COPY);
    expect(request.request.views).toEqual(stored.views);
    expect(request.planDocument.views).toEqual(stored.views);

    const result = readRun(runId, "result.json");
    expect(result.schemaVersion).toBe("1.13.0");
    expect(result.views).toHaveLength(1);
    expect(result.views[0].viewId).toBe("view-1");
    expect(result.views[0].label).toBe("Funding then bucket");
    expect(result.views[0].groupBy).toEqual([FUNDING, BUCKET]);

    // Independent restatement: group the copy's positions by the two level tags; cells are distinct families.
    const copy = await get<Json>(`/api/portfolios/${COPY}`);
    const want = new Map<string, { funding: string; bucket: string; positions: number; families: Set<string> }>();
    for (const pos of copy.positions as Json[]) {
      const funding = pos.dimensions[FUNDING] as string;
      const bucket = pos.dimensions[BUCKET] as string;
      const k = `${funding}|${bucket}`;
      const g = want.get(k) ?? { funding, bucket, positions: 0, families: new Set<string>() };
      g.positions += 1;
      g.families.add(pos.familyId);
      want.set(k, g);
    }
    const expected = [
      { funding: "retail", bucket: "retail-stable", positions: 376, cells: 2 },
      { funding: "retail", bucket: "retail-less-stable", positions: 300, cells: 1 },
      { funding: "secured", bucket: "gse-secured", positions: 25, cells: 1 },
      { funding: "unsecured-wholesale", bucket: "financial-wholesale", positions: 25, cells: 1 },
    ];
    expect(want.size).toBe(4);
    for (const e of expected) {
      const g = want.get(`${e.funding}|${e.bucket}`)!;
      expect(g.positions).toBe(e.positions);
      expect(g.families.size).toBe(e.cells);
    }

    const byKey = (a: { key: Json }, b: { key: Json }) => String(a.key[BUCKET]).localeCompare(String(b.key[BUCKET]));
    const groups = [...(result.views[0].groups as Array<{ key: Json; positionCount: number; cellIds: string[] }>)].sort(byKey);
    expect(groups.map((g) => ({ key: g.key, positionCount: g.positionCount, cells: g.cellIds.length }))).toEqual(
      expected
        .map((e) => ({ key: { [FUNDING]: e.funding, [BUCKET]: e.bucket }, positionCount: e.positions, cells: e.cells }))
        .sort(byKey),
    );
    expect(groups.reduce((s, g) => s + g.positionCount, 0)).toBe(726);

    const pivotReply = await get<PivotResult>(`/api/runs/${runId}/pivot?view=view-1&metric=balance&scenarioId=S0`);
    const rows = [...(pivotReply as unknown as { rows: Array<{ key: Json; positionCount: number }> }).rows].sort(byKey);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => ({ key: r.key, positionCount: r.positionCount }))).toEqual(
      groups.map((g) => ({ key: g.key, positionCount: g.positionCount })),
    );

    // The Views tab paints this view rather than showing Not in this run.
    expect(viewPick(result as RunResult, {}).viewId).toBe("view-1");
    const html = renderToStaticMarkup(<PivotTable pivot={pivotReply} result={result as RunResult} />);
    for (const word of ["retail-stable", "retail-less-stable", "gse-secured", "financial-wholesale"]) expect(html).toContain(word);
  }, 150_000);
});

describe("T10: the Views card on the stored plan", () => {
  it("lists the stored view and offers only the dimensions not yet picked", async () => {
    const stored = await get<PlanDoc>("/api/run-plans/plan-synthetic-lcr-liabilities-v1-edit-1");
    expect(stored.views).toEqual([{ id: "view-1", label: "Funding then bucket", groupBy: [FUNDING, BUCKET] }]);
    const options = viewDimensionOptions(copyTaxonomy as never);
    const card = (picks: string[]) =>
      renderToStaticMarkup(
        <ViewsCard
          views={stored.views!}
          bookId={COPY}
          options={options}
          optionsError={null}
          note={`${BASE_BOOK} and 1 re-tagged copy`}
          draft={{ label: "", picks }}
          nextId="view-2"
          onDraft={() => {}}
          onAdd={() => {}}
          onRemove={() => {}}
        />,
      );
    const optionValues = (html: string): string[] => [...html.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]!);
    const empty = card([]);
    expect(empty).toContain("Funding then bucket");
    expect(optionValues(empty)).toEqual(["hqla-level", "lcr-category", FUNDING, BUCKET, "productFamily", "side"]);
    const picked = card([FUNDING, "side"]);
    expect(optionValues(picked)).toEqual(["hqla-level", "lcr-category", BUCKET, "productFamily"]);
  });
});

const LIMITATIONS = join(repoRoot(), "docs", "LIMITATIONS.md");
// The limitations file is optional: absent, the doc-sync check skips and says why.
describe.skipIf(!existsSync(LIMITATIONS))(`T11: LIMITATIONS records Piece 5b${existsSync(LIMITATIONS) ? "" : " [skipped: no docs/LIMITATIONS.md; the limitations page is docs/guide/limitations.md]"}`, () => {
  const doc = existsSync(LIMITATIONS) ? readFileSync(LIMITATIONS, "utf8") : "";
  const EM = String.fromCharCode(0x2014);
  const SECTION_SIGN = String.fromCharCode(0xa7);
  const between = (from: string, to: string): string => {
    const a = doc.indexOf(from);
    const b = doc.indexOf(to, a + from.length);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    return doc.slice(a, b);
  };

  it("holds a Piece 5b section between Piece 6b and the kernel re-sync", () => {
    const section = between("### ALM Studio Piece 5b (plan-builder views and re-tagged book picker)", "## 19. Kernel re-sync");
    expect(doc.indexOf("### ALM Studio Piece 6b (balance shocks)")).toBeLessThan(doc.indexOf("### ALM Studio Piece 5b (plan-builder views and re-tagged book picker)"));
    expect(section).toContain("synthetic-lcr-liabilities-v1");
    expect(section).toContain("the design notes");
    expect(section).toContain("POST /api/runs takes no views");
    expect(section).not.toContain(EM);
    expect(section).not.toContain(SECTION_SIGN);
  });
  it("no longer says the plan builder cannot declare a view", () => {
    const piece5 = between("### Hierarchies and mapping (Piece 5)", "### ALM Studio P2 (targets and new business)");
    expect(piece5).not.toContain("cannot declare a view over the new tags");
    expect(piece5).toContain("hand-written RunPlan");
    expect(piece5).toContain("Studio Piece 5b also seeds synthetic-lcr-liabilities-v1");
  });
  it("says the seeded plans declare no views, not the three", () => {
    expect(doc).toContain("The seeded plans declare no views");
    expect(doc).not.toContain("The three seeded plans declare no views");
  });
});
