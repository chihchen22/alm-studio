// apps/studio/src/__tests__/fundingSpreadShocksPage.test.tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DerivedMarketPreview, MarketListItem } from "@alm/reader";
import { FundingSpreadShocksView, FUNDING_SPREAD_COPY, type FundingSpreadShocksViewProps } from "../pages/scenarios/FundingSpreadShocksPage";
import { addFundingOp, emptyFundingShockDraft, setFundingBase, setFundingOpField, type FundingShockDraft } from "../scenarios/fundingSpreadShockModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

/** The seven paragraphs, restated verbatim from the approved design. Re-expectation: the third paragraph names a funding spread shock and adds the rate indices sentence. */
const COPY = [
  "Derive a new market snapshot from a stored one: pick a base market, then add basis points to, or scale, its term liquidity premium (TLP) nodes, at every node or at one tenor. The server derives the snapshot and stores it under its own id with a record of its base and its ops. Nothing runs here: attach the derived market on Market > Yield curves and name it as a run setup's Market on Run > Setups.",
  "Add is in basis points: 50 adds 0.50 percentage points to each node it reaches. Scale multiplies the stored spread by a factor greater than 0: 1.5 is fifty percent wider. Results are kept to 12 significant digits. The node at t = 0 stays pinned at 0 and no op reaches it, so the curve still rises from 0 to the first tenor. Every other node must stay greater than 0, the rule the workbook import applies. No op adds or removes a node.",
  "The risk-free curve and the volatility surfaces are copied unchanged. The term-funding quotes are not carried: their tie to the TLP depends on how the base was built, which the stored snapshot does not record, and no run reads them, so a funding spread shock stores none rather than quotes that disagree with its TLP. Rate indices the base carries are copied unchanged.",
  "A TLP shock moves EVE on the all-in discount basis (risk-free plus TLP) and FTP: the all-in transfer rate and the liquidity premium charge and credit. It does not move NII, the cash flows or the gaps, which read no TLP. Swap legs discount on the risk-free curve alone, so their present value does not move.",
  "The TLP stays static across the rate scenarios inside one run. Base against shock is two runs, one on each market, compared on Compare runs; attribution inside a run has no funding driver and cannot split out the TLP move.",
  // Re-expectation: volatility shocks are built; the sentence points to Volatility shocks instead of saying Not built.
  "Volatility shocks are derived markets too, on Volatility shocks; they move stochastic runs only, and no deterministic result reads a volatility.",
  "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
];

const MARKETS: MarketListItem[] = [
  { id: "market-public-2026-03-31", label: "Public market pack", calibrationDate: "2026-03-31" },
  { id: "tlp-shock-demo-v1", label: "TLP +50 bp on every node of the public market pack (demonstration values)", calibrationDate: "2026-03-31", derivedFromMarketId: "market-public-2026-03-31" },
];

const BASE = {
  tlpNodes: [
    { tYears: 0, spread: 0 }, { tYears: 0.083333, spread: 0.002 }, { tYears: 0.25, spread: 0.002 }, { tYears: 0.5, spread: 0.0025 },
    { tYears: 1, spread: 0.0025 }, { tYears: 2, spread: 0.003 }, { tYears: 3, spread: 0.0035 }, { tYears: 5, spread: 0.0045 },
    { tYears: 7, spread: 0.0055 }, { tYears: 10, spread: 0.0065 }, { tYears: 20, spread: 0.009 }, { tYears: 30, spread: 0.01 },
  ],
};

function draftWithOp(): FundingShockDraft {
  const d = addFundingOp(setFundingBase(emptyFundingShockDraft(), "market-public-2026-03-31"));
  return setFundingOpField(d, 0, { op: "add", valueText: "50" });
}

const props = (over: Partial<FundingSpreadShocksViewProps> = {}): FundingSpreadShocksViewProps => ({
  markets: MARKETS,
  base: BASE,
  baseNote: null,
  draft: draftWithOp(),
  block: null,
  preview: null,
  note: null,
  busy: null,
  planLink: null,
  onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  ...over,
});

/** The V1 preview, restated: add 50 bp on the 11 nodes above zero. */
const PREVIEW: DerivedMarketPreview = {
  id: "derived-mk-cc5f69059269",
  label: "Funding spread shock on market-public-2026-03-31 (demonstration values)",
  snapshot: {} as DerivedMarketPreview["snapshot"],
  changes: BASE.tlpNodes.slice(1).map((n, i) => ({
    nodeIndex: i + 1, tYears: n.tYears, from: n.spread, to: Math.round((n.spread + 0.005) * 1e12) / 1e12, changeBp: 50, ops: [0],
  })),
  indexChanges: [],
  volChanges: [],
  termFundingQuotesDropped: 11,
};

/** Each opening tag of a table header cell in a text, from the tag start to its first closing angle bracket; a thead is not one. Restated here, not imported from thScope.test. */
const thTags = (t: string): string[] => [...t.matchAll(/<th(?:>|[\s/][^>]*>)/g)].map((m) => m[0]);

describe("FundingSpreadShocksView copy", () => {
  it("prints each paragraph verbatim, matching the exported copy", () => {
    const t = text(renderToStaticMarkup(<FundingSpreadShocksView {...props()} />));
    for (const p of COPY) expect(t, p.slice(0, 40)).toContain(p);
    expect(Object.values(FUNDING_SPREAD_COPY)).toHaveLength(7);
    for (const p of Object.values(FUNDING_SPREAD_COPY)) expect(COPY).toContain(p);
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ preview: PREVIEW })} />);
    expect(html).not.toMatch(BANNED_CHARS);
    for (const f of ["../pages/scenarios/FundingSpreadShocksPage.tsx", "../scenarios/fundingSpreadShockModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
});

describe("FundingSpreadShocksView headers", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../pages/scenarios/FundingSpreadShocksPage.tsx", import.meta.url)), "utf8");
  it("the SOURCE holds exactly 13 header tags, each with scope=", () => {
    const tags = thTags(SRC);
    expect(tags).toHaveLength(13);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
  it("the tag reader finds a scoped header and skips thead", () => {
    expect(thTags('<thead><tr><th scope="col">A</th><th>B</th></tr></thead>')).toEqual(['<th scope="col">', "<th>"]);
  });
  it("every header in the rendered view carries scope=, whatever the row count", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ preview: PREVIEW })} />);
    const tags = thTags(html);
    expect(tags.length).toBeGreaterThan(13);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
});

describe("FundingSpreadShocksView form", () => {
  it("lists the base markets, the op row's choices and the help text", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props()} />);
    const t = text(html);
    expect(t).toContain("Derive a market");
    expect(t).toContain("market-public-2026-03-31: Public market pack (as of 2026-03-31)");
    expect(t).toContain("Every node except t = 0 (pinned at 0)");
    expect(t).toContain("1M, stored 0.2000%");
    expect(t).toContain("10Y, stored 0.6500%");
    expect(t).toContain("Add (bp)");
    expect(t).toContain("Scale by");
    expect(html).toContain('value="50"');
    expect(t).toContain("Basis points for Add, a factor above 0 for Scale by");
    expect(t).toContain("Leave empty for a label that names the base market");
    expect(t).toContain("Leave empty for the derived id");
    expect(t).toContain("Add an op");
  });
  it("the base nodes table lists each stored node, and the t = 0 row reads pinned at 0", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props()} />);
    const i = html.indexOf("<table", html.indexOf('aria-label="Derive a market"'));
    const t = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Tenor", "Stored spread"]) expect(t).toContain(h);
    expect(t).toContain("0Y pinned at 0");
    expect(t).toContain("1M 0.2000%");
    expect(t).toContain("30Y 1.0000%");
  });
  it("shows no base nodes table and no op rows until a base is read", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ base: null, baseNote: "Reading market market-public-2026-03-31" })} />);
    expect(text(html)).toContain("Reading market market-public-2026-03-31");
    // Only the stored shocks table remains: the derive card holds no table and no op editor while the base is read.
    expect(html.slice(0, html.indexOf('aria-label="Stored funding spread shocks"'))).not.toContain("<table");
    expect(text(html)).not.toContain("Add an op");
  });
  it("turns Preview and Save off by aria-disabled with the reason when blocked", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ block: "Enter a number" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Preview<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Save<\/button>/);
    expect(text(html)).toContain("Enter a number");
    expect(renderToStaticMarkup(<FundingSpreadShocksView {...props()} />)).not.toContain('aria-disabled="true"');
  });
});

describe("FundingSpreadShocksView preview", () => {
  it("prints the served spreads and change, and the dropped quote count in the foot", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ preview: PREVIEW })} />);
    expect(text(html)).toContain("Preview: derived-mk-cc5f69059269");
    const i = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const t = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Tenor", "Base spread", "Derived spread", "Change (bp)"]) expect(t).toContain(h);
    expect(t).toContain("1M 0.2000% 0.7000% 50");
    expect(t).toContain("30Y 1.0000% 1.5000% 50");
    expect(text(html)).toContain("Term-funding quotes: 11 not carried. Source: /api/market/derive/preview");
  });
  it("lists one row per changed node", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ preview: PREVIEW })} />);
    const i = html.indexOf("<tbody", html.indexOf('aria-label="Preview"'));
    const body = html.slice(i, html.indexOf("</tbody>", i));
    expect(body.match(/<tr/g)).toHaveLength(11);
  });
  it("shows no preview card when there is none", () => {
    expect(text(renderToStaticMarkup(<FundingSpreadShocksView {...props()} />))).not.toContain("Preview: ");
  });
});

describe("FundingSpreadShocksView notes", () => {
  it("lists every problem of a refusal", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ note: { kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[0]: first", "second problem"], savedId: null } })} />);
    const t = text(html);
    expect(t).toContain("ops[0]: first");
    expect(t).toContain("second problem");
    expect(html).toContain('role="alert"');
  });
  it("links a saved market to Market > Yield curves, where it is attached (Piece B, step B3a, decision 42)", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({
      note: { kind: "created", text: "Saved as derived-mk-cc5f69059269", problems: [], savedId: "derived-mk-cc5f69059269" },
      planLink: "#/ws/ws-a/market/curves",
    })} />);
    expect(html).toContain('href="#/ws/ws-a/market/curves"');
    expect(text(html)).toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
  it("a conflict prints the server text and no link", () => {
    // The link address is handed in, so the link is absent because nothing was saved, not because there was no address.
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ note: { kind: "conflict", text: "409: exists", problems: [], savedId: null }, planLink: "#/ws/ws-a/market/curves" })} />);
    const t = text(html);
    expect(t).toContain("409: exists");
    expect(html).not.toContain('href="#/ws/ws-a/market/curves"');
    expect(t).not.toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
});

describe("FundingSpreadShocksView stored table", () => {
  it("lists only the markets that carry derivedFromMarketId, with label, base and as-of", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props()} />);
    const t = text(html.slice(html.indexOf('aria-label="Stored funding spread shocks"')));
    for (const h of ["Market", "Label", "Base market", "As of"]) expect(t).toContain(h);
    expect(t).toContain("tlp-shock-demo-v1 TLP +50 bp on every node of the public market pack (demonstration values) market-public-2026-03-31 2026-03-31");
    expect(t).not.toContain("Public market pack");
  });
  it("says None stored when no market is derived", () => {
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...props({ markets: [MARKETS[0]!] })} />);
    expect(text(html.slice(html.indexOf('aria-label="Stored funding spread shocks"')))).toContain("None stored");
  });
});
