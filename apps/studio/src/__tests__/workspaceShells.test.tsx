// apps/studio/src/__tests__/workspaceShells.test.tsx
// Today's pages under the workspace frame, the harness pages, the default-set control, the import form,
// the carried definitions list.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { ApiError, type MarketBlock } from "@alm/reader";
import { screensOf } from "../router";
import { RateModelView } from "../pages/market/RateModelPage";
import { TemplatesView } from "../pages/balance/TemplatesPage";
import { MappingView } from "../pages/assumptions/MappingPage";
import { AttachedSetsView } from "../pages/assumptions/AttachedSets";
import { ImportPositionsView } from "../pages/balance/ImportPositions";
import type { CoaOption, ImportNote } from "../balance/importModel";
import { RateIndicesView } from "../pages/market/RateIndicesPage";
import { MarketView } from "../pages/market/MarketView";
import { definitionRows, reapplyBody } from "../market/definitionsModel";
import { coaChoice, importBlock, importFormModel, importNote, importSetBody, refusalNote } from "../balance/importModel";
import { attachBody, defaultBody, mappingGrid } from "../assumptions/attachModel";
import { emptyRateIndexDraft } from "../market/rateIndexModel";
import { curveInstances, curveMethods, rateModelInstances, rateModelMethods } from "../harness/instances";
import { HEAD } from "./fixtures/workspace";
import { CATALOG, LINEAGE_M, MARKET, MARKETS, SERIES } from "./fixtures/market";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};
const REGIONS = ["Method", "Settings", "Inputs", "Validation", "Used by", "Provenance"];

describe("the section shells list their screens", () => {
  it("Market, Balance Sheet, Assumptions, Run, Results and Govern list the screens of the frame, each once", () => {
    const listed = (s: Parameters<typeof screensOf>[0]) => screensOf(s).map((x) => x.screen);
    expect(listed("market")).toEqual(["curves", "curve-builder", "derived-curves", "vols", "rate-model", "indices", "macro"]);
    expect(listed("balance")).toEqual(["positions", "coa", "hierarchies", "templates", "strategy"]);
    expect(listed("assumptions")).toEqual(["prepay", "decay", "deposit-repricing", "renewals-draws", "loan-client-rate", "mapping", "sets"]);
    expect(listed("run")).toEqual(["setups", "scenarios", "batches", "queue", "instrument"]);
    expect(listed("results")).toEqual(["dashboard", "nii", "eve", "gap", "ftp", "seg", "liquidity", "instruments", "rates", "stochastic", "attribution", "views", "metrics", "lenses", "compare"]);
    expect(listed("govern")).toEqual(["lineage", "inventory", "audit", "limits", "approvals"]);
  });
});

describe("the harness pages", () => {
  it("Market > Rate model: the three instances, Hull-White 1F and BGM mounted with the request note, SABR a surface preview linking to Volatility surfaces, the frame regions", () => {
    const inst = rateModelInstances({ stochasticSetups: [] });
    const html = renderToStaticMarkup(<RateModelView instances={inst} methods={rateModelMethods(CATALOG, "#/ws/ws-a/market/vols")} selected={inst[0]!.id} ws="ws-a" />);
    const t = text(html);
    for (const r of REGIONS) expect(t, r).toContain(r);
    expect(t).toContain("Deterministic forwards");
    expect(t).toMatch(/Hull-White 1F alm-hull-white mounted stochastic runs by request from the Workbench or the API, base scenario only; not a plan stage/);
    expect(t).toMatch(/alm-bgm-lmm mounted stochastic runs by request from the Workbench or the API, base scenario only; not a plan stage/);
    expect(t).toMatch(/alm-sabr surface preview/);
    expect(html).toContain('<a href="#/ws/ws-a/market/vols">Volatility surfaces</a>');
    expect(t).not.toContain("engine: later phase");
    expect(t).toMatch(/Formula[^.]*not available in this release/);
    // The instance list links by instance in the query, inside this workspace.
    expect(html).toContain('href="#/ws/ws-a/market/rate-model?instance=');
  });

  it("Market > Rate model from a catalog without alm-hull-white: the page still reads Hull-White 1F and BGM mounted", () => {
    const live = { components: CATALOG.components.filter((c) => c.id !== "alm-hull-white"), mounted: CATALOG.mounted.filter((p) => p.id !== "alm-hull-white") };
    expect(live.mounted.some((p) => p.id === "alm-hull-white" || p.id === "alm-bgm-lmm")).toBe(false);
    const inst = rateModelInstances({ stochasticSetups: [] });
    const t = text(renderToStaticMarkup(<RateModelView instances={inst} methods={rateModelMethods(live, "#/ws/ws-a/market/vols")} selected="bgm-lmm-2f" ws="ws-a" />));
    expect(t).toMatch(/Hull-White 1F alm-hull-white mounted/);
    expect(t).toMatch(/alm-bgm-lmm mounted/);
    expect(t).toContain("the default subset of the long-yield volatility surface");
    expect(t).not.toMatch(/cap (normal )?vol|cap quote|swaption (quote|normal|grid|atm)/i);
  });

  it("Balance Sheet > New-business templates: the reserved frame with no instance and the Flat vehicle named", () => {
    const t = text(renderToStaticMarkup(<TemplatesView ws="ws-a" />));
    for (const r of ["Method", "Settings", "Used by"]) expect(t, r).toContain(r);
    expect(t).toContain("No instance in this release");
    expect(t).toMatch(/60-month fixed bullet/);
    expect(t).toMatch(/a later release/);
  });

  it("Assumptions > Mapping: one grid of family and selector rows against the overlay kind columns, over the default set", () => {
    const set = { schemaVersion: "1.0.0", id: "demo-behavioral-v1", label: "Demo", bindings: [
      { familyId: "dda", overlay: { kind: "nmd-decay", params: { closureSteady: 0.75, maxRateDecay: 3 } }, modelVersion: "kernel-nmd-decay-1" },
      { familyId: "mma", overlay: { kind: "deposit-beta", params: { betaMin: 0.45 } }, modelVersion: "kernel-deposit-beta-1" },
      { familyId: "dda", selector: { segment: "retail" }, overlay: { kind: "nmd-decay", params: { closureSteady: 0.5, maxRateDecay: 3 } }, modelVersion: "kernel-nmd-decay-2" },
    ] } as unknown as AssumptionSet;
    const grid = mappingGrid(set);
    expect(grid.kinds).toEqual(["deposit-beta", "nmd-decay"]);
    expect(grid.rows.map((r) => [r.familyId, r.selector, r.cells])).toEqual([
      ["dda", "segment: retail", [null, "kernel-nmd-decay-2"]],
      ["dda", "whole family", [null, "kernel-nmd-decay-1"]],
      ["mma", "whole family", ["kernel-deposit-beta-1", null]],
    ]);
    const t = text(renderToStaticMarkup(<MappingView ws="ws-a" setId="demo-behavioral-v1" grid={grid} />));
    expect(t).toContain("demo-behavioral-v1");
    expect(t).toContain("deposit-beta");
    expect(t).toContain("kernel-nmd-decay-2");
    expect(t).toContain("Not bound");
  });

  it("Assumptions > Mapping with no set says which control attaches one", () => {
    const t = text(renderToStaticMarkup(<MappingView ws="ws-a" setId={null} grid={null} />));
    expect(t).toContain("No assumption set is attached");
  });
});

describe("Market > Yield curves under the frame", () => {
  const model = {
    marketId: MARKETS[0]!.id, asOf: "2026-03-31", contentHash: "hash-q1", markets: MARKETS,
    curves: [], cap: { rows: [], cols: [], cells: [] } as never, swaption: { rows: [], cols: [], cells: [] } as never,
    lineage: LINEAGE_M, history: SERIES, snapshot: MARKET,
    // The model names its base curve (loadMarket reads it from GET /api/market/:id).
    baseCurve: { kind: "default", version: 2 },
  };
  it("lists the snapshots as a fact, not a picker: the workspace pins one base", () => {
    const html = renderToStaticMarkup(<MarketView model={model as never} query={{}} section="curves" ws="ws-a" />);
    expect(html).not.toContain("asOf=");
    expect(text(html)).toContain("The workspace pins");
  });
  it("shows the three curve instances under the charts, the selected one by the instance key", () => {
    const inst = curveInstances(MARKET, { positions: 2351, setupsOnBase: [] });
    const html = renderToStaticMarkup(
      <MarketView model={model as never} query={{ instance: "tlp" }} section="spreads" ws="ws-a"
        frame={{ module: "curve", instances: inst, methods: curveMethods(CATALOG), selected: "tlp" }} />,
    );
    const t = text(html);
    expect(t).toContain("TLP overlay");
    expect(t).toContain("alm-tlp-overlay");
    expect(html).toContain('href="#/ws/ws-a/market/curves?instance=risk-free"');
  });
});

describe("Market > Rate indices: carried definitions", () => {
  const ref = (id: string) => ({ collection: "market" as const, id, contentHash: `h-${id}`, pinnedAt: "2026-10-09T09:00:00.000Z" });
  const market: MarketBlock = {
    snapshot: ref("market-public-2026-03-31"),
    derived: [
      { ...ref("derived-mk-aaaaaaaaaaaa"), definitionKey: "tlp-shock-demo-v1", parentKey: "macro-demo-v1" },
      { ...ref("derived-mk-bbbbbbbbbbbb"), definitionKey: "macro-demo-v1", parentKey: null },
    ],
    carried: [
      { definitionKey: "vol-b", parentKey: "vol-a", source: ref("vol-b-src"), status: "awaiting", appliedId: null, refusal: null },
      { definitionKey: "vol-a", parentKey: null, source: ref("vol-a-src"), status: "applied", appliedId: "derived-mk-0123456789ab", refusal: null },
      { definitionKey: "idx-x", parentKey: null, source: ref("idx-x-src"), status: "refused", appliedId: null, refusal: "the macro history ends at the old as-of month" },
    ],
    carriedFrom: { workspaceId: "ws-prev", at: "2026-10-09T09:00:00.000Z" },
  };

  it("orders every definition after the one it depends on, with its level", () => {
    const rows = definitionRows(market);
    expect(rows.map((r) => `${r.key}:${r.level}:${r.state}`)).toEqual([
      "macro-demo-v1:0:in-block", "tlp-shock-demo-v1:1:in-block", "vol-a:0:applied", "vol-b:1:awaiting", "idx-x:0:refused",
    ]);
    expect(definitionRows({ ...market, derived: [], carried: [] })).toEqual([]);
  });

  it("renders the list in that order with each status, the refusal text and the Re-apply button", () => {
    const html = renderToStaticMarkup(
      <RateIndicesView
        markets={[]} chosen={null} chosenNote={null} draft={emptyRateIndexDraft()} block={null} preview={null} note={null} busy={null} planLink={null}
        onMarket={noop} onAddOp={noop} onRemoveOp={noop} onOp={noop} onLabel={noop} onId={noop} onPreview={noop} onSave={noop}
        historyOpen={null} onHistory={noop} onImported={noop} onClearHistory={noop} startFillNote={null} startFilling={null} onFillStart={noop}
        definitions={definitionRows(market)}
        reapply={{ awaiting: 1, busy: false, note: null, block: null, onReapply: noop }}
      />,
    );
    const at = (s: string) => html.indexOf(s);
    expect(at("macro-demo-v1")).toBeGreaterThan(-1);
    expect(at("macro-demo-v1")).toBeLessThan(at("tlp-shock-demo-v1"));
    expect(at("vol-a")).toBeLessThan(at("vol-b"));
    const t = text(html);
    expect(t).toContain("the macro history ends at the old as-of month");
    expect(t).toContain("Awaiting re-apply");
    expect(t).toContain("Refused");
    expect(t).toContain("derived-mk-0123456789ab");
    expect(t).toContain("Re-apply carried definitions");
  });

  it("the Re-apply body names the head revision and the typed name; the button is off with nothing awaiting", () => {
    expect(reapplyBody({ ...HEAD, revision: 7 }, "Chih")).toEqual({ expectedRevision: 7, by: "Chih" });
    const html = renderToStaticMarkup(
      <RateIndicesView
        markets={[]} chosen={null} chosenNote={null} draft={emptyRateIndexDraft()} block={null} preview={null} note={null} busy={null} planLink={null}
        onMarket={noop} onAddOp={noop} onRemoveOp={noop} onOp={noop} onLabel={noop} onId={noop} onPreview={noop} onSave={noop}
        historyOpen={null} onHistory={noop} onImported={noop} onClearHistory={noop} startFillNote={null} startFilling={null} onFillStart={noop}
        definitions={definitionRows({ ...market, carried: [] })}
        reapply={null}
      />,
    );
    expect(text(html)).not.toContain("Re-apply carried definitions");
  });
});

describe("Assumptions > Assumption sets: attached sets and the workspace default", () => {
  const sets = (n: number) => HEAD.blocks.assumptions.sets.slice(0, n).map((s) => ({ id: s.id, label: s.id }));
  const base = { by: "", busy: false, note: null as string | null, onDefault: noop, onAttach: noop, onBy: noop, stored: [] as Array<{ id: string; label: string }> };

  it("two or more attached sets show a radio per set, the default checked, and the rule in words", () => {
    const html = renderToStaticMarkup(<AttachedSetsView {...base} attached={sets(3)} defaultSetId="loan-repricing-demo-v1" />);
    expect(html.match(/type="radio"/g)!.length).toBe(3);
    expect(html).toMatch(/<input[^>]*checked=""[^>]*value="loan-repricing-demo-v1"/);
    const t = text(html);
    expect(t).toContain("Workspace default");
    expect(t).toMatch(/run setup that names the workspace default[^.]*resolves to this set/);
  });

  it("one attached set shows no radio: the first set attached is the default", () => {
    const html = renderToStaticMarkup(<AttachedSetsView {...base} attached={sets(1)} defaultSetId="demo-behavioral-v1" />);
    expect(html).not.toContain('type="radio"');
    expect(text(html)).toContain("The first set attached becomes the workspace default");
  });

  it("none attached says Attach a set, and that the vanilla empty set is a valid contractual-only choice", () => {
    const t = text(renderToStaticMarkup(<AttachedSetsView {...base} attached={[]} defaultSetId={null} stored={[{ id: "vanilla-empty-v1", label: "Vanilla" }]} />));
    expect(t).toContain("Attach a set");
    expect(t).toMatch(/vanilla empty set[^.]*contractual-only/);
  });

  it("builds the block bodies from the head: attach is add, the default control is set-default", () => {
    expect(attachBody({ ...HEAD, revision: 5 }, "stress-illustrative-v1", "Chih")).toEqual({
      expectedRevision: 5, by: "Chih", block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: "stress-illustrative-v1" },
    });
    expect(defaultBody({ ...HEAD, revision: 5 }, "housing-demo-v1", "Chih")).toEqual({
      expectedRevision: 5, by: "Chih", block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id: "housing-demo-v1" },
    });
  });
});

describe("Balance Sheet > Positions: import into the workspace", () => {
  it("the as-of is the cut-off, read-only on a Production workspace and editable elsewhere", () => {
    expect(importFormModel({ ...HEAD, type: "production", cutoffDate: "2026-02-28" })).toMatchObject({ asOf: "2026-02-28", asOfReadOnly: true });
    expect(importFormModel({ ...HEAD, type: "test", cutoffDate: "2026-03-31" })).toMatchObject({ asOf: "2026-03-31", asOfReadOnly: false });
    for (const type of ["monthly", "ftp", "stress"] as const) expect(importFormModel({ ...HEAD, type }).asOfReadOnly, type).toBe(false);
  });

  it("proposes the workspace's chart as the CSV import's chart and an id from the workspace id", () => {
    const m = importFormModel(HEAD);
    expect(m.coaId).toBe("demo-coa-v1");
    expect(m.portfolioId).toBe("ws-synthetic-2500-v1-positions");
  });

  it("the block write after an import sets the positions block at the head revision", () => {
    expect(importSetBody({ ...HEAD, revision: 4 }, "book-x", "Chih")).toEqual({
      expectedRevision: 4, by: "Chih", block: "positions", op: "set", ref: { collection: "portfolios", id: "book-x" },
    });
  });

  it("the view shows the one primary action, the as-of field locked on Production, and no hex literal", () => {
    const common = { by: "", file: null as string | null, busy: false, note: null as ImportNote | null, coas: [] as CoaOption[], onBy: noop, onFile: noop, onField: noop, onImport: noop };
    const prod = renderToStaticMarkup(<ImportPositionsView {...common} model={importFormModel({ ...HEAD, type: "production" })} open />);
    expect(text(prod)).toContain("Import positions (CSV or JSON)");
    expect(prod).toMatch(/<input[^>]*aria-label="As-of date"[^>]*readonly=""/);
    const test = renderToStaticMarkup(<ImportPositionsView {...common} model={importFormModel({ ...HEAD, type: "test" })} open />);
    expect(test).not.toMatch(/<input[^>]*aria-label="As-of date"[^>]*readonly=""/);
    expect(test).not.toMatch(/#[0-9a-f]{3,6}\b/i);
  });

  describe("a refused import lists its rows, the chart is a pick, and the off button says why", () => {
    const view = (over: Partial<Parameters<typeof ImportPositionsView>[0]> = {}) => {
      const props = {
        by: "Chih", file: "book.csv" as string | null, busy: false, note: null as ImportNote | null,
        coas: [{ id: "coa-a", label: "Alpha chart" }, { id: "demo-coa-v1", label: "" }] as CoaOption[] | "loading",
        onBy: noop, onFile: noop, onField: noop, onImport: noop, model: importFormModel(HEAD), open: true,
      };
      return renderToStaticMarkup(<ImportPositionsView {...props} {...over} />);
    };
    const refused = (n: number, message = "portfolio import rejected: 12 error(s); every error is listed, not just the first") =>
      new ApiError(422, "validation", message, Array.from({ length: n }, (_, i) => ({ row: i + 2, column: "terms_type", message: `terms_type "fixed-loan" contradicts family "cds" number ${i}` })));

    it("a 422 with two detail items prints both lines with the row and the column, under a headline with no status prefix", () => {
      const e = new ApiError(422, "validation", "portfolio import rejected: 2 error(s); every error is listed, not just the first", [
        { row: 3, column: "terms_type", message: 'terms_type "fixed-loan" contradicts family "cds"\'s instrumentType "cd"' },
        { row: 7, positionId: "p-7", column: "notional", message: "notional is blank" },
      ]);
      const note = refusalNote(e);
      expect(note.text).toBe("portfolio import rejected: 2 error(s); every error is listed, not just the first");
      expect(note.items).toEqual([
        'row 3, terms_type: terms_type "fixed-loan" contradicts family "cds"\'s instrumentType "cd"',
        "row 7, p-7, notional: notional is blank",
      ]);
      expect(note.more).toBe(0);
      const html = view({ note });
      expect(html).toMatch(/<ul class="list">/);
      expect(text(html)).toContain("row 3, terms_type: terms_type");
      expect(text(html)).toContain("row 7, p-7, notional: notional is blank");
      expect(text(html)).not.toContain("422 validation");
    });

    it("an item with no row, column or position id prints its message alone", () => {
      const note = refusalNote(new ApiError(422, "validation", "rejected", [{ message: "the file has no header" }, "plain text item"]));
      expect(note.items).toEqual(["the file has no header", "plain text item"]);
    });

    it("12 items list 10 and say and 2 more", () => {
      const note = refusalNote(refused(12));
      expect(note.items).toHaveLength(10);
      expect(note.more).toBe(2);
      const html = view({ note });
      expect((html.match(/<li>/g) ?? []).length).toBe(10);
      expect(text(html)).toContain("and 2 more");
      expect(text(view({ note: refusalNote(refused(10)) }))).not.toContain("more");
    });

    it("a reply with no detail prints the headline only, with no list", () => {
      const note = refusalNote(new ApiError(409, "conflict", "revision 4 expected, head is 5"));
      expect(note).toEqual({ text: "409: revision 4 expected, head is 5", items: [], more: 0 });
      const html = view({ note });
      expect(html).not.toContain("<ul");
      expect(text(html)).toContain("409: revision 4 expected, head is 5");
      expect(refusalNote(new ApiError(500, "internal", "store unreadable")).text).toBe("500: store unreadable");
      // A client refusal with no list keeps the reason alone, as does a 422 that carries rows.
      expect(refusalNote(new ApiError(422, "validation", "positions file has no rows")).text).toBe("positions file has no rows");
      expect(refusalNote(new ApiError(422, "validation", "rejected", [{ message: "x" }])).text).toBe("rejected");
      // A reply with no JSON body keeps its sentence, not a doubled status.
      expect(refusalNote(new ApiError(502, "http-error", "502 Bad Gateway")).text).toBe("The request failed with HTTP 502 and the reply gave no reason.");
      expect(refusalNote(new TypeError("Failed to fetch")).text).toBe("The platform could not be reached. Is it running?");
      expect(importNote("Imported b into ws")).toEqual({ text: "Imported b into ws", items: [], more: 0 });
    });

    it("the chart is a select over the stored charts, labelled with id and label, defaulting to the workspace's own chart", () => {
      const html = view();
      expect(html).toMatch(/<select[^>]*aria-label="Chart of accounts id"/);
      expect(html).toContain('<option value="coa-a">coa-a: Alpha chart</option>');
      // The workspace names demo-coa-v1 and it is in the list: it is the one selected.
      expect(html).toMatch(/<option value="demo-coa-v1" selected="">demo-coa-v1<\/option>/);
      expect(html).not.toContain("Type the chart of accounts id.");
    });

    it("the default falls to the first stored chart when the workspace's chart is not in the list, and a typed pick wins", () => {
      const coas = [{ id: "coa-a", label: "Alpha chart" }, { id: "coa-b", label: "" }];
      expect(coaChoice(undefined, "demo-coa-v1", coas)).toBe("coa-a");
      expect(coaChoice(undefined, "coa-b", coas)).toBe("coa-b");
      expect(coaChoice(undefined, null, coas)).toBe("coa-a");
      expect(coaChoice("coa-b", "demo-coa-v1", coas)).toBe("coa-b");
      expect(coaChoice(undefined, "demo-coa-v1", [])).toBe("demo-coa-v1");
      expect(coaChoice(undefined, null, [])).toBe("");
      const html = view({ model: { ...importFormModel(HEAD), coaId: "gone-coa" } });
      expect(html).toMatch(/<option value="coa-a" selected="">/);
    });

    it("an empty list falls back to the free-text input with the hint", () => {
      const html = view({ coas: [] });
      expect(html).not.toMatch(/<select[^>]*aria-label="Chart of accounts id"/);
      expect(html).toMatch(/<input[^>]*aria-label="Chart of accounts id"[^>]*value="demo-coa-v1"/);
      expect(text(html)).toContain("Type the chart of accounts id.");
    });

    it("the off button names what is missing; with a file and a name there is no such sentence", () => {
      expect(importBlock({ file: null, by: "", busy: false })).toBe("Choose a file and enter a name.");
      expect(importBlock({ file: null, by: "Chih", busy: false })).toBe("Choose a file.");
      expect(importBlock({ file: "b.csv", by: " ", busy: false })).toBe("Enter a name.");
      expect(importBlock({ file: "b.csv", by: "Chih", busy: false })).toBeNull();
      expect(importBlock({ file: null, by: "", busy: true })).toBeNull();
      // The stored charts are read first: the loading sentence comes before the file and name checks.
      expect(importBlock({ file: null, by: "", busy: false, coasLoading: true })).toBe("Reading the charts of accounts.");
      expect(importBlock({ file: "b.csv", by: "Chih", busy: false, coasLoading: true })).toBe("Reading the charts of accounts.");
      expect(importBlock({ file: "b.csv", by: "Chih", busy: false, coasLoading: false })).toBeNull();
      expect(importBlock({ file: "b.csv", by: "Chih", busy: true, coasLoading: true })).toBeNull();
      const reading = view({ coas: "loading" });
      expect(text(reading)).toContain("Reading the charts of accounts.");
      expect(reading).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Import positions<\/button>/);
      const off = view({ file: null, by: "" });
      expect(text(off)).toContain("Choose a file and enter a name.");
      expect(off).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Import positions<\/button>/);
      const on = view();
      expect(text(on)).not.toContain("Choose a file");
      expect(on).not.toMatch(/<button[^>]*aria-disabled="true"[^>]*>Import positions<\/button>/);
    });
  });
});
