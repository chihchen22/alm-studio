/**
 * LinePlot's markup (ALM Studio Polish 10 T1). The server render draws at the 640 px fallback width, so the geometry is fixed: a 300 px plot has 50 px on the
 * left for the y numbers, 16 on the right, 10 on top and 28 under it (574 by 262 px). Hover, the legend toggle and the
 * zoom run in the browser (the drive checks them); here the ticks, grid lines, paths, markers, legend chips, zoom
 * hint, area, zero line and table are read from the markup. Expected texts and coordinates are restated.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinePlot, type LinePlotProps, type PlotSeries } from "../charts/LinePlot";
import { moneyTick } from "../format/figures";

const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

const A: PlotSeries = { id: "a", label: "A", tone: "accent", points: [[1, 1], [2, 3], [3, 2]] };
const B: PlotSeries = { id: "b", label: "B", tone: "second", dash: true, points: [[1, 2], [2, 2.5], [3, null]] };
const TICKS = [{ value: 1, label: "one" }, { value: 2, label: "two" }, { value: 3, label: "three" }];

function plot(extra: Partial<LinePlotProps> = {}) {
  return renderToStaticMarkup(
    <LinePlot series={[A, B]} xScale="linear" xTicks={TICKS} xLabel={(x) => `x${x}`} yTick={(v) => v.toFixed(1)} format={(v) => `${v.toFixed(2)}%`} unit="Rate, percent" {...extra} />,
  );
}
const count = (html: string, s: string) => html.split(s).length - 1;

describe("LinePlot", () => {
  it("draws at the fallback width with a focusable SVG named by its series and unit", () => {
    const html = plot();
    expect(html).toContain('<svg tabindex="0" width="100%" height="300" viewBox="0 0 640 300" role="img" aria-label="A, B, Rate, percent">');
  });

  it("prints a y number and a grid line at every nice tick, and an x label and a faint grid line at every x tick", () => {
    const html = plot();
    // Values 1 to 3, padded 5% to 0.9 and 3.1; six ticks wanted on 262 px, so a 0.5 step from 0.5 to 3.5.
    expect(count(html, 'class="lp-grid"')).toBe(7);
    expect(html).toContain('<text class="lp-ax" x="42" y="13.5" text-anchor="end">3.5</text>');
    expect(html).toContain('<text class="lp-ax" x="42" y="275.5" text-anchor="end">0.5</text>');
    expect(count(html, 'class="lp-grid lp-grid-x"')).toBe(3);
    expect(html).toContain('<text class="lp-ax" x="337" y="292" text-anchor="middle">two</text>');
    // No value is negative, so there is no zero line.
    expect(html).not.toContain("lp-zero");
  });

  it("draws each series as a 2 px path in its token stroke, a null breaking it, the dashed one dashed", () => {
    const html = plot();
    // x 1, 2, 3 at 50, 337, 624 px; y 1, 3, 2 and 2.5 at 228.33, 53.67, 141 and 97.33 px.
    expect(html).toContain('<path class="lp-line" d="M50.00,228.33L337.00,53.67L624.00,141.00" stroke="var(--series-1)"></path>');
    expect(html).toContain('<path class="lp-line" d="M50.00,141.00L337.00,97.33" stroke="var(--series-2)" stroke-dasharray="6 4"></path>');
  });

  it("puts a hollow marker on every stored point of a series of 40 points or fewer, and none when told not to", () => {
    expect(count(plot(), 'class="lp-mark"')).toBe(5);
    expect(plot()).toContain('<circle class="lp-mark" cx="50" cy="228.33333333333334" r="2.6" stroke="var(--series-1)"></circle>');
    expect(count(plot({ markers: false }), 'class="lp-mark"')).toBe(0);
    const long: PlotSeries = { id: "l", label: "L", tone: "accent", points: Array.from({ length: 41 }, (_, k): [number, number] => [k, k]) };
    expect(count(plot({ series: [long] }), 'class="lp-mark"')).toBe(0);
  });

  it("gives two or more series a legend of pressed chips, each keyed in its stroke; one series has none", () => {
    const html = plot();
    expect(html).toContain('<div class="lp-legend" role="group" aria-label="Series">');
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:var(--series-1)"></i>A</button>');
    expect(html).toContain('<button type="button" class="lp-chip" aria-pressed="true"><i class="key-line" style="background:repeating-linear-gradient(90deg, var(--series-2) 0 4px, transparent 4px 7px)"></i>B</button>');
    expect(plot({ series: [A] })).not.toContain("lp-legend");
    expect(plot({ legend: false })).not.toContain("lp-legend");
  });

  it("draws no crosshair and no tooltip until the pointer or a key puts one there", () => {
    const html = plot();
    expect(html).not.toContain("lp-tip");
    expect(html).not.toContain("lp-hover");
  });

  it("offers the drag zoom in the unit line when zoom is on", () => {
    expect(plot({ zoom: true })).toContain('<div class="lp-unit"><span>Rate, percent</span><span>Drag to zoom</span></div>');
    expect(plot()).toContain('<div class="lp-unit"><span>Rate, percent</span></div>');
  });

  it("fills a soft gradient under a single solid series, its stops set through style", () => {
    const html = plot({ series: [A], area: true });
    expect(html).toContain('<stop offset="0" style="stop-color:var(--series-1);stop-opacity:0.16"></stop><stop offset="1" style="stop-color:var(--series-1);stop-opacity:0"></stop>');
    expect(html).toMatch(/<path class="lp-area" d="M50\.00,228\.33L337\.00,53\.67L624\.00,141\.00L624\.00,272L50\.00,272Z" fill="url\(#[^)]+-area\)"><\/path>/);
    expect(plot({ area: true })).not.toContain("lp-area");
  });

  it("breaks the area where the line breaks: one soft fill per run between nulls (Polish 11, T1 review Minor 3)", () => {
    // Values 1, 3, (none), 2, 2.5 on x 1 to 5: range 0.5 to 3.5 on 262 px, x 1 to 5 at 50, 193.5, 337, 480.5, 624 px.
    const gappy: PlotSeries = { id: "g", label: "G", tone: "accent", points: [[1, 1], [2, 3], [3, null], [4, 2], [5, 2.5]] };
    const html = plot({ series: [gappy], area: true, xTicks: [] });
    const areas = [...html.matchAll(/<path class="lp-area" d="([^"]+)" fill="url\(#[^)]+-area\)"><\/path>/g)].map((m) => m[1]);
    expect(areas).toEqual(["M50.00,228.33L193.50,53.67L193.50,272L50.00,272Z", "M480.50,141.00L624.00,97.33L624.00,272L480.50,272Z"]);
    // A run of one stored point has no area, as it has no line.
    const lone: PlotSeries = { id: "l", label: "L", tone: "accent", points: [[1, 1], [2, null], [3, 2], [4, 3]] };
    expect(count(plot({ series: [lone], area: true, xTicks: [] }), 'class="lp-area"')).toBe(1);
  });

  it("clips the lines 6 px beyond the plot's 50 to 624 px across and 10 to 272 px down (Polish 11 fix round 1; x, Polish 12)", () => {
    // A 2.6 px marker with its 1.5 px stroke (3.35 px outer radius) on an edge draws whole. y: 10 - 6 = 4, height
    // 262 + 12 = 274 (the TLP's stored 0 at 0 years on the Spreads card's zero floor). x: 50 - 6 = 44, width 574 + 12 = 586
    // (the TLP's 0-year node at x 50, a Market curve's longest tenor at x 624). Unzoomed, as a server render always is.
    expect(plot()).toMatch(/<clipPath id="[^"]+-clip"><rect x="44" y="4" width="586" height="274"><\/rect><\/clipPath>/);
  });

  it("keeps the clip tight in x when a context line runs past the window, as past a slice's null end cell (Polish 14)", () => {
    // The series store x 1 to 3, so the window is 1..3; the context line is stored at x 4 too. x: 50, width 574; y as before.
    const html = plot({ context: [{ id: "c", points: [[1, 2], [4, 2]] }] });
    expect(html).toMatch(/<clipPath id="[^"]+-clip"><rect x="50" y="4" width="574" height="274"><\/rect><\/clipPath>/);
  });

  it("draws a zero line when zero lies inside the range, and context lines thin and muted", () => {
    const neg: PlotSeries = { id: "n", label: "N", tone: "third", points: [[1, -1], [2, 1]] };
    expect(plot({ series: [neg] })).toContain('class="lp-zero"');
    const html = plot({ series: [A], context: [{ id: "c1", points: [[1, 2], [3, 2]] }, { id: "c2", points: [[1, 1], [3, 1]] }] });
    expect(count(html, 'class="lp-ctx"')).toBe(2);
  });

  it("with yZero, runs the y axis from 0 however far above it the values sit (Polish 13)", () => {
    const far: PlotSeries = { id: "f", label: "F", tone: "accent", points: [[1, 900], [2, 1000]] };
    // 0 to 1000 padded to 1050: ticks 0 to 1200, 200 apart. 0 sits on the plot's foot (272 px), 1200 on its top (10 px);
    // 900 at 10 + 300 / 1200 * 262 = 75.5 px and 1000 at 10 + 200 / 1200 * 262 = 53.67 px.
    // Whole-number labels (four characters at most), so the left margin stays 50 px and only the range is under test.
    const whole = (v: number) => v.toFixed(0);
    const html = plot({ series: [far], yZero: true, yTick: whole });
    expect(html).toContain('<text class="lp-ax" x="42" y="275.5" text-anchor="end">0</text>');
    expect(html).toContain('<text class="lp-ax" x="42" y="13.5" text-anchor="end">1200</text>');
    expect(html).toContain('<path class="lp-line" d="M50.00,75.50L624.00,53.67" stroke="var(--series-1)"></path>');
    // Without it the range fits the values: 880 at the foot.
    expect(plot({ series: [far], yTick: whole })).toContain('<text class="lp-ax" x="42" y="275.5" text-anchor="end">880</text>');
  });

  it("widens its left margin to the widest y label, so a long money label starts inside the SVG (Polish 13 fix round 1)", () => {
    const big: PlotSeries = { id: "g", label: "G", tone: "accent", points: [[1, 3_000e6], [2, 3_300e6]] };
    const html = plot({ series: [big], yZero: true, yTick: moneyTick });
    // 0 to 3,300M padded 165M above: raw step 3,465M / 6 = 577.5M rounds to 500M, so $0M to $3,500M. "$3,500M" is
    // seven characters: margin ceil(7 * 6.6) + 8 + 4 = 59 px, labels anchored at 51 px, so the widest starts near
    // 51 - 46.2 = 4.8 px, not below 0. The plot runs 59 to 624 px (565 px wide).
    expect(html).toContain('<text class="lp-ax" x="51" y="13.5" text-anchor="end">$3,500M</text>');
    expect(html).toContain('<text class="lp-ax" x="51" y="275.5" text-anchor="end">$0M</text>');
    expect(html).toContain('<line class="lp-grid" x1="59" x2="624"');
    // x 1 and 2 at 59 and 624 px; y = 10 + (3500 - v) / 3500 * 262: 3,000M at 47.43 px, 3,300M at 24.97 px.
    expect(html).toContain('<path class="lp-line" d="M59.00,47.43L624.00,24.97" stroke="var(--series-1)"></path>');
    // The clip follows the margin: 6 px beyond 59 to 624 across.
    expect(html).toMatch(/<clipPath id="[^"]+-clip"><rect x="53" y="4" width="577" height="274"><\/rect><\/clipPath>/);
  });

  it("holds the full-range y labels in a memo keyed on what they read, so a hover render does not redo them (Polish 15 item 2)", () => {
    // A static render draws once, so the memo is read from the source: the full range's domain and labels sit inside one
    // useMemo whose key is the series, the context, the unzoomed range, the plot height, yZero and the tick formatter.
    // Hover, hide and zoom state are not in the key. The margin itself is pinned by the markup tests above and below.
    const src = readFileSync(new URL("../charts/LinePlot.tsx", import.meta.url), "utf8");
    expect(src).toContain([
      "  const fullLabels = useMemo(() => {",
      "    const full = yDomain(valuesIn([...series, ...context], u0, u1), ph, props.yZero === true);",
      "    return full.ticks.map((v) => props.yTick(v, full.step));",
      "  }, [series, props.context, u0, u1, ph, props.yZero, props.yTick]);",
      "  const ml = steadyLeftMargin(yLabels, fullLabels, GLYPH_PX, 8, M.l);",
    ].join("\n"));
    expect(src.match(/yDomain\(/g)?.length).toBe(2);
  });

  it("is the one line chart: Lines.tsx is retired and no Studio source imports it (Polish 13, ruling 2026-09-30)", () => {
    expect(existsSync(new URL("../charts/Lines.tsx", import.meta.url))).toBe(false);
    for (const page of ["pages/balance/BalanceView.tsx", "pages/results/NiiTab.tsx", "pages/results/RatesTab.tsx", "pages/scenarios/ShockPreviewCard.tsx"]) {
      expect(readFileSync(new URL(`../${page}`, import.meta.url), "utf8"), page).not.toContain("charts/Lines");
    }
  });

  it("drops an x label whose box would meet the one before (6.6 px a character, 10 px apart)", () => {
    const html = plot({ series: [A], xScale: "sqrt", xDomain: [0, 30], xTicks: [{ value: 0.083333, label: "1M" }, { value: 0.25, label: "3M" }, { value: 0.5, label: "6M" }] });
    expect(html).toContain(">1M</text>");
    expect(html).not.toContain(">3M</text>");
    expect(html).toContain(">6M</text>");
  });

  it("keeps the Show table: every stored value, Unobservable for a missing one", () => {
    const html = plot();
    expect(html).toContain('<summary>Show table</summary>');
    expect(html).toContain('<thead><tr><th scope="col">Point</th><th scope="col" class="num">A</th><th scope="col" class="num">B</th></tr></thead>');
    expect(html).toContain('<tr><th scope="row">x3</th><td class="num lvl">2.00%</td><td class="num lvl">Unobservable</td></tr>');
    expect(plot({ table: false })).not.toContain("Show table");
  });

  it("adds each other series' gap to the delta series in the table, in whole signed bp", () => {
    const base: PlotSeries = { id: "base", label: "Base curve", tone: "muted", dash: true, points: [[1, 3.7], [2, 3.8], [3, null]] };
    const up: PlotSeries = { id: "up", label: "Up", tone: "accent", points: [[1, 4.7], [2, 3.3], [3, 4]] };
    const html = plot({ series: [up, base], delta: "base" });
    expect(html).toContain('<thead><tr><th scope="col">Point</th><th scope="col" class="num">Up</th><th scope="col" class="num">Base curve</th><th scope="col" class="num">Up vs base, bp</th></tr></thead>');
    expect(html).toContain('<tr><th scope="row">x1</th><td class="num lvl">4.70%</td><td class="num lvl">3.70%</td><td class="num lvl">+100</td></tr>');
    expect(html).toContain('<tr><th scope="row">x2</th><td class="num lvl">3.30%</td><td class="num lvl">3.80%</td><td class="num lvl">-50</td></tr>');
    expect(html).toContain('<tr><th scope="row">x3</th><td class="num lvl">4.00%</td><td class="num lvl">Unobservable</td><td class="num lvl">Unobservable</td></tr>');
  });

  it("styles the chart with tokens only: muted 11 px axis numbers, hairline grid, 2 px round lines, a surface tooltip", () => {
    for (const rule of [
      ".lp-ax { fill: var(--muted); font-size: 11px; font-family: var(--font-num); }",
      ".lp-grid { stroke: var(--line); stroke-width: 1; shape-rendering: crispEdges; }",
      ".lp-line { fill: none; stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; transition: opacity var(--t-fast); }",
      ".lp-mark { fill: var(--surface); stroke-width: 1.5; }",
      ".lp-band { fill: var(--accent-wash); stroke: var(--accent); stroke-width: 1; }",
      ".lp-chip[aria-pressed=\"false\"] { opacity: .45; }",
    ]) expect(APP_CSS).toContain(rule);
    expect(APP_CSS).toMatch(/\.lp-tip \{[^}]*background: var\(--surface\);[^}]*box-shadow: var\(--shadow-2\);/);
  });

  it("lets a capped tooltip's series names wrap while its numbers stay on one line (Polish 11, F11)", () => {
    expect(APP_CSS).toContain(".lp-tip td:first-child { white-space: normal; }");
    expect(APP_CSS).toContain(".lp-tip td, .lp-tip th { padding: 1.5px 0; color: var(--ink-2); font-weight: 400; white-space: nowrap; }");
  });

  it("dims a stale shock preview's LinePlot, not the retired Lines wrapper (Polish 13 fix round 2)", () => {
    // The preview card wraps its chart in .preview-stale while a new form is checked; LinePlot's SVG sits in .lp-plot.
    expect(APP_CSS).toContain(".preview-stale .lp-plot svg { opacity: 0.6; }");
    expect(APP_CSS).not.toContain(".preview-stale .plot svg");
    expect(plot()).toContain('<div class="lp-plot"><svg');
  });

  it("keeps a drag-zoom or a double-click from selecting the chart's own text (Polish 10 Task 5, F8)", () => {
    expect(APP_CSS).toContain(".lp-plot svg text { -webkit-user-select: none; user-select: none; }");
  });

  it("drops the dead Lines end-label rules and their note, and nothing around them (Polish 14, Polish 13 Minor 5)", () => {
    expect(APP_CSS).not.toContain("plot-ends");
    expect(APP_CSS).not.toContain("Lines (charts/Lines.tsx)");
    // The treemap block now runs straight into the LinePlot note, one blank line between.
    expect(APP_CSS).toContain(".treemap-omitted { font-size: var(--fs-1); color: var(--muted); }\n\n/* LinePlot (charts/LinePlot.tsx, Polish 10 T1)");
  });
});
