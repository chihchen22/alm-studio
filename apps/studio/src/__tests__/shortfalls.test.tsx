// apps/studio/src/__tests__/shortfalls.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "@alm/engine";
import { shortfallRows } from "../results/shortfallRows";
import { ShortfallCard, shortfallKey } from "../pages/results/NiiTab";

const result = {
  nii: {
    byScenario: [
      { scenarioId: "BASE", byFamily: [], totalNet12: 0, totalNet24: 0, shortfalls: [
        { familyId: "fixed-loans", reinvest: "growth", firstBucket: 0, clampedBuckets: 12, targetBalanceEnd: 1, achievedBalanceEnd: 250_000_000, balanceGapEnd: 249_999_999 },
      ] },
      { scenarioId: "S100", byFamily: [], totalNet12: 0, totalNet24: 0 },
    ],
  },
} as unknown as RunResult;

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("shortfallRows", () => {
  it("lists every stored shortfall in scenario order, fields as stored", () => {
    expect(shortfallRows(result)).toEqual([
      { scenarioId: "BASE", familyId: "fixed-loans", reinvest: "growth", targetBalanceEnd: 1, achievedBalanceEnd: 250_000_000, balanceGapEnd: 249_999_999, firstBucket: 0, clampedBuckets: 12 },
    ]);
  });
  it("is empty when no scenario stores one", () => {
    expect(shortfallRows({ nii: { byScenario: [{ scenarioId: "S100", byFamily: [], totalNet12: 0, totalNet24: 0 }] } } as unknown as RunResult)).toEqual([]);
  });
});

describe("ShortfallCard", () => {
  it("prints the stored fields in full USD with grouping commas", () => {
    const t = text(renderToStaticMarkup(<ShortfallCard runId="r1" rows={shortfallRows(result)} bound={true} scenarioLabel={(id) => id} />));
    // Restated: 1 prints 1; 250,000,000 prints with commas; the gap 249,999,999 is positive and prints no sign.
    expect(t).toContain("Target at end, USD Achieved at end, USD Gap, USD");
    expect(t).toContain("BASE fixed-loans growth 1 250,000,000 249,999,999 0 12");
    // The scenario opens the row as its row header (Row header scope).
    const html = renderToStaticMarkup(<ShortfallCard runId="r1" rows={shortfallRows(result)} bound={true} scenarioLabel={(id) => id} />);
    expect(html).toContain('<tr><th scope="row">BASE</th><td class="mono">fixed-loans</td><td>growth</td>');
  });
  it("with a balance plan and no stored shortfall, says every target held, as a status line", () => {
    const html = renderToStaticMarkup(<ShortfallCard runId="r1" rows={[]} bound={true} scenarioLabel={(id) => id} />);
    expect(html).toContain('<span class="status status-pass">Every target held</span>');
    expect(text(html)).toContain("Every target held No shortfall stored: new business held every target in the scenarios that ran it.");
  });
  it("with no balance plan in the run, says there is no target to check", () => {
    const html = renderToStaticMarkup(<ShortfallCard runId="r1" rows={[]} bound={false} scenarioLabel={(id) => id} />);
    expect(html).toContain('<span class="status status-unobs">No balance plan</span>');
    expect(text(html)).toContain("No balance plan This run binds no balance plan, so there is no target to check.");
    expect(text(html)).not.toContain("Every target held");
  });
});

describe("shortfall row keys (Piece 2 bugs)", () => {
  const row = { reinvest: "growth", targetBalanceEnd: 1, achievedBalanceEnd: 1, balanceGapEnd: 0, firstBucket: 0, clampedBuckets: 1 };
  it("do not collide when a hyphen moves between the scenario id and the family id", () => {
    const left = shortfallKey({ ...row, scenarioId: "a-b", familyId: "c" });
    const right = shortfallKey({ ...row, scenarioId: "a", familyId: "b-c" });
    // Restated: the key is the JSON pair, so the boundary between the two ids is explicit.
    expect(left).toBe('["a-b","c"]');
    expect(right).toBe('["a","b-c"]');
    expect(left).not.toBe(right);
  });
});
