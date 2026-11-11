// apps/studio/src/__tests__/niiScreen.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NiiMonthlyReply } from "@alm/reader";
import { signedMM, usd } from "@alm/reader";
import { NiiTab } from "../pages/results/NiiTab";
import { NiiMonthlyView } from "../pages/results/NiiMonthlyCard";
import { NewBusinessBlock, madeInWindow } from "../pages/results/NewBusinessBlock";
import { StochasticNiiView } from "../pages/results/NiiAbsentStates";
import { DEFAULT_WINDOW, niiCaption, rollUp, windowChoices, windowOf } from "../pages/results/niiWindow";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const FLAT = "Flat (simple top-up)";
const props = (result = RESULT, query: Record<string, string> = {}, basisLabel: string | null = FLAT) => ({
  ws: "ws-a", runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id, basisLabel,
});

/** 360 months: income 10,000,000 + 1,000 k, expense 4,000,000 + 1,000 k, so net is 6,000,000 every month. */
const income = Array.from({ length: 360 }, (_, k) => 10_000_000 + 1000 * k);
const expense = Array.from({ length: 360 }, (_, k) => 4_000_000 + 1000 * k);
const net = income.map((v, k) => v - expense[k]!);
const REPLY: NiiMonthlyReply = {
  kind: "monthly",
  horizonMonths: 360,
  byScenario: [
    {
      scenarioId: "S0",
      income, expense, net,
      byFamily: [
        { familyId: "cash", side: "asset", income: income.map(() => 5_000_000), expense: income.map(() => 0), net: income.map(() => 5_000_000) },
        { familyId: "fixed-loan", side: "asset", income: income.map(() => 5_000_000), expense: income.map(() => 0), net: income.map(() => 5_000_000) },
      ],
    },
  ],
};

describe("the window control", () => {
  it("defaults to 60 months and never exceeds the grid", () => {
    expect(DEFAULT_WINDOW).toBe(60);
    expect(windowOf({}, 360)).toBe(60);
    expect(windowOf({}, 36)).toBe(36);
  });
  it("reads ?window= inside 12 to the grid length and falls back to the default outside it", () => {
    expect(windowOf({ window: "24" }, 360)).toBe(24);
    expect(windowOf({ window: "360" }, 360)).toBe(360);
    expect(windowOf({ window: "11" }, 360)).toBe(60);
    expect(windowOf({ window: "361" }, 360)).toBe(60);
    expect(windowOf({ window: "abc" }, 360)).toBe(60);
  });
  it("offers 12, 24, 60 and the whole grid as quick choices", () => {
    expect(windowChoices(360)).toEqual([12, 24, 36, 60, 120, 240, 360]);
    expect(windowChoices(48)).toEqual([12, 24, 36, 48]);
  });
  it("captions a figure with the window and the basis label", () => {
    expect(niiCaption(60, FLAT)).toBe("NII, 60 months, Flat (simple top-up)");
    expect(niiCaption(12, null)).toBe("NII, 12 months, basis not recorded");
  });
  it("rolls up the first n months of a series, and null when the series is shorter", () => {
    expect(rollUp([1, 2, 3, 4], 3)).toBe(6);
    expect(rollUp([1, 2], 3)).toBeNull();
  });
});

describe("NII screen: caption, window and standing notes", () => {
  it("prints the 60-month caption with the basis label on the monthly figure", () => {
    const html = renderToStaticMarkup(<NiiTab {...props()} />);
    expect(html).toContain("NII, 60 months, Flat (simple top-up)");
  });
  it("prints the label on the horizon block too", () => {
    const html = renderToStaticMarkup(<NiiTab {...props()} />);
    expect(html).toContain("Basis: Flat (simple top-up)");
  });
  it("prints the Flat standing note under Flat only", () => {
    const flat = renderToStaticMarkup(<NiiTab {...props()} />);
    expect(flat).toContain("The balance mix is static; the product mix is not.");
    expect(flat).not.toContain("Runoff (no new business)");
    const runoff = renderToStaticMarkup(<NiiTab {...props(RESULT, {}, "Runoff")} />);
    expect(runoff).not.toContain("The balance mix is static; the product mix is not.");
  });
  it("prints the Runoff banner under Runoff only", () => {
    const runoff = renderToStaticMarkup(<NiiTab {...props(RESULT, {}, "Runoff")} />);
    expect(runoff).toContain("Runoff (no new business)");
    const custom = renderToStaticMarkup(<NiiTab {...props(RESULT, {}, "Custom dynamic (balance-targets-demo-v1)")} />);
    expect(custom).not.toContain("Runoff (no new business)");
    expect(custom).not.toContain("The balance mix is static; the product mix is not.");
  });
  it("shortens the monthly figure to the window and keeps the stored series otherwise", () => {
    const html = renderToStaticMarkup(<NiiTab {...props(RESULT, { window: "24" })} />);
    expect(html).toContain("NII, 24 months, Flat (simple top-up)");
  });
});

describe("the run's opening window, nii.windowMonths (slice three, decision 118)", () => {
  const withWindow = (months: number) => { const r = freshResult(); r.nii.windowMonths = months; return r; };
  it("windowOf opens on the run's window, clamps it to the grid, and an explicit ?window= still wins", () => {
    expect(windowOf({}, 360, 36)).toBe(36);
    expect(windowOf({}, 24, 36)).toBe(24);
    expect(windowOf({}, 360, undefined)).toBe(DEFAULT_WINDOW);
    expect(windowOf({ window: "120" }, 360, 36)).toBe(120);
    // A query outside 12 to the grid falls back to the run's window, not to 60.
    expect(windowOf({ window: "361" }, 360, 36)).toBe(36);
    // A run window under 12 (possible only through the API) opens at the slider's floor, 12 or a shorter grid.
    expect(windowOf({}, 360, 6)).toBe(12);
    expect(windowOf({}, 8, 6)).toBe(8);
  });
  it("the NII screen opens on the run's window when the envelope carries one", () => {
    const html = renderToStaticMarkup(<NiiTab {...props(withWindow(36))} />);
    expect(html).toContain("NII, 36 months, Flat (simple top-up)");
    expect(html).not.toContain("NII, 60 months");
  });
  it("an envelope without windowMonths opens on 60", () => {
    expect("windowMonths" in RESULT.nii).toBe(false);
    expect(renderToStaticMarkup(<NiiTab {...props()} />)).toContain("NII, 60 months, Flat (simple top-up)");
  });
  it("?window= beats the run's window", () => {
    const html = renderToStaticMarkup(<NiiTab {...props(withWindow(36), { window: "120" })} />);
    expect(html).toContain("NII, 120 months, Flat (simple top-up)");
    expect(html).not.toContain("NII, 36 months");
  });
});

describe("the horizon table follows nii.horizonsMonths (slice three, decision 119)", () => {
  /** The demo envelope with a 60-month entry added to every scenario, as a default slice-three run carries it. */
  const with60 = () => {
    const r = freshResult();
    r.nii.horizonsMonths = [12, 24, 60];
    r.nii.byScenario.forEach((s, i) => { s.totalNetByHorizon = { ...s.totalNetByHorizon, 60: 123_456_789 + 1_000_000 * i }; });
    return r;
  };
  const section = (html: string) => html.slice(html.indexOf('aria-label="NII by horizon"'), html.indexOf("</section>", html.indexOf('aria-label="NII by horizon"')));
  it("a [12, 24, 60] run prints a Net 60m column with the stored 60-month sums, last", () => {
    const r = with60();
    const html = section(renderToStaticMarkup(<NiiTab {...props(r)} />));
    expect(html).toContain('<th scope="col" class="num">Net 12m</th><th scope="col" class="num">Net 24m</th><th scope="col" class="num">Net 60m</th></tr>');
    for (const s of r.nii.byScenario) expect(html).toContain(`totalNetByHorizon.60">${signedMM(s.totalNetByHorizon![60]!)}</td></tr>`);
  });
  it("nothing else on the screen moves: stripping the 60 column gives the [12, 24] page byte for byte", () => {
    const base = renderToStaticMarkup(<NiiTab {...props()} />);
    const html = renderToStaticMarkup(<NiiTab {...props(with60())} />);
    expect(html).not.toBe(base);
    const stripped = html
      .replace('<th scope="col" class="num">Net 60m</th>', "")
      .replace(/<td class="num" title="[^"]*totalNetByHorizon\.60">[^<]*<\/td>/g, "");
    expect(stripped).toBe(base);
  });
});

describe("the monthly table from the engine reader", () => {
  const view = (over: Partial<Parameters<typeof NiiMonthlyView>[0]> = {}) => renderToStaticMarkup(
    <NiiMonthlyView reply={REPLY} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={60} family={null} basisLabel={FLAT} query={{}} stored={{ net12: 72_000_000, net24: 144_000_000 }} {...over} />,
  );
  it("prints one row per month of the window with income, expense and net, and no row past it", () => {
    const html = view();
    expect(html).toContain('<th scope="row" class="num">1</th>');
    expect(html).toContain('<th scope="row" class="num">60</th>');
    expect(html).not.toContain('<th scope="row" class="num">61</th>');
    expect(html).toContain(usd(10_000_000));
    expect(html).toContain(usd(4_000_000));
    expect(html).toContain(usd(6_000_000));
    expect(html).toContain("NII, 60 months, Flat (simple top-up)");
  });
  it("shows the 12 and 24 month roll-ups as derived from the monthly series, with the stored sum beside them", () => {
    const html = view();
    expect(html).toContain("Derived roll-up");
    expect(html).toContain("not an engine field");
    // income 12 = 120,066,000; expense 12 = 48,066,000; net 12 = 72,000,000; net 24 = 144,000,000.
    expect(html).toContain("$120.1M");
    expect(html).toContain("$48.1M");
    expect(html).toContain("+$72.0M");
    expect(html).toContain("+$144.0M");
    expect(html).toContain("matches the stored horizon sum");
  });
  it("flags a roll-up that differs from the stored horizon sum", () => {
    expect(view({ stored: { net12: 71_000_000, net24: 144_000_000 } })).toContain("differs from the stored horizon sum");
  });
  it("reads one family's rows when a family is chosen", () => {
    const html = view({ family: "cash" });
    expect(html).toContain("cash");
    expect(html).toContain(usd(5_000_000));
    expect(html).not.toContain(usd(10_000_000));
  });
  it("carries the window range control from 12 to the grid length", () => {
    const html = view();
    expect(html).toContain('type="range"');
    expect(html).toContain('min="12"');
    expect(html).toContain('max="360"');
    expect(html).toContain('value="60"');
  });
});

describe("the absent states print their typed reason, not an error", () => {
  const absent = (reason: "no-netMonthly" | "stochastic") => renderToStaticMarkup(
    <NiiMonthlyView reply={{ kind: "absent", reason }} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={60} family={null} basisLabel={FLAT} query={{}} stored={null} />,
  );
  it("an envelope without netMonthly says to re-run on the current engine", () => {
    const html = absent("no-netMonthly");
    expect(html).toContain("Monthly NII not stored on this envelope; re-run on the current engine");
    expect(html).not.toContain('role="alert"');
  });
  it("a stochastic envelope says monthly NII is not part of it", () => {
    const html = absent("stochastic");
    expect(html).toContain("monthly NII is not part of the stochastic envelope");
    expect(html).not.toContain('role="alert"');
  });
  it("a stochastic run prints its 12-month distribution beside that sentence", () => {
    const rows = [{ stat: "mean" as const, p: null, value: 1_234_567 }, { stat: "quantile" as const, p: 0.05, value: 987_654 }];
    const html = renderToStaticMarkup(<StochasticNiiView runId="run-mc" rows={rows} />);
    expect(html).toContain("monthly NII is not part of the stochastic envelope");
    expect(html).toContain("NII 12m distribution");
    expect(html).toContain("Mean");
  });
});

const familyIds = RESULT.nii.byScenario[0]!.byFamily.map((f) => f.familyId);

function withNewBusiness() {
  const r = freshResult();
  const s0 = r.nii.byScenario[0]!;
  s0.newBusiness = familyIds.slice(0, 2).map((familyId, i) => ({
    familyId,
    originations: Array.from({ length: 360 }, (_, k) => (k === 0 ? 0 : 1_000_000 * (i + 1))),
  }));
  s0.shortfalls = [{ familyId: familyIds[2]!, reinvest: "flat", firstBucket: 3, clampedBuckets: 12, targetBalanceEnd: 1_000_000, achievedBalanceEnd: 1_500_000, balanceGapEnd: 500_000 }];
  r.notImplemented = [...r.notImplemented, { _tag: "not-implemented", layer: "plan.balance-basis.skipped", reason: "flat basis skipped 2 families with no positive opening balance or a side other than asset or liability: swaps, fees" }];
  return r;
}

describe("the New business block", () => {
  const block = (result = withNewBusiness(), label: string | null = FLAT, scenarioId = "S0") => renderToStaticMarkup(
    <NewBusinessBlock result={result} scenarioId={scenarioId} scenarioLabel={(id) => id} basisLabel={label} window={60} />,
  );
  it("renders one row per family the scenario originated, with the window total marked derived", () => {
    const html = block();
    expect(html).toContain("New business");
    expect(html).toContain(familyIds[0]!);
    expect(html).toContain(familyIds[1]!);
    // Ruling 46: bucket 0 is the opening bucket and is zero; a 60 month window holds the tranches made in months 1 to
    // 60, so 60 x 1,000,000 and 60 x 2,000,000 by hand (the old 0 to 59 reading gave $59.0M and $118.0M).
    expect(html).toContain("$60.0M");
    expect(html).toContain("$120.0M");
    expect(html).not.toContain("$59.0M");
    expect(html).toContain("derived");
  });
  it("renders every reinvestment shortfall as a named row with its family and balanceGapEnd", () => {
    const html = block();
    expect(html).toContain(familyIds[2]!);
    expect(html).toContain(usd(500_000));
    expect(html).toContain("held above its target");
  });
  it("lists the skipped families from the compile tag", () => {
    const html = block();
    expect(html).toContain("Skipped by the Flat basis");
    expect(html).toContain("swaps, fees");
  });
  it("says originations are not stored on an envelope from before the arm existed", () => {
    const html = block(freshResult());
    expect(html).toContain("originations not stored on this envelope");
  });
  it("says a static scenario of a mixed run runs off", () => {
    const html = block(withNewBusiness(), "Flat on S0, Runoff on S100", "S100");
    expect(html).toContain("runs off");
    expect(html).not.toContain("originations not stored on this envelope");
  });
  it("renders nothing on a Runoff run", () => {
    expect(block(freshResult(), "Runoff")).toBe("");
  });
  it("sits on the NII screen under the horizon block", () => {
    const html = renderToStaticMarkup(<NiiTab {...props(withNewBusiness())} />);
    expect(html).toContain("Skipped by the Flat basis");
  });
});

describe("ruling 46: the New business block's window counts months 1 .. N", () => {
  it("originations 0, 10, 20, ... over a window of 6 read 210 by hand, months 1 to 6, labelled 1 to 6", () => {
    const r = freshResult();
    const s0 = r.nii.byScenario[0]!;
    // Index k is the tranche made at the end of month k: 0, 10, 20, 30, 40, 50, 60, 70, 80 (index 0 holds nothing).
    s0.newBusiness = [{ familyId: familyIds[0]!, originations: [0, 10_000_000, 20_000_000, 30_000_000, 40_000_000, 50_000_000, 60_000_000, 70_000_000, 80_000_000] }];
    const html = renderToStaticMarkup(<NewBusinessBlock result={r} scenarioId="S0" scenarioLabel={(id) => id} basisLabel={FLAT} window={6} />);
    // 10 + 20 + 30 + 40 + 50 + 60 = 210 (millions); the old slice of indices 0 to 5 read 150.
    expect(html).toContain("$210.0M");
    expect(html).not.toContain("$150.0M");
    // Months originating over the window: all six months made something.
    expect(html).toMatch(/\$210\.0M[^]*?<td class="num">6<\/td>/);
    // The monthly table: month 1 shows the month-1 tranche (10,000,000), month 6 the month-6 one, month 7 is past the window.
    const rows = [...html.matchAll(/<tr><th scope="row" class="num">(\d+)<\/th><td class="num">([^<]+)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
    expect(rows.map((x) => x[0])).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect(rows[0]![1]).toBe(usd(10_000_000));
    expect(rows[5]![1]).toBe(usd(60_000_000));
  });
  it("a grid shorter than the window gives the months it holds", () => {
    expect(madeInWindow([0, 1, 2, 3], 12)).toEqual([1, 2, 3]);
    expect(madeInWindow([0, 1, 2, 3], 2)).toEqual([1, 2]);
  });
});
