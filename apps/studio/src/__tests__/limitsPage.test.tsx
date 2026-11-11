// apps/studio/src/__tests__/limitsPage.test.tsx
/**
 * Controls (limits): Govern > Controls > Limits lists each stored lens, read-only. The six definitions are restated
 * here from docs/harness/lenses.json as GET /api/lenses serves them; nothing is read from the page code.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { LensListItem } from "@alm/reader";
import { LimitsView } from "../pages/controls/LimitsPage";
import { layerDef } from "../router";

const H = "a".repeat(64);
const LENSES = [
  { id: "balance-demo-v1", label: "Balance runoff (demonstration limits, reads the demonstration metric)", objective: "strategy", contentHash: H,
    constraints: [{ id: "runoff-50", reader: "customValue", params: { metricId: "balance-summary", key: "runoff-share" }, op: "atMost", limit: 0.5, label: "Share of opening balance run off by the final bucket" }] },
  { id: "capital-demo-v1", label: "Capital (demonstration limits)", objective: "capital", contentHash: H,
    constraints: [{ id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08, label: "Common equity tier 1 ratio (no component on this envelope)" }] },
  { id: "liquidity-demo-v1", label: "Liquidity (demonstration limits)", objective: "liquidity", contentHash: H,
    constraints: [
      { id: "cum-gap-1m", reader: "cumulativeLiquidityGap", params: { band: "0-1M" }, op: "atLeast", limit: -50000000, label: "Cumulative liquidity gap through 1 month" },
      { id: "cum-gap-3m", reader: "cumulativeLiquidityGap", params: { band: "1-3M" }, op: "atLeast", limit: -100000000, label: "Cumulative liquidity gap through 3 months" },
    ] },
  { id: "rate-demo-v1", label: "Interest-rate risk (demonstration limits)", objective: "rate", contentHash: H,
    constraints: [
      { id: "eve-15", reader: "deltaEvePct", op: "atLeast", limit: -0.15, label: "Delta EVE versus base, decimal fraction" },
      { id: "nii-12", reader: "deltaNiiPct", params: { horizonMonths: 12 }, op: "atLeast", limit: -0.1, label: "Delta NII at 12 months versus base, decimal fraction" },
    ] },
  { id: "strategy-demo-v1", label: "Management strategy (demonstration limits)", objective: "strategy", contentHash: H,
    constraints: [
      { id: "no-shortfall", reader: "shortfallCount", op: "atMost", limit: 0, label: "Reinvestment shortfalls reported by the projection" },
      { id: "nii-24", reader: "deltaNiiPct", params: { horizonMonths: 24 }, op: "atLeast", limit: -0.05, label: "Delta NII at 24 months versus base, decimal fraction" },
    ] },
  { id: "wal-gap-demo-v1", label: "WAL gap (demonstration limits, reads the wal-gap metric)", objective: "liquidity", contentHash: H,
    constraints: [
      { id: "gap-24", reader: "customValue", params: { metricId: "wal-gap", key: "wal-gap" }, op: "atMost", limit: 24, label: "Asset WAL minus liability WAL, months" },
      { id: "ratio-50", reader: "customValue", params: { metricId: "wal-gap", key: "wal-ratio" }, op: "atLeast", limit: 0.5, label: "Liability WAL over asset WAL" },
    ] },
] as unknown as LensListItem[];

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("Limits page (Controls)", () => {
  const html = renderToStaticMarkup(<LimitsView lenses={LENSES} />);

  it("lists all six stored lenses as cards, label then objective", () => {
    const cards = [...html.matchAll(/<section class="card table-card" aria-label="Lens ([^"]+)">/g)].map((m) => m[1]);
    expect(cards).toEqual(["balance-demo-v1", "capital-demo-v1", "liquidity-demo-v1", "rate-demo-v1", "strategy-demo-v1", "wal-gap-demo-v1"]);
    expect(html).toContain('<div class="card-title">Interest-rate risk (demonstration limits)</div><p class="card-desc">Objective rate; id <span class="mono">rate-demo-v1</span>.</p>');
  });

  it("prints each constraint's reader, test as at most or at least, stored limit and label", () => {
    expect(html).toContain('<tr><th scope="row" class="mono">eve-15</th><td class="mono">deltaEvePct</td><td>at least</td><td class="num">-0.15</td><td>Delta EVE versus base, decimal fraction</td></tr>');
    expect(html).toContain('<tr><th scope="row" class="mono">no-shortfall</th><td class="mono">shortfallCount</td><td>at most</td><td class="num">0</td><td>Reinvestment shortfalls reported by the projection</td></tr>');
    expect(html).toContain('<td class="mono">cumulativeLiquidityGap<span class="muted"> band=0-1M</span></td><td>at least</td><td class="num">-50000000</td>');
    expect(text(html).match(/ at most /g)).toHaveLength(3);
    expect(text(html).match(/ at least /g)).toHaveLength(7);
    expect(html).not.toContain("atMost");
    expect(html).not.toContain("atLeast");
  });

  it("says plainly the lenses are demonstration values and that editing is not available yet, with no date", () => {
    const t = text(html);
    expect(t).toContain("The 6 stored lenses are demonstration values: every limit is illustrative, and none is a calibrated or governed limit.");
    expect(t).toContain("Editing is not available yet: the seed is the only writer, and this page only reads.");
    expect(t).not.toMatch(/risk appetite/i);
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(t).toContain("Source: /api/lenses");
  });

  it("an empty store says so", () => {
    expect(text(renderToStaticMarkup(<LimitsView lenses={[]} />))).toContain("The store holds no lens definition, so /api/lenses returned none.");
  });

  it("the Limits layer and Approvals and sign-off are both live, with no soon piece", () => {
    expect(layerDef("govern/controls/limits").status).toBe("live");
    expect(layerDef("govern/controls/limits").soon).toBeUndefined();
    expect(layerDef("govern/controls/approvals").status).toBe("live");
    expect(layerDef("govern/controls/approvals").soon).toBeUndefined();
  });
});
