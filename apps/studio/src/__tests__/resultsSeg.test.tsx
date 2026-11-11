// apps/studio/src/__tests__/resultsSeg.test.tsx
// The SEG / EBP tab. Expected figures are restated here from the
// fixture's own inputs, not read back from the code under test.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NOT_IN_RUN } from "@alm/reader";
import type { RunResult } from "@alm/engine";
import { SegTab } from "../pages/results/SegTab";
import { BLOCKS_DETAIL, blocksResult } from "./fixtures/blocks";
import { freshResult } from "./fixtures/results";

const props = (result: RunResult, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: BLOCKS_DETAIL, result, query, scenarioLabel: (id: string) => id });

describe("SegTab", () => {
  const html = renderToStaticMarkup(<SegTab ws="ws-a" {...props(blocksResult())} />);

  it("names the convention in one note: constant balance sheet, shock from month 1, the two shock sizes", () => {
    expect(html).toContain("Constant balance sheet");
    expect(html).toContain("replacement vintages");
    expect(html).toContain("month 1 is unshocked");
    expect(html).toContain("10bp");
    expect(html).toContain("200bp");
  });

  it("prints the bank SEG peak (largest absolute value) and its month, with its 0-based series index", () => {
    // Fixture bank series: index 3 is the largest, +1,846.32M. Month = index + 1.
    expect(html).toContain("+$1,846.3M");
    expect(html).toContain("month 4");
    expect(html).toContain("index 3");
    expect(html).toContain("liability-sensitive");
  });

  it("prints a negative bank peak with its minus sign when the largest absolute value is negative", () => {
    const r = blocksResult();
    r.seg!.segBank = r.seg!.segBank.map((v, i) => (i === 7 ? -3_000_000_000 : v));
    const out = renderToStaticMarkup(<SegTab ws="ws-a" {...props(r)} />);
    expect(out).toContain("−$3,000.0M");
    expect(out).toContain("month 8");
    expect(out).toContain("index 7");
  });

  it("draws the bank SEG, the book outstanding and periodic series, and the two EBP series", () => {
    expect(html).toContain('aria-label="Bank SEG"');
    expect(html).toContain('aria-label="Book SEG, outstanding and periodic"');
    expect(html).toContain('aria-label="Equivalent balance profile"');
    expect(html).toContain("Assets");
    expect(html).toContain("Liabilities");
    // Source lines name the stored fields.
    expect(html).toContain("seg.segBank");
    expect(html).toContain("seg.book.ebpAssets");
  });

  it("prints the constant-balance NII block: base, the two 200bp changes, NIM, the horizon", () => {
    // Fixture nii: base 60M, up 66M, down 52M; NIM 2.965 percent.
    expect(html).toContain('aria-label="Constant balance NII"');
    expect(html).toContain("$60.0M");
    expect(html).toContain("+$6.0M");
    expect(html).toContain("−$8.0M");
    expect(html).toContain("2.97%");
  });

  it("lists the families with their peaks, each opening its row as a row header", () => {
    expect(html).toContain('<th scope="row" class="mono">fixed-loans</th>');
    expect(html).toContain('<th scope="row" class="mono">hys-a</th>');
    expect(html).toContain("+$1,200.0M");
    expect(html).toContain("−$400.0M");
  });

  it("lists what the block could not cover, with the reason", () => {
    expect(html).toContain("fx-swap-1");
    expect(html).toContain("no replacement vintage");
  });

  it("a run that did not opt in to seg is not in this run, with one sentence", () => {
    const out = renderToStaticMarkup(<SegTab ws="ws-a" {...props(freshResult())} />);
    expect(out).toContain(NOT_IN_RUN);
    expect(out).toContain("did not opt in to the seg block");
    expect(out).not.toContain('aria-label="Bank SEG"');
  });
});
