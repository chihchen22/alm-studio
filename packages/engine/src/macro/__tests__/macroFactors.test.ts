// packages/engine/src/macro/__tests__/macroFactors.test.ts
import { describe, expect, it } from "vitest";
import { MACRO_SERIES_ID_PATTERN, monthAdd, validateMacroFactors } from "../macroFactors";
import { RATE_INDEX_ID_PATTERN } from "../../rateIndex/rateIndices";

const AS_OF = "2026-03";
const proj = (over: Record<string, unknown> = {}) => ({
  id: "hpi-flat", label: "House prices flat (authored projection)", kind: "index", role: "projection",
  unit: "ratio to 2026-03", firstMonth: "2026-04", values: new Array(360).fill(1),
  source: { authored: true, note: "Synthetic, authored for demonstration." }, ...over,
});
const hist = (over: Record<string, unknown> = {}) => ({
  id: "unrate", label: "Civilian unemployment rate (BLS via FRED)", kind: "rate", role: "history",
  unit: "decimal", firstMonth: "2025-09", values: [0.044, null, 0.045, 0.045, 0.044, 0.044, 0.043],
  source: { seriesId: "UNRATE", provider: "BLS via FRED", url: "https://fred.stlouisfed.org/graph/fredgraph.csv?id=UNRATE",
    retrievedOn: "2026-10-08", vintage: "FRED as retrieved 2026-10-08", endMonth: "2026-03",
    rawFileSha256: "621ff6fadf50910cb7a21ee20ba610c247cb043b29b4e05c4c1a72fadca2a06c", knownGaps: ["2025-10"] },
  ...over,
});
const texts = (b: unknown) => validateMacroFactors(b, AS_OF).map((p) => p.message);

describe("monthAdd", () => {
  it("steps across year ends both ways", () => {
    expect(monthAdd("2026-03", 1)).toBe("2026-04");
    expect(monthAdd("2025-12", 1)).toBe("2026-01");
    expect(monthAdd("1991-01", 422)).toBe("2026-03");
    expect(monthAdd("2026-01", -1)).toBe("2025-12");
  });
});

describe("validateMacroFactors", () => {
  it("the id grammar is the rate index grammar", () => {
    expect(MACRO_SERIES_ID_PATTERN.source).toBe(RATE_INDEX_ID_PATTERN.source);
  });
  it("accepts a projection and a history with its one known gap", () => {
    expect(texts([proj(), hist()])).toEqual([]);
  });
  it("refuses a null at a month the source does not list", () => {
    expect(texts([hist({ source: { ...hist().source, knownGaps: [] } })])).toEqual([
      "macroFactors[0].values[1]: 2025-10 is null; a history may carry null only at a month its source lists in knownGaps",
    ]);
  });
  it("refuses a listed gap that carries a value", () => {
    expect(texts([hist({ values: [0.044, 0.044, 0.045, 0.045, 0.044, 0.044, 0.043] })])).toEqual([
      "macroFactors[0].source.knownGaps: 2025-10 is listed as a gap the provider did not publish, but the series carries a value there",
    ]);
  });
  it("refuses null in a projection", () => {
    const v = new Array(360).fill(1); v[5] = null;
    expect(texts([proj({ values: v })])).toEqual(["macroFactors[0].values[5]: a projection carries a finite number every month; got null"]);
  });
  it("bounds an index projection to 0.25 to 4 and a rate to 0 to 1", () => {
    const v = new Array(360).fill(1); v[0] = 0.24;
    expect(texts([proj({ values: v })])).toEqual(["macroFactors[0].values[0]: an index projection lies from 0.25 to 4; got 0.24"]);
    expect(texts([hist({ values: [0.044, null, 1.5, 0.045, 0.044, 0.044, 0.043] })])).toEqual(["macroFactors[0].values[2]: a rate is a decimal from 0 to 1; got 1.5"]);
  });
  it("ties history to the as-of and projection to the month after", () => {
    expect(texts([hist({ firstMonth: "2025-08" })])).toContain("macroFactors[0]: a history ends at the market as-of month 2026-03; this one ends at 2026-02");
    expect(texts([proj({ firstMonth: "2026-03" })])).toEqual(["macroFactors[0].firstMonth: a projection starts the month after the as-of, 2026-04; got 2026-03"]);
  });
  it("refuses more than 8 series, duplicate ids and unknown keys", () => {
    const nine = Array.from({ length: 9 }, (_, i) => proj({ id: `s-${i}` }));
    expect(texts(nine)[0]).toBe("macroFactors: at most 8 series; got 9");
    expect(texts([proj(), proj()])).toEqual(['macroFactors: series id "hpi-flat" appears more than once']);
    expect(texts([{ ...proj(), extra: 1 }])).toEqual(['macroFactors[0]: unknown field "extra"; a series carries id, label, kind, role, unit, firstMonth, values and source']);
  });
  it("refuses a non-list", () => {
    expect(texts({})).toEqual(["macroFactors: expected a list of macro series"]);
  });
});
