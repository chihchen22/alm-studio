/**
 * The Rates tab's rows, and the rows for a served shock
 * preview (previewRows, bp1). Every value the helpers return is a stored
 * document or served preview field, as stored or times 100 (display scaling to
 * percent), or chart geometry over such values; no helper computes a statistic.
 * Each expected number below is restated from the fixture literal, never read
 * back from the helper.
 */
import { describe, expect, it } from "vitest";
import type { RateDocument, StochasticRateFan } from "@alm/engine";
import {
  BASE_SERIES_ID,
  RATE_TO_PCT,
  bp1,
  curveRows,
  curveSeriesIds,
  fanRows,
  pathRows,
  pctPoints,
  previewRows,
} from "../rateChartRows";
import type { ShockPreview } from "../api/client";

function curve(t: number[], z: number[]) {
  return { t, z, df: z.map((zi, i) => Math.exp(-zi * t[i])) };
}

const OMITTED_REASON =
  'rate path model "bgm-lmm" is not the deterministic built-in; the rate document recomputes only the deterministic path';

/** Two scenarios: S0 carries a path, S1 is omitted. Horizon 3 months. */
function doc(): RateDocument {
  return {
    schemaVersion: "1.0.0",
    kind: "rate-document",
    runId: "run-1",
    mode: "deterministic",
    grid: { horizonMonths: 3, dtYears: 1 / 12, asOf: "2026-06-30" },
    base: curve([0.5, 1, 2], [0.04, 0.042, 0.045]),
    scenarios: [
      {
        scenarioId: "S0",
        rateSpecKind: "base",
        ratePathModel: "deterministic",
        curve: curve([0.5, 1, 2], [0.04, 0.042, 0.045]),
        path: { times: [0, 1 / 12, 2 / 12, 3 / 12], rate: [0.0425, 0.043, 0.0435] },
      },
      {
        scenarioId: "S1",
        rateSpecKind: "parallel",
        ratePathModel: "bgm-lmm",
        curve: curve([0.5, 1, 2], [0.06, 0.062, 0.065]),
        pathOmitted: OMITTED_REASON,
      },
    ],
  };
}

/** Quantiles deliberately OUT of pinned order so a by-position read would fail. */
function fan(): StochasticRateFan {
  return {
    scenarioId: "S0",
    nPaths: 4,
    a: 0.03,
    sigma: 0.01,
    times: [0, 1 / 12],
    mean: [0.04, 0.041],
    quantiles: [
      { p: 0.95, values: [0.05, 0.052] },
      { p: 0.05, values: [0.03, 0.031] },
      { p: 0.5, values: [0.04, 0.0405] },
      { p: 0.75, values: [0.045, 0.046] },
      { p: 0.25, values: [0.035, 0.036] },
    ],
  };
}

describe("pctPoints and the scale", () => {
  it("scales by exactly 100", () => {
    expect(RATE_TO_PCT).toBe(100);
    expect(0.0425 * RATE_TO_PCT).toBe(4.25);
  });
  it("formats a percent value to two decimals with a sign", () => {
    expect(pctPoints(4.25)).toBe("4.25%");
    expect(pctPoints(4.2)).toBe("4.20%");
    expect(pctPoints(-0.5)).toBe("-0.50%");
  });
});

describe("curveSeriesIds", () => {
  it("lists base first, then the scenarios in document order", () => {
    expect(curveSeriesIds(doc())).toEqual([BASE_SERIES_ID, "S0", "S1"]);
    expect(BASE_SERIES_ID).toBe("base");
  });
});

describe("curveRows", () => {
  it("has one row per base node with every series' zero rate in percent", () => {
    const rows = curveRows(doc());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ t: 0.5, base: 0.04 * 100, S0: 0.04 * 100, S1: 0.06 * 100 });
    expect(rows[2]).toEqual({ t: 2, base: 0.045 * 100, S0: 0.045 * 100, S1: 0.065 * 100 });
  });
  it("throws naming the scenario whose curve grid differs from the base grid", () => {
    const d = doc();
    d.scenarios[1].curve = curve([0.5, 1], [0.06, 0.062]);
    expect(() => curveRows(d)).toThrow(/S1/);
  });
  it("throws naming a scenario id that would overwrite a row key", () => {
    const d = doc();
    d.scenarios[0].scenarioId = "base";
    expect(() => curveRows(d)).toThrow(/"base"/);
  });
});

describe("pathRows", () => {
  it("has horizonMonths rows, one column per scenario with a path, and lists the omitted ones verbatim", () => {
    const { rows, omitted } = pathRows(doc());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ month: 0, S0: 0.0425 * 100 });
    expect(rows[2]).toEqual({ month: 2, S0: 0.0435 * 100 });
    expect(Object.keys(rows[0])).toEqual(["month", "S0"]);
    expect(omitted).toEqual([{ scenarioId: "S1", reason: OMITTED_REASON }]);
  });
  it("returns no rows when no scenario carries a path", () => {
    const d = doc();
    delete d.scenarios[0].path;
    d.scenarios[0].pathOmitted = OMITTED_REASON;
    const { rows, omitted } = pathRows(d);
    expect(rows).toEqual([]);
    expect(omitted.map((o) => o.scenarioId)).toEqual(["S0", "S1"]);
  });
  it("throws naming the scenario whose path length differs from the horizon", () => {
    const d = doc();
    d.scenarios[0].path = { times: [0, 1 / 12, 2 / 12], rate: [0.0425, 0.043] };
    expect(() => pathRows(d)).toThrow(/S0/);
  });
  it("throws naming a scenario id that would overwrite the month key", () => {
    const d = doc();
    d.scenarios[0].scenarioId = "month";
    expect(() => pathRows(d)).toThrow(/"month"/);
  });
});

describe("fanRows", () => {
  it("reads quantiles by p, not by position, and scales every value to percent", () => {
    const rows = fanRows(fan());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      t: 0,
      mean: 0.04 * 100,
      p50: 0.04 * 100,
      outer: [0.03 * 100, 0.05 * 100],
      inner: [0.035 * 100, 0.045 * 100],
    });
    expect(rows[1]).toEqual({
      t: 1 / 12,
      mean: 0.041 * 100,
      p50: 0.0405 * 100,
      outer: [0.031 * 100, 0.052 * 100],
      inner: [0.036 * 100, 0.046 * 100],
    });
  });
  it("throws naming the missing p", () => {
    const f = fan();
    f.quantiles = f.quantiles.filter((q) => q.p !== 0.25);
    expect(() => fanRows(f)).toThrow(/0\.25/);
  });
  it("throws when a series length differs from the step grid", () => {
    const f = fan();
    f.mean = [0.04];
    expect(() => fanRows(f)).toThrow(/mean/);
  });
});

describe("previewRows and bp1 (Studio P3)", () => {
  const reply: ShockPreview = {
    marketSnapshot: "m",
    calibrationDate: "2026-03-31",
    base: { t: [1, 10], z: [0.04, 0.05], df: [0.96, 0.6] },
    shocked: { t: [1, 10], z: [0.043, 0.053], df: [0.95, 0.59] },
    shiftBp: [300, 300],
  };
  it("scales the served rates to percent and keeps the served tenor and shift", () => {
    expect(previewRows(reply)).toEqual([
      { t: 1, basePct: 0.04 * 100, shockedPct: 0.043 * 100, shiftBp: 300 },
      { t: 10, basePct: 0.05 * 100, shockedPct: 0.053 * 100, shiftBp: 300 },
    ]);
  });
  it("refuses arrays that disagree in length", () => {
    expect(() => previewRows({ ...reply, shiftBp: [300] })).toThrow("shock preview arrays disagree");
  });
  it("refuses a value that is not a finite number, naming the field and node (Polish 1 S3)", () => {
    expect(() => previewRows({ ...reply, shiftBp: [300, null as unknown as number] })).toThrow("shock preview shiftBp[1] is not a finite number: null");
    expect(() => previewRows({ ...reply, base: { ...reply.base, z: [0.04, Number.NaN] } })).toThrow("shock preview base.z[1] is not a finite number: NaN");
    expect(() => previewRows({ ...reply, shocked: { ...reply.shocked, z: [null as unknown as number, 0.053] } })).toThrow("shock preview shocked.z[0] is not a finite number: null");
  });
  it("refuses a shocked tenor that is not a finite number (Polish 1 S3)", () => {
    expect(() => previewRows({ ...reply, shocked: { ...reply.shocked, t: [1, Number.POSITIVE_INFINITY] } })).toThrow("shock preview shocked.t[1] is not a finite number: Infinity");
  });
  it("prints one decimal and never a signed zero", () => {
    expect(bp1(300.00000000000006)).toBe("300.0");
    expect(bp1(-7.24)).toBe("-7.2");
    expect(bp1(-0.04)).toBe("0.0");
    expect(bp1(0)).toBe("0.0");
  });
});
