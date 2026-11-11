// apps/studio/src/__tests__/shockPreview.test.tsx
/**
 * The preview loop's pure parts and the preview card. Expected texts and numbers are restated from the
 * fixture literal.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, type ShockPreview } from "@alm/reader";
import { actionEnabled, classifyPreview, keep, previewFor, previewKey, refusalText, retryPreview, toPreviewState, type PreviewState } from "../pages/scenarios/useShockPreview";
import { ShockPreviewCard } from "../pages/scenarios/ShockPreviewCard";

const SPEC = { kind: "parallel" as const, shockBp: 300 };
const REPLY: ShockPreview = {
  marketSnapshot: "market-public-2026-03-31",
  calibrationDate: "2026-03-31",
  base: { t: [1, 30], z: [0.04, 0.05], df: [0.96, 0.22] },
  // Self-consistent (Polish 13 fix round 2): each shocked rate is the base rate plus the served shift, 300 bp at 1Y and
  // -0.01 bp at 30Y (the shift that prints as an unsigned 0.0).
  shocked: { t: [1, 30], z: [0.07, 0.049999], df: [0.93, 0.22] },
  shiftBp: [300.00000000000006, -0.01],
};
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("preview keys and answers", () => {
  it("keys by snapshot and spec; no spec, no key", () => {
    expect(previewKey("m", null)).toBeNull();
    expect(previewKey("m", SPEC)).toBe(previewKey("m", { kind: "parallel", shockBp: 300 }));
    expect(previewKey("m", SPEC)).not.toBe(previewKey("m2", SPEC));
    expect(previewKey("m", SPEC)).not.toBe(previewKey("m", { kind: "parallel", shockBp: 301 }));
  });
  it("paints an answer only for its own key", () => {
    const ok: PreviewState = { state: "ok", reply: REPLY };
    const key = previewKey("m", SPEC);
    expect(previewFor(null, { key, p: ok })).toEqual({ state: "idle" });
    expect(previewFor(key, { key, p: ok })).toBe(ok);
    expect(previewFor(previewKey("m", { kind: "parallel", shockBp: 301 }), { key, p: ok })).toEqual({ state: "checking", last: REPLY });
  });
  it("while a new form is checked, the last ok reply rides along (Polish 1 S1)", () => {
    const key = previewKey("m", SPEC);
    const next = previewKey("m", { kind: "parallel", shockBp: 301 });
    expect(previewFor(next, { key, p: { state: "refused", message: "x" }, last: REPLY })).toEqual({ state: "checking", last: REPLY });
    expect(previewFor(next, { key, p: { state: "refused", message: "x" } })).toEqual({ state: "checking" });
    expect(previewFor(null, { key, p: { state: "ok", reply: REPLY } })).toEqual({ state: "idle" });
  });
  it("keep records the answer under its key and carries the last ok reply forward", () => {
    const first = keep({ key: null, p: { state: "idle" } }, "a", { state: "ok", reply: REPLY });
    expect(first).toEqual({ key: "a", p: { state: "ok", reply: REPLY } });
    expect(keep(first, "b", { state: "refused", message: "x" })).toEqual({ key: "b", p: { state: "refused", message: "x" }, last: REPLY });
  });
  it("Check again reads checking for the same key (Polish 1 S2)", () => {
    const key = previewKey("m", SPEC);
    expect(previewFor(key, retryPreview({ key, p: { state: "unavailable", message: "Failed to fetch" } }))).toEqual({ state: "checking" });
    expect(previewFor(key, retryPreview({ key, p: { state: "unavailable", message: "Failed to fetch" }, last: REPLY }))).toEqual({ state: "checking", last: REPLY });
  });
  it("a reply the card cannot draw is unavailable, and never enables the action (Polish 1 S3)", () => {
    expect(toPreviewState(REPLY)).toEqual({ state: "ok", reply: REPLY });
    const bad = toPreviewState({ ...REPLY, shiftBp: [300, null as unknown as number] });
    // Plain words for the reader: no field path, no "null" (Task 8 fix M3).
    expect(bad).toEqual({ state: "unavailable", message: "The platform sent a preview with missing or unreadable values, so it cannot be drawn." });
    expect(actionEnabled(true, bad)).toBe(false);
  });
  it("a 4xx is a refusal with the server's text, no status prefix; anything else is unavailable", () => {
    expect(classifyPreview(new ApiError(422, "validation", "twist pivot 40y must lie strictly inside (0, 30y)")))
      .toEqual({ state: "refused", message: "twist pivot 40y must lie strictly inside (0, 30y)" });
    expect(classifyPreview(new ApiError(404, "not-found", "no market"))).toEqual({ state: "refused", message: "no market" });
    expect(classifyPreview(new ApiError(500, "internal", "boom"))).toMatchObject({ state: "unavailable" });
    expect(classifyPreview(new TypeError("Failed to fetch"))).toEqual({ state: "unavailable", message: "The platform could not be reached. Is it running?" });
  });
  it("a 4xx with no JSON body is the platform failing, not a refusal of the shock: unavailable, so Check again shows (final review I1)", () => {
    expect(classifyPreview(new ApiError(404, "http-error", "404 Not Found")))
      .toEqual({ state: "unavailable", message: "The request failed with HTTP 404 and the reply gave no reason." });
    expect(classifyPreview(new ApiError(429, "http-error", "429 Too Many Requests")))
      .toEqual({ state: "unavailable", message: "The request failed with HTTP 429 and the reply gave no reason." });
  });
  it("a refusal naming a zero-based knot says which table row it means (Polish 1 S4)", () => {
    const engine = "invalid custom shock vector at rateSpec.shocks[1].tenorYears: tenor 1y must strictly exceed the preceding tenor 5y (tenors ascending, no duplicates)";
    expect(classifyPreview(new ApiError(422, "validation", engine))).toEqual({ state: "refused", message: `${engine} (knot 2 in the table)` });
    expect(refusalText("invalid custom shock vector at rateSpec.shocks[0].shockBp: shock at tenor 1y must be a finite number, got null"))
      .toBe("invalid custom shock vector at rateSpec.shocks[0].shockBp: shock at tenor 1y must be a finite number, got null (knot 1 in the table)");
    expect(refusalText("twist pivot 40y must lie strictly inside (0, 30y)")).toBe("twist pivot 40y must lie strictly inside (0, 30y)");
  });
});

describe("the action (spec Section 5.1 item 5, Section 6 item 3)", () => {
  it("is on only for a passing form with an ok answer to that form", () => {
    const ok: PreviewState = { state: "ok", reply: REPLY };
    expect(actionEnabled(true, ok)).toBe(true);
    expect(actionEnabled(false, ok)).toBe(false);
    const others: PreviewState[] = [{ state: "idle" }, { state: "checking" }, { state: "refused", message: "x" }, { state: "unavailable", message: "x" }];
    for (const p of others) expect(actionEnabled(true, p), p.state).toBe(false);
    expect(actionEnabled(true, { state: "checking", last: REPLY })).toBe(false);
    const key = previewKey("m", SPEC);
    const older = previewFor(previewKey("m", { kind: "parallel", shockBp: 301 }), { key, p: ok });
    expect(actionEnabled(true, older)).toBe(false);
  });
});

describe("ShockPreviewCard", () => {
  it("draws the served curves and prints each node: tenor, both rates, the served shift", () => {
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="market-public-2026-03-31" preview={{ state: "ok", reply: REPLY }} />);
    expect(html).toContain("<svg");
    const t = text(html);
    expect(t).toContain("Preview on market-public-2026-03-31");
    expect(t).toContain("Calibration date 2026-03-31. Continuously compounded zero rates. Longest curve tenor 30Y. The chart spaces the tenors to scale on a square-root axis.");
    expect(t).not.toContain("evenly");
    expect(t).toContain("1Y 4.00% 7.00% 300.0");
    expect(t).toContain("30Y 5.00% 5.00% 0.0");
    // Row header scope 2: the tenor names its row.
    expect(html).toContain('<tr><th scope="row" class="num">1Y</th><td class="num">4.00%</td>');
    expect(html).toContain('<tr><th scope="row" class="num">30Y</th><td class="num">5.00%</td>');
    expect(t).toContain("The engine applies no floor: a zero rate below zero is shown as it is.");
  });
  it("heads its table short enough to fit the card, names the chart's unit once, and holds each number once (no Show table)", () => {
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="market-public-2026-03-31" preview={{ state: "ok", reply: REPLY }} />);
    expect(html).toContain('<thead><tr><th scope="col" class="num">Tenor</th><th scope="col" class="num">Base</th><th scope="col" class="num">Shocked</th><th scope="col" class="num">Shift (bp)</th></tr></thead>');
    expect(html).toContain('<div class="lp-unit"><span>percent</span></div>');
    expect(html).toContain('role="img" aria-label="Base curve, Shocked curve, percent"');
    expect(text(html)).not.toContain("continuously compounded zero rate, percent");
    expect(text(html)).not.toContain("Show table");
  });
  it("draws the two curves on LinePlot with tenors to scale and a y range that fits them, not from 0 (Polish 13)", () => {
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="market-public-2026-03-31" preview={{ state: "ok", reply: REPLY }} />);
    // Values 4.00 to 7.00 padded 0.15 each side: raw step 3.3 / 6 = 0.55 rounds to 0.5, so ticks 3.5% to 7.5%, not
    // from 0; every value is positive, so there is no zero line.
    expect(html).toContain('<text class="lp-ax" x="42" y="275.5" text-anchor="end">3.5%</text>');
    expect(html).toContain('<text class="lp-ax" x="42" y="13.5" text-anchor="end">7.5%</text>');
    expect(html).not.toContain(">0.0%</text>");
    expect(html).not.toContain("lp-zero");
    // Square-root axis from 0 to 30Y over 50 to 624 px: 1Y at 50 + 574 / sqrt(30) = 154.80 px, 30Y at 624 px. y = 10 +
    // (7.5 - v) / 4 * 262: the base curve (muted) 4.00 at 239.25 px, 5.00 at 173.75 px; the shocked curve (accent) 7.00
    // at 42.75 px, 4.9999 at 173.76 px.
    expect(html).toContain('<path class="lp-line" d="M154.80,239.25L624.00,173.75" stroke="var(--muted)"></path>');
    expect(html).toContain('<path class="lp-line" d="M154.80,42.75L624.00,173.76" stroke="var(--series-1)"></path>');
    // One x tick per node, labelled as the table labels it; a legend chip per curve.
    expect(html).toContain('text-anchor="middle">1Y</text>');
    expect(html).toContain('text-anchor="middle">30Y</text>');
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--muted)"></i>Base curve</button>');
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--series-1)"></i>Shocked curve</button>');
    // No drag zoom on the preview.
    expect(html).not.toContain("Drag to zoom");
  });
  it("shows a refusal with no chart, and says so while checking or idle", () => {
    const refused = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "refused", message: "twist pivot 40y must lie strictly inside (0, 30y)" }} />);
    expect(refused).not.toContain("<svg");
    expect(text(refused)).toContain("Refused twist pivot 40y must lie strictly inside (0, 30y)");
    expect(text(renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "checking" }} />))).toContain("Checking the shock on m");
    expect(text(renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "idle" }} />))).toContain("Complete the form to see the shocked curve.");
    expect(text(renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "unavailable", message: "Failed to fetch" }} />))).toContain("Preview unavailable Failed to fetch");
  });
  it("while checking, the previous form's curve stays drawn under the checking line (Polish 1 S1)", () => {
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "checking", last: REPLY }} />);
    expect(text(html)).toContain("Checking the shock on m. The chart below shows the previous form.");
    expect(html).toContain('<div class="preview-stale">');
    expect(html).toContain("<svg");
    expect(text(html)).toContain("4.00% 7.00% 300.0");
  });
  it("an unavailable preview offers Check again; a refusal does not (Polish 1 S2)", () => {
    const retry = () => {};
    const unavailable = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "unavailable", message: "Failed to fetch" }} onRetry={retry} />);
    // A bordered secondary button on a line of its own, not a transparent quiet one (Task 8 fix, critic minor 10).
    expect(unavailable).toContain('<div class="sheet-actions"><button type="button" class="btn">Check again</button></div>');
    expect(text(unavailable)).toContain("Preview unavailable Failed to fetch Check again");
    const refused = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "refused", message: "x" }} onRetry={retry} />);
    expect(refused).not.toContain("Check again");
  });
  it("a reply whose arrays disagree shows the reader's refusal, not a short table", () => {
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "ok", reply: { ...REPLY, shiftBp: [300] } }} />);
    expect(html).not.toContain("<svg");
    expect(text(html)).toContain("shock preview arrays disagree");
  });
  it("the stored 1M node prints as 1M in the table and on the chart (Polish 1 S5)", () => {
    const oneMonth = { ...REPLY, base: { t: [0.083333, 30], z: [0.04, 0.05], df: [0.99, 0.22] }, shocked: { t: [0.083333, 30], z: [0.07, 0.049999], df: [0.99, 0.22] } };
    const html = renderToStaticMarkup(<ShockPreviewCard marketSnapshot="m" preview={{ state: "ok", reply: oneMonth }} />);
    expect(text(html)).toContain("1M 4.00% 7.00% 300.0");
    expect(html).toContain('text-anchor="middle">1M</text>');
    expect(html).not.toContain("0.083333");
  });
});
