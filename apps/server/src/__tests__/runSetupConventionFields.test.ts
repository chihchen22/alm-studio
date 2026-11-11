/**
 * The schema 1.9.0 run-setup fields and the SEG knobs, on a synthetic setup built from
 * Standard ALCO: `nmdConvention`, `nmdWarmup`, `seg` (with and without the knobs), `liquidityStress`,
 * `eve.discountBasis`, `gap.nextReset` and `instrumentResults`. Each is optional and left out when absent, so
 * an older setup keeps its bytes and its id; a setup that names one round-trips through the parse gate and compiles to
 * the engine options its launch submits, and the run route stores the SEG knobs with their known keys only. Every
 * expected value is restated here, not read back from the code under test.
 */
import { describe, expect, it } from "vitest";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import { resolveEngineOptions } from "../http/routes/runs";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { engineOptionsOfSetup, instrumentResultsOfSetup } from "../workspaces/setupCompile";
import { runSetupIdOf, standardAlcoSetup } from "../workspaces/standardAlco";
import type { RunSetup } from "../workspaces/types";

/** A synthetic stress table, round illustrative values. */
const STRESS = {
  table: {
    bau: { hysOutflowMonthly: 0.004, wholesaleRenewal: 1, nibOutflowMonthly: 0.001, drawRate: 0 },
    moderate: { hysOutflowMonthly: 0.04, wholesaleRenewal: 0.6, nibOutflowMonthly: 0.008, drawRate: 0.12 },
    severe: { hysOutflowMonthly: 0.08, wholesaleRenewal: 0.2, nibOutflowMonthly: 0.015, drawRate: 0.25 },
  },
  buffer: 1_000_000_000,
  undrawnFace: 250_000_000,
};

const WARMUP = { kind: "flat-at-r0" as const, months: 36, shiftPctByScenario: { "SRP-SUP": 3, "SRP-STEEP": -1.95 } };

function alco(): Omit<RunSetup, "id"> {
  const { id: _id, ...s } = standardAlcoSetup("ws-example");
  return JSON.parse(JSON.stringify(s)) as Omit<RunSetup, "id">;
}

/** Standard ALCO with every new field set, in the order the parse writes them: the new fields before the four bookkeeping fields. */
function fullSetup(): Omit<RunSetup, "id"> {
  const { batch, importedFrom, supersedes, note, ...s } = alco();
  return {
    ...s,
    eve: { ...s.eve, discountBasis: "spread-consistent", keyRate: true },
    gap: { ...s.gap, nextReset: true },
    instrumentResults: { save: true },
    nmdConvention: "regulatory",
    nmdWarmup: WARMUP,
    seg: { enabled: true },
    liquidityStress: JSON.parse(JSON.stringify(STRESS)),
    batch,
    importedFrom,
    supersedes,
    note,
  };
}

const refused = (mutate: (s: Record<string, any>) => void): string => {
  const s = JSON.parse(JSON.stringify(fullSetup())) as Record<string, any>;
  mutate(s);
  try {
    parseRunSetup(s);
  } catch (e) {
    return (e as Error).message;
  }
  return "ACCEPTED";
};

describe("parseRunSetup: the schema 1.9.0 fields on a synthetic setup", () => {
  it("round-trips a setup carrying every new field, byte for byte", () => {
    expect(JSON.stringify(parseRunSetup(JSON.parse(JSON.stringify(fullSetup()))))).toBe(JSON.stringify(fullSetup()));
  });

  it("leaves every new field out when absent, so Standard ALCO keeps its bytes and its id", () => {
    const { id, ...body } = standardAlcoSetup("ws-example");
    const parsed = parseRunSetup(JSON.parse(JSON.stringify(body)));
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(body));
    expect(runSetupIdOf(parsed)).toBe(id);
    for (const key of ["nmdConvention", "nmdWarmup", "seg", "liquidityStress"]) expect(key in parsed).toBe(false);
    expect("nextReset" in parsed.gap).toBe(false);
  });

  it("refuses unknown values with a sentence naming the field", () => {
    expect(refused((s) => { s.nmdConvention = "core"; })).toBe(`nmdConvention: expected one of "behavioral", "regulatory", "shocked-level", got "core"`);
    expect(refused((s) => { s.nmdWarmup = { kind: "kernel", months: 36 }; })).toBe(`nmdWarmup.kind must be "flat-at-r0" or "history", got "kernel"`);
    expect(refused((s) => { s.seg = true; })).toBe("seg: expected an object");
    expect(refused((s) => { s.gap.nextReset = "yes"; })).toBe("gap.nextReset: expected true or false");
    expect(refused((s) => { s.liquidityStress.table.severe.drawRate = 1.5; })).toMatch(/^liquidityStress\.table\.severe\.drawRate must be a decimal in \[0, 1\], got 1\.5$/);
    expect(refused((s) => { s.eve.discountBasis = "par"; })).toMatch(/^eve\.discountBasis: expected one of "all-in", "risk-free", "spread-consistent", got "par"$/);
    expect(refused((s) => { s.instrumentResults = { save: true, coaNodeIds: [] }; })).toMatch(/^instrumentResults\.coaNodeIds: expected at least one chart of account node when save is true$/);
  });

  it("drops a key the liquidity stress block does not know, as the parse drops any unknown key", () => {
    const s = JSON.parse(JSON.stringify(fullSetup())) as Record<string, any>;
    s.liquidityStress.horizonMonths = 12;
    s.liquidityStress.table.bau.extra = 1;
    expect(JSON.stringify(parseRunSetup(s))).toBe(JSON.stringify(fullSetup()));
  });
});

describe("engine options of a setup", () => {
  it("adds each new option to Standard ALCO's own options, and only while it is not the default", () => {
    const base = engineOptionsOfSetup(alco());
    expect(engineOptionsOfSetup(fullSetup())).toEqual({
      ...base,
      keyRate: true,
      discountBasis: "spread-consistent",
      nmdConvention: "regulatory",
      nmdWarmup: WARMUP,
      seg: true,
      nextResetGap: true,
      liquidityStress: STRESS,
    });
    expect(instrumentResultsOfSetup(fullSetup())).toEqual({ save: true });
    expect(instrumentResultsOfSetup(alco())).toBeUndefined();
    const off = fullSetup();
    const offOptions = engineOptionsOfSetup({ ...off, nmdConvention: "behavioral", seg: { enabled: false }, gap: { ...off.gap, nextReset: false } });
    expect("nmdConvention" in offOptions || "seg" in offOptions || "nextResetGap" in offOptions).toBe(false);
  });
});

describe("the SEG knobs on a synthetic setup and through the run route", () => {
  const KNOBS = { enabled: true, shockBp: 25, horizonMonths: 720, niiShockBp: 25, cprOverlay: [{ familyId: "MORTGAGE", upAnnualCpr: 0.09, downAnnualCpr: 0.14 }] };

  it("a setup with the knobs round-trips byte for byte; one without them submits no segSettings", () => {
    const s = { ...fullSetup() };
    s.seg = KNOBS;
    expect(JSON.stringify(parseRunSetup(JSON.parse(JSON.stringify(s))))).toBe(JSON.stringify(s));
    expect(engineOptionsOfSetup(fullSetup()).segSettings).toBeUndefined();
  });

  it("the knobs reach the launch body only while the SEG block is on", () => {
    const { enabled: _e, ...knobs } = KNOBS;
    expect(engineOptionsOfSetup({ ...fullSetup(), seg: KNOBS }).segSettings).toEqual(knobs);
    expect(engineOptionsOfSetup({ ...fullSetup(), seg: { ...KNOBS, enabled: false } }).segSettings).toBeUndefined();
  });

  it("refuses a malformed knob by name", () => {
    const refusal = (seg: unknown): string => {
      try {
        parseRunSetup({ ...fullSetup(), seg });
      } catch (e) {
        return (e as Error).message;
      }
      return "ACCEPTED";
    };
    expect(refusal({ enabled: true, shockBp: 0 })).toMatch(/seg\.shockBp must be/);
    expect(refusal({ enabled: true, horizonMonths: 1000 })).toMatch(/seg\.horizonMonths must be/);
    expect(refusal({ enabled: true, size: 25 })).toMatch(/seg\.size is not a SEG setting/);
  });

  it("the run route stores engineOptions.segSettings with its known keys, hands it to the pipeline, and refuses it without seg", () => {
    const stored = resolveEngineOptions({ seg: true, segSettings: { shockBp: 25, horizonMonths: 720 } }, 360);
    expect(stored.segSettings).toEqual({ shockBp: 25, horizonMonths: 720 });
    expect(pipelineOptionsOf(stored).segSettings).toEqual({ shockBp: 25, horizonMonths: 720 });
    const plain = resolveEngineOptions({ seg: true }, 360);
    expect("segSettings" in plain).toBe(false);
    expect(() => resolveEngineOptions({ segSettings: { shockBp: 25 } }, 360)).toThrow(/send it with engineOptions\.seg: true/);
    expect(() => resolveEngineOptions({ seg: true, segSettings: { shockBp: "25" } }, 360)).toThrow(/engineOptions\.segSettings\.shockBp must be/);
  });
});
