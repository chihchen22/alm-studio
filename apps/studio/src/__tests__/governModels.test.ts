import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, type CatalogLineage, type CatalogRunInputs, type CatalogRunListItem, type PluginCatalogReply } from "@alm/reader";
import { auditCell, auditPlan, auditRows, inventoryRows, planReadable } from "../govern/governModels";
import { AuditInputsUnobservable, AuditView, InventoryView, LineageUnobservable, LineageView } from "../pages/govern/GovernPages";

describe("inventoryRows", () => {
  it("marks a component Runs when its id or an alias is mounted", () => {
    const reply = {
      components: [
        { id: "alm-yield-curve", kind: "curve", label: "Yield curve", consumes: [], produces: [], role: "stage", purpose: "Bootstrap" },
        { id: "alm-draw-rate-model", kind: "behavioral", label: "Draw S-curve", consumes: [], produces: [] },
      ],
      stageKinds: [],
      mounted: [{ id: "engine.curve.bootstrap", aliases: ["alm-yield-curve", "engine.curve"], kind: "curve" }],
    } as unknown as PluginCatalogReply;
    expect(inventoryRows(reply).map((r) => [r.id, r.runs, r.role, r.purpose])).toEqual([
      ["alm-yield-curve", true, "stage", "Bootstrap"],
      ["alm-draw-rate-model", false, "", ""],
    ]);
  });

  it("keeps consumes and produces as the stored lists, an empty list empty (Polish 6 T3)", () => {
    const reply = {
      components: [
        { id: "alm-nii", kind: "measure", label: "NII", consumes: ["cashflows", "curve"], produces: ["nii"] },
        { id: "alm-market-data", kind: "input", label: "Market data", consumes: [], produces: [] },
      ],
      stageKinds: [],
      mounted: [{ id: "alm-nii", aliases: [], kind: "measure" }],
    } as unknown as PluginCatalogReply;
    expect(inventoryRows(reply).map((r) => [r.id, r.consumes, r.produces, r.runs])).toEqual([
      ["alm-nii", ["cashflows", "curve"], ["nii"], true],
      ["alm-market-data", [], [], false],
    ]);
  });
});

describe("auditRows", () => {
  it("sorts newest first, a run with no submittedAt last", () => {
    const runs = [
      { runId: "a", submittedAt: "2026-09-26T01:00:00Z" },
      { runId: "b", submittedAt: null },
      { runId: "c", submittedAt: "2026-09-26T05:00:00Z" },
    ] as unknown as CatalogRunListItem[];
    expect(auditRows(runs).map((r) => r.runId)).toEqual(["c", "a", "b"]);
  });

  it("does not reorder its input", () => {
    const runs = [
      { runId: "a", submittedAt: "2026-09-26T01:00:00Z" },
      { runId: "c", submittedAt: "2026-09-26T05:00:00Z" },
    ] as unknown as CatalogRunListItem[];
    auditRows(runs);
    expect(runs.map((r) => r.runId)).toEqual(["a", "c"]);
  });
});

describe("auditCell", () => {
  const row = (over: Partial<CatalogRunListItem>): CatalogRunListItem => ({
    runId: "r1", state: "done", label: null, submittedAt: "2026-09-26T01:00:00Z", endedAt: "2026-09-26T01:01:00Z",
    elapsedMs: 60000, platformRequestHash: "prh", engineInputsHash: "eih", resultContentHash: "rch", ...over,
  });

  it("prints a stored value verbatim", () => {
    expect(auditCell(row({}), "submittedAt")).toBe("2026-09-26T01:00:00Z");
    expect(auditCell(row({}), "endedAt")).toBe("2026-09-26T01:01:00Z");
    expect(auditCell(row({}), "engineInputsHash")).toBe("eih");
    expect(auditCell(row({}), "resultContentHash")).toBe("rch");
  });

  it("prints Unobservable with its reason, never blank", () => {
    expect(auditCell(row({ submittedAt: null }), "submittedAt")).toBe("Unobservable: no submit time recorded");
    expect(auditCell(row({ state: "running", endedAt: null }), "endedAt")).toBe("Unobservable: the run has not ended");
    expect(auditCell(row({ state: "done", endedAt: null }), "endedAt")).toBe("Unobservable: no end time recorded");
    expect(auditCell(row({ state: "queued", engineInputsHash: null }), "engineInputsHash")).toBe("Unobservable: the run has not compiled");
    expect(auditCell(row({ state: "error", engineInputsHash: null }), "engineInputsHash")).toBe("Unobservable: no engine inputs recorded");
    expect(auditCell(row({ state: "running", resultContentHash: null }), "resultContentHash")).toBe("Unobservable: the run has not finished");
    expect(auditCell(row({ state: "cancelled", resultContentHash: null }), "resultContentHash")).toBe("Unobservable: the run ended cancelled without a result");
    expect(auditCell(row({ state: "done", resultContentHash: null }), "resultContentHash")).toBe("Unobservable: no result stored");
  });
});

describe("auditPlan", () => {
  it("reads the plan id off the provenance in hand", () => {
    expect(auditPlan({ kind: "read", provenance: { planId: "PLAN-7" } })).toBe("PLAN-7");
  });

  it("prints Not in this run only when the provenance is in hand and carries no plan id", () => {
    expect(auditPlan({ kind: "read", provenance: {} })).toBe("Not in this run: the run was not submitted from a plan");
    expect(auditPlan({ kind: "read", provenance: { planId: null } })).toBe("Not in this run: the run was not submitted from a plan");
  });

  it("prints Unobservable with the row state's reason when the provenance was not read", () => {
    expect(auditPlan({ kind: "skipped", state: "running" })).toBe("Unobservable: the run has not finished");
    expect(auditPlan({ kind: "skipped", state: "queued" })).toBe("Unobservable: the run has not finished");
    expect(auditPlan({ kind: "skipped", state: "error" })).toBe("Unobservable: the run ended error without a result");
  });

  it("prints Unobservable with the load's own error when the read was refused", () => {
    expect(auditPlan({ kind: "failed", error: "409 STOCHASTIC_RUN: read /stochastic" })).toBe("Unobservable: 409 STOCHASTIC_RUN: read /stochastic");
  });
});

describe("planReadable", () => {
  it("reads the provenance of a done run only", () => {
    expect(["done", "running", "queued", "error", "cancelled"].map(planReadable)).toEqual([true, false, false, false, false]);
  });
});

describe("LineageView", () => {
  const lineage: CatalogLineage = {
    collection: "assumption-sets",
    id: "as-base",
    contentHash: "sha256:abc",
    consumedBy: [
      { runId: "run-1", role: "assumptions", state: "done", submittedAt: "2026-09-26T01:00:00Z", endedAt: null, pinnedContentHash: "sha256:abc" },
      { runId: "run-2", role: "assumptions", state: "queued", submittedAt: null, endedAt: null, pinnedContentHash: "sha256:abc" },
    ],
  };

  it("shows the content hash and every consuming run, a missing time with its reason", () => {
    const html = renderToStaticMarkup(createElement(LineageView, { lc: "assumption-sets", ids: ["as-base", "as-alt"], lid: "as-base", lineage, onPick: () => {} }));
    expect(html).toContain("sha256:abc");
    expect(html).toContain("run-1");
    expect(html).toContain("run-2");
    expect(html).toContain("2026-09-26T01:00:00Z");
    expect(html).toContain("Unobservable: no submit time recorded");
    // Each consuming run opens its row as a row header (Row header scope).
    expect(html).toContain('<tr><th scope="row" class="mono">run-1</th><td class="mono">assumptions</td>');
    expect(html).toContain('<tr><th scope="row" class="mono">run-2</th><td class="mono">assumptions</td>');
    expect(html).toContain("Source: /api/catalog/lineage/assumption-sets/as-base");
    expect(html).toContain("Run plans are not a run-consumable collection");
    expect(html).toContain(">Assumption sets<");
    expect(html).toContain(">Books<");
    expect(html).toContain(">as-alt<");
    expect(html).toContain('<p class="card-foot">The catalog is read from the server&#x27;s mirror. A book, snapshot, set or slate saved in Studio, and a run that reaches its end, sync into it at once, best effort; the server&#x27;s start and a seed reconcile it. A run or a set whose sync failed appears after the next start or seed.</p>');
  });

  it("says so when no run consumed the id, and when the collection holds no id", () => {
    const unused = renderToStaticMarkup(createElement(LineageView, { lc: "market", ids: ["m-1"], lid: "m-1", lineage: { ...lineage, collection: "market", id: "m-1", consumedBy: [] }, onPick: () => {} }));
    expect(unused).toContain("No run has consumed it.");
    const empty = renderToStaticMarkup(createElement(LineageView, { lc: "portfolios", ids: [], lid: undefined, lineage: null, onPick: () => {} }));
    expect(empty).toContain("The collection holds no stored id.");
  });
});

describe("InventoryView", () => {
  it("lists every component with its status chip, consumes and produces, None when empty", () => {
    const reply = {
      components: [
        { id: "alm-nii", kind: "measure", label: "NII", role: "stage", purpose: "Aggregate NII", consumes: ["cashflows", "curve"], produces: ["nii"] },
        { id: "alm-draw-rate-model", kind: "behavioral", label: "Draw S-curve", consumes: [], produces: [] },
      ],
      stageKinds: [],
      mounted: [{ id: "engine.nii", aliases: ["alm-nii"], kind: "measure" }],
    } as unknown as PluginCatalogReply;
    const html = renderToStaticMarkup(createElement(InventoryView, { reply }));
    expect(html).toContain('<th scope="col">Consumes</th>');
    expect(html).toContain('<th scope="col">Produces</th>');
    expect(html).toContain('<span class="unit">cashflows,</span> <span class="unit">curve</span>');
    expect(html).toContain(">nii<");
    expect(html).toContain("Aggregate NII");
    expect(html).toContain('<span class="chip chip-runs">Runs</span>');
    expect(html).toContain('<span class="chip chip-catalog">Catalog only</span>');
    // The second component's Role, Consumes and Produces; its Purpose is the Component cell's None line (Polish 7 T2).
    expect(html.match(/<span class="muted">None<\/span>/g)?.length).toBe(3);
    expect(html).toContain('<span class="mono muted inv-id">alm-draw-rate-model</span><span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">behavioral</span></span> · <span class="sr-only">Role: </span><span class="muted">None</span></span><span class="muted purpose">None</span></th>');
    expect(html).toContain("the route carries no model version");
    // Port lists wrap in their cell between ids and at an id's word joints only (app.css .table td.mono.wrap; Polish 6
    // T3, Task 6 fix I1); the kind (one unit) and the role are the Component cell's meta line, and Purpose its last line
    // (app.css .table td .inv-meta, .table td .purpose; Polish 7 T2, Polish 8 T1).
    expect(html).toContain('<td class="mono wrap"><span class="unit">cashflows,</span> <span class="unit">curve</span></td>');
    expect(html).toContain('<th scope="row">NII <span class="mono muted inv-id">alm-nii</span><span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">measure</span></span> · <span class="sr-only">Role: </span>stage</span><span class="muted purpose">Aggregate NII</span></th>');
    expect(html).not.toContain(">Purpose</th>");
    expect(html).not.toContain(">Kind</th>");
  });
});

describe("AuditView", () => {
  const runs = [
    { runId: "run-old", state: "done", label: "Base book", submittedAt: "2026-09-26T01:00:00Z", endedAt: "2026-09-26T01:02:00Z", elapsedMs: 120000, platformRequestHash: "prh-old", engineInputsHash: "eih-old", resultContentHash: "rch-old" },
    { runId: "run-new", state: "running", label: null, submittedAt: "2026-09-26T05:00:00Z", endedAt: null, elapsedMs: null, platformRequestHash: "prh-new", engineInputsHash: "eih-new", resultContentHash: null },
  ] as CatalogRunListItem[];

  it("lists runs newest first with every hash, missing values with their reason", () => {
    const html = renderToStaticMarkup(createElement(AuditView, { ws: "ws-a", runs, query: {}, open: undefined, opened: null }));
    expect(html.indexOf("run-new")).toBeLessThan(html.indexOf("run-old"));
    expect(html).toContain("prh-old");
    expect(html).toContain("eih-old");
    expect(html).toContain("rch-old");
    expect(html).toContain("Base book");
    expect(html).toContain('<span class="muted">No label</span>');
    expect(html).toContain("Unobservable: the run has not ended");
    expect(html).toContain("Unobservable: the run has not finished");
    expect(html).toContain('href="#/ws/ws-a/govern/audit?audit=run-old"');
    // Each run opens its row as a row header, its id still the link (Row header scope).
    expect(html).toContain('<th scope="row" class="mono"><a href="#/ws/ws-a/govern/audit?audit=run-old">run-old</a></th><td>Base book</td>');
    expect(html).not.toContain("Inputs of");
    expect(html).toContain('<p class="card-foot">The catalog is read from the server&#x27;s mirror. A book, snapshot, set or slate saved in Studio, and a run that reaches its end, sync into it at once, best effort; the server&#x27;s start and a seed reconcile it. A run or a set whose sync failed appears after the next start or seed.</p>');
  });

  it("an opened row shows its input hashes and its plan from the result provenance", () => {
    const inputs = {
      runId: "run-old", state: "done", seed: null, grid: null, engineContext: null, platformRequestHash: "prh-old",
      engineInputsHash: "eih-old", resultContentHash: "rch-old", resultBytes: 10, submittedAt: null, endedAt: null,
      inputs: [{ role: "portfolio", ord: 0, collection: "portfolios", id: "book-1", contentHash: "sha256:book" }],
    } as CatalogRunInputs;
    const html = renderToStaticMarkup(createElement(AuditView, {
      ws: "ws-a", runs, query: {}, open: "run-old", opened: { inputs, plan: { kind: "read", provenance: { planId: "PLAN-7" } } },
    }));
    expect(html).toContain("Inputs of run-old");
    expect(html).toContain("sha256:book");
    expect(html).toContain("book-1");
    expect(html).toContain("PLAN-7");
    expect(html).toContain("<dt>Plan</dt><dd class=\"mono\">PLAN-7</dd>");
    expect(html).toContain("Source: /api/catalog/runs/run-old/inputs; the plan from /api/runs/run-old/result/provenance planId.");
    expect(html).toContain('class="row-link is-selected"');
    // Each input opens its row on its role as a row header (Row header scope).
    expect(html).toContain('<tr><th scope="row" class="mono">portfolio</th><td class="mono">portfolios</td><td class="mono">book-1</td>');
  });

  it("an opened row that is not done prints its plan Unobservable with the reason", () => {
    const inputs = { runId: "run-new", inputs: [] } as unknown as CatalogRunInputs;
    const html = renderToStaticMarkup(createElement(AuditView, {
      ws: "ws-a", runs, query: {}, open: "run-new", opened: { inputs, plan: { kind: "skipped", state: "running" } },
    }));
    expect(html).toContain("<dt>Plan</dt><dd class=\"mono\">Unobservable: the run has not finished</dd>");
    expect(html).toContain("The run pinned no inputs.");
  });

  it("an opened row whose inputs read failed prints Unobservable with the server's reason, not its status text", () => {
    const err = new ApiError(404, "not-found", "run run-x is not mirrored in the platform database");
    const html = renderToStaticMarkup(createElement(AuditInputsUnobservable, { runId: "run-x", error: err }));
    expect(html).toBe(
      '<section class="card unobs-panel" aria-label="Run inputs"><div class="card-title">Inputs of run-x</div>'
      + '<span class="status status-unobs">Unobservable</span>'
      + '<p class="unobs-text">run run-x is not mirrored in the platform database</p>'
      + '<p class="card-foot">Source: /api/catalog/runs/run-x/inputs</p></section>',
    );
    expect(html).not.toContain("404");
    expect(renderToStaticMarkup(createElement(AuditInputsUnobservable, { runId: "run-x", error: new Error("fetch failed") }))).toContain('<p class="unobs-text">fetch failed</p>');
  });
});

describe("LineageUnobservable", () => {
  it("a lineage read that failed for one id prints Unobservable with the server's reason, not its status text", () => {
    const err = new ApiError(404, "not-found", "assumption-sets/set-new is not mirrored in the platform database");
    const html = renderToStaticMarkup(createElement(LineageUnobservable, { lc: "assumption-sets", lid: "set-new", error: err }));
    expect(html).toBe(
      '<section class="card unobs-panel" aria-label="Lineage"><div class="card-title">set-new</div>'
      + '<span class="status status-unobs">Unobservable</span>'
      + '<p class="unobs-text">assumption-sets/set-new is not mirrored in the platform database</p>'
      + '<p class="card-foot">Source: /api/catalog/lineage/assumption-sets/set-new</p></section>',
    );
    expect(html).not.toContain("404");
    expect(html).not.toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(LineageUnobservable, { lc: "market", lid: "m-1", error: new Error("fetch failed") }))).toContain('<p class="unobs-text">fetch failed</p>');
  });
  it("a non-JSON failure prints plain words, not the raw status line (Polish 1 F2)", () => {
    const err = new ApiError(502, "http-error", "502 Bad Gateway");
    const lineage = renderToStaticMarkup(createElement(LineageUnobservable, { lc: "market", lid: "m-1", error: err }));
    expect(lineage).toContain('<p class="unobs-text">The request failed with HTTP 502 and the reply gave no reason.</p>');
    expect(lineage).not.toContain("502 Bad Gateway");
    const audit = renderToStaticMarkup(createElement(AuditInputsUnobservable, { runId: "run-x", error: err }));
    expect(audit).toContain('<p class="unobs-text">The request failed with HTTP 502 and the reply gave no reason.</p>');
    expect(audit).not.toContain("502 Bad Gateway");
  });
});

describe("every Govern column header is a column header (Polish 9, ruling 2026-09-29)", () => {
  const theadOf = (html: string) => [...html.matchAll(/<thead>[\s\S]*?<\/thead>/g)].map((m) => m[0]);

  it("sets scope col on each header of the inventory, lineage, audit and run inputs tables", () => {
    const inv = renderToStaticMarkup(createElement(InventoryView, { reply: { components: [], stageKinds: [], mounted: [] } as unknown as PluginCatalogReply }));
    expect(theadOf(inv)).toEqual(['<thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Consumes</th><th scope="col">Produces</th></tr></thead>']);

    const lineage: CatalogLineage = {
      collection: "assumption-sets", id: "as-base", contentHash: "sha256:abc",
      consumedBy: [{ runId: "run-1", role: "assumptions", state: "done", submittedAt: null, endedAt: null, pinnedContentHash: "sha256:abc" }],
    };
    const lin = renderToStaticMarkup(createElement(LineageView, { lc: "assumption-sets", ids: ["as-base"], lid: "as-base", lineage, onPick: () => {} }));
    expect(theadOf(lin)).toEqual(['<thead><tr><th scope="col">Run</th><th scope="col">Role</th><th scope="col">State</th><th scope="col">Submitted</th><th scope="col">Pinned hash</th></tr></thead>']);

    const runs = [{ runId: "run-1", state: "done", label: null, submittedAt: null, endedAt: null, elapsedMs: null, platformRequestHash: "prh", engineInputsHash: null, resultContentHash: null }] as CatalogRunListItem[];
    const inputs = { runId: "run-1", inputs: [{ role: "portfolio", ord: 0, collection: "portfolios", id: "book-1", contentHash: "sha256:book" }] } as unknown as CatalogRunInputs;
    const aud = renderToStaticMarkup(createElement(AuditView, { ws: "ws-a", runs, query: {}, open: "run-1", opened: { inputs, plan: { kind: "skipped", state: "done" } } }));
    expect(theadOf(aud)).toEqual([
      '<thead><tr><th scope="col">Run</th><th scope="col">Label</th><th scope="col">State</th><th scope="col">Submitted</th><th scope="col">Ended</th><th scope="col">Request hash</th><th scope="col">Inputs hash</th><th scope="col">Result hash</th></tr></thead>',
      '<thead><tr><th scope="col">Role</th><th scope="col">Collection</th><th scope="col">Id</th><th scope="col">Content hash</th></tr></thead>',
    ]);
  });
});
