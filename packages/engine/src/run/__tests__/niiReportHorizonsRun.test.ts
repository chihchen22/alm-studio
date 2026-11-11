/**
 * Studio piece D slice three, Task 3 (spec decisions 115 to 119): the NII report horizons and the NII window a
 * run setup names, honoured by the run.
 *
 *  - A run asking for [12, 24, 60] adds a 60-month entry to the NII block and moves nothing else: once the added
 *    entries are stripped (`byHorizon[60]` on every family and cell row, `totalNetByHorizon[60]`,
 *    `derivativesNetByHorizon[60]`, and the trailing 60 of `horizonsMonths`), the WHOLE envelope is byte-equal to
 *    the default run's. That covers every 12 and 24 month NII figure and also EVE, gap, attribution, SEG, NIM and
 *    the FTP bridge. The book carries a swap (the derivatives line) and a declared view (the byCell arm), and the
 *    run opts in to SEG so NIM is written.
 *  - The FTP bridge keeps the constant first horizon (decision 117): 12 months on both runs, the same block.
 *  - `nii.windowMonths` is written only when the window is not 60, and before `nimPct`, so key order is fixed
 *    (decision 118).
 *  - The 60-month `deltaNiiPct` becomes observable on a run that carries the entry (decision 119); on a run that
 *    does not, it stays unobservable.
 *
 * Expected values are restated from the envelope's own fields, never imported from the code under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { PortfolioSpec } from "../../contracts/position";
import type { RunResult } from "../../contracts/run";
import { LENS_READERS } from "../../report/lensReaders";
import { hedgedBook, swapPosition, SWAP_FAMILY_ID } from "../../swap/__tests__/fixtures";
import { resolveDefaultContext } from "../engine";
import { buildRunResult, type RunPipelineContext } from "../orchestrate";
import {
  baseAssumptions,
  BY_SEGMENT_VIEW,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  viewSegmentedBook,
} from "./fixtures";

/** The segmented deposit book with a declared view, plus one pay-fixed swap tagged into the view. */
function book(): PortfolioSpec {
  const swap = { ...swapPosition("H60", SWAP_FAMILY_ID, { maturityMonths: 60 }), dimensions: { segment: "whole-book" } };
  return hedgedBook("PF-NII-HORIZONS", [swap], [SWAP_FAMILY_ID], viewSegmentedBook("PF-NII-HORIZONS"));
}

let market: MarketSnapshot;
function run(extra: Partial<RunPipelineContext>): RunResult {
  const b = book();
  const set = baseAssumptions("AS-NII-HORIZONS");
  return buildRunResult(
    makeRunRequest(market, {
      portfolioId: b.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
      views: [BY_SEGMENT_VIEW],
    }),
    b,
    { ...resolveDefaultContext(), seg: true, ...extra },
  );
}

let plain: RunResult;
let with60: RunResult;
let window36: RunResult;
beforeAll(async () => {
  market = await loadMarket();
  plain = run({});
  with60 = run({ reportHorizons: [12, 24, 60], windowMonths: 60 });
  window36 = run({ windowMonths: 36 });
}, 600_000);

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key);
type Horizons = Record<string, unknown>;

/** A deep copy of `r` with the added 60-month NII entries removed; throws if an entry it should strip is missing. */
function stripSixty(r: RunResult): RunResult {
  const c = JSON.parse(JSON.stringify(r)) as RunResult;
  const drop = (map: Horizons | undefined, where: string): void => {
    if (map === undefined || !own(map, "60")) throw new Error(`no 60-month entry at ${where}`);
    delete map["60"];
  };
  const hs = c.nii.horizonsMonths;
  if (hs[hs.length - 1] !== 60) throw new Error(`horizonsMonths does not end on 60: [${hs.join(", ")}]`);
  hs.pop();
  for (const s of c.nii.byScenario) {
    for (const f of s.byFamily) drop(f.byHorizon as Horizons, `${s.scenarioId}/${f.familyId}`);
    for (const cell of s.byCell ?? []) drop(cell.byHorizon as Horizons, `${s.scenarioId}/${cell.cellId}`);
    drop(s.totalNetByHorizon as Horizons, `${s.scenarioId} total`);
    drop(s.derivativesNetByHorizon as Horizons, `${s.scenarioId} derivatives`);
  }
  return c;
}

describe("NII report horizons [12, 24, 60] (decisions 115, 119)", () => {
  it("the run reports the list it asked for, and the fixture carries the arms it must strip", () => {
    expect(with60.nii.horizonsMonths).toEqual([12, 24, 60]);
    expect(plain.nii.horizonsMonths).toEqual([12, 24]);
    for (const s of with60.nii.byScenario) {
      expect(s.byCell?.length ?? 0).toBeGreaterThan(0);
      expect(s.derivativesNetByHorizon).toBeDefined();
    }
    expect(with60.seg).toBeDefined();
    expect(typeof with60.nii.nimPct).toBe("number");
    expect(with60.ftp).toBeDefined();
  });

  it("every 60-month entry is the sum of the first 60 monthly nets (it is a real window, not a copy)", () => {
    for (const s of with60.nii.byScenario) {
      let sum = 0;
      for (let k = 0; k < 60; k++) sum += s.netMonthly![k]!;
      expect(Math.abs(s.totalNetByHorizon![60]! - sum)).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(sum)));
    }
  });

  it("stripped of the 60-month entries, the whole envelope is byte-equal to the default run", () => {
    expect(JSON.stringify(stripSixty(with60))).toBe(JSON.stringify(plain));
  });

  it("EVE, gap, attribution, SEG, NIM and the FTP bridge are unchanged by the list, block by block", () => {
    expect(JSON.stringify(with60.eve)).toBe(JSON.stringify(plain.eve));
    expect(JSON.stringify(with60.gap)).toBe(JSON.stringify(plain.gap));
    expect(JSON.stringify(with60.attribution)).toBe(JSON.stringify(plain.attribution));
    expect(JSON.stringify(with60.seg)).toBe(JSON.stringify(plain.seg));
    expect(with60.nii.nimPct).toBe(plain.nii.nimPct);
  });
});

describe("the FTP bridge keeps the constant first horizon (decision 117)", () => {
  it("bridges at 12 months, against the 12-month NII, on a run with [12, 24, 60] exactly as on the default", () => {
    expect(with60.ftp!.nimBridge.horizonMonths).toBe(12);
    expect(JSON.stringify(with60.ftp)).toBe(JSON.stringify(plain.ftp));
    const base = with60.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(with60.ftp!.nimBridge.niiNet12).toBe(base.totalNet12);
  });
});

describe("nii.windowMonths (decision 118)", () => {
  it("is absent at 60 and on a run that names no window", () => {
    expect(own(with60.nii, "windowMonths")).toBe(false);
    expect(own(plain.nii, "windowMonths")).toBe(false);
  });

  it("is present otherwise, set before nimPct, and moves nothing else", () => {
    expect(window36.nii.windowMonths).toBe(36);
    expect(Object.keys(window36.nii)).toEqual(["horizonsMonths", "byScenario", "windowMonths", "nimPct"]);
    const c = JSON.parse(JSON.stringify(window36)) as RunResult;
    delete c.nii.windowMonths;
    expect(JSON.stringify(c)).toBe(JSON.stringify(plain));
  });
});

describe("deltaNiiPct at 60 months (decision 119)", () => {
  it("is a value on a run that carries the 60-month entry, restated from the two scenario totals", () => {
    const nii = (id: string): number => with60.nii.byScenario.find((s) => s.scenarioId === id)!.totalNetByHorizon![60]!;
    const expected = (nii("S100") - nii("S0")) / Math.abs(nii("S0"));
    expect(
      LENS_READERS.deltaNiiPct({ result: with60, scenarioId: "S100", baseScenarioId: "S0", params: { horizonMonths: 60 } }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("stays unobservable on a run that does not carry it", () => {
    const out = LENS_READERS.deltaNiiPct({ result: plain, scenarioId: "S100", baseScenarioId: "S0", params: { horizonMonths: 60 } });
    expect(out.kind).toBe("unobservable");
    if (out.kind !== "unobservable") return;
    expect(out.reason).toContain("60");
    expect(out.reason).toContain("[12, 24]");
  });
});
