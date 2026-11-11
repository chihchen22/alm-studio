// apps/studio/src/__tests__/volatilityShocksPage.test.tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { DerivedMarketPreview, MarketListItem } from "@alm/reader";
import { VolatilityShocksView, VOLATILITY_SHOCK_COPY, type VolatilityShocksViewProps } from "../pages/scenarios/VolatilityShocksPage";
import { addVolOp, emptyVolShockDraft, setVolBase, setVolOpField, type VolShockDraft } from "../scenarios/volatilityShockModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

/** The eight paragraphs, restated verbatim from the approved design, in the order the card prints them. */
const COPY = [
  "Derive a new market snapshot from a stored one: pick a base market, then scale, or add basis points to, its constructed short-rate volatilities, at every expiry or at one. The server derives the snapshot and stores it under its own id with a record of its base and its ops. Nothing runs here.",
  "Scale multiplies every stored volatility in an expiry row by a factor from 0.25 to 4: 1.5 is fifty percent higher. Add is in basis points of normal volatility: 10 adds 10 bp to every strike in the row. Results are kept to 12 significant digits. Every volatility must stay above 0 and below 500 bp (0.05), the ceiling of the Hull-White sigma the calibration fits. No op adds or removes an expiry or a strike.",
  "These volatilities are a constructed illustrative analog on the short rate (realized Treasury yield volatility times a stated premium), for education. They are not market quotes. The long-yield volatility surface is copied unchanged; no op here shocks it.",
  "Stochastic runs only. A Hull-White stochastic run calibrates the mean reversion a and volatility sigma to the at-the-money column, so a shock moves a, sigma and the fit error, and through them the width of the EVE distribution. The 12-month NII distribution widens only where the book carries income that depends on the rate path within the 12-month horizon; on the seeded vanilla book that income is path independent and its distribution does not move. The strike wings move with the at-the-money column and no run reads them. A uniform scale multiplies sigma by the same factor and leaves a unchanged; an add, or a change at one expiry, reshapes the term structure and moves a as well.",
  "Deterministic results do not move: rate scenarios still shift the zero curve only, and no deterministic number reads a volatility. A plan run on a volatility-shocked market returns the base market's numbers.",
  "Studio does not run stochastic runs. Run the derived market and its base market in stochastic mode on the workbench Run page with the same seed and path count. Stochastic distributions shows each run's envelope: the calibrated a and sigma, the fit error against the 5 bp gate, and the EVE and 12-month NII distributions. Compare runs then sets the two envelopes side by side: the calibrated a and sigma, the fit error against the 5 bp gate, and each statistic of the EVE and 12-month NII distributions with B - A labelled derived. Both pages download a CSV. A stochastic run that supplies its own Hull-White parameters (modelParams) on a volatility-shocked market is refused, because it would skip the calibration and ignore the shock. A BGM run on a volatility-shocked market is refused: BGM calibrates to the long-yield volatility surface, which no op here shocks, so the shock would be silently ignored. Run Hull-White on the derived market, or BGM on its unshocked base.",
  "The risk-free curve, the TLP nodes, the term-funding quotes and any rate indices are copied unchanged.",
  "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
];

const MARKETS: MarketListItem[] = [
  { id: "market-public-2026-03-31", label: "Public market pack", calibrationDate: "2026-03-31" },
  { id: "vol-shock-demo-v1", label: "Constructed short-rate volatilities times 1.5 at every expiry of the public market pack (demonstration values)", calibrationDate: "2026-03-31", derivedFromMarketId: "market-public-2026-03-31" },
];

const BASE = {
  capQuotes: [
    { expiryYears: 1, strike: 0.02, normalVol: 0.0066, isAtm: false },
    { expiryYears: 1, strike: null, normalVol: 0.006345, isAtm: true },
    { expiryYears: 2, strike: null, normalVol: 0.006212, isAtm: true },
    { expiryYears: 30, strike: null, normalVol: 0.005444, isAtm: true },
  ],
};

function draftWithOp(): VolShockDraft {
  const d = addVolOp(setVolBase(emptyVolShockDraft(), "market-public-2026-03-31"));
  return setVolOpField(d, 0, { valueText: "1.5" });
}

const props = (over: Partial<VolatilityShocksViewProps> = {}): VolatilityShocksViewProps => ({
  markets: MARKETS, base: BASE, baseNote: null, draft: draftWithOp(), block: null, preview: null, note: null, busy: null, planLink: null,
  onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  ...over,
});

/** A fixed preview reply: the 1Y row of the x1.5 scale on the public pack (63.45 to 95.175 bp, 31.725 bp, 26 quotes), then 2Y and a row with no at-the-money quote. */
const PREVIEW: DerivedMarketPreview = {
  id: "derived-mk-fdb4bee2e09a",
  label: "Short-rate volatility shock on market-public-2026-03-31 (demonstration values)",
  snapshot: {} as DerivedMarketPreview["snapshot"],
  changes: [],
  indexChanges: [],
  volChanges: [
    { expiryYears: 1, quotes: 26, quotesChanged: 26, atmFrom: 0.006345, atmTo: 0.0095175, atmChangeBp: 31.725, ops: [0] },
    { expiryYears: 2, quotes: 26, quotesChanged: 26, atmFrom: 0.006212, atmTo: 0.009318, atmChangeBp: 31.06, ops: [0] },
  ],
  termFundingQuotesDropped: 0,
};

const thTags = (t: string): string[] => [...t.matchAll(/<th(?:>|[\s/][^>]*>)/g)].map((m) => m[0]);

describe("VolatilityShocksView copy", () => {
  it("prints each of the eight paragraphs verbatim, matching the exported copy", () => {
    const t = text(renderToStaticMarkup(<VolatilityShocksView {...props()} />));
    for (const p of COPY) expect(t, p.slice(0, 40)).toContain(p);
    expect(Object.values(VOLATILITY_SHOCK_COPY)).toHaveLength(8);
    for (const p of Object.values(VOLATILITY_SHOCK_COPY)) expect(COPY).toContain(p);
  });
  it("says that a BGM run refuses a shocked market, and no longer that no run reads the long-yield surface", () => {
    expect(VOLATILITY_SHOCK_COPY.where).toContain("A BGM run on a volatility-shocked market is refused");
    expect(Object.values(VOLATILITY_SHOCK_COPY).join(" ")).not.toContain("no run reads it");
  });
  it("qualifies the NII claim: EVE width moves, NII only on path-dependent income", () => {
    expect(VOLATILITY_SHOCK_COPY.measures).toContain("the width of the EVE distribution");
    expect(VOLATILITY_SHOCK_COPY.measures).toContain("on the seeded vanilla book that income is path independent");
  });
  it("never calls the volatilities cap or swaption quotes; the only 'market quote' is the denial", () => {
    const t = text(renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />)).toLowerCase();
    expect(t).not.toContain("cap quote");
    expect(t).not.toContain("swaption quote");
    expect(t.match(/market quote/g) ?? []).toHaveLength(1);
    expect(t).toContain("they are not market quotes.");
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />);
    expect(html).not.toMatch(BANNED_CHARS);
    for (const f of ["../pages/scenarios/VolatilityShocksPage.tsx", "../scenarios/volatilityShockModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
  it("carries no inline style attribute, in markup or in source", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />);
    expect(html).not.toContain("style=");
    expect(readFileSync(new URL("../pages/scenarios/VolatilityShocksPage.tsx", import.meta.url), "utf8")).not.toMatch(/style=\{/);
  });
});

describe("VolatilityShocksView headers", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../pages/scenarios/VolatilityShocksPage.tsx", import.meta.url)), "utf8");
  it("the SOURCE holds exactly 14 header tags, each with scope=", () => {
    const tags = thTags(SRC);
    expect(tags).toHaveLength(14);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
  it("every header in the rendered view carries scope=", () => {
    const tags = thTags(renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />));
    expect(tags.length).toBeGreaterThan(14);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
});

describe("VolatilityShocksView form", () => {
  it("lists the base markets, the op row's choices and the help text", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props()} />);
    const t = text(html);
    expect(t).toContain("Derive a market");
    expect(t).toContain("market-public-2026-03-31: Public market pack (as of 2026-03-31)");
    expect(t).toContain("Every expiry");
    expect(t).toContain("1Y, stored 63.45 bp");
    expect(t).toContain("30Y, stored 54.44 bp");
    expect(t).toContain("Scale by");
    expect(t).toContain("Add (bp)");
    expect(html).toContain('value="1.5"');
    expect(t).toContain("A factor from 0.25 to 4 for Scale by, basis points for Add");
    expect(t).toContain("Leave empty for a label that names the base market");
    expect(t).toContain("Add an op");
  });
  it("the base table lists the at-the-money column only, in basis points", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props()} />);
    const i = html.indexOf("<table", html.indexOf('aria-label="Derive a market"'));
    const t = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Expiry", "Stored ATM vol (bp)"]) expect(t).toContain(h);
    expect(t).toContain("1Y 63.45");
    expect(t).toContain("30Y 54.44");
    expect(t).not.toContain("66");
  });
  it("shows no base table and no op rows until a base is read", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ base: null, baseNote: "Reading market market-public-2026-03-31" })} />);
    expect(text(html)).toContain("Reading market market-public-2026-03-31");
    expect(html.slice(0, html.indexOf('aria-label="Stored derived markets"'))).not.toContain("<table");
    expect(text(html)).not.toContain("Add an op");
  });
  it("turns Preview and Save off by aria-disabled with the reason when blocked", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ block: "Enter a number" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Preview<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Save<\/button>/);
    expect(text(html)).toContain("Enter a number");
    expect(renderToStaticMarkup(<VolatilityShocksView {...props()} />)).not.toContain('aria-disabled="true"');
  });
});

describe("VolatilityShocksView preview", () => {
  it("prints the served volatilities, the change and the quotes moved, and the foot", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />);
    expect(text(html)).toContain("Preview: derived-mk-fdb4bee2e09a");
    const i = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const t = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Expiry", "Base ATM vol (bp)", "Derived ATM vol (bp)", "Change (bp)", "Quotes moved"]) expect(t).toContain(h);
    expect(t).toContain("1Y 63.45 95.175 31.725 26");
    expect(t).toContain("2Y 62.12 93.18 31.06 26");
    expect(text(html)).toContain("Long-yield grid copied unchanged. Source: /api/market/derive/preview");
  });
  it("lists one row per expiry row the server returned", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ preview: PREVIEW })} />);
    const i = html.indexOf("<tbody", html.indexOf('aria-label="Preview"'));
    expect(html.slice(i, html.indexOf("</tbody>", i)).match(/<tr/g)).toHaveLength(2);
  });
  it("shows no preview card when there is none", () => {
    expect(text(renderToStaticMarkup(<VolatilityShocksView {...props()} />))).not.toContain("Preview: ");
  });
});

describe("VolatilityShocksView notes", () => {
  it("lists every problem of a refusal", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ note: { kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[0]: first", "second problem"], savedId: null } })} />);
    const t = text(html);
    expect(t).toContain("ops[0]: first");
    expect(t).toContain("second problem");
    expect(html).toContain('role="alert"');
  });
  it("links a saved market to Market > Yield curves, where it is attached (Piece B, step B3a, decision 42)", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({
      note: { kind: "created", text: "Saved as derived-mk-fdb4bee2e09a", problems: [], savedId: "derived-mk-fdb4bee2e09a" },
      planLink: "#/ws/ws-a/market/curves",
    })} />);
    expect(html).toContain('href="#/ws/ws-a/market/curves"');
    expect(text(html)).toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
  it("a conflict prints the server text and no link", () => {
    // The link address is handed in, so the link is absent because nothing was saved, not because there was no address.
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ note: { kind: "conflict", text: "409: exists", problems: [], savedId: null }, planLink: "#/ws/ws-a/market/curves" })} />);
    const t = text(html);
    expect(t).toContain("409: exists");
    expect(html).not.toContain('href="#/ws/ws-a/market/curves"');
    expect(t).not.toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
});

describe("VolatilityShocksView stored table", () => {
  it("lists only the markets that carry derivedFromMarketId, with label, base and as-of", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props()} />);
    const t = text(html.slice(html.indexOf('aria-label="Stored derived markets"')));
    for (const h of ["Market", "Label", "Base market", "As of"]) expect(t).toContain(h);
    expect(t).toContain("vol-shock-demo-v1 Constructed short-rate volatilities times 1.5 at every expiry of the public market pack (demonstration values) market-public-2026-03-31 2026-03-31");
    expect(t).not.toContain("Public market pack");
  });
  it("says None stored when no market is derived", () => {
    const html = renderToStaticMarkup(<VolatilityShocksView {...props({ markets: [MARKETS[0]!] })} />);
    expect(text(html.slice(html.indexOf('aria-label="Stored derived markets"')))).toContain("None stored");
  });
});
