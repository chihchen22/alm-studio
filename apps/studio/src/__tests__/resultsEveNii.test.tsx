// apps/studio/src/__tests__/resultsEveNii.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_IN_RUN, signedMM, signedPct, usdMM, years } from "@alm/reader";
import { EQUITY_GATE_REASON, EveTab, FAMILY_GATE_REASON, FAMILY_GATE_SENTENCE } from "../pages/results/EveTab";
import { NiiTab } from "../pages/results/NiiTab";
import { OverviewTab } from "../pages/results/OverviewTab";
import { liveTabs } from "../pages/results/tabs";
import { scenarioLabeller } from "../format/scenarios";
import { BLOCKS_DETAIL, BLOCK_GROUPS, blocksResult } from "./fixtures/blocks";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const props = (result = RESULT, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id });

describe("EveTab", () => {
  it("prints each scenario's stored fields with the viewer's formatters", () => {
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props()} />);
    const s = RESULT.eve.byScenario[1]!;
    expect(html).toContain(usdMM(RESULT.eve.byScenario[0]!.pvAssets));
    expect(html).toContain(usdMM(s.eve));
    expect(html).toContain(signedMM(s.deltaEveVsBase));
    expect(html).toContain(signedPct(s.deltaEvePct));
  });

  it("says key-rate and channels are not in this run when the envelope lacks them", () => {
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props()} />);
    expect(html).toContain("Key-rate durations");
    expect(html).toContain("has no eve.keyRate");
    expect(html).toContain("has no eve.channels");
    expect(html).toContain(NOT_IN_RUN);
  });

  it("keeps the four stored duration states apart", () => {
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props()} />);
    const s0 = RESULT.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(html).toContain(years(s0.effectiveDurationEquity!));
    expect(html).toContain("n/a (base-only)");

    const kept = freshResult();
    const k = kept.eve.byScenario.find((s) => s.scenarioId === "S100")!;
    k.durationSanityPassed = false;
    k.effectiveDurationEquity = 7.654321;
    const keptHtml = renderToStaticMarkup(<EveTab ws="ws-a" {...props(kept)} />);
    expect(keptHtml).toContain(`>${years(7.654321)} <span class="status status-breach" title="${FAMILY_GATE_REASON}">family gate failed<`);
    expect(keptHtml).toContain(FAMILY_GATE_REASON);
    // The sentence is on the page, not only in a title (Studio Part 2 D16).
    expect(FAMILY_GATE_SENTENCE).toBe("A family duration gate failed; the equity duration shown is the one the engine kept.");
    expect(keptHtml).toContain(`<span class="field-help">${FAMILY_GATE_SENTENCE}</span>`);
    expect(html).not.toContain(FAMILY_GATE_SENTENCE);
    expect(keptHtml).not.toContain(EQUITY_GATE_REASON);

    const gone = freshResult();
    const g = gone.eve.byScenario.find((s) => s.scenarioId === "S100")!;
    g.durationSanityPassed = false;
    delete g.effectiveDurationEquity;
    const goneHtml = renderToStaticMarkup(<EveTab ws="ws-a" {...props(gone)} />);
    expect(goneHtml).toContain(">flagged<");
    expect(goneHtml).toContain(EQUITY_GATE_REASON);
    expect(goneHtml).not.toContain(FAMILY_GATE_REASON);
  });

  it("a scenario without pvDerivatives on a derivative book says why", () => {
    const r = freshResult();
    r.eve.byScenario[0]!.pvDerivatives = 1_500_000;
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("PV derivatives");
    expect(html).toContain(signedMM(1_500_000));
    expect(html).toContain(`title="pvDerivatives is absent for ${r.eve.byScenario[1]!.scenarioId}">${NOT_IN_RUN}<`);
  });

  it("prints the channel decomposition when the envelope carries it", () => {
    const r = freshResult();
    r.eve.channels = { discountBasis: "all-in", byScenario: [{ scenarioId: "S100", eveBase: 5e8, eveShocked: 4e8, totalDelta: -1e8, projectionDelta: -3e7, discountingDelta: -6.9e7, interactionResidual: -1_234_567 }] };
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Interaction residual");
    expect(html).toContain(signedMM(-1_234_567));
    expect(html).not.toContain("has no eve.channels");
  });
});

describe("NiiTab", () => {
  it("prints the horizon block verbatim and the selected scenario's monthly vector", () => {
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(RESULT, { scenario: "S100" })} />);
    const s100 = RESULT.nii.byScenario.find((s) => s.scenarioId === "S100")!;
    expect(html).toContain(signedMM(RESULT.nii.byScenario[0]!.totalNet12));
    expect(html).toContain(signedMM(s100.totalNet24));
    expect(html).toContain(signedMM(s100.netMonthly![0]!));
    expect(html).toContain("nii.byScenario[scenarioId=S100].netMonthly");
    // Each horizon row opens on its scenario as a row header (Row header scope).
    expect(html).toContain('<tr><th scope="row">S0 <span class="mono muted">S0</span></th><td class="num"');
    expect(html).toContain('<tr><th scope="row">S100 <span class="mono muted">S100</span></th><td class="num"');
  });

  it("draws the monthly net on LinePlot: bucket k at month k + 1, signed USD millions, a zero line, no area (Polish 13)", () => {
    const r = freshResult();
    r.nii.byScenario.find((s) => s.scenarioId === "S100")!.netMonthly = [2_000_000, -1_000_000, 3_000_000];
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(r, { scenario: "S100" })} />);
    expect(html).toContain('role="img" aria-label="S100, USD per month, side-signed"');
    expect(html).toContain('<div class="lp-unit"><span>USD per month, side-signed</span><span>Drag to zoom</span></div>');
    // -1M to 3M padded 0.2M each side: raw step 4.4M / 6 = 0.73M rounds to 1M, so ticks -2M to 4M. The top tick sits at
    // 10 px, the foot at 272 px; 0 lies inside, so the zero line is drawn.
    expect(html).toContain('<text class="lp-ax" x="42" y="13.5" text-anchor="end">$4M</text>');
    expect(html).toContain('<text class="lp-ax" x="42" y="275.5" text-anchor="end">−$2M</text>');
    expect(html).toContain('class="lp-zero"');
    // Months 1 to 3 at x 50, 337 and 624 px; y = 10 + (4 - v) / 6 * 262 px: 97.33, 228.33, 53.67.
    expect(html).toContain('<path class="lp-line" d="M50.00,97.33L337.00,228.33L624.00,53.67" stroke="var(--series-1)"></path>');
    expect(html).not.toContain("lp-area");
    expect(html).toContain('<tr><th scope="row">M2</th><td class="num lvl">-$1.0M</td></tr>');
    expect(html).not.toContain("over 3 points");
  });

  it("a removed monthly vector is not in this run", () => {
    const r = freshResult();
    delete r.nii.byScenario[0]!.netMonthly;
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(r)} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("has no netMonthly");
  });

  it("both tabs are registered, NII before EVE in the Task 12 order", () => {
    const own = ["overview", "nii", "eve"];
    expect(liveTabs().map((t) => t.id).filter((id) => own.includes(id))).toEqual(own);
  });
});

describe("a scenario id holding '].'", () => {
  it("renders the Overview and NII tabs for scenario S].0 without throwing", () => {
    const r = freshResult();
    const from = r.eve.byScenario[0]!.scenarioId;
    const id = "S].0";
    r.eve.byScenario[0]!.scenarioId = id;
    r.nii.byScenario.find((s) => s.scenarioId === from)!.scenarioId = id;
    r.cashflows.byScenario.find((s) => s.scenarioId === from)!.scenarioId = id;
    r.provenance.scenarioIds = r.provenance.scenarioIds.map((s) => (s === from ? id : s));
    const eve = r.eve.byScenario[0]!;
    const nii = r.nii.byScenario.find((s) => s.scenarioId === id)!;

    const overview = renderToStaticMarkup(<OverviewTab ws="ws-a" {...props(r)} />);
    expect(overview).toContain(`title="eve.byScenario[scenarioId=${id}].eve">${usdMM(eve.eve)}<`);
    expect(overview).toContain(`title="nii.byScenario[scenarioId=${id}].totalNet12">${signedMM(nii.totalNet12)}<`);
    expect(overview).not.toContain(NOT_IN_RUN);

    const niiHtml = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(r, { scenario: id })} />);
    expect(niiHtml).toContain(`title="nii.byScenario[scenarioId=${id}].totalNet12">${signedMM(nii.totalNet12)}<`);
    expect(niiHtml).toContain(signedMM(nii.netMonthly![0]!));
    expect(niiHtml).toContain(`nii.byScenario[scenarioId=${id}].netMonthly`);
    expect(niiHtml).not.toContain(NOT_IN_RUN);
  });
});

describe("NiiTab, the two earnings conventions (Task 12)", () => {
  const withSeg = () => renderToStaticMarkup(<NiiTab ws="ws-a" {...props(blocksResult())} runId="run-fixture" />);

  it("prints two cards under their convention labels, the runoff one first", () => {
    const html = withSeg();
    expect(html).toContain("Runoff convention (engine)");
    expect(html).toContain("Constant balance sheet convention");
    expect(html.indexOf("Runoff convention (engine)")).toBeLessThan(html.indexOf("Constant balance sheet convention"));
  });

  it("puts NIM under each card: the engine's own under the runoff card, the seg block's under the other", () => {
    const html = withSeg();
    const runoff = html.slice(html.indexOf("Runoff convention (engine)"), html.indexOf("Constant balance sheet convention"));
    const constant = html.slice(html.indexOf("Constant balance sheet convention"));
    // Fixture: nii.nimPct 2.5, seg.nimPct 2.97.
    expect(runoff).toContain("NIM 2.50%");
    expect(runoff).not.toContain("2.97%");
    expect(constant).toContain("NIM 2.97%");
    // The runoff card prints the base scenario's stored 12-month net.
    expect(runoff).toContain(usdMM(RESULT.nii.byScenario[0]!.totalNet12));
  });

  it("the constant-balance card prints base, the two 200bp changes and the attribution-group split", () => {
    const html = withSeg();
    const constant = html.slice(html.indexOf("Constant balance sheet convention"));
    // Fixture nii: base 60M, +200bp 66M, -200bp 52M.
    expect(constant).toContain("$60.0M");
    expect(constant).toContain("+$6.0M");
    expect(constant).toContain("-$8.0M");
    const groups = [...BLOCK_GROUPS];
    expect(groups.length).toBe(4);
    for (const g of groups) expect(constant).toContain(g.replace(/_/g, " "));
    expect(constant).toContain("seg.byAttributionGroup");
  });

  it("a run without the seg block keeps the NII tab as it was: no second convention", () => {
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props()} />);
    expect(html).not.toContain("Constant balance sheet convention");
    expect(html).not.toContain("Runoff convention (engine)");
  });

  it("the runoff card says NIM is not in this run when the engine wrote none", () => {
    const r = blocksResult();
    delete r.nii.nimPct;
    const html = renderToStaticMarkup(<NiiTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("NIM not in this run");
  });
});

describe("EveTab, basis, convention and pair duration (Task 12)", () => {
  it("names the discount basis and the NMD convention of the run", () => {
    const r = blocksResult();
    r.eve.discountBasis = "spread-consistent";
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Discount basis: spread-consistent");
    expect(html).toContain("NMD convention: regulatory");
  });

  it("reads a run with no nmdConvention as behavioral", () => {
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props()} />);
    expect(html).toContain("NMD convention: behavioral");
  });

  it("prints the 200bp pair duration from the stored plus and minus 200bp PVs", () => {
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props()} />);
    const by = (id: string) => RESULT.eve.byScenario.find((s) => s.scenarioId === id)!;
    // D = (PV(-200) - PV(+200)) / (2 x PV(0) x 0.02), restated here.
    const dA = (by("S-200").pvAssets - by("S200").pvAssets) / (2 * by("S0").pvAssets * 0.02);
    const dL = (by("S-200").pvLiabilities - by("S200").pvLiabilities) / (2 * by("S0").pvLiabilities * 0.02);
    const gap = dA - (by("S0").pvLiabilities / by("S0").pvAssets) * dL;
    expect(html).toContain("200bp pair duration");
    expect(html).toContain(`assets ${dA.toFixed(2)} years`);
    expect(html).toContain(`liabilities ${dL.toFixed(2)} years`);
    expect(html).toContain(`duration gap ${gap.toFixed(2)} years`);
  });

  it("uses the SRP31 parallel pair when the run has no plus and minus 200bp parallel scenarios", () => {
    const r = freshResult();
    const pairs: Array<[string, string]> = [["S200", "SRP-PUP"], ["S-200", "SRP-PDN"]];
    for (const [from, to] of pairs) r.eve.byScenario.find((s) => s.scenarioId === from)!.scenarioId = to;
    const by = (id: string) => r.eve.byScenario.find((s) => s.scenarioId === id)!;
    const dA = (by("SRP-PDN").pvAssets - by("SRP-PUP").pvAssets) / (2 * by("S0").pvAssets * 0.02);
    const dL = (by("SRP-PDN").pvLiabilities - by("SRP-PUP").pvLiabilities) / (2 * by("S0").pvLiabilities * 0.02);
    const gap = dA - (by("S0").pvLiabilities / by("S0").pvAssets) * dL;
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).not.toContain("200bp pair duration: not in this run");
    expect(html).toContain("from the stored SRP-PDN and SRP-PUP PVs");
    expect(html).toContain(`assets ${dA.toFixed(2)} years`);
    expect(html).toContain(`liabilities ${dL.toFixed(2)} years`);
    expect(html).toContain(`duration gap ${gap.toFixed(2)} years`);
  });

  it("prefers the SRP31 parallel pair over the stored plus and minus 200bp scenarios when both are present", () => {
    const r = freshResult();
    const src = (id: string) => r.eve.byScenario.find((s) => s.scenarioId === id)!;
    // Copies of the two 200bp legs under the SRP ids, with PVs moved so the two pairs give different durations.
    r.eve.byScenario.push({ ...src("S200"), scenarioId: "SRP-PUP", pvAssets: src("S200").pvAssets * 0.97, pvLiabilities: src("S200").pvLiabilities * 0.98 });
    r.eve.byScenario.push({ ...src("S-200"), scenarioId: "SRP-PDN", pvAssets: src("S-200").pvAssets * 1.03, pvLiabilities: src("S-200").pvLiabilities * 1.01 });
    const by = (id: string) => r.eve.byScenario.find((s) => s.scenarioId === id)!;
    const dA = (by("SRP-PDN").pvAssets - by("SRP-PUP").pvAssets) / (2 * by("S0").pvAssets * 0.02);
    const dAstored = (by("S-200").pvAssets - by("S200").pvAssets) / (2 * by("S0").pvAssets * 0.02);
    expect(dA.toFixed(2)).not.toBe(dAstored.toFixed(2));
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("from the stored SRP-PDN and SRP-PUP PVs");
    expect(html).toContain(`assets ${dA.toFixed(2)} years`);
  });

  it("says the pair is not in this run when a leg is missing", () => {
    const r = freshResult();
    r.eve.byScenario = r.eve.byScenario.filter((s) => s.scenarioId !== "S200");
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("200bp pair duration: not in this run");
    // Post-merge fix: the sentence names both pairs the tab reads, the SRP31 parallel pair first.
    expect(html).toContain("the SRP31 parallel pair (SRP-PUP and SRP-PDN) or the plus and minus 200bp parallel scenarios");
  });

  it("names the deposit history when the run carries nmdWarmup, and says nothing of it when absent", () => {
    const r = freshResult();
    r.nmdWarmup = { kind: "flat-at-r0", months: 36, levelPct: 3.7111877541, shiftPctByScenario: { S0: 0, S200: 2, "S-200": -2 } };
    const html = renderToStaticMarkup(<EveTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Deposit history: flat 36 months at r0, re-levelled in each scenario by its short-end shock.");
    const absent = renderToStaticMarkup(<EveTab ws="ws-a" {...props(freshResult())} />);
    expect(freshResult().nmdWarmup).toBeUndefined();
    expect(absent).not.toContain("Deposit history");
  });

  it("the SRP31 rows carry their labels, not a knot count", () => {
    const knots = Array.from({ length: 11 }, (_, i) => ({ tenorYears: i + 1, shockBp: 100 }));
    const detail = {
      ...BLOCKS_DETAIL,
      scenarios: [
        { id: "SRP-STEEP", label: "SRP31 steepener", rateSpec: { kind: "custom", shocks: knots } },
        { id: "S0", label: "S0", rateSpec: { kind: "base" } },
      ],
    } as unknown as typeof BLOCKS_DETAIL;
    const label = scenarioLabeller(detail);
    expect(label("SRP-STEEP")).toBe("SRP31 steepener");
    expect(label("S0")).toBe("Base");
    // A custom scenario that is not one of the six keeps the knot-count label.
    const other = { ...detail, scenarios: [{ id: "MINE", label: "Mine", rateSpec: { kind: "custom", shocks: knots } }] } as unknown as typeof BLOCKS_DETAIL;
    expect(scenarioLabeller(other)("MINE")).toBe("Custom (11 knots)");
  });
});
