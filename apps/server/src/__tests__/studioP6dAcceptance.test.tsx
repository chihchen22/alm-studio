// apps/server/src/__tests__/studioP6dAcceptance.test.tsx
/**
 * ALM Studio Piece 6d acceptance on a freshly seeded test platform: the
 * Volatility shocks view fed by the real routes. The request is built through the
 * model, a preview through the real derive route renders the 15 served
 * at-the-money rows and the served change, a save of the seeded ops under the
 * seeded id answers 200 unchanged and links to the Plan page, the stored table
 * names the seeded vol-shock market and its base, and the Plan page Market
 * picker lists it as a direct derived copy. Expected values are restated here,
 * never read from the code they check.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getMarket, getRunPlan, listMarket, previewDerivedMarket, saveDerivedMarket, type DerivedMarketPreview } from "@alm/reader";
import { seedStore, VOL_SHOCK_DEMO_LABEL, VOL_SHOCK_DEMO_OPS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { LAYERS, parseHash } from "../../../studio/src/router";
import { VolatilityShocksView, VOLATILITY_SHOCK_COPY, type VolatilityShocksViewProps } from "../../../studio/src/pages/scenarios/VolatilityShocksPage";
import { SHOCK_COPY } from "../../../studio/src/pages/scenarios/BehavioralShocksPage";
import { BALANCE_SHOCK_COPY } from "../../../studio/src/pages/scenarios/BalanceShocksPage";
import { FUNDING_SPREAD_COPY } from "../../../studio/src/pages/scenarios/FundingSpreadShocksPage";
import { marketChoices, marketNote } from "../../../studio/src/plan/planMarket";
import {
  addVolOp, emptyVolShockDraft, fundingSaveNoteOf, planLinkFor, setVolBase, setVolOpField, volRequestOf,
} from "../../../studio/src/scenarios/volatilityShockModel";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  const store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const text = (s: string) =>
  s.replace(/<wbr\/?>/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const noop = () => {};

const BASE_ID = "market-public-2026-03-31";
const SEEDED_ID = "vol-shock-demo-v1";

function view(over: Partial<VolatilityShocksViewProps>): VolatilityShocksViewProps {
  return {
    markets: [], base: null, baseNote: null, draft: emptyVolShockDraft(), block: null, preview: null, note: null, busy: null, planLink: null,
    onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
    ...over,
  };
}

/** The seeded ops as the page builds them: every expiry, Scale by 1.5. */
function seededDraft() {
  let draft = addVolOp(setVolBase(emptyVolShockDraft(), BASE_ID));
  draft = setVolOpField(draft, 0, { valueText: "1.5" });
  return draft;
}

describe("Volatility shocks on the seeded platform", () => {
  it("the hub row is live, addressed at #/data/scenarios/volatility-shocks", () => {
    const l = LAYERS.find((x) => x.id === "data/scenarios/volatility-shocks")!;
    expect(l.status).toBe("live");
    expect(l.label).toBe("Volatility shocks");
    expect(parseHash("#/data/scenarios/volatility-shocks")).toMatchObject({ kind: "legacy", layer: "data/scenarios/volatility-shocks" });
  });

  it("the stored table shows the seeded vol-shock market with its label and base", async () => {
    const markets = await listMarket();
    const html = renderToStaticMarkup(<VolatilityShocksView {...view({ markets })} />);
    const m = html.match(/<section[^>]*aria-label="Stored derived markets"[^>]*>([\s\S]*?)<\/section>/);
    expect(m).not.toBeNull();
    const rows = [...m![1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));
    expect(rows).toContain("vol-shock-demo-v1 Constructed short-rate volatilities times 1.5 at every expiry of the public market pack (demonstration values) market-public-2026-03-31 2026-03-31");
    expect(rows.some((r) => r.startsWith(`${BASE_ID} `))).toBe(false);
  });

  it("a preview of the seeded ops through the real route prints the 15 served at-the-money rows", async () => {
    const base = await getMarket(BASE_ID);
    const draft = seededDraft();
    const req = volRequestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    expect(req.body).toEqual({ baseId: BASE_ID, ops: [{ op: "scale-short-rate-vol", value: 1.5 }] });
    expect(req.body.ops).toEqual([...VOL_SHOCK_DEMO_OPS]);

    const preview: DerivedMarketPreview = await previewDerivedMarket(req.body);
    expect(preview.id).toBe("derived-mk-fdb4bee2e09a");
    expect(preview.volChanges).toHaveLength(15);
    const markets = await listMarket();
    const html = renderToStaticMarkup(<VolatilityShocksView {...view({ markets, base, draft, preview })} />);
    const i = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const tableHtml = html.slice(i, html.indexOf("</table>", i));
    const body = tableHtml.slice(tableHtml.indexOf("<tbody"));
    expect(body.match(/<tr/g)).toHaveLength(15);
    const rows = text(tableHtml);
    // The 1Y row: 63.45 bp to 95.175 bp, a change of 31.725 bp, all 26 quotes in the row moved (restated from the design).
    expect(rows).toContain("1Y 63.45 95.175 31.725 26");
    expect(text(html)).toContain("Long-yield grid copied unchanged. Source: /api/market/derive/preview");
  });

  it("a save of the seeded ops under the seeded id answers 200 unchanged, names the id and links to the Plan page", async () => {
    const base = await getMarket(BASE_ID);
    const draft = { ...seededDraft(), id: SEEDED_ID, label: VOL_SHOCK_DEMO_LABEL };
    const req = volRequestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    const reply = await saveDerivedMarket(req.body);
    expect(reply.outcome).toBe("unchanged");
    expect(reply.id).toBe(SEEDED_ID);
    const note = fundingSaveNoteOf(reply);
    expect(note).toEqual({ kind: "unchanged", text: "vol-shock-demo-v1 already saved with this content", problems: [], savedId: SEEDED_ID });
    expect(planLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups");
    const html = renderToStaticMarkup(<VolatilityShocksView {...view({ markets: await listMarket(), base, draft, note, planLink: planLinkFor("ws-a", {}) })} />);
    expect(html).toContain('href="#/ws/ws-a/run/setups"');
    expect(text(html)).toContain("vol-shock-demo-v1 already saved with this content");
  });

  it("a refusal through the real route reaches the page as every problem listed", async () => {
    const base = await getMarket(BASE_ID);
    let draft = addVolOp(setVolBase(emptyVolShockDraft(), BASE_ID));
    draft = setVolOpField(draft, 0, { valueText: "5" });
    const req = volRequestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    const note = await previewDerivedMarket(req.body).then(() => null, fundingSaveNoteOf);
    expect(note).not.toBeNull();
    expect(note!.kind).toBe("refused");
    expect(note!.text).toBe("Refused: every problem is listed.");
    expect(note!.problems).toEqual(["ops[0]: a short-rate volatility scale factor must be from 0.25 to 4; got 5"]);
  });
});

describe("Plan page Market picker on the seeded platform", () => {
  it("lists vol-shock-demo-v1 as a derived copy, and the note counts the direct copies actually stored", async () => {
    const rows = await listMarket();
    const plan = await getRunPlan("plan-synthetic-2500-v1");
    const choices = marketChoices(plan.inputs.marketSnapshot, rows);
    expect(choices.base).toBe(BASE_ID);
    const copy = choices.options.find((o) => o.id === SEEDED_ID);
    expect(copy).toEqual({ id: SEEDED_ID, derived: true });
    // N is 3: the seeded rate-indices-demo-v1, tlp-shock-demo-v1 and vol-shock-demo-v1. This suite saves no new derived-mk copy
    // (a preview stores nothing and the seeded-ops save answers 200 unchanged), so nothing is added to the three.
    // Re-expectation: +1 for the seeded macro-demo-v1 market, same base. N is 4.
    expect(choices.options.slice(1).map((o) => o.id)).toEqual(["macro-demo-v1", "rate-indices-demo-v1", "tlp-shock-demo-v1", "vol-shock-demo-v1"]);
    expect(marketNote(choices)).toBe("market-public-2026-03-31 and 4 derived copies");
  });
});

describe("The three shock pages after Piece 6d", () => {
  it("none says Not built: volatility shocks, in copy or in source", () => {
    const copies = [...Object.values(SHOCK_COPY), ...Object.values(BALANCE_SHOCK_COPY), ...Object.values(FUNDING_SPREAD_COPY)].join(" ");
    expect(copies).not.toContain("Not built: volatility shocks");
    for (const f of ["BehavioralShocksPage", "BalanceShocksPage", "FundingSpreadShocksPage"]) {
      const src = readFileSync(new URL(`../../../studio/src/pages/scenarios/${f}.tsx`, import.meta.url), "utf8");
      expect(src, f).not.toContain("Not built: volatility shocks");
      expect(src, f).not.toContain("Not built: new-business pricing shocks (spread over index and term) and volatility shocks");
    }
    // Each now points to the Volatility shocks page, and the Balance page keeps its one honest Not built.
    expect(SHOCK_COPY.elsewhere).toContain("Volatility shocks");
    expect(BALANCE_SHOCK_COPY.notBuilt).toContain("Volatility shocks");
    expect(FUNDING_SPREAD_COPY.elsewhere).toContain("Volatility shocks");
  });

  it("the Volatility shocks page itself never fakes a stochastic run or a distribution", () => {
    const all = Object.values(VOLATILITY_SHOCK_COPY).join(" ");
    expect(all).toContain("Studio does not run stochastic runs");
    expect(all).toContain("Compare runs then sets the two envelopes side by side");
    expect(all).not.toContain("Compare reads deterministic results only");
  });
});
