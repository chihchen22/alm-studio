// apps/studio/src/__tests__/resultsLiquidity.test.tsx
// The Liquidity tab. Expected figures restated from the fixture's inputs.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_IN_RUN } from "@alm/reader";
import type { RunResult } from "@alm/engine";
import { LiquidityTab } from "../pages/results/LiquidityTab";
import { BLOCKS_DETAIL, blocksResult, liquidityFixture } from "./fixtures/blocks";
import { freshResult } from "./fixtures/results";

const props = (result: RunResult, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: BLOCKS_DETAIL, result, query, scenarioLabel: (id: string) => id });

describe("LiquidityTab", () => {
  const liq = liquidityFixture();
  const html = renderToStaticMarkup(<LiquidityTab ws="ws-a" {...props(blocksResult())} />);

  it("prints one ladder per scenario, twelve months each, with the stored cumulative", () => {
    for (const label of ["Business as usual", "Moderate stress", "Severe stress"]) expect(html).toContain(label);
    expect(html.match(/aria-label="Ladder, /g)?.length).toBe(3);
    // Severe: inflow 100M, hys out 180M, nib out 60M, draws 30M, wholesale 30M in month 3. Month 1 net -170M.
    expect(html).toContain('<th scope="row" class="num">1</th>');
    expect(html).toContain("−$170.0M");
    const severe = liq.scenarios[2]!;
    expect(html).toContain(`−$${(-severe.cumulative[11]! / 1e6).toLocaleString("en-US", { minimumFractionDigits: 1 })}M`);
    // 3 scenarios x 12 months, and the survival path's 12 months under the ladder.
    expect(html.match(/<th scope="row" class="num">/g)?.length).toBe(48);
  });

  it("prints the survival horizon per scenario: a number, or beyond twelve months when the buffer is never pierced", () => {
    expect(html).toContain("Beyond 12 months");
    expect(html).toContain("9.4 months");
    expect(html).toContain("3.2 months");
  });

  it("prints the peak shortfall and its month for each scenario", () => {
    const severe = liq.scenarios[2]!;
    expect(html).toContain(`month ${severe.peakMonth}`);
    expect(html).toContain("Peak shortfall");
  });

  it("draws the cumulative net funding against the buffer line and says what the line is", () => {
    expect(html).toContain('aria-label="Cumulative net funding against the buffer"');
    expect(html).toContain("$900.0M");
    expect(html).toContain("buffer");
    expect(html).toContain("liquidityStress.scenarios");
  });

  it("prints the stress table that produced each ladder, as percent per month", () => {
    // Fixture table: severe hys 8 percent, nib 1.5 percent, renewal 20, draw 25 percent; moderate 4, 0.8, 60, 12; bau 0.4, 0.1, 100, 0.
    for (const figure of ["8.00%", "1.50%", "20.00%", "25.00%", "4.00%", "0.80%", "60.00%", "12.00%", "0.40%", "0.10%", "100.00%"]) expect(html).toContain(figure);
  });

  it("a run that did not opt in to liquidityStress is not in this run, with one sentence", () => {
    const out = renderToStaticMarkup(<LiquidityTab ws="ws-a" {...props(freshResult())} />);
    expect(out).toContain(NOT_IN_RUN);
    expect(out).toContain("did not opt in to the liquidity stress block");
    expect(out).not.toContain('aria-label="Ladder, ');
  });
});
