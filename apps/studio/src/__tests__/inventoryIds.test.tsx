/**
 * Govern ids break only at a word joint (ALM Studio Polish 6 T3; Task 6 fix I1, ruling). The inventory
 * keeps Consumes and Produces as the stored lists; the view prints each id, with the comma that follows it, as one
 * unit, joined to the next by a space. Inside a unit a line may break only at a word joint: after a hyphen, or before
 * a capital that follows a lowercase letter or a digit, each marked by a wbr. Kind is one such unit. An id never
 * breaks inside a word: no rule lets a line break anywhere. Markup and rule texts are restated here; the drive counts
 * the lines each piece takes and checks the table fits its card at 1440 px.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginCatalogReply } from "@alm/reader";
import { idPieces } from "../govern/governModels";
import { InventoryView } from "../pages/govern/GovernPages";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
const COMPONENTS_CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
const TOKENS_CSS = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");

describe("idPieces, an id's word joints", () => {
  it("splits after each hyphen", () => {
    expect(idPieces("contractual-cashflow")).toEqual(["contractual-", "cashflow"]);
    expect(idPieces("balance-new-business")).toEqual(["balance-", "new-", "business"]);
  });
  it("splits before a capital that follows a lowercase letter or a digit", () => {
    expect(idPieces("MoneynessConstruction")).toEqual(["Moneyness", "Construction"]);
    expect(idPieces("DiscountFactorPath")).toEqual(["Discount", "Factor", "Path"]);
    expect(idPieces("v2Result")).toEqual(["v2", "Result"]);
  });
  it("keeps a word whole: one word, an acronym, a leading or trailing hyphen", () => {
    expect(idPieces("curve")).toEqual(["curve"]);
    expect(idPieces("Wal")).toEqual(["Wal"]);
    expect(idPieces("EVE")).toEqual(["EVE"]);
    expect(idPieces("-lead")).toEqual(["-", "lead"]);
    expect(idPieces("trail-")).toEqual(["trail-"]);
  });
  it("cuts once where a hyphen meets a capital, after each of two hyphens, and keeps an empty id whole (Polish 7 T1)", () => {
    expect(idPieces("a-B")).toEqual(["a-", "B"]);
    expect(idPieces("x--y")).toEqual(["x-", "-", "y"]);
    expect(idPieces("")).toEqual([""]);
  });
});

describe("the Govern inventory's ids", () => {
  it("print each id with its comma as one unit, joined by a space, a wbr at each word joint, and Kind as one unit", () => {
    const reply = {
      components: [{ id: "alm-nii", kind: "contractual-cashflow", label: "NII", consumes: ["CashflowSet", "DiscountFactorPath", "MarketSnapshot"], produces: ["NiiResult"] }],
      stageKinds: [],
      mounted: [],
    } as unknown as PluginCatalogReply;
    const html = renderToStaticMarkup(<InventoryView reply={reply} />);
    // Kind is one unit on the Component cell's meta line, in a mono span, then the role (Polish 8 T1), each after its
    // visually hidden label (Polish 9).
    expect(html).toContain('<span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">contractual-<wbr/>cashflow</span></span> · <span class="sr-only">Role: </span><span class="muted">None</span></span>');
    expect(html).toContain(
      '<td class="mono wrap"><span class="unit">Cashflow<wbr/>Set,</span> <span class="unit">Discount<wbr/>Factor<wbr/>Path,</span> <span class="unit">Market<wbr/>Snapshot</span></td><td class="mono wrap"><span class="unit">Nii<wbr/>Result</span></td>',
    );
  });
  it("let a unit break at its wbr, never anywhere, and print the meta and Purpose lines as 13 px blocks in the body weight (Polish 8 T1)", () => {
    expect(APP_CSS).toContain(".table td.mono.wrap { white-space: normal; min-width: 14ch; }");
    // A nowrap unit would suppress its wbr joints.
    expect(APP_CSS).not.toMatch(/\.unit[^{}]*\{[^}]*white-space: nowrap/);
    expect(APP_CSS).not.toMatch(/td\.mono\.wrap[^{}]*\{[^}]*overflow-wrap/);
    expect(APP_CSS).not.toMatch(/\.unit[^{}]*\{[^}]*(overflow-wrap|word-break)/);
    // 13 px, one step under the 14 px name (ruling 2026-09-29); Purpose keeps a measured measure and avoids a lone
    // last word where the browser can.
    expect(TOKENS_CSS).toContain("--fs-1: 12px; --fs-2: 13px; --fs-3: 14px;");
    expect(APP_CSS).toContain(".table td .inv-meta, .table td .purpose { display: block; margin-top: var(--sp-1); font-size: var(--fs-2); font-weight: 400; }");
    expect(APP_CSS).toContain(".table td .purpose { max-width: 52ch; text-wrap: pretty; }");
    expect(APP_CSS).not.toContain("td.purpose");
  });
});

describe("the Govern inventory's Component cell (Polish 7 T2, Polish 8 T1)", () => {
  it("prints four columns; the Component cell holds the name and id, a meta line with the kind and the role, then Purpose", () => {
    const reply = {
      components: [
        { id: "alm-nii", kind: "measure", label: "NII", role: "stage", purpose: "Aggregate NII", consumes: [], produces: [] },
        { id: "alm-ftp", kind: "metric", label: "FTP", consumes: [], produces: [] },
      ],
      stageKinds: [],
      mounted: [],
    } as unknown as PluginCatalogReply;
    const html = renderToStaticMarkup(<InventoryView reply={reply} />);
    expect(html).toContain('<thead><tr><th scope="col">Component</th><th scope="col">Status</th><th scope="col">Consumes</th><th scope="col">Produces</th></tr></thead>');
    expect(html).toContain('<th scope="row">NII <span class="mono muted inv-id">alm-nii</span><span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">measure</span></span> · <span class="sr-only">Role: </span>stage</span><span class="muted purpose">Aggregate NII</span></th>');
    // No role and no purpose: the role prints the muted None as the Role column did, and Purpose prints None.
    expect(html).toContain('<th scope="row">FTP <span class="mono muted inv-id">alm-ftp</span><span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">metric</span></span> · <span class="sr-only">Role: </span><span class="muted">None</span></span><span class="muted purpose">None</span></th>');
    // Two rows of four cells each, the Component cell a row header (Row header scope): 2 row headers, 6 data cells;
    // Kind and Role are no longer columns.
    expect(html.match(/<th scope="row"/g)?.length).toBe(2);
    expect(html.match(/<td/g)?.length).toBe(6);
    expect(html).not.toContain(">Kind</th>");
    expect(html).not.toContain(">Role</th>");
  });
});

describe("the Govern inventory's row alignment (Polish 7 Task 4 I1)", () => {
  it("sets each body cell on the row's first baseline, on the inventory table only", () => {
    const reply = {
      components: [{ id: "alm-nii", kind: "measure", label: "NII", purpose: "Aggregate NII", consumes: [], produces: [] }],
      stageKinds: [],
      mounted: [],
    } as unknown as PluginCatalogReply;
    const html = renderToStaticMarkup(<InventoryView reply={reply} />);
    expect(html).toContain('<div class="table-wrap"><table class="table inventory"><thead>');
    expect(APP_CSS).toContain(".inventory td { vertical-align: baseline; }");
    // No other table moves: the shared cell rule sets no alignment, and app.css holds only the By kind header's, this
    // one, its twin for the Component row header (Row header scope) and the By kind family row header's middle line,
    // which keeps that body cell off the header band's floor (Row header scope 2).
    expect(COMPONENTS_CSS).not.toMatch(/\.table td \{[^}]*vertical-align/);
    // Rules, not comments: a comment that names the property changes no count (Polish 8 T3).
    const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules("/* vertical-align: top */ .x { top: 0; }").match(/vertical-align\s*:/g)).toBeNull();
    expect(rules(APP_CSS).match(/vertical-align\s*:/g)?.length).toBe(4);
    expect(APP_CSS).toContain(".inventory tbody th { vertical-align: baseline; }");
    expect(APP_CSS).toContain(".by-kind th { vertical-align: bottom; }");
    expect(APP_CSS).toContain(".by-kind tbody th { vertical-align: middle; }");
  });
});

describe("the Govern inventory's Component id, kind and meta labels (Polish 9, ruling 2026-09-29)", () => {
  const reply = {
    components: [
      { id: "alm-market-data", kind: "contractual-cashflow", label: "Market data", role: "stage", purpose: "Load quotes", consumes: [], produces: [] },
      { id: "alm-ftp", kind: "metric", label: "FTP", consumes: [], produces: [] },
    ],
    stageKinds: [],
    mounted: [],
  } as unknown as PluginCatalogReply;
  const rules = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("prints the id as one unbroken span: the inv-id class, no wbr inside it, and a nowrap rule scoped to the inventory", () => {
    const html = renderToStaticMarkup(<InventoryView reply={reply} />);
    expect(html).toContain('<th scope="row">Market data <span class="mono muted inv-id">alm-market-data</span><span class="muted inv-meta">');
    expect(html).toContain('<th scope="row">FTP <span class="mono muted inv-id">alm-ftp</span><span class="muted inv-meta">');
    // A long id drops whole to its own line; it carries no wbr joint, so nothing lets it break at a hyphen.
    expect(html).not.toMatch(/inv-id">[^<]*<wbr/);
    expect(rules(APP_CSS)).toContain(".inventory .inv-id { white-space: nowrap; }");
    // No media query and no column width comes with it above 900 px (the column rebalance was rejected). Up to
    // 900 px the phone block lets the id break at its hyphens, never inside a word, since a 160 px pinned column
    // cannot hold the longest id on one line (phone 1 final review Finding 2); that is its one other mention.
    const phone = "@media (max-width: 900px) {";
    const at = APP_CSS.indexOf(phone);
    const desk = rules(APP_CSS.slice(0, at));
    expect(desk).not.toMatch(/@media[^{]*\{[^}]*inv-id/);
    expect(desk.match(/inv-id/g)?.length).toBe(1);
    expect(rules(APP_CSS.slice(at)).match(/[^{}]*inv-id[^{}]*\{[^}]*\}/g)?.map((r) => r.replace(/\s+/g, " ").trim())).toEqual([".inventory .inv-id { white-space: normal; overflow-wrap: anywhere; }"]);
  });

  it("prints the kind at 12 px, the port ids' size, while the meta line and Purpose stay 13 px", () => {
    expect(TOKENS_CSS).toContain("--fs-1: 12px; --fs-2: 13px; --fs-3: 14px;");
    expect(rules(APP_CSS)).toContain(".inv-meta .mono { font-size: var(--fs-1); }");
    expect(COMPONENTS_CSS).toContain(".table td.mono, .table td.words { white-space: nowrap; font-size: var(--fs-1); }");
    expect(rules(APP_CSS)).toContain(".table td .inv-meta, .table td .purpose { display: block; margin-top: var(--sp-1); font-size: var(--fs-2); font-weight: 400; }");
  });

  it("labels the kind and the role for a screen reader with visually hidden Kind: and Role: spans, the role's None included", () => {
    const html = renderToStaticMarkup(<InventoryView reply={reply} />);
    expect(html).toContain('<span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">contractual-<wbr/>cashflow</span></span> · <span class="sr-only">Role: </span>stage</span>');
    expect(html).toContain('<span class="muted inv-meta"><span class="sr-only">Kind: </span><span class="mono"><span class="unit">metric</span></span> · <span class="sr-only">Role: </span><span class="muted">None</span></span>');
    // The house visually hidden class, from components.css.
    expect(COMPONENTS_CSS).toContain(".sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }");
  });
});
