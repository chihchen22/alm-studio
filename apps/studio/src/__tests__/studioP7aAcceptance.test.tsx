// apps/studio/src/__tests__/studioP7aAcceptance.test.tsx
/**
 * The Rate indices layer is live. The copy holds no
 * trade name, em-dash or section sign, says what a basis, a static basis and the
 * refusal mean, and Macro factors is still the one Soon layer.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LAYERS, hrefFor, parseHash } from "../router";
import { pageFor } from "../pages/pageFor";
import { RATE_INDEX_COPY, RateIndicesView, type RateIndicesViewProps } from "../pages/market/RateIndicesPage";
import { emptyRateIndexDraft } from "../market/rateIndexModel";
import { FUNDING_SPREAD_COPY } from "../pages/scenarios/FundingSpreadShocksPage";

const BANNED = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);
/** The trade name of the overnight benchmark, spelled in pieces so this file never prints it either. */
const TRADE_NAME = ["SO", "FR"].join("");
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const noop = () => {};

const props: RateIndicesViewProps = {
  markets: [{ id: "market-public-2026-03-31", label: "Public market pack", calibrationDate: "2026-03-31" }],
  chosen: null, chosenNote: null, draft: emptyRateIndexDraft(), block: null, preview: null, note: null, busy: null, planLink: null,
  onMarket: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
  historyOpen: null, onHistory: noop, onImported: noop, onClearHistory: noop, startFillNote: null, startFilling: null, onFillStart: noop,
};

describe("Studio Piece 7a: the Rate indices layer", () => {
  it("is live under Data > Market, addressed at #/data/market/indices, and macro is still the one Soon layer", () => {
    const l = LAYERS.find((x) => x.id === "data/market/indices")!;
    expect(l.status).toBe("live");
    expect(l.label).toBe("Rate indices");
    expect(l.module).toBe("data");
    expect(l.area).toBe("Market");
    expect(hrefFor({ ws: "ws-a", section: "market", screen: "indices", query: { instance: "x" } })).toBe("#/ws/ws-a/market/indices?instance=x");
    // Re-expectation (Piece E1): an old layer address parses to a legacy route that keeps the address as typed.
    expect(parseHash("#/data/market/indices?book=b1")).toEqual({ kind: "legacy", layer: "data/market/indices", query: { book: "b1" }, from: "#/data/market/indices?book=b1" });
    const soon = LAYERS.filter((x) => x.status === "soon");
    // Re-expectation: Macro factors is live; no layer is Soon.
    expect(soon.map((x) => x.id)).toEqual([]);
  });

  it("pageFor renders the Rate indices page, not the Soon page", () => {
    // Re-expectation (Piece E2): the page is reached at market/indices inside a workspace.
    const el = pageFor({ kind: "screen", ws: "ws-a", section: "market", screen: "indices", query: {} }, null) as { type: { name: string } };
    expect(el.type.name).toBe("RateIndicesPage");
  });

  it("the copy names no trade name and holds no em-dash or section sign, in the strings or in the markup", () => {
    const all = Object.values(RATE_INDEX_COPY).join(" ");
    expect(all).not.toContain(TRADE_NAME);
    expect(all).not.toMatch(BANNED);
    const html = renderToStaticMarkup(<RateIndicesView {...props} />);
    expect(html).not.toContain(TRADE_NAME);
    expect(html).not.toMatch(BANNED);
    for (const f of ["../pages/market/RateIndicesPage.tsx", "../market/rateIndexModel.ts"]) {
      const src = readFileSync(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(BANNED);
      expect(src, f).not.toContain(TRADE_NAME);
    }
  });

  it("the page says what the layer does and does not do", () => {
    const t = text(renderToStaticMarkup(<RateIndicesView {...props} />));
    for (const w of ["basis", "static", "one-month benchmark", "refused", "fixings", "demonstration", "chosen market's base"]) expect(t, w).toContain(w);
    expect(t).not.toContain("always the root");
    expect(Object.values(RATE_INDEX_COPY).join(" ")).not.toContain("always the root");
  });

  it("the funding spread shock copy no longer says every derived market stores no quotes, and names the indices it copies", () => {
    expect(FUNDING_SPREAD_COPY.copied).toContain("so a funding spread shock stores none");
    expect(FUNDING_SPREAD_COPY.copied).not.toContain("so a derived market stores none");
    expect(FUNDING_SPREAD_COPY.copied.endsWith("Rate indices the base carries are copied unchanged.")).toBe(true);
  });
});
