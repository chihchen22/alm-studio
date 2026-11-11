// apps/studio/src/__tests__/resultsFixedRateGap.test.tsx
/**
 * The Gap tab's fixed-rate card. Shown only when the run carries gap.fixedRate,
 * every figure the stored one; a run without it renders exactly as before.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { signedMM, usdMM } from "@alm/reader";
import type { FixedRateLadder } from "@alm/engine";
import { GapTab } from "../pages/results/GapTab";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const props = (result = RESULT) => ({ runId: "run-fixture", detail: DETAIL, result, query: {}, scenarioLabel: (id: string) => id });

const LABELS = ["0-1M", "1-3M", "3-6M", "6-12M", "1-2Y", "2-3Y", "3-5Y", "5-10Y", "10Y+"];
/** A stored ladder for the render: the first four bands are the v5 twin's, the split past one year is illustrative. */
const ASSETS = [65_741_069, 134_036_257, 1_209_016_333, 438_938_159, 1_497_000_000, 1_376_946_711, 600_000_000, 600_000_000, 778_321_471];
const LIABS = [0, 667_000_000, 667_000_000, 666_000_000, 250_000_000, 250_000_000, 0, 0, 0];

function ladder(): FixedRateLadder {
  let cum = 0;
  return {
    scenarioId: "S0",
    bands: [...LABELS],
    rows: LABELS.map((band, i) => {
      const gap = ASSETS[i]! - LIABS[i]!;
      cum += gap;
      return { band, assets: ASSETS[i]!, liabilities: LIABS[i]!, gap, cumulativeGap: cum };
    }),
    uncovered: [{ positionId: "sw-1", reason: "a swap carries no balance-sheet principal; its fixed leg is in the engine's repricing ladder" }],
  };
}

describe("GapTab fixed-rate card", () => {
  it("a run without gap.fixedRate shows no fixed-rate card", () => {
    expect("fixedRate" in RESULT.gap).toBe(false);
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props()} />);
    expect(html).not.toContain("Fixed-rate gap");
  });

  it("prints the stored bands, gap and cumulative, the uncovered reasons and the source, after the next-reset card", () => {
    const r = freshResult();
    r.gap.fixedRate = ladder();
    const html = renderToStaticMarkup(<GapTab ws="ws-a" {...props(r)} />);
    expect(html).toContain("Fixed-rate gap (rate-locked principal by payment month), scenario S0");
    const rows = ladder().rows;
    expect(html).toContain(`<tr><th scope="row">1-3M</th><td class="num">${usdMM(rows[1]!.assets)}</td><td class="num">${usdMM(rows[1]!.liabilities)}</td><td class="num">${signedMM(rows[1]!.gap)}</td>`);
    expect(html).toContain(signedMM(rows[8]!.cumulativeGap));
    expect(html).toContain("sw-1");
    expect(html).toContain("gap.fixedRate.rows");
    expect(html.indexOf("Next reset or maturity (ALCO convention)")).toBeLessThan(html.indexOf("Fixed-rate gap (rate-locked"));
  });
});
