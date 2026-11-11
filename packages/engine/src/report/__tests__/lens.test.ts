/**
 * The reading. Headroom and its basis, the three-way
 * status roll-up at scenario and lens level, the tie-break order, the scenario
 * filter, byte identity, and every refusal of Section 4.3 as a typed throw.
 *
 * The arithmetic assertions RESTATE the headroom formula from the envelope
 * field and the constraint's own limit rather than importing anything from the
 * module under test.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import type { LensDefinition } from "../../contracts/lens";
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
import { LensUnavailableError, readLens } from "../lens";

let result: RunResult;

beforeAll(async () => {
  const market: MarketSnapshot = await loadMarket();
  const book = viewSegmentedBook();
  const set = baseAssumptions("AS-LENS-READ");
  result = buildRunResult(
    makeRunRequest(market, {
      portfolioId: book.id,
      assumptionSets: [set],
      scenarios: regulatoryScenarios(set.id),
    }),
    book,
    resolveDefaultContext(),
  );
}, 180_000);

function clone(): RunResult {
  return JSON.parse(JSON.stringify(result)) as RunResult;
}

/** The scenario ids on the envelope, in envelope order: S0, S100, S-100, S200, S-200. */
function order(): string[] {
  return result.eve.byScenario.map((s) => s.scenarioId);
}

function evePct(scenarioId: string): number {
  return result.eve.byScenario.find((s) => s.scenarioId === scenarioId)!.deltaEvePct;
}

function lensWith(constraints: LensDefinition["constraints"]): LensDefinition {
  return { id: "probe-v1", label: "Probe", objective: "rate", constraints };
}

/** The typed refusal a call raises, so a case can assert on the message and not only on the class. */
function refusal(call: () => unknown): LensUnavailableError {
  try {
    call();
  } catch (e) {
    if (e instanceof LensUnavailableError) return e;
    throw e;
  }
  throw new Error("readLens answered where a typed refusal was expected");
}

describe("readLens", () => {
  it("atMost headroom is (limit - value) over |limit|, basis fraction", () => {
    const limit = 0.05;
    const lens = lensWith([{ id: "eve", reader: "deltaEvePct", op: "atMost", limit }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S100"] });
    const c = reading.byScenario[0].constraints[0];
    expect(c.value).toBe(evePct("S100"));
    expect(c.headroom).toBe((limit - evePct("S100")) / Math.abs(limit));
    expect(c.headroomBasis).toBe("fraction");
  });

  it("atLeast headroom is (value - limit) over |limit|, basis fraction", () => {
    const limit = -0.15;
    const lens = lensWith([{ id: "eve", reader: "deltaEvePct", op: "atLeast", limit }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S100"] });
    const c = reading.byScenario[0].constraints[0];
    expect(c.headroom).toBe((evePct("S100") - limit) / Math.abs(limit));
    expect(c.headroomBasis).toBe("fraction");
  });

  it("a zero limit leaves headroom absolute, because a fraction of zero is undefined", () => {
    const lens = lensWith([{ id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S0"] });
    const c = reading.byScenario[0].constraints[0];
    expect(c.value).toBe(0);
    expect(c.headroom).toBe(0);
    expect(c.headroomBasis).toBe("absolute");
  });

  it("a headroom of exactly zero is a pass, not a breach", () => {
    const lens = lensWith([{ id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S0"] });
    expect(reading.byScenario[0].constraints[0].status).toBe("pass");
    expect(reading.byScenario[0].status).toBe("pass");
    expect(reading.status).toBe("pass");
  });

  it("a scenario is breach if any constraint breaches, else pass if any passes, else unobservable", () => {
    const breach = readLens(
      result,
      lensWith([
        { id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 },
        { id: "eve", reader: "deltaEvePct", op: "atLeast", limit: 10 },
      ]),
      { baseScenarioId: "S0", scenarioIds: ["S100"] },
    );
    expect(breach.byScenario[0].constraints.map((c) => c.status)).toEqual(["pass", "breach"]);
    expect(breach.byScenario[0].status).toBe("breach");

    const mixed = readLens(
      result,
      lensWith([
        { id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08 },
        { id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 },
      ]),
      { baseScenarioId: "S0", scenarioIds: ["S100"] },
    );
    expect(mixed.byScenario[0].status).toBe("pass");

    const none = readLens(
      result,
      lensWith([{ id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08 }]),
      { baseScenarioId: "S0", scenarioIds: ["S100"] },
    );
    expect(none.byScenario[0].constraints[0].status).toBe("unobservable");
    expect(none.byScenario[0].constraints[0].value).toBeUndefined();
    expect(none.byScenario[0].constraints[0].headroom).toBeUndefined();
    expect(none.byScenario[0].headline).toBeUndefined();
    expect(none.byScenario[0].status).toBe("unobservable");
  });

  it("the lens rolls the same three ways up over scenarios and has no headline when none is observable", () => {
    const none = readLens(
      result,
      lensWith([{ id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08 }]),
      { baseScenarioId: "S0" },
    );
    expect(none.status).toBe("unobservable");
    expect(none.headline).toBeUndefined();
    expect(none.worst).toBeUndefined();
    expect(none.byScenario.map((s) => s.scenarioId)).toEqual(order());

    const breach = readLens(
      result,
      lensWith([{ id: "eve", reader: "deltaEvePct", op: "atLeast", limit: 10 }]),
      { baseScenarioId: "S0" },
    );
    expect(breach.status).toBe("breach");
  });

  it("a tie for the worst constraint resolves to the first in author order", () => {
    const lens = lensWith([
      { id: "first", reader: "deltaEvePct", op: "atLeast", limit: -0.15 },
      { id: "second", reader: "deltaEvePct", op: "atLeast", limit: -0.15 },
    ]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S100"] });
    const [a, b] = reading.byScenario[0].constraints;
    expect(a.headroom).toBe(b.headroom);
    expect(reading.byScenario[0].worstConstraintId).toBe("first");
  });

  it("a tie for the worst scenario resolves to the first in envelope order", () => {
    // shortfallCount is 0 on every static scenario, so with a limit of 1 every
    // scenario's headroom is (1 - 0) / 1 = 1 and every headline ties there.
    // RE-PINNED for piece 3b ruling 5: the limit was 0, which is ABSOLUTE
    // basis and no longer sets a headline at all, so the tie is now stated on a
    // fraction-basis constraint. The tie-break rule itself did not change.
    const lens = lensWith([{ id: "sf", reader: "shortfallCount", op: "atMost", limit: 1 }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0" });
    expect(new Set(reading.byScenario.map((s) => s.headline))).toEqual(new Set([1]));
    expect(reading.worst).toEqual({ scenarioId: order()[0], constraintId: "sf" });
    expect(reading.headline).toBe(1);
  });

  /**
   * The headline is a comparison across constraints,
   * and a currency or count slack is not comparable with a fraction of a limit,
   * so only fraction-basis constraints set it. Absolute-basis constraints keep
   * their value, their headroom and their status.
   */
  it("an absolute-basis constraint drives status and never sets the headline", () => {
    const lens = lensWith([
      { id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 },
      { id: "eve", reader: "deltaEvePct", op: "atLeast", limit: -0.15 },
    ]);
    const reading = readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["S100"] });
    const scenario = reading.byScenario[0]!;
    const [sf, eve] = scenario.constraints;

    expect(sf!.headroomBasis).toBe("absolute");
    expect(sf!.headroom).toBe(0);
    expect(sf!.status).toBe("pass");
    expect(eve!.headroomBasis).toBe("fraction");

    // RESTATED from the envelope field and the constraint's own limit.
    const expected = (evePct("S100") - -0.15) / Math.abs(-0.15);
    expect(eve!.headroom).toBe(expected);
    expect(scenario.headline).toBe(expected);
    expect(scenario.worstConstraintId).toBe("eve");
    expect(reading.headline).toBe(expected);
    expect(reading.worst).toEqual({ scenarioId: "S100", constraintId: "eve" });
  });

  it("a lens with only absolute-basis constraints has no headline and still rolls up status", () => {
    const lens = lensWith([{ id: "sf", reader: "shortfallCount", op: "atMost", limit: 0 }]);
    const reading = readLens(result, lens, { baseScenarioId: "S0" });
    const scenario = reading.byScenario[0]!;
    expect(scenario.constraints[0]!.status).toBe("pass");
    expect(scenario.constraints[0]!.headroom).toBe(0);
    expect(scenario.headline).toBeUndefined();
    expect(scenario.worstConstraintId).toBeUndefined();
    expect(scenario.status).toBe("pass");
    expect(reading.headline).toBeUndefined();
    expect(reading.worst).toBeUndefined();
    expect(reading.status).toBe("pass");
  });

  it("scenarioIds restricts the reading and keeps envelope order, not the caller's order", () => {
    const lens = lensWith([{ id: "eve", reader: "deltaEvePct", op: "atLeast", limit: -0.15 }]);
    const reading = readLens(result, lens, {
      baseScenarioId: "S0",
      scenarioIds: ["S-100", "S100"],
    });
    const expected = order().filter((id) => id === "S100" || id === "S-100");
    expect(reading.byScenario.map((s) => s.scenarioId)).toEqual(expected);
  });

  it("two readings are byte-identical and key order follows the interfaces", () => {
    const lens = lensWith([
      { id: "eve", reader: "deltaEvePct", op: "atLeast", limit: -0.15 },
      { id: "cet1", reader: "capitalRatio", op: "atLeast", limit: 0.08 },
    ]);
    const q = { baseScenarioId: "S0" };
    expect(JSON.stringify(readLens(result, lens, q))).toBe(
      JSON.stringify(readLens(result, lens, q)),
    );
    const reading = readLens(result, lens, q);
    expect(Object.keys(reading)).toEqual([
      "lensId",
      "objective",
      "baseScenarioId",
      "byScenario",
      "headline",
      "worst",
      "status",
    ]);
    expect(Object.keys(reading.byScenario[0])).toEqual([
      "scenarioId",
      "constraints",
      "headline",
      "worstConstraintId",
      "status",
    ]);
    expect(Object.keys(reading.byScenario[0].constraints[0])).toEqual([
      "constraintId",
      "reader",
      "op",
      "limit",
      "value",
      "headroom",
      "headroomBasis",
      "status",
    ]);
    expect(Object.keys(reading.byScenario[0].constraints[1])).toEqual([
      "constraintId",
      "reader",
      "op",
      "limit",
      "status",
      "reason",
    ]);
  });

  it("refuses a base scenario and a requested scenario the envelope does not carry", () => {
    const lens = lensWith([{ id: "eve", reader: "deltaEvePct", op: "atLeast", limit: -0.15 }]);
    const base = refusal(() => readLens(result, lens, { baseScenarioId: "SNOPE" }));
    expect(base.message).toContain("SNOPE");
    expect(base.message).toContain("base scenario");

    const asked = refusal(() =>
      readLens(result, lens, { baseScenarioId: "S0", scenarioIds: ["SGHOST"] }),
    );
    expect(asked.message).toContain("SGHOST");
    expect(asked.lensId).toBe("probe-v1");
  });

  it("refuses an invalid definition and a block the envelope does not carry", () => {
    const invalid = refusal(() =>
      readLens(result, { ...lensWith([]), constraints: [] }, { baseScenarioId: "S0" }),
    );
    expect(invalid.message).toContain("V2");

    const c = clone();
    c.gap.liquidity = [];
    const missing = refusal(() =>
      readLens(
        c,
        lensWith([
          {
            id: "cum-gap-1m",
            reader: "cumulativeLiquidityGap",
            params: { band: "0-1M" },
            op: "atLeast",
            limit: -50000000,
          },
        ]),
        { baseScenarioId: "S0" },
      ),
    );
    expect(missing.message).toContain("liquidity ladder");
    expect(missing.message).toContain("cum-gap-1m");
  });
});
