/**
 * Slice 4b T4: the Gap distributions card on the Stochastic screen. Read view only: the card prints the stored
 * `gap` block of the summary reply (the envelope's block, verbatim) and appears only when the reply carries it.
 * A reply without it renders the page it always did, byte for byte. Every expected value is restated by hand;
 * nothing is imported from the code under test as an expectation.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { summarizeStochastic, type StochasticDistribution, type StochasticGapBlock, type StochasticRunResult } from "@alm/engine";
import type { StochasticSummaryReply } from "@alm/reader";
import { StochasticRunBody } from "../pages/results/StochasticRunViews";
import { gapDistributionsCsv } from "../results/stochasticGap";

const BANNED_CHARS = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0xa7)}]`);

const golden = JSON.parse(
  readFileSync(new URL("../../../../packages/engine/src/run/__tests__/golden/stochastic-hw-vanilla-64.json", import.meta.url), "utf8"),
) as StochasticRunResult;
const reply: StochasticSummaryReply = summarizeStochastic({ envelope: golden, portfolioId: "vanilla-book-v1", marketId: "market-public" });

const detail = { runId: golden.runId, state: "done", submittedAt: "2026-10-25T10:00:00Z", platformRequestHash: "prh", mode: "stochastic", scenarios: [] };
const body = (summary: StochasticSummaryReply, query?: Record<string, string>) =>
  renderToStaticMarkup(<StochasticRunBody runId={golden.runId} data={{ detail: detail as never, summary, note: null }} query={query} />);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A distribution whose figures are m plus a fixed offset each, so every cell is told apart by hand. */
const d = (m: number): StochasticDistribution => ({
  nPaths: 64,
  mean: m,
  standardError: 1000.25,
  stdev: 8000.5,
  min: m - 50_000,
  max: m + 50_000,
  quantiles: [
    { p: 0.05, value: m - 20_000 },
    { p: 0.25, value: m - 10_000 },
    { p: 0.5, value: m },
    { p: 0.75, value: m + 10_000 },
    { p: 0.95, value: m + 20_000 },
  ],
});
const sides = (a: number, l: number) => ({ assets: d(a), liabilities: d(l), net: d(a - l) });

const BANDS: Array<[string, number, number]> = [
  ["0-1M", 0, 1],
  ["1-3M", 1, 3],
  ["3-6M", 3, 6],
  ["6-12M", 6, 12],
  ["1-2Y", 12, 24],
  ["2-3Y", 24, 36],
  ["3-5Y", 36, 60],
  ["5-10Y", 60, 120],
];

const GAP: StochasticGapBlock = {
  horizonMonths: 120,
  convention: "constant-balance-sheet",
  shockBp: 10,
  repricing: {
    bands: BANDS.map(([label, startMonth, endMonth], i) => ({ label, startMonth, endMonth, net: d((i + 1) * 1_000_000), cumulative: d((i + 1) * 2_000_000) })),
    beyondHorizon: { net: d(-3_250_000) },
  },
  liquidity: {
    bands: BANDS.map(([label, startMonth, endMonth], i) => ({
      label,
      startMonth,
      endMonth,
      runOff: sides((i + 1) * 3_000_000, (i + 1) * 1_000_000),
      cumulative: sides((i + 1) * 4_000_000, (i + 1) * 2_000_000),
    })),
    beyondHorizon: sides(850_000_000, 650_000_000),
    month1Balance: sides(1_000_000_000, 900_000_000),
  },
  uncovered: [
    { positionId: "cd-1", reason: "certificate of deposit: the SEG block does not cover this type" },
    { positionId: "cd-2", reason: "certificate of deposit: the SEG block does not cover this type" },
  ],
  uncoveredCount: 2,
};
const withGap: StochasticSummaryReply = { ...reply, gap: GAP };

const CARD_SENTENCE = "Each row is a statistic of this run's Monte Carlo path set, never a gap.";
const cardOf = (html: string): string => {
  const at = html.indexOf('aria-label="Gap distributions"');
  expect(at).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</section>", at));
};
const esc = (s: string) => s.replace(/'/g, "&#x27;");
const pill = (label: string, on: boolean) => `<button type="button" class="pill" aria-pressed="${on}">${label}</button>`;
const HEAD = '<th scope="col" class="num">Mean</th><th scope="col" class="num">SE</th><th scope="col" class="num">p5</th><th scope="col" class="num">p25</th><th scope="col" class="num">p50</th><th scope="col" class="num">p75</th><th scope="col" class="num">p95</th><th scope="col" class="num">N</th>';

describe("Gap distributions: absent unless the stored envelope carries gap", () => {
  it("a reply without gap renders the page it rendered before the slice, byte for byte, whatever the query", () => {
    // sha256 of the page for the committed 0.2.0 golden, measured before the gap distributions were added.
    const PIN = "49567c312fb14466907127e4bf5f38b9716d1c07cdb3ac51a4ff2a2f38e0699f";
    expect(sha(body(reply))).toBe(PIN);
    expect(sha(body(reply, {}))).toBe(PIN);
    expect(sha(body(reply, { stogap: "liquidity" }))).toBe(PIN);
    expect(body(reply)).not.toContain("Gap distributions");
  });

  it("a reply with gap adds the card and leaves every other card as it was", () => {
    const html = body(withGap);
    const at = html.indexOf('<section class="card" aria-label="Gap distributions">');
    expect(at).toBeGreaterThan(-1);
    const end = html.indexOf("</section>", at) + "</section>".length;
    expect(html.slice(0, at) + html.slice(end)).toBe(body(reply));
  });
});

describe("Gap distributions: the repricing view (the default)", () => {
  const card = cardOf(body(withGap));

  it("prints the card sentence, the switcher with Repricing pressed, and the calibration chip", () => {
    expect(card).toContain(esc(CARD_SENTENCE));
    expect(card).toContain('<nav class="chip-row" aria-label="Gap distributions view">');
    expect(card).toContain(pill("Repricing (SEG)", true));
    expect(card).toContain(pill("Liquidity (EBP)", false));
    expect(card).toContain('<span class="status status-pass">Within the gate</span>');
  });

  it("an unknown stogap value reads as repricing", () => {
    expect(cardOf(body(withGap, { stogap: "nonsense" }))).toBe(card);
    expect(cardOf(body(withGap, { stogap: "repricing" }))).toBe(card);
  });

  it("the band table: the eight bands then the beyond-horizon line, columns mean, SE, p5 to p95, N", () => {
    expect(card).toContain(`<thead><tr><th scope="col">Band</th>${HEAD}</tr></thead>`);
    const labels = [...card.matchAll(/<th scope="row">([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(labels).toEqual([
      "0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y", "Beyond 10 years (not banded)",
      "0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y",
    ]);
    // 3-6M net: mean 3,000,000, SE 1,000.25, quantiles 2.98M to 3.02M, N 64; each cell titled at full precision.
    expect(card).toContain(
      '<tr><th scope="row">3-6M</th><td class="num" title="3000000">+$3.0M</td><td class="num" title="1000.25">$0.0M</td>' +
        '<td class="num" title="2980000">+$3.0M</td><td class="num" title="2990000">+$3.0M</td><td class="num" title="3000000">+$3.0M</td>' +
        '<td class="num" title="3010000">+$3.0M</td><td class="num" title="3020000">+$3.0M</td><td class="num">64</td></tr>',
    );
    expect(card).toContain('<tr><th scope="row">Beyond 10 years (not banded)</th><td class="num" title="-3250000">-$3.3M</td>');
    // Cumulative 5-10Y: 16,000,000.
    expect(card).toContain("Cumulative repricing gap");
    expect(card).toContain('<tr><th scope="row">5-10Y</th><td class="num" title="16000000">+$16.0M</td>');
  });

  it("the notes: Hull-White only, 120 months, antithetic SE, SEG and EBP conventions, the month-120 edge", () => {
    for (const note of [
      "Hull-White only: BGM gap needs a general tenor rule.",
      "120 months: the SEG block runs to month 120, so the bands are 0-1M to 5-10Y; what is still outstanding at month 120 is the beyond-horizon line, outstanding beyond 10 years, not banded.",
      "The standard error is the standard error of the mean over antithetic-pair averages (nPaths / 2 independent samples).",
      "Repricing (SEG) follows the delta of accrued income under a 10 bp half-shock (convention constant-balance-sheet): each band is the signed net SEG that reprices in it, a fixed asset reading positive.",
      "Liquidity (EBP) is the average outstanding balance and carries no interest: each band is the balance that runs off in it (EBP at the band start minus EBP at the band end), by side, net being assets minus liabilities. On every path the run-off bands plus the beyond-horizon line add back to the month-1 balance.",
      "The month-120 edge: the block carries no balance after month 120, so EBP run-off during month 120 itself lands in the beyond-horizon line, not in 5-10Y. A 120-month bullet reads in the SEG 5-10Y band but in the EBP beyond-horizon line.",
      "Cumulative figures are each path's running sum of its own bands, then summarised; never a sum of band quantiles.",
    ]) {
      expect(card).toContain(`<li>${esc(note)}</li>`);
    }
  });

  it("the uncovered positions, with the count", () => {
    expect(card).toContain("Positions the SEG block does not cover: 2. They enter no figure above.");
    expect(card).toContain('<li><span class="mono">cd-1</span>: certificate of deposit: the SEG block does not cover this type</li>');
    const none = cardOf(body({ ...reply, gap: { ...GAP, uncovered: [], uncoveredCount: 0 } }));
    expect(none).toContain("Positions the SEG block does not cover: 0.");
    expect(none).not.toContain('aria-label="Uncovered positions"');
  });

  it("the CSV button and the source line; no launch control", () => {
    expect(card).toContain('<button type="button" class="pill">Download CSV</button>');
    expect(card).toContain(`Source: GET /api/runs/${golden.runId}/stochastic/summary, gap (the stored block, verbatim; nothing derived here)`);
    expect(card.toLowerCase()).not.toMatch(/launch|submit|run gap/);
  });

  it("carries no em-dash and no section sign", () => {
    expect(BANNED_CHARS.test(card)).toBe(false);
  });

  it("a figure that rounds to zero prints $0.0M with no sign; one that does not keeps its sign", () => {
    // Roundoff of a point mass (the beyond-horizon line of a book that all runs off by month 120).
    const roundoff: StochasticDistribution = {
      nPaths: 64,
      mean: -4e-9,
      standardError: 1e-12,
      stdev: 2e-12,
      min: -49_000,
      max: 3e-9,
      quantiles: [
        { p: 0.05, value: -4e-9 },
        { p: 0.25, value: -0 },
        { p: 0.5, value: 0 },
        { p: 0.75, value: 2e-9 },
        { p: 0.95, value: -51_000 },
      ],
    };
    const z = cardOf(body({ ...reply, gap: { ...GAP, repricing: { ...GAP.repricing, beyondHorizon: { net: roundoff } } } }));
    expect(z).toContain(
      '<tr><th scope="row">Beyond 10 years (not banded)</th><td class="num" title="-4e-9">$0.0M</td><td class="num" title="1e-12">$0.0M</td>' +
        '<td class="num" title="-4e-9">$0.0M</td><td class="num" title="0">$0.0M</td><td class="num" title="0">$0.0M</td>' +
        '<td class="num" title="2e-9">$0.0M</td><td class="num" title="-51000">-$0.1M</td><td class="num">64</td></tr>',
    );
    expect(z).not.toContain("-$0.0M");
    expect(z).not.toContain("+$0.0M");
  });
});

describe("Gap distributions: the liquidity view (stogap=liquidity)", () => {
  const card = cardOf(body(withGap, { stogap: "liquidity" }));

  it("presses Liquidity and prints each band by side, then beyond-horizon and the month-1 balance", () => {
    expect(card).toContain(pill("Repricing (SEG)", false));
    expect(card).toContain(pill("Liquidity (EBP)", true));
    expect(card).toContain(`<thead><tr><th scope="col">Band</th><th scope="col">Side</th>${HEAD}</tr></thead>`);
    const rows = [...card.matchAll(/<tr><th scope="row">([^<]*)<\/th><td>([^<]*)<\/td>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(rows.slice(0, 3)).toEqual(["0-1M Assets", "0-1M Liabilities", "0-1M Net"]);
    expect(rows.slice(24, 30)).toEqual([
      "Beyond 10 years (not banded) Assets",
      "Beyond 10 years (not banded) Liabilities",
      "Beyond 10 years (not banded) Net",
      "Month-1 balance Assets",
      "Month-1 balance Liabilities",
      "Month-1 balance Net",
    ]);
    expect(rows.length).toBe(30 + 24);
    // 1-3M run-off: assets 6M, liabilities 2M, net 4M.
    expect(card).toContain('<tr><th scope="row">1-3M</th><td>Net</td><td class="num" title="4000000">+$4.0M</td>');
    expect(card).toContain('<tr><th scope="row">Month-1 balance</th><td>Assets</td><td class="num" title="1000000000">+$1,000.0M</td>');
    expect(card).toContain("Cumulative liquidity run-off");
  });

  it("keeps the same notes and the uncovered list", () => {
    expect(card).toContain(esc("Liquidity (EBP) is the average outstanding balance and carries no interest"));
    expect(card).toContain("Positions the SEG block does not cover: 2.");
  });
});

describe("Gap distributions: the browser-built CSV", () => {
  const csv = gapDistributionsCsv(GAP);
  const lines = csv.split("\n");

  it("one header, then repricing (bands, beyond, cumulative), then liquidity by side (bands, beyond, month-1, cumulative)", () => {
    expect(lines[0]).toBe("measure,table,band,startMonth,endMonth,side,nPaths,mean,standardError,stdev,min,max,p5,p25,p50,p75,p95");
    expect(lines[1]).toBe("repricing,band,0-1M,0,1,net,64,1000000,1000.25,8000.5,950000,1050000,980000,990000,1000000,1010000,1020000");
    expect(lines[9]).toBe("repricing,beyondHorizon,Beyond 10 years (not banded),120,,net,64,-3250000,1000.25,8000.5,-3300000,-3200000,-3270000,-3260000,-3250000,-3240000,-3230000");
    expect(lines[10]).toBe("repricing,cumulative,0-1M,0,1,net,64,2000000,1000.25,8000.5,1950000,2050000,1980000,1990000,2000000,2010000,2020000");
    expect(lines[18]).toBe("liquidity,runOff,0-1M,0,1,assets,64,3000000,1000.25,8000.5,2950000,3050000,2980000,2990000,3000000,3010000,3020000");
    expect(lines[20]).toBe("liquidity,runOff,0-1M,0,1,net,64,2000000,1000.25,8000.5,1950000,2050000,1980000,1990000,2000000,2010000,2020000");
    expect(lines[42]).toBe("liquidity,beyondHorizon,Beyond 10 years (not banded),120,,assets,64,850000000,1000.25,8000.5,849950000,850050000,849980000,849990000,850000000,850010000,850020000");
    expect(lines[45]).toBe("liquidity,month1Balance,Month-1 balance,0,1,assets,64,1000000000,1000.25,8000.5,999950000,1000050000,999980000,999990000,1000000000,1000010000,1000020000");
    expect(lines[lines.length - 2]).toBe("liquidity,cumulative,5-10Y,60,120,net,64,16000000,1000.25,8000.5,15950000,16050000,15980000,15990000,16000000,16010000,16020000");
    // 1 header + repricing 8 + 1 + 8 + liquidity 24 + 3 + 3 + 24, and a final newline.
    expect(lines.length).toBe(1 + 17 + 54 + 1);
    expect(lines[lines.length - 1]).toBe("");
  });

  it("a missing pinned quantile is an empty cell, never an invented value", () => {
    const thin: StochasticGapBlock = { ...GAP, repricing: { ...GAP.repricing, beyondHorizon: { net: { ...d(5), quantiles: [] } } } };
    expect(gapDistributionsCsv(thin).split("\n")[9]).toBe("repricing,beyondHorizon,Beyond 10 years (not banded),120,,net,64,5,1000.25,8000.5,-49995,50005,,,,,");
  });
});
