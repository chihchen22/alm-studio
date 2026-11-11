// apps/server/src/__tests__/studioP6cAcceptance.test.tsx
/**
 * ALM Studio Piece 6c acceptance on a freshly seeded test platform: the Funding
 * spread shocks view fed by the real routes. The request is built through the
 * model, a preview through the real derive route renders the served base and
 * derived spreads and the served change, a save answers 201 with a derived-mk
 * id and links to the Plan page, the stored table names the seeded shock and its
 * base, and the catalog's Spreads lists label a derived market's tenors as
 * tenors. Expected values are restated here, never read from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { getCatalogMarketSnapshot, getMarket, getRunPlan, listMarket, listRunPlans, previewDerivedMarket, saveDerivedMarket, type DerivedMarketPreview } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { bootTestPlatform, type TestPlatform } from "./harness";
import { parseHash } from "../../../studio/src/router";
import { FundingSpreadShocksView, type FundingSpreadShocksViewProps } from "../../../studio/src/pages/scenarios/FundingSpreadShocksPage";
import { marketChoices, withMarket } from "../../../studio/src/plan/planMarket";
import { editCount, editsText, nextEditId, planEditSummary, withPlanId } from "../../../studio/src/plan/planEdits";
import { runButton } from "../../../studio/src/pages/plan/PlanPage";
import { curveAxis, curveLines } from "../../../studio/src/rows/marketRows";
import {
  addFundingOp, emptyFundingShockDraft, fundingRequestOf, fundingSaveNoteOf, planLinkFor, setFundingBase, setFundingOpField,
} from "../../../studio/src/scenarios/fundingSpreadShockModel";

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

function view(over: Partial<FundingSpreadShocksViewProps>): FundingSpreadShocksViewProps {
  return {
    markets: [], base: null, baseNote: null, draft: emptyFundingShockDraft(), block: null, preview: null, note: null, busy: null, planLink: null,
    onBase: noop, onAddOp: noop, onRemoveOp: noop, onOp: noop, onLabel: noop, onId: noop, onPreview: noop, onSave: noop,
    ...over,
  };
}

describe("Funding spread shocks on the seeded platform", () => {
  it("the stored table shows the seeded shock with its label and base", async () => {
    const markets = await listMarket();
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...view({ markets })} />);
    const m = html.match(/<section[^>]*aria-label="Stored funding spread shocks"[^>]*>([\s\S]*?)<\/section>/);
    expect(m).not.toBeNull();
    const rows = [...m![1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));
    expect(rows).toContain("tlp-shock-demo-v1 TLP +50 bp on every node of the public market pack (demonstration values) market-public-2026-03-31 2026-03-31");
    expect(rows.some((r) => r.startsWith(`${BASE_ID} `))).toBe(false);
  });

  it("a preview of add 25 at 10Y through the real route renders the served spreads and change, and a save names the id and links to the Plan page", async () => {
    const base = await getMarket(BASE_ID);
    let draft = addFundingOp(setFundingBase(emptyFundingShockDraft(), BASE_ID));
    draft = setFundingOpField(draft, 0, { tYears: 10, op: "add", valueText: "25" });
    const req = fundingRequestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    expect(req.body).toEqual({ baseId: BASE_ID, ops: [{ target: { tYears: 10 }, op: "add", value: 25 }] });

    const preview: DerivedMarketPreview = await previewDerivedMarket(req.body);
    const markets = await listMarket();
    const html = renderToStaticMarkup(<FundingSpreadShocksView {...view({ markets, base, draft, preview })} />);
    const first = html.indexOf("<table", html.indexOf('aria-label="Preview"'));
    const rows = text(html.slice(first, html.indexOf("</table>", first)));
    expect(rows).toContain("10Y 0.6500% 0.9000% 25");
    expect(text(html)).toContain("Term-funding quotes: 11 not carried");

    const reply = await saveDerivedMarket(req.body);
    expect(reply.outcome).toBe("created");
    expect(reply.id).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    const note = fundingSaveNoteOf(reply);
    expect(note).toMatchObject({ kind: "created", text: `Saved as ${reply.id}`, savedId: reply.id });

    // The note links to Run setups, where a setup names the market.
    expect(planLinkFor("ws-a", {})).toBe("#/ws/ws-a/run/setups");
    const savedHtml = renderToStaticMarkup(<FundingSpreadShocksView {...view({ markets: await listMarket(), base, draft, preview, note, planLink: planLinkFor("ws-a", {}) })} />);
    expect(savedHtml).toContain('href="#/ws/ws-a/run/setups"');
    expect(parseHash(planLinkFor("ws-a", {}))).toMatchObject({ kind: "screen", ws: "ws-a", section: "run", screen: "setups" });
    const m = savedHtml.match(/<section[^>]*aria-label="Stored funding spread shocks"[^>]*>([\s\S]*?)<\/section>/);
    const stored = [...m![1]!.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => text(r[1]!));
    expect(stored).toContain(`${reply.id} Funding spread shock on market-public-2026-03-31 (demonstration values) market-public-2026-03-31 2026-03-31`);
  });

  it("a refusal through the real route reaches the page as every problem listed", async () => {
    const base = await getMarket(BASE_ID);
    let draft = addFundingOp(setFundingBase(emptyFundingShockDraft(), BASE_ID));
    draft = setFundingOpField(draft, 0, { op: "add", valueText: "-50" });
    const req = fundingRequestOf(draft, base);
    if (!("body" in req)) throw new Error(`request blocked: ${req.block}`);
    const note = await previewDerivedMarket(req.body).then(() => null, fundingSaveNoteOf);
    expect(note).not.toBeNull();
    expect(note!.kind).toBe("refused");
    expect(note!.text).toBe("Refused: every problem is listed.");
    expect(note!.problems.length).toBeGreaterThan(0);
  });

  it("the catalog Spreads lists of the seeded derived market label the 1M point 1M, not 0.08333Y", async () => {
    const snap = await getCatalogMarketSnapshot("tlp-shock-demo-v1");
    const lines = curveLines(snap);
    // The derived market stores no term-funding quotes, so that curve draws no line.
    expect(lines.map((l) => l.curve)).toEqual(["risk-free", "tlp"]);
    const tlp = lines.find((l) => l.curve === "tlp")!;
    const axis = curveAxis([tlp.points]);
    expect(axis.labels).toContain("1M");
    expect(axis.labels).toContain("10Y");
    expect(axis.labels.some((l) => l.startsWith("0.0833"))).toBe(false);
    expect(tlp.points.find((p) => p.tYears === 0.083333)?.value).toBe(0.007);
  });
});

describe("Plan page Market picker on the seeded platform", () => {
  it("offers the base and only its direct copies over the real listing", async () => {
    const rows = await listMarket();
    const plan = await getRunPlan("plan-synthetic-2500-v1");
    expect(plan.inputs.marketSnapshot).toBe(BASE_ID);
    const choices = marketChoices(plan.inputs.marketSnapshot, rows);
    expect(choices.base).toBe(BASE_ID);
    // The save test above stored one more derived copy of the same base (add 25 at 10Y), so the copies are that one and the two seeded ones.
    // Re-expectation: was two copies; +1 for the seeded rate-indices-demo-v1 market (same base, ids sort derived-mk, rate-indices, tlp-shock).
    // Re-expectation: was three copies; +1 for the seeded vol-shock-demo-v1 market, same base (ids sort derived-mk, rate-indices, tlp-shock, vol-shock).
    const ids = choices.options.map((o) => o.id);
    expect(ids[0]).toBe(BASE_ID);
    expect(choices.options[0]!.derived).toBe(false);
    // Re-expectation: +1 for the seeded macro-demo-v1 market, same base. Ids sort derived-mk, macro, rate-indices, tlp-shock, vol-shock.
    expect(ids.slice(1)).toHaveLength(5);
    expect(ids.slice(1)[0]).toMatch(/^derived-mk-[0-9a-f]{12}$/);
    expect(ids.slice(1)[1]).toBe("macro-demo-v1");
    expect(ids.slice(1)[2]).toBe("rate-indices-demo-v1");
    expect(ids.slice(1)[3]).toBe("tlp-shock-demo-v1");
    expect(ids.slice(1)[4]).toBe("vol-shock-demo-v1");
    expect(choices.options.slice(1).every((o) => o.derived)).toBe(true);
    expect(rows.filter((r) => r.derivedFromMarketId === BASE_ID).map((r) => r.id).sort()).toEqual(ids.slice(1));
    // The same options come from the copy, and a copy of another base would not appear.
    expect(marketChoices("tlp-shock-demo-v1", rows)).toEqual(choices);
    for (const r of rows.filter((x) => x.derivedFromMarketId !== BASE_ID && x.id !== BASE_ID)) {
      expect(choices.options.map((o) => o.id)).not.toContain(r.id);
    }
  });

  it("a market pick is one edit, keeps Run behind Save as, and saves a plan that names the derived market", async () => {
    const loaded = await getRunPlan("plan-synthetic-2500-v1");
    const picked = withMarket(loaded, loaded, "tlp-shock-demo-v1");
    const summary = planEditSummary(loaded, picked);
    expect(summary.market).toBe(true);
    expect(summary.book).toBe(false);
    expect(editsText(summary)).toBe("market changed");
    expect(editCount(summary)).toBe(1);
    expect(runButton(editCount(summary))).toEqual({ disabled: true, title: "Save as first" });

    const taken = new Set((await listRunPlans()).map((p) => p.id));
    const saveId = nextEditId(loaded.planId, taken);
    expect(saveId).toBe("plan-synthetic-2500-v1-edit-1");
    const res = await realFetch(`${t.base}/api/run-plans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ plan: withPlanId(picked, saveId) }),
    });
    expect(res.status).toBe(201);
    const stored = await getRunPlan(saveId);
    expect(stored.inputs.marketSnapshot).toBe("tlp-shock-demo-v1");
    expect(runButton(editCount(planEditSummary(stored, stored))).disabled).toBe(false);
  });
});
