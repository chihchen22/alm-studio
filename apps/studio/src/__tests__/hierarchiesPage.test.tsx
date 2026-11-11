// apps/studio/src/__tests__/hierarchiesPage.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, type Hierarchy, type HierarchyMeta, type HierarchySources } from "@alm/reader";
import { HierarchiesPageView, HierarchiesView, hierarchyBodyShown, type HierarchyBody } from "../pages/balance/HierarchiesPage";
import { draftFrom, emptyDraft } from "../balance/hierarchyModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const DEMO: Hierarchy = {
  schemaVersion: "1.0.0",
  id: "liquidity-funding-demo-v1",
  label: "Liquidity funding hierarchy over the LCR category tag (demonstration values)",
  kind: "liquidity",
  sourceDimension: "lcr-category",
  levels: [{ id: "funding", label: "Funding source" }, { id: "bucket", label: "Run-off bucket" }],
  nodes: [
    { id: "retail", parentId: null, level: "funding" },
    { id: "unsecured-wholesale", parentId: null, level: "funding" },
    { id: "secured", parentId: null, level: "funding" },
    { id: "retail-stable", parentId: "retail", level: "bucket" },
    { id: "retail-less-stable", parentId: "retail", level: "bucket" },
    { id: "operational", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "nonfinancial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "financial-wholesale", parentId: "unsecured-wholesale", level: "bucket" },
    { id: "gse-secured", parentId: "secured", level: "bucket" },
  ],
  map: {
    operational: "operational", "retail-other": "retail-less-stable", "retail-stable": "retail-stable",
    "secured-gse": "gse-secured", "wholesale-financial": "financial-wholesale", "wholesale-nonfinancial": "nonfinancial-wholesale",
  },
};
const VALUES = ["operational", "retail-other", "retail-stable", "secured-gse", "wholesale-financial", "wholesale-nonfinancial"];
const BOOK = "synthetic-2500-lcr-v1";
const SOURCES: HierarchySources = {
  bookId: BOOK,
  taxonomyId: "liquidity-tags-v1",
  dimensions: [
    { id: "lcr-category", label: "LCR category", eligible: true, reason: null, values: VALUES, carried: true },
    { id: "side", label: "Side", eligible: false, reason: "derived from the family by the engine, not an authored tag", values: [], carried: true },
  ],
};
const META: HierarchyMeta[] = [
  { id: "liquidity-funding-demo-v1", contentHash: "h", importedAt: "t", label: "Demo", kind: "liquidity", sourceDimension: "lcr-category", checkedBookId: BOOK, seeded: true },
  { id: "elsewhere", contentHash: "h", importedAt: "t", label: "Other tag", kind: "risk", sourceDimension: "side", checkedBookId: BOOK },
];
const noop = () => {};
const base = {
  bookId: BOOK,
  sources: SOURCES,
  stored: META,
  selected: null as string | null,
  storedDoc: null as Hierarchy | null,
  draft: { ...emptyDraft("lcr-category"), id: "lcr-category-hierarchy-v1" },
  problems: [] as string[],
  msg: null as string | null,
  busy: null as string | null,
  loadError: null as string | null,
  onPick: noop, onSource: noop, onKind: noop, onId: noop, onLabel: noop, onSave: noop, onApply: noop,
  onLevel: noop, onAddLevel: noop, onRemoveLevel: noop, onNode: noop, onNodeParent: noop, onAddNode: noop, onRemoveNode: noop, onMap: noop,
};
const view = (over: Partial<typeof base> = {}) => renderToStaticMarkup(<HierarchiesView {...base} {...over} />);
const body = (sources: HierarchySources): HierarchyBody => ({ bookId: BOOK, sources, stored: META });
const pageView = (over: { bookId?: string | null; shown?: HierarchyBody | null; load?: never } = {}) => renderToStaticMarkup(
  <HierarchiesPageView bookId={"bookId" in over ? over.bookId! : BOOK} load={{ state: "ok", value: null }} shown={"shown" in over ? over.shown! : body(SOURCES)} refresh={0} onChanged={noop} />,
);

describe("HierarchiesPageView states", () => {
  it("no book says so", () => {
    expect(text(pageView({ bookId: null, shown: null }))).toBe("Unobservable: no book selected. Set the Book pill.");
  });
  it("a load error prints the error line", () => {
    const html = renderToStaticMarkup(<HierarchiesPageView bookId={BOOK} load={{ state: "error", error: new ApiError(404, "not-found", 'portfolio "x" not found') }} shown={null} refresh={0} onChanged={noop} />);
    expect(text(html)).toContain("404: portfolio &quot;x&quot; not found");
  });
  it("nothing yet on screen prints Reading book", () => {
    expect(text(pageView({ shown: null }))).toBe(`Reading book ${BOOK}`);
  });
  it("a book with no taxonomy says it carries no tag", () => {
    expect(text(pageView({ shown: body({ bookId: BOOK, taxonomyId: null, dimensions: [] }) }))).toBe(`Book ${BOOK} declares no taxonomy, so it carries no tag to map. Pick a tagged book with the Book pill.`);
  });
  it("a book with no eligible tag lists each tag's reason", () => {
    const dims = [{ ...SOURCES.dimensions[1]! }, { id: "behavioralClasses", label: "Classes", eligible: false, reason: "multi-valued: a position can carry several values, so it would land on several leaves", values: [], carried: true }];
    expect(text(pageView({ shown: body({ bookId: BOOK, taxonomyId: "t", dimensions: dims }) }))).toBe(
      `Book ${BOOK} carries no single-valued authored tag to map: side: derived from the family by the engine, not an authored tag; behavioralClasses: multi-valued: a position can carry several values, so it would land on several leaves. Pick a tagged book with the Book pill.`,
    );
  });
  it("an eligible book opens the editor", () => {
    const t = text(pageView());
    expect(t).toContain("Save as lcr-category-hierarchy-v1");
    expect(t).toContain("Unmapped: operational, retail-other, retail-stable, secured-gse, wholesale-financial, wholesale-nonfinancial");
  });
  it("hierarchyBodyShown keeps the body while the same book is re-read, and drops it for another book", () => {
    const kept = body(SOURCES);
    expect(hierarchyBodyShown(kept, { state: "loading" }, BOOK)).toBe(kept);
    expect(hierarchyBodyShown(kept, { state: "loading" }, "other")).toBeNull();
    expect(hierarchyBodyShown(null, { state: "ok", value: kept }, BOOK)).toBe(kept);
    expect(hierarchyBodyShown(null, { state: "ok", value: kept }, "other")).toBeNull();
    expect(hierarchyBodyShown(kept, { state: "error", error: new Error("x") }, BOOK)).toBeNull();
  });
});

describe("HierarchiesView", () => {
  it("carries the honest card text in full", () => {
    const t = text(view());
    expect(t).toContain("A hierarchy maps one tag the book already carries into a tree of named levels.");
    expect(t).toContain("Apply writes a new book with a new id: the same positions, each carrying one more tag per level, named hierarchy id dot level id, and a taxonomy that declares them.");
    expect(t).toContain("Apply sums nothing and moves no balance, but the new book has its own content hash, so a run on it is a run on a different input.");
    expect(t).toContain("Risk, liquidity and regulatory hierarchies only; capital, ledger and planning hierarchies are not built.");
    expect(t).toContain(
      "On the Plan page, the Book picker offers a plan's book and its re-tagged copies, and the Views card declares a view over the new tags; the validate gate accepts or refuses it, and a run of the saved plan is grouped by it on the Results Views tab.",
    );
    expect(t).not.toContain("The plan builder cannot yet declare a view over the new tags; only a hand-written run plan can.");
    expect(t).toContain("A position that carries no value for the source tag gets no hierarchy tag, and a view over a tag refuses a book with an untagged position.");
    expect(t).not.toContain("no result is grouped by them");
  });
  it("lists only stored hierarchies over an eligible tag of this book, as id: label", () => {
    const html = view();
    expect(html).toContain("liquidity-funding-demo-v1: Demo");
    expect(html).not.toContain("Other tag");
    expect(html).toContain(">New hierarchy<");
  });
  it("offers an ineligible tag as a disabled option holding its reason", () => {
    const html = view();
    expect(html).toMatch(/<option value="side" disabled="">side \(derived from the family by the engine, not an authored tag\)<\/option>/);
    expect(html).toMatch(/<option value="lcr-category" selected="">lcr-category<\/option>/);
  });
  it("the hierarchy picker is disabled while busy, so a pick during a save is not overridden", () => {
    expect(view()).toMatch(/<select aria-label="Hierarchy"(?![^>]*disabled)/);
    expect(view({ busy: "Saving x" })).toMatch(/<select aria-label="Hierarchy" disabled=""/);
  });
  it("locks the source tag while a stored hierarchy is picked", () => {
    expect(view()).toMatch(/aria-label="Source tag"(?![^>]*disabled)/);
    const picked = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) });
    expect(picked).toMatch(/<select aria-label="Source tag" disabled=""/);
  });
  it("prints Unmapped for values with no leaf", () => {
    const d = draftFrom(DEMO);
    d.map = { ...d.map };
    delete d.map["operational"];
    expect(text(view({ selected: DEMO.id, storedDoc: DEMO, draft: d }))).toContain("Unmapped: operational");
  });
  it("says every value maps when none is left", () => {
    expect(text(view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) }))).toContain(`Every value of lcr-category on ${BOOK} maps to a leaf.`);
  });
  it("Apply is disabled with the save-first hint when the draft differs from the stored document", () => {
    const edited = { ...draftFrom(DEMO), kind: "risk" as const };
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: edited });
    expect(html).toMatch(/<button type="button" class="btn" disabled="">Apply to <span class="mono">synthetic-2500-lcr-v1<\/span><\/button>/);
    expect(text(html)).toContain("Apply takes a stored hierarchy: save the edits first.");
  });
  it("Apply is enabled with no hint when the draft is the stored document", () => {
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) });
    expect(html).toMatch(/<button type="button" class="btn">Apply to <span class="mono">synthetic-2500-lcr-v1<\/span><\/button>/);
    expect(text(html)).not.toContain("Apply takes a stored hierarchy");
  });
  it("Apply is disabled while busy", () => {
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO), busy: "Saving x" });
    expect(html).toMatch(/class="btn" disabled="">Apply to/);
    expect(text(html)).toContain("Saving x");
  });
  it("renders the three tables with row headers and no bare header", () => {
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) });
    for (const m of html.matchAll(/<th(?:>|[\s/][^>]*>)/g)) expect(m[0]).toContain("scope=");
    expect((html.match(/<th scope="row"/g) ?? []).length).toBe(2 + 9 + 6);
    const t = text(html);
    expect(t).toContain("Order Level id Label Action");
    expect(t).toContain("Order Node id Level Parent Action");
    expect(t).toContain("Source value Leaf node");
    expect(t).toContain("Add level");
    expect(t).toContain("Add node at Funding source");
    expect(t).toContain("Source: /api/hierarchies; /api/hierarchies/sources/synthetic-2500-lcr-v1");
  });
  it("Remove is on the last level row only, and the first-level parent select says None (first level)", () => {
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) });
    expect(html).toContain("None (first level)");
    const levels = html.slice(html.indexOf('aria-label="Levels"'), html.indexOf('aria-label="Nodes"'));
    expect((levels.match(/aria-label="Remove level /g) ?? []).length).toBe(1);
  });
  it("shows the problems banner and the load error panel", () => {
    expect(view({ problems: ["Give the hierarchy an id."] })).toContain('<div class="card plan-banner" role="alert"><div>Give the hierarchy an id.</div></div>');
    const failed = text(view({ selected: "x", loadError: "hierarchy \"x\" not found" }));
    expect(failed).toContain("Hierarchy not read");
    expect(failed).not.toContain("Unmapped:");
  });
  it("prints no number a result would carry, and no em-dash or section sign", () => {
    const html = view({ selected: DEMO.id, storedDoc: DEMO, draft: draftFrom(DEMO) });
    expect(html).not.toContain(String.fromCharCode(0x2014));
    expect(html).not.toContain(String.fromCharCode(0xa7));
  });
});
