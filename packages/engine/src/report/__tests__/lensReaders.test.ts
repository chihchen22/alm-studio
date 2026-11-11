/**
 * Each reader over a real run built through the same
 * fixtures pivot.test.ts uses.
 *
 * Every value assertion is against THE ENVELOPE FIELD the reader claims to
 * read, never against a literal: a literal copied out of a first run would make
 * the test agree with whatever the code does. For deltaNiiPct the assertion
 * RESTATES the formula from the two scenario totals rather than importing it,
 * so the check cannot borrow its expected value from the thing it checks.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { CustomMetricScenarioRow } from "../../contracts/customMetric";
import type { RunResult } from "../../contracts/run";
import { resolveDefaultContext } from "../../run/engine";
import { buildRunResult } from "../../run/orchestrate";
import {
  baseAssumptions,
  loadMarket,
  makeRunRequest,
  regulatoryScenarios,
  viewSegmentedBook,
} from "../../run/__tests__/fixtures";
import { LENS_READERS } from "../lensReaders";

let result: RunResult;

beforeAll(async () => {
  const market: MarketSnapshot = await loadMarket();
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-LENS-READERS");
  result = buildRunResult(
    makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
    }),
    book,
    // resolveDefaultContext takes ZERO arguments (run/engine.ts).
    resolveDefaultContext(),
  );
}, 180_000);

/** A deep clone, so a case may delete or zero a field without touching the shared envelope. */
function clone(): RunResult {
  return JSON.parse(JSON.stringify(result)) as RunResult;
}

describe("lens readers", () => {
  it("deltaEvePct returns the envelope's own deltaEvePct for the scenario", () => {
    const expected = result.eve.byScenario.find((s) => s.scenarioId === "S100")!.deltaEvePct;
    expect(
      LENS_READERS.deltaEvePct({ result, scenarioId: "S100", baseScenarioId: "S0" }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("deltaEvePct refuses a scenario the eve block does not carry", () => {
    const out = LENS_READERS.deltaEvePct({ result, scenarioId: "SNOPE", baseScenarioId: "S0" });
    expect(out.kind).toBe("refusal");
    if (out.kind !== "refusal") return;
    expect(out.missing).toContain("SNOPE");
    expect(out.missing).toContain("eve");
  });

  it("deltaNiiPct equals (N_s - N_base) / |N_base| restated from the two scenario totals", () => {
    const nii = (id: string): number =>
      result.nii.byScenario.find((s) => s.scenarioId === id)!.totalNetByHorizon![12]!;
    const expected = (nii("S100") - nii("S0")) / Math.abs(nii("S0"));
    expect(
      LENS_READERS.deltaNiiPct({
        result,
        scenarioId: "S100",
        baseScenarioId: "S0",
        params: { horizonMonths: 12 },
      }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("deltaNiiPct falls back to totalNet12 when the horizon map is absent", () => {
    const c = clone();
    for (const s of c.nii.byScenario) delete s.totalNetByHorizon;
    const nii = (id: string): number =>
      c.nii.byScenario.find((s) => s.scenarioId === id)!.totalNet12;
    const expected = (nii("S100") - nii("S0")) / Math.abs(nii("S0"));
    expect(
      LENS_READERS.deltaNiiPct({
        result: c,
        scenarioId: "S100",
        baseScenarioId: "S0",
        params: { horizonMonths: 12 },
      }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("deltaNiiPct is unobservable when base NII at the horizon is zero", () => {
    const c = clone();
    const base = c.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    base.totalNetByHorizon = { ...base.totalNetByHorizon, 12: 0 };
    const out = LENS_READERS.deltaNiiPct({
      result: c,
      scenarioId: "S100",
      baseScenarioId: "S0",
      params: { horizonMonths: 12 },
    });
    expect(out.kind).toBe("unobservable");
    if (out.kind !== "unobservable") return;
    expect(out.reason).toContain("zero");
    expect(out.reason).toContain("undefined");
  });

  it("deltaNiiPct is unobservable at a horizon the run did not compute", () => {
    const out = LENS_READERS.deltaNiiPct({
      result,
      scenarioId: "S100",
      baseScenarioId: "S0",
      params: { horizonMonths: 36 },
    });
    expect(out.kind).toBe("unobservable");
    if (out.kind !== "unobservable") return;
    expect(out.reason).toContain("36");
  });

  it("deltaNiiPct is unobservable at 60 months on a run that reports [12, 24] only (slice three: a run that asks for 60 answers it)", () => {
    // The value case at 60, on a run that asked for [12, 24, 60], is pinned in run/__tests__/niiReportHorizonsRun.test.ts.
    expect(result.nii.horizonsMonths).toEqual([12, 24]);
    const out = LENS_READERS.deltaNiiPct({
      result,
      scenarioId: "S100",
      baseScenarioId: "S0",
      params: { horizonMonths: 60 },
    });
    expect(out.kind).toBe("unobservable");
    if (out.kind !== "unobservable") return;
    expect(out.reason).toContain("horizon 60 months");
  });

  it("cumulativeLiquidityGap returns the ladder row's own cumulativeGap", () => {
    const ladder = result.gap.liquidity.find((l) => l.scenarioId === "S0")!;
    const expected = ladder.rows.find((r) => r.band.label === "0-1M")!.cumulativeGap;
    expect(
      LENS_READERS.cumulativeLiquidityGap({
        result,
        scenarioId: "S0",
        baseScenarioId: "S0",
        params: { band: "0-1M" },
      }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("cumulativeLiquidityGap refuses a scenario with no liquidity ladder", () => {
    const c = clone();
    c.gap.liquidity = [];
    const out = LENS_READERS.cumulativeLiquidityGap({
      result: c,
      scenarioId: "S0",
      baseScenarioId: "S0",
      params: { band: "0-1M" },
    });
    expect(out.kind).toBe("refusal");
    if (out.kind !== "refusal") return;
    expect(out.missing).toContain("liquidity ladder");
  });

  it("shortfallCount is the shortfalls length, and 0 when the arm is absent", () => {
    const scn = result.nii.byScenario.find((s) => s.scenarioId === "S0")!;
    expect(scn.shortfalls).toBeUndefined(); // a static grid reports none
    expect(
      LENS_READERS.shortfallCount({ result, scenarioId: "S0", baseScenarioId: "S0" }),
    ).toEqual({ kind: "value", value: 0 });
  });

  it("capitalRatio is always unobservable, naming the missing component", () => {
    const out = LENS_READERS.capitalRatio({ result, scenarioId: "S0", baseScenarioId: "S0" });
    expect(out).toEqual({
      kind: "unobservable",
      reason: "no capital metric on the envelope; a capital component is a later release",
    });
  });

  /**
   * The envelope arm is HAND-BUILT on a clone: the
   * reader's job is to read what the envelope carries, and the expected value is
   * the number this test wrote into the row, not a number computed by anything
   * under test.
   */
  function withCustom(): RunResult {
    const c = clone();
    c.custom = {
      "balance-summary": {
        metricId: "balance-summary",
        label: "Balance summary (demonstration metric)",
        keys: [
          { id: "opening-balance", label: "Opening", unit: "currency" },
          { id: "runoff-share", label: "Runoff share", unit: "fraction" },
        ],
        byScenario: c.eve.byScenario.map((s, i): CustomMetricScenarioRow => ({
          scenarioId: s.scenarioId,
          // The FIRST scenario reports both keys; every other one reports only
          // the balance, so the absent-key path is exercised on a real row.
          values: i === 0 ? { "opening-balance": 1234, "runoff-share": 0.3 } : { "opening-balance": 1234 },
        })),
      },
    };
    return c;
  }

  it("customValue returns the number the envelope row carries", () => {
    const c = withCustom();
    const row = c.custom!["balance-summary"]!.byScenario[0]!;
    // The expected value is read back off THE ENVELOPE FIELD the reader claims
    // to read, not restated as a literal beside it.
    const expected = row.values["runoff-share"];
    expect(
      LENS_READERS.customValue({
        result: c,
        scenarioId: row.scenarioId,
        baseScenarioId: "S0",
        params: { metricId: "balance-summary", key: "runoff-share" },
      }),
    ).toEqual({ kind: "value", value: expected });
  });

  it("customValue is unobservable when the arm, the metric or the key on the row is absent", () => {
    const params = { metricId: "balance-summary", key: "runoff-share" };

    const noArm = LENS_READERS.customValue({ result, scenarioId: "S0", baseScenarioId: "S0", params });
    expect(noArm.kind).toBe("unobservable");
    if (noArm.kind !== "unobservable") return;
    expect(noArm.reason).toContain("the run named no stage producing it");

    const otherMetric = LENS_READERS.customValue({
      result: withCustom(),
      scenarioId: "S0",
      baseScenarioId: "S0",
      params: { metricId: "other-metric", key: "runoff-share" },
    });
    expect(otherMetric.kind).toBe("unobservable");
    if (otherMetric.kind !== "unobservable") return;
    expect(otherMetric.reason).toContain("other-metric");
    expect(otherMetric.reason).toContain("the run named no stage producing it");

    // A row that reports the balance and NOT the share: the metric could not
    // observe that number for that scenario, which is not a missing row.
    const c = withCustom();
    const second = c.eve.byScenario[1]!.scenarioId;
    const absentKey = LENS_READERS.customValue({
      result: c,
      scenarioId: second,
      baseScenarioId: "S0",
      params,
    });
    expect(absentKey.kind).toBe("unobservable");
    if (absentKey.kind !== "unobservable") return;
    expect(absentKey.reason).toContain("runoff-share");
    expect(absentKey.reason).toContain("this scenario");
  });

  it("customValue REFUSES an undeclared key and a scenario the metric carries no row for", () => {
    const c = withCustom();
    const undeclared = LENS_READERS.customValue({
      result: c,
      scenarioId: "S0",
      baseScenarioId: "S0",
      params: { metricId: "balance-summary", key: "no-such-key" },
    });
    expect(undeclared.kind).toBe("refusal");
    if (undeclared.kind !== "refusal") return;
    expect(undeclared.missing).toContain("no-such-key");

    c.custom!["balance-summary"]!.byScenario = c.custom!["balance-summary"]!.byScenario.slice(1);
    const noRow = LENS_READERS.customValue({
      result: c,
      scenarioId: "S0",
      baseScenarioId: "S0",
      params: { metricId: "balance-summary", key: "runoff-share" },
    });
    expect(noRow.kind).toBe("refusal");
    if (noRow.kind !== "refusal") return;
    expect(noRow.missing).toContain("S0");
  });

  /**
   * Both maps the reader indexes are plain objects, and "constructor" matches
   * CUSTOM_METRIC_ID_PATTERN, so V4 accepts a lens naming it. A plain index
   * would resolve it to an inherited member and the next line would throw,
   * which a reader is contracted never to do.
   */
  it("customValue does not read an inherited member for a prototype-named metricId", () => {
    const c = withCustom();
    let out: ReturnType<typeof LENS_READERS.customValue> | undefined;
    expect(() => {
      out = LENS_READERS.customValue({
        result: c,
        scenarioId: "S0",
        baseScenarioId: "S0",
        params: { metricId: "constructor", key: "runoff-share" },
      });
    }).not.toThrow();
    expect(out!.kind).toBe("unobservable");
    if (out!.kind !== "unobservable") return;
    expect(out!.reason).toContain("the run named no stage producing it");
  });
});
