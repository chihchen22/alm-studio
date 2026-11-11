// apps/studio/src/__tests__/resultsTeachA4.test.tsx
/**
 * Teaching build slice A4 on the Studio side: the bucket and FTP CSV links, the guard on a stored interest-inclusive
 * ladder with no interest rows, and the monthly NII CSV header (units, scenario, family or node, RFC 4180 quoting).
 * Expected strings are restated by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "@alm/engine";
import { GapTab, withInterestCsv } from "../pages/results/GapTab";
import { FtpTab } from "../pages/results/FtpTab";
import { niiMonthlyCsv } from "../pages/results/NiiMonthlyCard";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";
import { CUSTOM_BUCKETS, MONTHLY_BUCKETS } from "./fixtures/gapBuckets";

const props = (result: RunResult = RESULT, query: Record<string, string> = {}) => ({
  runId: "run-fixture", detail: DETAIL, result, query, scenarioLabel: (id: string) => id,
});

/** S0's liquidity ladder carries withInterest with its combined rows only, as an envelope from before the interest view. */
function noInterest(): RunResult {
  const r = freshResult();
  const liq = r.gap.liquidity.find((l) => l.scenarioId === "S0")!;
  (liq as { withInterest?: unknown }).withInterest = { rows: liq.rows.map((x) => ({ ...x, band: { ...x.band } })) };
  return r;
}

describe("Gap tab: the bucket CSV links", () => {
  it("links each bucketed ladder to its server CSV, and a ladder without buckets to none", () => {
    const r = freshResult();
    for (const l of r.gap.repricing) l.userBuckets = CUSTOM_BUCKETS();
    for (const l of r.gap.liquidity) l.userBuckets = MONTHLY_BUCKETS();
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(r)} />);
    expect(html).toContain('<a class="btn btn-quiet" href="/api/runs/run-fixture/export/repricing-gap-buckets.csv" download="">Export repricing-gap-buckets.csv</a>');
    expect(html).toContain('<a class="btn btn-quiet" href="/api/runs/run-fixture/export/liquidity-gap-buckets.csv" download="">Export liquidity-gap-buckets.csv</a>');
    expect(html).toContain("The CSV carries the custom buckets of every scenario, every figure at full precision.");
    expect(html).toContain("The CSV carries the monthly buckets of every scenario, every figure at full precision.");
    const plain = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(plain).not.toContain("gap-buckets.csv");
  });
});

describe("Gap tab: a stored interest-inclusive ladder with no interest rows (slice A4 guard)", () => {
  it("renders every view; the Interest view says what is missing instead of blanking the tab", () => {
    for (const liqview of ["total", "principal", "interest"]) {
      expect(() => renderToStaticMarkup(<GapTab ws="ws-a" {...props(noInterest(), { liqview })} />), liqview).not.toThrow();
    }
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(noInterest(), { liqview: "interest" })} />);
    expect(html).toContain("This run stores the interest-inclusive ladder without its interest rows (withInterest.interest is absent), so the Interest view has nothing to show. Principal and Total read as stored.");
    expect(html).toContain("Next reset or maturity");
  });

  it("writes the CSV with the interest columns blank, never 0", () => {
    const w = noInterest().gap.liquidity.find((l) => l.scenarioId === "S0")!.withInterest!;
    const lines = withInterestCsv("S0", w).trimEnd().split("\n");
    expect(lines).toHaveLength(1 + w.rows.length);
    const r0 = w.rows[0]!;
    expect(lines[1]).toBe(`S0,standard,${r0.band.label},${r0.band.startMonth},${r0.band.endMonth},${r0.assets},${r0.liabilities},${r0.gap},${r0.cumulativeGap},,,,`);
  });
});

describe("FTP tab: the CSV link", () => {
  it("links the FTP table to its server CSV", () => {
    const html = renderToStaticMarkup(<FtpTab ws="ws-a" {...props()} />);
    expect(html).toContain('<a class="btn btn-quiet" href="/api/runs/run-fixture/export/ftp.csv" download="">Export ftp.csv</a>');
    expect(html).toContain("The CSV carries every family, the book roll-up and the NIM bridge at full precision; a blank rate is a rate the engine does not store.");
  });
});

describe("the monthly NII CSV header", () => {
  it("names the scenario, the family or node and each column's unit, and quotes only where RFC 4180 needs it", () => {
    const csv = niiMonthlyCsv("S0", { kind: "node", id: 'n,"1"' }, [
      { id: "income", label: "Income", values: [10, 20], note: "summed here from the family rows" },
      { id: "yield", label: "Yield, annualized", values: [0.0512345, null], note: "worked out here" },
    ]);
    expect(csv).toBe(
      'scenarioId,familyId,coaNodeId,Month,"Income (USD, summed here from the family rows)","Yield, annualized (annual rate as a decimal, worked out here)"\n' +
        'S0,,"n,""1""",1,10,0.0512345\n' +
        'S0,,"n,""1""",2,20,\n',
    );
    expect(niiMonthlyCsv("S100", null, [{ id: "net", label: "Net interest", values: [1.5] }])).toBe("scenarioId,familyId,coaNodeId,Month,Net interest (USD)\nS100,TOTAL,,1,1.5\n");
    expect(niiMonthlyCsv("S0", { kind: "family", id: "cash" }, [{ id: "balance", label: "Balance, start of month", values: [7] }]).split("\n")[1]).toBe("S0,cash,,1,7");
  });
});
