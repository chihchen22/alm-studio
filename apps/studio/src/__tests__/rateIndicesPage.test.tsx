// apps/studio/src/__tests__/rateIndicesPage.test.tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompoundedWindowIndex } from "@alm/engine";
import type { DerivedMarketPreview, MarketListItem } from "@alm/reader";
import { RATE_INDEX_COPY, RateIndicesView, type RateIndicesViewProps } from "../pages/market/RateIndicesPage";
import {
  addHistoryOp, addRateIndexOp, emptyRateIndexDraft, kindDefaults, setRateIndexMarket, setRateIndexOpField, type RateIndexDraft, type RateIndexOpDraft, type RateIndexSource,
} from "../market/rateIndexModel";

/** The em-dash and the section sign, built from code points so this file holds neither. */
const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

/** The paragraphs of the About card, restated verbatim from the approved design, in reading order (step B3a adds the formulas paragraph after the model). */
const COPY = [
  "Name a rate index on a market so that a floating loan can reset on it. Pick a market to see the indices it carries, then set an index or shift the basis of one, preview the derived market, and save it under its own id. Nothing runs here: attach the saved market to this workspace, below or on Market > Yield curves, and name it as a run setup's Market on Run > Setups.",
  "An index is one of three kinds. A compounded window reads the run's one benchmark curve over 1, 3, 6 or 12 months with simple compounding, plus a constant basis; a one-month window with no basis is the one-month benchmark itself. A constant-maturity swap reads the path's forward par swap rate at 1 to 30 years on the curve's quoted basis, plus its basis; on a Treasury curve it is the CMT par yield. A formula reads another index on the same market, its parent: a coefficient (level) multiplies the parent's rate, and a beta (change) passes a share of each month's change in the parent through from a typed start value. Derived curves are built: a compounded window or a swap index may name one, saved on the Derived curves screen, and the curve's spread at the index tenor is added as one more constant.",
  "A formula's basis is its spread: on the level form it is added every month; on the change form it is added once, to the start. Shift a basis moves it. A lag, in whole months, reads the parent that many months back; before the cut-off it reads the parent's history where the parent has one, and the parent's value at the cut-off where it has none. A floor and a cap clip the index rate before the loan's margin, and a beta index carries the clipped rate into the next month. Formulas on formulas run in dependency order, at most five deep; a loop is refused.",
  "An index may carry a history: monthly fixings imported from a CSV or Excel file of dates and values, with the unit stated. A daily file keeps each month's last fixing. A formula with a lag reads its parent's history for the parent's months before the cut-off: a level formula from its own month 0, a beta formula from month 1, since its month 0 is its start plus basis. The parent's own months read the curve, and the history is never shocked. Open History on an index to import, see the series and the gap to the cut-off; the import adds a row that points the index at the history, saved with the market.",
  "Rate scenarios and stochastic paths move every index through the benchmark curve. The basis stays static inside a run, as the TLP does. A basis shock is a second market, derived here, and compared with the first on Compare runs.",
  "On a stochastic path a compounded window compounds the path's own one-month rates over its tenor, so it is read in arrears, and a swap index reads the path's own swap rate.",
  "A new market derives from the chosen market's base, carrying the ops that built the chosen market first and then yours. The chosen market itself is never changed.",
  "Floating-loan positions that name an index read it, floating term funding included. A floating loan that names none resets on the one-month benchmark plus its margin. A position that names an index the market does not carry is refused before any number is produced.",
  "Swap floating legs stay on the one-month benchmark. Deposits, the deposit beta, the mortgage refinancing driver and new business read no index. A derived curve reaches index resets only: mortgages, client rates, new business and discounting read the base curve.",
  "Coupons, NII and cash flows move with the index. EVE moves through the cash flows only, since discounting is unchanged. The FTP margin absorbs the basis. The repricing gap reads as before.",
  "A position names its index with rateIndexId in its JSON terms; the CSV import does not carry it. The seeded book synthetic-2500-indexed-v1 and the plan plan-synthetic-2500-indexed-v1 run on rate-indices-demo-v1.",
  "Every value entered here is a demonstration value, calibrated to nothing. The derived market label says so.",
  "Not built: fixings, which wait for seasoned floaters; averaging indices such as MTA or COFI-style; a convexity adjustment on swap indices; a separately bootstrapped curve for each index, since a derived curve is a spread over the run's one curve; daily-compounded forms; a basis or a spread that moves inside a run.",
];
const NONE = "This market carries no rate indices.";

const PUBLIC_ID = "market-public-2026-03-31";
const SEED_ID = "rate-indices-demo-v1";

const MARKETS: MarketListItem[] = [
  { id: PUBLIC_ID, label: "Public market pack", calibrationDate: "2026-03-31" },
  { id: SEED_ID, label: "Three rate indices on the public market pack (demonstration values)", calibrationDate: "2026-03-31", derivedFromMarketId: PUBLIC_ID },
];

const SEEDED: RateIndexSource = {
  rateIndices: [
    { id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basis: 0.03 },
    { id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basis: 0 },
    { id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basis: 0 },
  ],
  derivedFrom: { baseId: PUBLIC_ID, baseContentHash: "h", ops: [] },
};

function shiftDraft(): RateIndexDraft {
  let d = addRateIndexOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "shift");
  d = setRateIndexOpField(d, 0, { indexId: "prime-demo", valueText: "25" });
  return addRateIndexOp(d, "set");
}

const props = (over: Partial<RateIndicesViewProps> = {}): RateIndicesViewProps => ({
  markets: MARKETS,
  chosen: { id: SEED_ID, source: SEEDED },
  chosenNote: null,
  draft: shiftDraft(),
  block: null,
  preview: null,
  note: null,
  busy: null,
  planLink: null,
  onMarket: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  historyOpen: null, onHistory: noop, onImported: noop, onClearHistory: noop,
  startFillNote: null, startFilling: null, onFillStart: noop,
  ...over,
});

/** A preview with a basis shift of 25 bp on the seeded prime index, and one new index. */
const PREVIEW: DerivedMarketPreview = {
  id: "derived-mk-0123456789ab",
  label: "Rate indices on market-public-2026-03-31 (demonstration values)",
  snapshot: {} as DerivedMarketPreview["snapshot"],
  changes: [],
  indexChanges: [
    { id: "prime-demo", from: { id: "prime-demo", label: "P", tenorMonths: 1, basis: 0.03 }, to: { id: "prime-demo", label: "P", tenorMonths: 1, basis: 0.0325 }, basisChangeBp: 25, ops: [3] },
    { id: "rfr-6m", from: null, to: { id: "rfr-6m", label: "Six-month", tenorMonths: 6, basis: 0.001 }, basisChangeBp: null, ops: [4] },
  ],
  volChanges: [],
  termFundingQuotesDropped: 0,
};

const thTags = (t: string): string[] => [...t.matchAll(/<th(?:>|[\s/][^>]*>)/g)].map((m) => m[0]);

describe("RateIndicesView copy", () => {
  it("prints each About paragraph verbatim, matching the exported copy", () => {
    const t = text(renderToStaticMarkup(<RateIndicesView {...props()} />));
    for (const p of COPY) expect(t, p.slice(0, 40)).toContain(p);
    const { none, ...rest } = RATE_INDEX_COPY;
    expect(none).toBe(NONE);
    expect(Object.values(rest)).toHaveLength(COPY.length);
    for (const p of Object.values(rest)) expect(COPY).toContain(p);
  });
  it("holds neither an em-dash nor a section sign, in markup or in source", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ preview: PREVIEW })} />);
    expect(html).not.toMatch(BANNED_CHARS);
    for (const f of ["../pages/market/RateIndicesPage.tsx", "../market/rateIndexModel.ts"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8")).not.toMatch(BANNED_CHARS);
    }
  });
});

describe("RateIndicesView picker and table", () => {
  it("lists every market in the picker and prints the chosen market's indices with ids and labels", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props()} />);
    const t = text(html);
    expect(t).toContain("market-public-2026-03-31: Public market pack (as of 2026-03-31)");
    const i = html.indexOf("<table", html.indexOf('aria-label="Indices of the chosen market"'));
    const tab = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Index", "Label", "Settings", "Basis"]) expect(tab).toContain(h);
    expect(tab).toContain("prime-demo Prime-style rate, benchmark plus 300 bp (demonstration values) 1 month 3.0000%");
    expect(tab).toContain("rfr-3m Three-month benchmark term rate (demonstration index) 3 months 0.0000%");
  });
  it("a market with no indices prints the empty state and no indices table", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: PUBLIC_ID, source: {} }, draft: setRateIndexMarket(emptyRateIndexDraft(), PUBLIC_ID) })} />);
    const card = html.slice(html.indexOf('aria-label="Indices of the chosen market"'), html.indexOf('aria-label="Derive a market"'));
    expect(text(card)).toContain(NONE);
    expect(card).not.toContain("<table");
  });
  it("no market chosen shows the picker and neither the table nor the derive card", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: null, draft: emptyRateIndexDraft() })} />);
    expect(html).not.toContain('aria-label="Indices of the chosen market"');
    expect(html).not.toContain('aria-label="Derive a market"');
  });
  it("a market that is being read says so", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: null, chosenNote: "Reading market rate-indices-demo-v1" })} />);
    expect(text(html)).toContain("Reading market rate-indices-demo-v1");
  });
  it("names the chosen market's base when it is derived, and says nothing of one when it is not", () => {
    const derived = text(renderToStaticMarkup(<RateIndicesView {...props()} />));
    expect(derived).toContain("Builds on market-public-2026-03-31, the chosen market's base");
    const plain = text(renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: PUBLIC_ID, source: {} }, draft: setRateIndexMarket(emptyRateIndexDraft(), PUBLIC_ID) })} />));
    expect(plain).not.toContain("Builds on");
  });
});

describe("RateIndicesView form", () => {
  it("renders a shift row with the picked index and a set row, with the add buttons and the help text", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props()} />);
    const t = text(html);
    expect(t).toContain("Set an index");
    expect(t).toContain("Shift a basis");
    expect(t).toContain("prime-demo: Prime-style rate, benchmark plus 300 bp (demonstration values)");
    expect(html).toContain('value="25"');
    for (const w of ["1 month", "3 months", "6 months", "12 months"]) expect(t).toContain(w);
    expect(t).toContain("Basis points added to the stored basis");
    expect(t).toContain("Basis in basis points");
    expect(t).toContain("Leave empty for a label that names the base market");
    expect(t).toContain("Leave empty for the derived id");
  });
  it("turns Preview and Save off by aria-disabled with the reason when blocked", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ block: "Enter an index id" })} />);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Preview<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Save<\/button>/);
    expect(text(html)).toContain("Enter an index id");
    expect(renderToStaticMarkup(<RateIndicesView {...props()} />)).not.toContain('aria-disabled="true"');
  });
});

describe("RateIndicesView preview", () => {
  it("prints the served change in basis points and no number that is not in the fixture", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ preview: PREVIEW })} />);
    expect(text(html)).toContain("Preview: derived-mk-0123456789ab");
    const i = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const t = text(html.slice(i, html.indexOf("</table>", i)));
    for (const h of ["Index", "Settings", "Base basis", "Derived basis", "Change (bp)"]) expect(t).toContain(h);
    expect(t).toContain("prime-demo 1 month 3.0000% 3.2500% 25");
    expect(t).toContain("rfr-6m 6 months not in the base 0.1000% none");
  });
  it("lists one row per touched index", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ preview: PREVIEW })} />);
    const i = html.indexOf("<tbody", html.indexOf('aria-label="Preview"'));
    expect(html.slice(i, html.indexOf("</tbody>", i)).match(/<tr/g)).toHaveLength(2);
  });
  it("prints the dropped quote count only when it is above zero", () => {
    expect(text(renderToStaticMarkup(<RateIndicesView {...props({ preview: PREVIEW })} />))).not.toContain("not carried");
    const t = text(renderToStaticMarkup(<RateIndicesView {...props({ preview: { ...PREVIEW, termFundingQuotesDropped: 11 } })} />));
    expect(t).toContain("Term-funding quotes: 11 not carried");
    expect(t).toContain("Source: /api/market/derive/preview");
  });
  it("shows no preview card when there is none", () => {
    expect(text(renderToStaticMarkup(<RateIndicesView {...props()} />))).not.toContain("Preview: ");
  });
});

describe("RateIndicesView notes", () => {
  it("lists every problem of a refusal", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ note: { kind: "refused", text: "Refused: every problem is listed.", problems: ["ops[3]: first", "second problem"], savedId: null } })} />);
    expect(text(html)).toContain("ops[3]: first");
    expect(text(html)).toContain("second problem");
    expect(html).toContain('role="alert"');
  });
  it("links a saved market to Market > Yield curves, where it is attached (Piece B, step B3a, decision 42)", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({
      note: { kind: "created", text: "Saved as derived-mk-0123456789ab", problems: [], savedId: "derived-mk-0123456789ab" },
      planLink: "#/ws/ws-a/market/curves",
    })} />);
    expect(html).toContain('href="#/ws/ws-a/market/curves"');
    expect(text(html)).toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
  it("a conflict prints the server text and no link", () => {
    // The link address is handed in, so the link is absent because nothing was saved, not because there was no address.
    const html = renderToStaticMarkup(<RateIndicesView {...props({ note: { kind: "conflict", text: "409: exists", problems: [], savedId: null }, planLink: "#/ws/ws-a/market/curves" })} />);
    const t = text(html);
    expect(t).toContain("409: exists");
    expect(html).not.toContain('href="#/ws/ws-a/market/curves"');
    expect(t).not.toContain("Attach it on Market > Yield curves, then name it as a run setup's Market");
  });
});

describe("RateIndicesView derived curves (Piece B, step B2)", () => {
  const CURVES = [{ id: "ust-sofr", text: "ust-sofr: Treasury over SOFR (on sofr-main)" }, { id: "prime-x", text: "prime-x (on platform-default)" }];
  const tableOf = (html: string, label: string) => {
    const i = html.indexOf("<table", html.indexOf(`aria-label="${label}"`));
    return html.slice(i, html.indexOf("</table>", i));
  };
  it("a set row has a Derived curve select after the tenor, None (base curve) first, then each listed curve by its own id", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ derivedCurves: CURVES })} />);
    const at = html.indexOf('aria-label="Derived curve of op 2"');
    expect(at).toBeGreaterThan(html.indexOf('aria-label="Tenor of op 2"'));
    const sel = html.slice(at, html.indexOf("</select>", at));
    const opts = [...sel.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(opts).toEqual([["", "None (base curve)"], ["ust-sofr", "ust-sofr: Treasury over SOFR (on sofr-main)"], ["prime-x", "prime-x (on platform-default)"]]);
    // A shift row has no such select.
    expect(html).not.toContain('aria-label="Derived curve of op 1"');
  });
  it("the select shows the row's chosen curve", () => {
    const d = setRateIndexOpField(shiftDraft(), 1, { spreadCurve: "prime-x" });
    const html = renderToStaticMarkup(<RateIndicesView {...props({ draft: d, derivedCurves: CURVES })} />);
    const at = html.indexOf('aria-label="Derived curve of op 2"');
    expect(html.slice(at, html.indexOf("</select>", at))).toMatch(/<option value="prime-x" selected="">/);
  });
  it("a chosen curve the list lacks shows as <id> (not listed), selected, so the select names what is sent (M5)", () => {
    const d = setRateIndexOpField(shiftDraft(), 1, { spreadCurve: "gone-curve" });
    const html = renderToStaticMarkup(<RateIndicesView {...props({ draft: d, derivedCurves: CURVES })} />);
    const at = html.indexOf('aria-label="Derived curve of op 2"');
    const sel = html.slice(at, html.indexOf("</select>", at));
    const opts = [...sel.matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], m[2] !== undefined, m[3]]);
    expect(opts).toEqual([
      ["", false, "None (base curve)"],
      ["ust-sofr", false, "ust-sofr: Treasury over SOFR (on sofr-main)"],
      ["prime-x", false, "prime-x (on platform-default)"],
      ["gone-curve", true, "gone-curve (not listed)"],
    ]);
    // A listed choice adds no extra option.
    const listed = renderToStaticMarkup(<RateIndicesView {...props({ draft: setRateIndexOpField(shiftDraft(), 1, { spreadCurve: "prime-x" }), derivedCurves: CURVES })} />);
    expect(listed).not.toContain("(not listed)");
  });

  it("with no curve listed the select offers None (base curve) alone, and a listing note is printed", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ derivedCurvesNote: "Derived curves could not be read: 500" })} />);
    const at = html.indexOf('aria-label="Derived curve of op 2"');
    expect([...html.slice(at, html.indexOf("</select>", at)).matchAll(/<option/g)]).toHaveLength(1);
    expect(text(html)).toContain("Derived curves could not be read: 500");
  });
  it("the indices table has a Derived curve column naming the curve, or None (base curve)", () => {
    const src: RateIndexSource = { ...SEEDED, rateIndices: [...SEEDED.rateIndices!, { id: "sofr-3m-idx", label: "Three-month term", tenorMonths: 3, basis: 0, spreadCurve: "ust-sofr" }] };
    const t = text(tableOf(renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: SEED_ID, source: src } })} />), "Indices of the chosen market"));
    expect(t).toContain("Derived curve");
    expect(t).toContain("rfr-3m Three-month benchmark term rate (demonstration index) 3 months 0.0000% None (base curve)");
    expect(t).toContain("sofr-3m-idx Three-month term 3 months 0.0000% ust-sofr");
  });
  it("the preview table has a Derived curve column for the derived index", () => {
    const preview: DerivedMarketPreview = { ...PREVIEW, indexChanges: [
      PREVIEW.indexChanges[0]!,
      // The fixture's rfr-6m is a compounded window; a formula index cannot carry spreadCurve.
      { ...PREVIEW.indexChanges[1]!, to: { ...(PREVIEW.indexChanges[1]!.to as CompoundedWindowIndex), spreadCurve: "ust-sofr" } },
    ] };
    const t = text(tableOf(renderToStaticMarkup(<RateIndicesView {...props({ preview })} />), "Preview"));
    expect(t).toContain("Derived curve");
    expect(t).toContain("prime-demo 1 month 3.0000% 3.2500% 25 None (base curve)");
    expect(t).toContain("rfr-6m 6 months not in the base 0.1000% none ust-sofr");
  });
});

describe("kind menu and settings forms (Piece B, step B3a)", () => {
  const draftWith = (row: Partial<RateIndexOpDraft>): RateIndexDraft => {
    const d = addRateIndexOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "set");
    return setRateIndexOpField(d, 0, row);
  };
  const html = (row: Partial<RateIndexOpDraft>) => renderToStaticMarkup(<RateIndicesView {...props({ draft: draftWith(row) })} />);
  it("a formula row shows parent, form, beta, start, lag, floor and cap, and no tenor or derived curve", () => {
    const h = html({ ...kindDefaults("formula"), form: "change", startText: "433" });
    for (const l of ["Kind of op 1", "Parent of op 1", "Form of op 1", "Beta of op 1", "Start value of op 1", "Lag of op 1", "Floor of op 1", "Cap of op 1"]) expect(h).toContain(`aria-label="${l}"`);
    for (const l of ["Tenor of op 1", "Derived curve of op 1", "Coefficient of op 1"]) expect(h).not.toContain(`aria-label="${l}"`);
    expect(text(h)).toContain("433 bp is 4.33 percent");
  });
  it("a level row shows a coefficient and no start value", () => {
    const h = html(kindDefaults("formula"));
    expect(h).toContain('aria-label="Coefficient of op 1"');
    expect(h).not.toContain('aria-label="Start value of op 1"');
  });
  it("a swap row shows the eight swap tenors and the derived curve", () => {
    const h = html(kindDefaults("constant-maturity-swap"));
    const sel = h.slice(h.indexOf('aria-label="Swap tenor of op 1"'), h.indexOf("</select>", h.indexOf('aria-label="Swap tenor of op 1"')));
    expect((sel.match(/<option /g) ?? []).length).toBe(8);
    expect(h).toContain('aria-label="Derived curve of op 1"');
  });
  it("a change row says the index starts at start plus basis, on the start field and on the basis field", () => {
    const h = html({ ...kindDefaults("formula"), form: "change" });
    expect(text(h)).toContain(
      "The published fixing at the cut-off, in basis points, spread included: 433 is 4.33 percent. The index starts at this value plus the basis, so leave the basis at 0 unless you are shocking it.",
    );
    expect(text(h)).toContain("Added once to the start, so it moves the whole path; Shift a basis moves it. Leave it at 0 when the start is the published fixing.");
    expect(text(h)).not.toContain("The formula's spread in basis points; Shift a basis moves it");
  });
  it("a level row keeps the spread help on the basis field", () => {
    const h = html(kindDefaults("formula"));
    expect(text(h)).toContain("The formula's spread in basis points; Shift a basis moves it");
    expect(text(h)).not.toContain("Added once to the start");
  });
  it("the factor field's visible label names the form; the aria-label keeps the short name", () => {
    const change = html({ ...kindDefaults("formula"), form: "change" });
    expect(change).toContain('<span class="field-label">Beta (change)</span>');
    expect(change).toContain('aria-label="Beta of op 1"');
    const level = html(kindDefaults("formula"));
    expect(level).toContain('<span class="field-label">Coefficient (level)</span>');
    expect(level).toContain('aria-label="Coefficient of op 1"');
  });
  it("a swap row's derived curve help reads the spread at the swap tenor, in months", () => {
    expect(text(html(kindDefaults("constant-maturity-swap")))).toContain(
      "Its spread at the swap tenor, in months (12 x the years), is added to the reset; saved on the Derived curves screen",
    );
  });
  it("the kind menu names the three kinds", () => {
    expect(text(html({}))).toContain("Compounded window Constant-maturity swap Formula on another index");
  });
});

describe("RateIndicesView history (Piece B, step B3b, decision 54)", () => {
  const H_ID = "ih-0123456789abcdef";
  const withHistory: RateIndexSource = { ...SEEDED, calibrationDate: "2026-03-31", rateIndices: SEEDED.rateIndices!.map((r) => (r.id === "rfr-1m" ? { ...r, historyId: H_ID } : r)) };
  const tableOf = (html: string, label: string) => {
    const i = html.indexOf("<table", html.indexOf(`aria-label="${label}"`));
    return html.slice(i, html.indexOf("</table>", i));
  };
  const rowOf = (table: string, id: string) => {
    const i = table.indexOf(`>${id}</th>`);
    return table.slice(table.lastIndexOf("<tr", i), table.indexOf("</tr>", i));
  };
  it("the indices table has a History column after Derived curve: the id in a mono cell, or None, and a History toggle", () => {
    const tab = tableOf(renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: SEED_ID, source: withHistory } })} />), "Indices of the chosen market");
    const heads = [...tab.slice(0, tab.indexOf("</thead>")).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Index", "Label", "Settings", "Basis", "Derived curve", "History"]);
    const one = rowOf(tab, "rfr-1m");
    expect(one).toContain(`<span class="mono">${H_ID}</span>`);
    // Closed, the toggle controls nothing, so aria-controls never names a missing id (review fix).
    expect(one).toMatch(/<button[^>]*aria-expanded="false"[^>]*>History<\/button>/);
    expect(one).not.toContain("aria-controls=");
    const three = rowOf(tab, "rfr-3m");
    expect(text(three)).toContain("None");
    expect(three).toMatch(/<button[^>]*aria-expanded="false"[^>]*>History<\/button>/);
    expect(tab).not.toContain('aria-label="History of');
  });
  it("an open History renders the panel as its own card after the table, inside the indices card, never in a table row (review fix)", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: SEED_ID, source: withHistory }, historyOpen: "rfr-1m" })} />);
    const tab = tableOf(html, "Indices of the chosen market");
    expect(rowOf(tab, "rfr-1m")).toMatch(/<button[^>]*aria-expanded="true"[^>]*aria-controls="[^"]+"[^>]*>History<\/button>/);
    expect(rowOf(tab, "rfr-3m")).not.toContain("aria-controls=");
    expect(tab).not.toContain('aria-label="History of');
    expect(tab).not.toMatch(/colspan/i);
    const card = html.slice(html.indexOf('aria-label="Indices of the chosen market"'), html.indexOf('aria-label="Derive a market"'));
    const wrapEnd = card.indexOf("</table></div>");
    const panel = card.indexOf('aria-label="History of rfr-1m"');
    expect(wrapEnd).toBeGreaterThan(0);
    expect(panel).toBeGreaterThan(wrapEnd);
    // The element with the id the toggle controls holds the panel.
    const controls = /aria-controls="([^"]+)"/.exec(rowOf(tab, "rfr-1m"))![1]!;
    const holder = card.indexOf(`id="${controls}"`);
    expect(holder).toBeGreaterThan(wrapEnd);
    expect(holder).toBeLessThan(panel);
    expect(html.match(/aria-label="History of /g)).toHaveLength(1);
  });
  it("the panel's holder keeps a token gap below the table (Task 11 live walk: the card touched the table's scrollbar)", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: SEED_ID, source: withHistory }, historyOpen: "rfr-1m" })} />);
    const controls = /aria-controls="([^"]+)"/.exec(rowOf(tableOf(html, "Indices of the chosen market"), "rfr-1m"))![1]!;
    expect(html).toContain(`<div id="${controls}" class="history-slot">`);
    const css = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.history-slot \{ margin-top: var\(--sp-4\); \}/);
  });
  it("an open History for an index the market does not carry renders no panel and no aria-controls", () => {
    const html = renderToStaticMarkup(<RateIndicesView {...props({ chosen: { id: SEED_ID, source: withHistory }, historyOpen: "gone" })} />);
    expect(html).not.toContain('aria-label="History of');
    expect(html).not.toContain("aria-controls=");
  });
  it("a history op row points an index at a history, or clears it, with the index select and no basis field", () => {
    let d = addHistoryOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "rfr-1m", H_ID);
    d = addHistoryOp(d, "rfr-3m", null);
    const html = renderToStaticMarkup(<RateIndicesView {...props({ draft: d })} />);
    const op1 = html.slice(html.indexOf('aria-label="Op 1"'), html.indexOf('aria-label="Op 2"'));
    expect(text(op1)).toContain("Point an index at a history");
    expect(text(op1)).toContain(`History ${H_ID}`);
    expect(op1).toContain('aria-label="Index of op 1"');
    expect(op1).toMatch(/<option value="rfr-1m" selected="">/);
    expect(op1).not.toContain('aria-label="Value of op 1"');
    // The line sits under the Index select, inside its field, not beside it in the grid (review fix).
    const field = op1.slice(op1.lastIndexOf('<label class="field"', op1.indexOf('aria-label="Index of op 1"')), op1.indexOf("</label>", op1.indexOf('aria-label="Index of op 1"')));
    expect(field.indexOf("</select>")).toBeLessThan(field.indexOf(H_ID));
    expect(text(field)).toContain(`History ${H_ID}`);
    const op2 = html.slice(html.indexOf('aria-label="Op 2"'));
    const op2Card = op2.slice(0, op2.indexOf("</section>"));
    expect(text(op2Card)).toContain("Clear an index's history");
    expect(text(op2Card)).toContain("Clears the history");
    const field2 = op2Card.slice(op2Card.indexOf('<label class="field"'), op2Card.indexOf("</label>"));
    expect(text(field2)).toContain("Clears the history");
    expect(op2Card).not.toContain('aria-label="Value of op 2"');
  });
  it("the preview table has a History column after Derived curve", () => {
    const preview: DerivedMarketPreview = { ...PREVIEW, indexChanges: [
      { ...PREVIEW.indexChanges[0]!, to: { ...(PREVIEW.indexChanges[0]!.to as CompoundedWindowIndex), historyId: H_ID } },
      PREVIEW.indexChanges[1]!,
    ] };
    const tab = tableOf(renderToStaticMarkup(<RateIndicesView {...props({ preview })} />), "Preview");
    const heads = [...tab.slice(0, tab.indexOf("</thead>")).matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(heads).toEqual(["Index", "Settings", "Base basis", "Derived basis", "Change (bp)", "Derived curve", "History"]);
    const t = text(tab);
    expect(t).toContain(`prime-demo 1 month 3.0000% 3.2500% 25 None (base curve) ${H_ID}`);
    expect(t).toContain("rfr-6m 6 months not in the base 0.1000% none None (base curve) None");
  });
  it("the About card says history is built and no longer says it comes next", () => {
    const t = text(renderToStaticMarkup(<RateIndicesView {...props()} />));
    expect(t).not.toContain("which come next");
    expect(RATE_INDEX_COPY.history).toContain("Open History on an index to import");
  });
});

describe("the start fill (Piece B, step B3b, decision 53)", () => {
  const draftWith = (row: Partial<RateIndexOpDraft>): RateIndexDraft => {
    const d = addRateIndexOp(setRateIndexMarket(emptyRateIndexDraft(), SEED_ID), "set");
    return setRateIndexOpField(d, 0, { ...kindDefaults("formula"), indexId: "admin-rate", ...row });
  };
  const html = (row: Partial<RateIndexOpDraft>, over: Partial<RateIndicesViewProps> = {}) =>
    renderToStaticMarkup(<RateIndicesView {...props({ draft: draftWith(row), ...over })} />);
  const BUTTON = /<button[^>]*aria-label="Fill the start of op 1 from history"[^>]*>Fill start from history<\/button>/;
  const REFUSAL = "the history ends 2025-12, before the cut-off month 2026-03; type the start value";
  it("a formula row on the change form carries the fill button after the start value; the level form does not", () => {
    const h = html({ form: "change" });
    expect(h).toMatch(BUTTON);
    expect(h.indexOf('aria-label="Start value of op 1"')).toBeLessThan(h.indexOf('aria-label="Fill the start of op 1 from history"'));
    expect(h.indexOf('aria-label="Fill the start of op 1 from history"')).toBeLessThan(h.indexOf('aria-label="Lag of op 1"'));
    expect(html({})).not.toContain("Fill the start of op 1 from history");
    expect(html({ form: "level" })).not.toContain("Fill start from history");
  });
  it("the fill button is off while the page is busy", () => {
    expect(html({ form: "change" }, { busy: "Saving" })).toMatch(/<button[^>]*aria-label="Fill the start of op 1 from history"[^>]*disabled=""/);
    expect(html({ form: "change" })).not.toMatch(/<button[^>]*aria-label="Fill the start of op 1 from history"[^>]*disabled=""/);
  });
  it("the start help says the fill reads the index's own history and the number written is of record", () => {
    expect(text(html({ form: "change" }))).toContain(
      "Fill from history reads the index's own history at the cut-off month, minus the basis; the number written here is of record.",
    );
  });
  it("prints the fill's refusal beside the button of its own row, in role status, and nowhere else", () => {
    const d = draftWith({ form: "change" });
    const key = d.ops[0]!.key;
    const h = html({ form: "change" }, { startFillNote: { key, text: REFUSAL } });
    expect(h).toContain(`role="status">${REFUSAL}</`);
    expect(h.indexOf('aria-label="Fill the start of op 1 from history"')).toBeLessThan(h.indexOf(REFUSAL));
    expect(h.indexOf(REFUSAL)).toBeLessThan(h.indexOf('aria-label="Lag of op 1"'));
    expect(html({ form: "change" }, { startFillNote: { key: key + 1, text: REFUSAL } })).not.toContain(REFUSAL);
  });
  it("a landed fill says where the start came from, in the row's status note (Task 10 review)", () => {
    const key = draftWith({ form: "change" }).ops[0]!.key;
    expect(html({ form: "change", startText: "435" }, { startFillNote: { key, text: "Filled from ih-1111111111111111 at 2026-03." } }))
      .toContain('role="status">Filled from ih-1111111111111111 at 2026-03.</');
  });
  it("the fill button is off while its own read runs, with the reason beside it; another row's read leaves it on (Task 10 review)", () => {
    const key = draftWith({ form: "change" }).ops[0]!.key;
    const h = html({ form: "change" }, { startFilling: key });
    const button = /<button[^>]*aria-label="Fill the start of op 1 from history"[^>]*>/.exec(h)![0];
    expect(button).toContain('aria-disabled="true"');
    expect(button).not.toContain('disabled=""');
    const reason = /aria-describedby="([^"]+)"/.exec(button)![1]!;
    expect(h).toContain(`id="${reason}" role="status">Reading the index&#x27;s history</`);
    const idle = /<button[^>]*aria-label="Fill the start of op 1 from history"[^>]*>/.exec(html({ form: "change" }, { startFilling: key + 1 }))![0];
    expect(idle).not.toContain("aria-disabled");
    expect(idle).not.toContain("aria-describedby");
  });
});

describe("RateIndicesView headers", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../pages/market/RateIndicesPage.tsx", import.meta.url)), "utf8");
  it("the SOURCE holds exactly 20 header tags, each with scope= (the definitions table of the workspace frame adds 5, the Derived curve columns of B2 add 2, the History columns of B3b add 2)", () => {
    const tags = thTags(SRC);
    expect(tags).toHaveLength(20);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
  it("every header in the rendered view carries scope=", () => {
    const tags = thTags(renderToStaticMarkup(<RateIndicesView {...props({ preview: PREVIEW })} />));
    expect(tags.length).toBeGreaterThan(11);
    for (const t of tags) expect(t, t).toContain("scope=");
  });
});
