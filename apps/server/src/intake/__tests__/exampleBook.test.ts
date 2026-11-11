/**
 * The example input book (`examples/example-book-v1.json`, docs/oss/example-book.md): it passes the JSON import path
 * the Studio's Import positions form and POST /api/portfolios/import use, its behavioral blocks are the kernel's
 * published defaults (nothing fitted), and a run over the regulatory grid on the public pack prices every family.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BETA_S_CURVE_DEFAULTS, IB_BUCKETS, loadMarketSnapshot, MBS_DEFAULTS, NMD_DEFAULTS } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext, type PortfolioSpec } from "@alm/engine";
import { makeRunRequest } from "@alm/engine/src/run/__tests__/fixtures";
import { parsePositionsJson } from "../positionsJson";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const BOOK = JSON.parse(read("../../../../../examples/example-book-v1.json")) as PortfolioSpec;

describe("the example input book", () => {
  it("imports on the JSON path with no error and no warning", () => {
    const out = parsePositionsJson(BOOK);
    expect("errors" in out ? out.errors : []).toEqual([]);
    expect("portfolio" in out ? out.portfolio.positions.length : 0).toBe(11);
    expect("warnings" in out ? out.warnings ?? [] : []).toEqual([]);
  });

  it("carries the kernel's default behavioral blocks, so nothing in it is fitted", () => {
    const terms = (id: string) => BOOK.positions.find((p) => p.id === id)!.terms as unknown as Record<string, unknown>;
    expect(terms("ex-mtg-1").cprParams).toEqual(MBS_DEFAULTS);
    expect(terms("ex-dda-1").nmdParams).toEqual(NMD_DEFAULTS);
    expect(terms("ex-mma-1").sCurve).toEqual(BETA_S_CURVE_DEFAULTS);
    expect(terms("ex-mma-1").nmdParams).toEqual({ ...NMD_DEFAULTS, buckets: IB_BUCKETS });
  });

  it("runs the regulatory grid on the public pack and prices every family at the base", async () => {
    const market = await loadMarketSnapshot(fileURLToPath(new URL("../../../../../packages/kernel/public/market_public.json", import.meta.url)));
    const req = makeRunRequest(market, {
      portfolioId: BOOK.id,
      assumptionSets: [{ schemaVersion: "1.0.0", id: "AS-BASE", label: "No overlays: the positions' own blocks", bindings: [] }],
      grid: { horizonMonths: 360, asOf: BOOK.asOf },
    });
    const result = buildRunResult(req, BOOK, resolveDefaultContext());
    const base = result.eve.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(base.byFamily.map((f) => f.familyId).sort()).toEqual(BOOK.coa.families.map((f) => f.id).sort());
    expect(base.byFamily.every((f) => Number.isFinite(f.pv) && f.pv !== 0)).toBe(true);
  });
});
