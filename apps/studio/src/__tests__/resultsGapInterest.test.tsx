// apps/studio/src/__tests__/resultsGapInterest.test.tsx
/**
 * Studio piece D slice 4a, Task 4 (spec rulings 2, 6 and 12, Amendment A1): Results > Gap shows the interest-inclusive
 * liquidity ladder (`GapLadder.withInterest`) as a labelled second view beside the principal liquidity ladder, with
 * the payment-date sentence and the swap sentence, and its own CSV. A run without `withInterest` shows nothing new.
 * Amendment A2: the card switches between three views, Principal (the outstanding gap, the ladder of the card above),
 * Interest (income, expense and net, `withInterest.interest`) and Total (`withInterest.rows`), on the `liqview` hash
 * key, Total by default; the card's CSV gains the interest columns. Expected sentences are restated by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { signedMM, usdMM } from "@alm/reader";
import type { GapLadder, RunResult } from "@alm/engine";
import {
  GapTab,
  INTEREST_TIMING_NOTE,
  SWAP_SETTLEMENT_NOTE,
  WITH_INTEREST_TITLE,
  withInterestCsv,
} from "../pages/results/GapTab";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";
import { MONTHLY_BUCKETS } from "./fixtures/gapBuckets";

type WithInterest = NonNullable<GapLadder["withInterest"]>;
type Row = GapLadder["rows"][number];

const props = (result: RunResult = RESULT, query: Record<string, string> = {}) => ({
  runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id,
});

const withCum = (rows: Array<Omit<Row, "gap" | "cumulativeGap">>): Row[] => {
  let cum = 0;
  return rows.map((r) => {
    const gap = r.assets - r.liabilities;
    cum += gap;
    return { ...r, band: { ...r.band }, gap, cumulativeGap: cum };
  });
};

const principalRows = (): Row[] => RESULT.gap.liquidity.find((l) => l.scenarioId === "S0")!.rows;

/** Synthetic interest, printed distinctly: 1.25M of income and 0.4M of expense in every band. */
function interestOnly(): Row[] {
  return withCum(principalRows().map((r) => ({ band: r.band, assets: 1_250_000, liabilities: 400_000 })));
}

/** The S0 liquidity ladder's nine bands plus the synthetic interest: the Total view. */
function interestRows(): Row[] {
  return withCum(principalRows().map((r) => ({ band: r.band, assets: r.assets + 1_250_000, liabilities: r.liabilities + 400_000 })));
}

/** Monthly interest rows, n months: 500k + 1k k of income, 200k of expense. */
function monthlyInterest(n: number): Row[] {
  return withCum(Array.from({ length: n }, (_, k) => ({ band: { label: `M${k + 1}`, startMonth: k, endMonth: k + 1 }, assets: 500_000 + 1_000 * k, liabilities: 200_000 })));
}

/** The demo envelope with withInterest on the S0 liquidity ladder; `monthly` also sets userBuckets on every view. */
function withInterest(monthly = false): RunResult {
  const r = freshResult();
  const liq = r.gap.liquidity.find((l) => l.scenarioId === "S0")!;
  if (monthly) liq.userBuckets = MONTHLY_BUCKETS();
  liq.withInterest = {
    rows: interestRows(),
    ...(monthly ? { userBuckets: MONTHLY_BUCKETS(30) } : {}),
    interest: { rows: interestOnly(), ...(monthly ? { userBuckets: { kind: "monthly" as const, rows: monthlyInterest(30) } } : {}) },
  };
  return r;
}

const CARD = `<figure class="card viz" aria-label="${WITH_INTEREST_TITLE}">`;
const cardOf = (html: string): string => html.slice(html.indexOf(CARD), html.indexOf("Next reset or maturity"));
const tr = (r: Row) =>
  `<tr><th scope="row">${r.band.label}</th><td class="num">${usdMM(r.assets)}</td><td class="num">${usdMM(r.liabilities)}</td><td class="num">${signedMM(r.gap)}</td><td class="num">${signedMM(r.cumulativeGap)}</td></tr>`;
const head = (cat: string, a: string, b: string, gap: string, cum: string) =>
  `<thead><tr><th scope="col">${cat}</th><th scope="col" class="num">${a}</th><th scope="col" class="num">${b}</th><th scope="col" class="num">${gap}</th><th scope="col" class="num">${cum}</th></tr></thead>`;
const pill = (label: string, on: boolean) => `<button type="button" class="pill" aria-pressed="${on}">${label}</button>`;

describe("GapTab: the interest-inclusive liquidity ladder", () => {
  it("states the payment-date and swap sentences as written", () => {
    expect(WITH_INTEREST_TITLE).toBe("Liquidity gap with interest");
    expect(INTEREST_TIMING_NOTE).toBe(
      "Interest counts on its payment date: credited deposit interest counts as paid monthly, and CD interest is paid with principal.",
    );
    expect(SWAP_SETTLEMENT_NOTE).toBe("Net swap settlement is included here, not in the principal ladder.");
  });

  it("a run without withInterest shows nothing new", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(html).not.toContain(WITH_INTEREST_TITLE);
    expect(html).not.toContain(INTEREST_TIMING_NOTE);
    expect(html).not.toContain(SWAP_SETTLEMENT_NOTE);
    expect(html).not.toContain("withInterest");
    expect(html).not.toContain("Download CSV");
  });

  it("a ladder with withInterest adds a second card after the principal liquidity card, before the next-reset card", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest())} />);
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(html.split(CARD).length - 1).toBe(1);
    expect(html).toContain(`<div class="card-title">${WITH_INTEREST_TITLE}, S0</div>`);
    expect(html.indexOf('aria-label="Liquidity gap"')).toBeLessThan(html.indexOf(CARD));
    expect(html.indexOf(CARD)).toBeLessThan(html.indexOf("Next reset or maturity"));
    // The principal card is the card it always was: the page up to the new card equals the plain page's prefix.
    expect(html.slice(0, html.indexOf(CARD))).toBe(plain.slice(0, html.indexOf(CARD)));
    // The lead sentence names the three views; the two ruling sentences follow in the same note.
    expect(html).toContain(
      `<p class="card-desc" role="note">Three views of the same run-off: Principal is the outstanding gap of the liquidity card above, Interest is the contractual interest cash flow on its own (income in assets, expense in liabilities, net as the gap), and Total is the two together, band by band. ${INTEREST_TIMING_NOTE} ${SWAP_SETTLEMENT_NOTE}</p>`,
    );
    // Nine bands only: no second block heading.
    expect(html).not.toContain("Nine standard bands");
  });

  it("the three-view switcher: Principal, Interest and Total, Total pressed by default", () => {
    const card = cardOf(renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest())} />));
    expect(card).toContain(`<nav class="chip-row" aria-label="Liquidity with interest view">${pill("Principal", false)}${pill("Interest", false)}${pill("Total", true)}</nav>`);
  });

  it("Total (the default, and any unknown liqview): withInterest.rows, assets and liabilities", () => {
    for (const query of [{}, { liqview: "total" }, { liqview: "nonsense" }] as Record<string, string>[]) {
      const card = cardOf(renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(), query)} />));
      expect(card).toContain(pill("Total", true));
      expect(card).toContain(head("Band", "Assets", "Liabilities", "Gap", "Cumulative (engine)"));
      for (const r of interestRows()) expect(card).toContain(tr(r));
      expect(card).toContain("Source: gap.liquidity[scenarioId=S0].withInterest.rows. Gap and cumulative gap are the stored fields.");
    }
  });

  it("Interest: withInterest.interest.rows as income, expense, net and cumulative net", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(), { liqview: "interest" })} />);
    // Same address, no withInterest: the scenario picker's links carry the address's keys on both pages.
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props(RESULT, { liqview: "interest" })} />);
    const card = cardOf(html);
    expect(card).toContain(pill("Interest", true));
    expect(card).toContain(head("Band", "Interest income", "Interest expense", "Net interest", "Cumulative net (engine)"));
    for (const r of interestOnly()) expect(card).toContain(tr(r));
    for (const r of interestRows()) expect(card).not.toContain(tr(r));
    expect(card).toContain("Source: gap.liquidity[scenarioId=S0].withInterest.interest.rows. Net and cumulative net are the stored fields.");
    // The principal card above is unchanged whichever view this card shows.
    expect(html.slice(0, html.indexOf(CARD))).toBe(plain.slice(0, html.indexOf(CARD)));
  });

  it("Principal: the ladder of the card above, the outstanding gap, read from gap.liquidity rows", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(), { liqview: "principal" })} />);
    // Same address, no withInterest: the scenario picker's links carry the address's keys on both pages.
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props(RESULT, { liqview: "principal" })} />);
    const card = cardOf(html);
    expect(card).toContain(pill("Principal", true));
    expect(card).toContain(head("Band", "Assets", "Liabilities", "Gap", "Cumulative (engine)"));
    for (const r of principalRows()) expect(card).toContain(tr(r));
    expect(card).toContain("Source: gap.liquidity[scenarioId=S0].rows, the outstanding gap. Gap and cumulative gap are the stored fields.");
    expect(html.slice(0, html.indexOf(CARD))).toBe(plain.slice(0, html.indexOf(CARD)));
  });

  it("monthly: each view carries its own monthly block and pager, named apart from the principal one", () => {
    const total = cardOf(renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(true))} />));
    expect(total).toContain('<h3 class="viz-title">Monthly buckets</h3>');
    expect(total).toContain('<h3 class="viz-title">Nine standard bands</h3>');
    expect(total).toContain('aria-label="Next, liquidity with interest months"');
    expect(total).toContain("Rows 1 to 24 of 30");
    expect(total).toContain(
      "Source: gap.liquidity[scenarioId=S0].withInterest.userBuckets.rows (kind monthly) for the monthly buckets and gap.liquidity[scenarioId=S0].withInterest.rows for the nine standard bands.",
    );
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(true), { liqview: "interest" })} />);
    expect(html).toContain('aria-label="Next, liquidity months"');
    const interest = cardOf(html);
    expect(interest).toContain("Rows 1 to 24 of 30");
    expect(interest).toContain(tr(monthlyInterest(30)[0]!));
    expect(interest).toContain(head("Month", "Interest income", "Interest expense", "Net interest", "Cumulative net (engine)"));
    expect(interest).toContain(
      "Source: gap.liquidity[scenarioId=S0].withInterest.interest.userBuckets.rows (kind monthly) for the monthly buckets and gap.liquidity[scenarioId=S0].withInterest.interest.rows for the nine standard bands.",
    );
    const principal = cardOf(renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest(true), { liqview: "principal" })} />));
    expect(principal).toContain("Rows 1 to 24 of 40");
    expect(principal).toContain(
      "Source: gap.liquidity[scenarioId=S0].userBuckets.rows (kind monthly) for the monthly buckets and gap.liquidity[scenarioId=S0].rows for the nine standard bands, the outstanding gap.",
    );
  });

  it("the second card offers its own CSV; the export bar's tables are unchanged", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withInterest())} />);
    const card = html.slice(html.indexOf(`aria-label="${WITH_INTEREST_TITLE}"`));
    expect(card).toContain(">Download CSV</button>");
    expect(html.split("Download CSV").length - 1).toBe(1);
    expect(card).toContain("The CSV carries the nine standard bands, the total and the interest on its own, every figure as stored.");
  });

  it("the CSV: one row per band, standard rows first, then the run's own buckets, total then interest columns, every number at full precision", () => {
    const band = (label: string, startMonth: number, endMonth: number) => ({ label, startMonth, endMonth });
    const w: WithInterest = {
      rows: [
        { band: band("0-1M", 0, 1), assets: 1.5, liabilities: 0.25, gap: 1.25, cumulativeGap: 1.25 },
        { band: band("1-3M", 1, 3), assets: 0.1 + 0.2, liabilities: 0, gap: 0.1 + 0.2, cumulativeGap: 1.55 },
      ],
      userBuckets: {
        kind: "custom",
        edgesMonths: [1, 3],
        rows: [{ band: band("M1", 0, 1), assets: 2, liabilities: 3, gap: -1, cumulativeGap: -1 }],
      },
      interest: {
        rows: [
          { band: band("0-1M", 0, 1), assets: 0.5, liabilities: 0.25, gap: 0.25, cumulativeGap: 0.25 },
          { band: band("1-3M", 1, 3), assets: 0.1, liabilities: 0, gap: 0.1, cumulativeGap: 0.35 },
        ],
        userBuckets: {
          kind: "custom",
          edgesMonths: [1, 3],
          rows: [{ band: band("M1", 0, 1), assets: 0.75, liabilities: 1, gap: -0.25, cumulativeGap: -0.25 }],
        },
      },
    };
    expect(withInterestCsv("S0", w)).toBe(
      "scenarioId,buckets,band,startMonth,endMonth,assets,liabilities,gap,cumulativeGap,interestIncome,interestExpense,netInterest,cumulativeNetInterest\n" +
        "S0,standard,0-1M,0,1,1.5,0.25,1.25,1.25,0.5,0.25,0.25,0.25\n" +
        "S0,standard,1-3M,1,3,0.30000000000000004,0,0.30000000000000004,1.55,0.1,0,0.1,0.35\n" +
        "S0,custom,M1,0,1,2,3,-1,-1,0.75,1,-0.25,-0.25\n",
    );
    // A label holding a comma or a quote is quoted, RFC 4180.
    const r0 = { band: band('a,"b"', 0, 1), assets: 1, liabilities: 1, gap: 0, cumulativeGap: 0 };
    const odd: WithInterest = { rows: [r0], interest: { rows: [{ ...r0, assets: 0, liabilities: 0 }] } };
    expect(withInterestCsv("S0", odd).split("\n")[1]).toBe('S0,standard,"a,""b""",0,1,1,1,0,0,0,0,0,0');
    // A total row and an interest row on different bands are refused, never paired by position.
    const skew: WithInterest = { rows: [r0], interest: { rows: [{ ...r0, band: band("1-3M", 1, 3) }] } };
    expect(() => withInterestCsv("S0", skew)).toThrow(/band/);
  });
});
