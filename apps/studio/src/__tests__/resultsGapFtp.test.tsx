// apps/studio/src/__tests__/resultsGapFtp.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_IN_RUN, pct, signedMM, usdMM } from "@alm/reader";
import type { RunResult } from "@alm/engine";
import { BarPairs } from "../charts/BarPairs";
import { gapPage, GAP_PAGE_SIZE, GapTab, MonthlyPagedTable, NINE_BANDS_ONLY, nineBandsOnlyFor } from "../pages/results/GapTab";
import { FtpTab } from "../pages/results/FtpTab";
import { liveTabs } from "../pages/results/tabs";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";
import { CUSTOM_BUCKETS, MONTHLY_BUCKETS } from "./fixtures/gapBuckets";

const props = (result = RESULT, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id });

describe("GapTab", () => {
  it("prints both ladders for the selected scenario, the engine's cumulative included", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(RESULT, { scenario: "S200" })} />);
    const rep = RESULT.gap.repricing.find((l) => l.scenarioId === "S200")!;
    const liq = RESULT.gap.liquidity.find((l) => l.scenarioId === "S200")!;
    const last = rep.rows[rep.rows.length - 1]!;
    expect(html).toContain(last.band.label);
    expect(html).toContain(usdMM(last.assets));
    expect(html).toContain(signedMM(last.cumulativeGap));
    expect(html).toContain(signedMM(liq.rows[0]!.gap));
    expect(html).toContain('<th scope="col">Band</th>');
    // Each band opens its row as a row header (Row header scope).
    expect(html).toContain(`<tr><th scope="row">${last.band.label}</th><td class="num">${usdMM(last.assets)}</td>`);
  });

  it("a run without userBuckets says once, at page level, that it stores the nine standard bands only (decision 113)", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    const note = '<p class="card-desc" role="note">This run stores the nine standard bands only.</p>';
    expect(NINE_BANDS_ONLY).toBe("This run stores the nine standard bands only.");
    expect(html.split(note).length - 1).toBe(1);
    // Where the interim note sat: after the scenario picker, before the first card.
    expect(html.indexOf("</nav>")).toBeLessThan(html.indexOf(note));
    expect(html.indexOf(note)).toBeLessThan(html.indexOf("Repricing gap"));
    expect(html).not.toContain("gap in the nine standard bands only");
    // No interim copy is left, and no second block heading: the nine bands are the only view.
    expect(html).not.toContain("Interim");
    expect(html).not.toContain("a later release");
    expect(html).not.toContain("Nine standard bands");
    expect(html).toContain("Source: gap.repricing[scenarioId=S0].rows. Gap and cumulative gap are the stored fields.");
  });

  it("a scenario with no ladder is not in this run", () => {
    const r = freshResult();
    r.gap.liquidity = r.gap.liquidity.filter((l) => l.scenarioId !== "S0");
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(r)} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("gap.liquidity has no ladder for scenario S0");
  });
});

type UserBuckets = NonNullable<RunResult["gap"]["repricing"][number]["userBuckets"]>;

describe("GapTab: the run's own buckets (slice three, decisions 107, 108, 113)", () => {
  // Each pager button's accessible name holds its visible label and names the ladder.
  const btn = (label: "Prev" | "Next", on: boolean, name = "repricing months") =>
    `<button type="button" class="btn btn-quiet" aria-label="${label}, ${name}"${on ? "" : ' disabled=""'}>${label}</button>`;
  const PREV_OFF = btn("Prev", false);
  const PREV_ON = btn("Prev", true);
  const NEXT_OFF = btn("Next", false);
  const NEXT_ON = btn("Next", true);
  const NOTE = NINE_BANDS_ONLY;
  const REP_NOTE = "This run stores the repricing gap in the nine standard bands only.";
  const LIQ_NOTE = "This run stores the liquidity gap in the nine standard bands only.";
  const NINE = '<h3 class="viz-title">Nine standard bands</h3>';
  const row = (label: string) => `<th scope="row">${label}</th>`;
  /** The demo envelope with userBuckets set on the S0 repricing and, or, liquidity ladder. */
  const withBuckets = (rep?: UserBuckets, liq?: UserBuckets): RunResult => {
    const r = freshResult();
    if (rep !== undefined) r.gap.repricing.find((l) => l.scenarioId === "S0")!.userBuckets = rep;
    if (liq !== undefined) r.gap.liquidity.find((l) => l.scenarioId === "S0")!.userBuckets = liq;
    return r;
  };

  it("monthly: the run's buckets come first, the nine standard bands second under their own heading", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(MONTHLY_BUCKETS()))} />);
    const rep = RESULT.gap.repricing.find((l) => l.scenarioId === "S0")!;
    expect(html.indexOf("Repricing gap")).toBeLessThan(html.indexOf("Monthly buckets"));
    expect(html.indexOf("Monthly buckets")).toBeLessThan(html.indexOf(NINE));
    expect(html.indexOf(NINE)).toBeLessThan(html.indexOf(row(rep.rows[0]!.band.label)));
    // The nine bands keep their bars, their rows and their stored figures.
    expect(html).toContain(`<tr><th scope="row">${rep.rows[0]!.band.label}</th><td class="num">${usdMM(rep.rows[0]!.assets)}</td>`);
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(html.split("USD by band").length).toBe(plain.split("USD by band").length);
    expect(html).toContain("Source: gap.repricing[scenarioId=S0].userBuckets.rows (kind monthly) for the monthly buckets and gap.repricing[scenarioId=S0].rows for the nine standard bands.");
  });

  it("monthly: a line of cumulative gap, never bar pairs, and a paged table of the first page", () => {
    const u = MONTHLY_BUCKETS();
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(u))} />);
    expect(html).toContain('aria-label="Cumulative gap, USD at month end"');
    expect(html).toContain('class="lp-line"');
    expect(html).not.toContain("USD by bucket");
    // The line's own table is off (the paged table prints the rows): Show table stays the bar charts' only.
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(html.split("Show table").length).toBe(plain.split("Show table").length);
    expect(html).toContain('<th scope="col">Month</th>');
    expect(html).toContain(`<tr><th scope="row">M1</th><td class="num">${usdMM(100_000_000)}</td><td class="num">${usdMM(90_000_000)}</td><td class="num">${signedMM(10_000_000)}</td><td class="num">${signedMM(10_000_000)}</td></tr>`);
    expect(html).toContain(row(`M${GAP_PAGE_SIZE}`));
    expect(html).not.toContain(row(`M${GAP_PAGE_SIZE + 1}`));
    expect(html).toContain(`<span class="num" aria-live="polite">Rows 1 to ${GAP_PAGE_SIZE} of 40</span>`);
    expect(html).toContain(PREV_OFF);
    expect(html).toContain(NEXT_ON);
    expect(html).toContain(signedMM(u.rows[GAP_PAGE_SIZE - 1]!.cumulativeGap));
  });

  it("monthly: the second page holds the rest, Next off and Prev on; a page past the end clamps to the last", () => {
    const rows = MONTHLY_BUCKETS().rows;
    const last = renderToStaticMarkup(<MonthlyPagedTable rows={rows} page={1} name="repricing months" onPage={() => undefined} />);
    expect(last).toContain(`<span class="num" aria-live="polite">Rows ${GAP_PAGE_SIZE + 1} to 40 of 40</span>`);
    expect(last).toContain(row(`M${GAP_PAGE_SIZE + 1}`));
    expect(last).toContain(row("M40"));
    expect(last).not.toContain(row(`M${GAP_PAGE_SIZE}`));
    // One head row plus one row per month on the page.
    expect(last.split("<tr>").length - 1).toBe(1 + 40 - GAP_PAGE_SIZE);
    expect(last).toContain(PREV_ON);
    expect(last).toContain(NEXT_OFF);
    expect(renderToStaticMarkup(<MonthlyPagedTable rows={rows} page={9} name="repricing months" onPage={() => undefined} />)).toBe(last);
    // 360 months: 15 pages, the last from 337 to 360.
    expect(gapPage(360, 14)).toEqual({ page: 14, pages: 15, from: 337, to: 360 });
    expect(gapPage(360, 0)).toEqual({ page: 0, pages: 15, from: 1, to: GAP_PAGE_SIZE });
    expect(gapPage(0, 0)).toEqual({ page: 0, pages: 1, from: 0, to: 0 });
  });

  it("custom: bars and a table over the run's buckets, with the edges named, and no pager", () => {
    const u = CUSTOM_BUCKETS();
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(u))} />);
    expect(html).toContain('<h3 class="viz-title">Custom buckets</h3>');
    expect(html).toContain("bucket edges, in months: 1, 3, 12, 60, 120.");
    expect(html).toContain("USD by bucket");
    expect(html).toContain('<th scope="col">Bucket</th>');
    expect(u.rows).toHaveLength(6);
    for (const r of u.rows) expect(html).toContain(`<tr><th scope="row">${r.band.label}</th><td class="num">${usdMM(r.assets)}</td>`);
    expect(html).toContain(signedMM(u.rows[5]!.cumulativeGap));
    expect(html).not.toContain("Rows 1 to");
    expect(html).not.toContain('class="lp-line"');
    expect(html.indexOf("Custom buckets")).toBeLessThan(html.indexOf(NINE));
    expect(html).toContain("userBuckets.rows (kind custom) for the custom buckets");
  });

  it("only repricing bucketed: the liquidity card carries the scoped sentence, the repricing card and the page none", () => {
    const repOnly = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(MONTHLY_BUCKETS(), undefined))} />);
    expect(nineBandsOnlyFor("liquidity")).toBe(LIQ_NOTE);
    expect(repOnly).not.toContain(NOTE);
    expect(repOnly).not.toContain(REP_NOTE);
    expect(repOnly.split(`<p class="card-desc" role="note">${LIQ_NOTE}</p>`).length - 1).toBe(1);
    expect(repOnly.split("Monthly buckets").length - 1).toBe(1);
    expect(repOnly.indexOf("Monthly buckets")).toBeLessThan(repOnly.indexOf("Liquidity gap"));
    expect(repOnly.indexOf(LIQ_NOTE)).toBeGreaterThan(repOnly.indexOf("Liquidity gap"));
    expect(repOnly).toContain("Source: gap.liquidity[scenarioId=S0].rows. Gap and cumulative gap are the stored fields.");
  });

  it("only liquidity bucketed: the repricing card carries the scoped sentence, the liquidity card and the page none", () => {
    const liqOnly = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(undefined, CUSTOM_BUCKETS()))} />);
    expect(nineBandsOnlyFor("repricing")).toBe(REP_NOTE);
    expect(liqOnly).not.toContain(NOTE);
    expect(liqOnly).not.toContain(LIQ_NOTE);
    expect(liqOnly.split(REP_NOTE).length - 1).toBe(1);
    expect(liqOnly.indexOf("Repricing gap")).toBeLessThan(liqOnly.indexOf(REP_NOTE));
    expect(liqOnly.indexOf(REP_NOTE)).toBeLessThan(liqOnly.indexOf("Liquidity gap"));
    expect(liqOnly.indexOf("Custom buckets")).toBeGreaterThan(liqOnly.indexOf("Liquidity gap"));
    expect(liqOnly).toContain("Source: gap.liquidity[scenarioId=S0].userBuckets.rows (kind custom)");
  });

  it("both bucketed: no sentence anywhere, and each card has its own nine-band block", () => {
    const both = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(MONTHLY_BUCKETS(), CUSTOM_BUCKETS()))} />);
    expect(both).not.toContain("nine standard bands only");
    expect(both.split(NINE).length - 1).toBe(2);
  });

  it("two monthly ladders name their own pager buttons", () => {
    const both = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(MONTHLY_BUCKETS(), MONTHLY_BUCKETS()))} />);
    expect(both).toContain(btn("Next", true, "repricing months"));
    expect(both).toContain(btn("Next", true, "liquidity months"));
  });

  it("a scenario without userBuckets on either ladder prints the page sentence once, even when another scenario carries them", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(withBuckets(MONTHLY_BUCKETS(), CUSTOM_BUCKETS()), { scenario: "S200" })} />);
    expect(html.split(NOTE).length - 1).toBe(1);
    expect(html).not.toContain(NINE);
  });
});

describe("GapTab: the next-reset ALCO ladder (Task 15)", () => {
  const NEXT_RESET = {
    bands: ["0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y", "10Y+"],
    rows: [
      { band: "0-1M", assets: 3_300_000_000, liabilities: 2_833_250_000, gap: 466_750_000, cumulativeGap: 466_750_000 },
      { band: "1-3M", assets: 0, liabilities: 667_000_000, gap: -667_000_000, cumulativeGap: -200_250_000 },
      { band: "3-6M", assets: 1_000_000_000, liabilities: 667_000_000, gap: 333_000_000, cumulativeGap: 132_750_000 },
      { band: "6-12M", assets: 0, liabilities: 666_000_000, gap: -666_000_000, cumulativeGap: -533_250_000 },
    ],
    coreExcluded: 4_166_750_000,
    uncovered: [{ positionId: "sw-1", reason: "a swap carries no balance-sheet notional in the next-reset ladder" }],
  };

  it("prints the second ladder from the stored block: bands, stored cumulative, core excluded and the uncovered reasons", () => {
    const r = freshResult();
    r.gap.nextReset = NEXT_RESET;
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Next reset or maturity (ALCO convention)");
    expect(html).toContain(signedMM(-533_250_000));
    expect(html).toContain(usdMM(2_833_250_000));
    expect(html).toContain(usdMM(4_166_750_000));
    expect(html).toContain("sw-1");
    expect(html).toContain("a swap carries no balance-sheet notional in the next-reset ladder");
    expect(html).toContain(`<tr><th scope="row">6-12M</th><td class="num">${usdMM(0)}</td>`);
    expect(html).toContain("gap.nextReset.rows");
    // The ALCO card follows the engine's two ladders.
    expect(html.indexOf("Liquidity gap")).toBeLessThan(html.indexOf("Next reset or maturity (ALCO convention)"));
  });

  it("a run without the opt-in shows the card as not in this run, with the reason", () => {
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect("nextReset" in RESULT.gap).toBe(false);
    expect(html).toContain("Next reset or maturity (ALCO convention)");
    expect(html).toContain("gap.nextReset is absent: the run did not opt in to the next-reset ladder");
  });
});

describe("FtpTab", () => {
  it("prints the stored family rates, the bridge and the shocked refusal verbatim", () => {
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props()} />);
    const f = RESULT.ftp!.byFamily.find((x) => x.couponRate !== undefined)!;
    expect(html).toContain(pct(f.couponRate!, 4));
    expect(html).toContain(signedMM(RESULT.ftp!.nimBridge.bridgeNet12));
    expect(html).toContain(signedMM(RESULT.ftp!.nimBridge.niiNet12));
    expect(html).toContain(RESULT.ftp!.shockedScenarios.reason.slice(0, 20));
    // Each family opens its row as a row header (Row header scope).
    for (const fam of RESULT.ftp!.byFamily) expect(html).toContain(`<tr><th scope="row" class="mono">${fam.familyId}</th><td>${fam.side}</td>`);
  });

  it("an envelope with no ftp block is not in this run", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.ftp;
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r as RunResult)} />);
    expect(html).toContain(NOT_IN_RUN);
    expect(html).toContain("no ftp block");
  });

  it("the not-in-run reason names a run setup that turned FTP off (slice three decision 123)", () => {
    const r = freshResult() as Partial<RunResult>;
    delete r.ftp;
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r as RunResult)} />);
    // Its own clause among three causes, not a sub-case of the old-envelope clause.
    expect(html).toContain(
      "The envelope carries no ftp block: a seasoned book omits it and carries a notImplemented tag instead, an envelope stored before the block existed does not carry it, or the run setup turned FTP off.",
    );
  });

  it("a family with no priced notional carries its reason; a stored 0 book NIM with no priced notional carries the guard flag", () => {
    const r = freshResult();
    for (const f of r.ftp!.byFamily) {
      f.positionCount = 0;
      f.notional = 0;
      delete f.couponRate;
    }
    r.ftp!.book.bookNimRate = 0;
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r)} />);
    expect(html).toContain(`couponRate is absent for family ${r.ftp!.byFamily[0]!.familyId}: the engine transfer-prices no notional for this family`);
    expect(html).toContain(pct(0, 4));
    expect(html).toContain("zero-notional guard");
  });

  it("a nonzero book NIM never carries the guard flag", () => {
    expect(renderToStaticMarkup(<FtpTab ws="ws-a" {...props()} />)).not.toContain("zero-notional guard");
    const r = freshResult();
    for (const f of r.ftp!.byFamily) f.notional = 0;
    expect(r.ftp!.book.bookNimRate).not.toBe(0);
    expect(renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r)} />)).not.toContain("zero-notional guard");
  });

  it("the derivatives line shows only when the engine stored derivativesNet12", () => {
    expect(renderToStaticMarkup(<FtpTab ws="ws-a" {...props()} />)).not.toContain("Derivatives 12m");
    const r = freshResult();
    r.ftp!.nimBridge.derivativesNet12 = -7_000_000;
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Derivatives 12m");
    expect(html).toContain(signedMM(-7_000_000));
  });

  it("BarPairs keeps Scenario as its default header; the tabs are registered", () => {
    const pairs = renderToStaticMarkup(<BarPairs rows={[{ label: "a", a: 1, b: 2 }]} aLabel="A" bLabel="B" unit="u" />);
    expect(pairs).toContain('<th scope="col">Scenario</th>');
    // Row header scope 2: the category names its row in the Show table.
    expect(pairs).toContain('<tr><th scope="row">a</th><td class="num lvl">');
    const own = ["gap", "ftp"];
    expect(liveTabs().map((t) => t.id).filter((id) => own.includes(id))).toEqual(own);
  });
});
