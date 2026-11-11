/**
 * The flat-carry client-rate row. Every expected number is
 * RESTATED from the calculation spec (vectors 1, 2, 3, 4, 5, 8, 9a), never read
 * from the code under test. Decimal tolerance 1e-12 absolute; delta tolerance 1e-14.
 *
 * Flat continuous curve z: the forward semiannual par yield over any window is
 * 2(e^{z/2} - 1); the annual ACT/360 par rate is (e^z - 1) * 360/365.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MORTGAGE_DEFAULTS,
  Mortgage,
  assembleClientRate,
  flatCarry,
  rehydrateCurve,
  type CurveConvention,
  type RatePath,
  type ZeroCurve,
} from "@alm/kernel";
import type { AssumptionSet, OverlayBinding } from "../../contracts/assumptions";
import type { Scenario } from "../../contracts/scenario";
import { buildScenarioRatePath } from "../../projection/static/staticRunoff";
import { CLIENT_RATE_BENCHMARK_TENOR_YEARS, clientRateRow } from "../clientRate";
import { ClientRateBenchmarkError, RateDocumentError } from "../errors";
import * as rateDocumentModule from "../rateDocument";

const NODES_T = [0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];
const flatCurve = (z: number, convention: CurveConvention = "semiannual_bond"): ZeroCurve =>
  rehydrateCurve({ t: NODES_T, z: NODES_T.map(() => z), convention });

const binding = (familyId: string, totalSpreadBp: number): OverlayBinding => ({
  familyId,
  overlay: { kind: "loan-client-rate", model: "flat-carry", totalSpreadBp } as unknown as OverlayBinding["overlay"],
  modelVersion: "illustrative-flat-carry-1",
});
const setOf = (b: OverlayBinding): AssumptionSet => ({ schemaVersion: "1.0.0", id: "set-1", label: "s", bindings: [b] });

/** A stub RatePath whose 10Y forward is a fixed list. */
function stubPath(forward: number[]): RatePath {
  return {
    nSteps: forward.length,
    times: forward.map((_, k) => k / 12).concat([forward.length / 12]),
    rateAt: () => 0.03,
    forwardRateAt: (step: number) => forward[step]!,
  };
}

const row = (forward: number[], bp: number, familyId = "commercial-loans", scenarioId = "base") => {
  const b = binding(familyId, bp);
  return clientRateRow(setOf(b), b, stubPath(forward), flatCurve(0.04), forward.length, scenarioId);
};

const scenarioOf = (rateSpec: Scenario["rateSpec"]): Scenario => ({
  id: "sc",
  label: "sc",
  rateSpec,
  assumptionSetId: "set-1",
  newBusiness: { mode: "static", rules: [] },
});

function realRow(curve: ZeroCurve, rateSpec: Scenario["rateSpec"], bp: number, horizon: number) {
  const b = binding("mortgages", bp);
  const path = buildScenarioRatePath(curve, scenarioOf(rateSpec), horizon);
  return clientRateRow(setOf(b), b, path, curve, horizon, "sc");
}

describe("row arithmetic on a stub path (vectors 1, 2, 9a)", () => {
  it("benchmark [0.0400, 0.0410, 0.0425] with 175 bp gives [0.0575, 0.0585, 0.0600]", () => {
    const r = row([0.04, 0.041, 0.0425], 175);
    expect(r.benchmark).toEqual([0.04, 0.041, 0.0425]);
    expect(r.clientRate.length).toBe(3);
    const want = [0.0575, 0.0585, 0.06];
    want.forEach((w, k) => {
      expect(Math.abs(r.clientRate[k]! - w)).toBeLessThan(1e-12);
      expect(Math.abs(r.clientRate[k]! - r.benchmark[k]! - 0.0175)).toBeLessThan(1e-12);
    });
    expect(r.totalSpreadBp).toBe(175);
    expect(r.model).toBe("flat-carry");
    expect(r.assumptionSetId).toBe("set-1");
    expect(r.familyId).toBe("commercial-loans");
    expect(r.benchmarkTenorYears).toBe(10);
  });

  it("unit trap: B 0.0425 with 175 bp is 0.06, not 0.042675, 1.7925 or 0.017925", () => {
    const r = row([0.0425], 175);
    expect(Math.abs(r.clientRate[0]! - 0.06)).toBeLessThan(1e-12);
    for (const bug of [0.042675, 1.7925, 0.017925]) expect(Math.abs(r.clientRate[0]! - bug)).toBeGreaterThan(1e-3);
  });

  it("applies no floor: [-0.005, -0.03] with 175 bp gives [0.0125, -0.0125]", () => {
    const r = row([-0.005, -0.03], 175);
    expect(Math.abs(r.clientRate[0]! - 0.0125)).toBeLessThan(1e-12);
    expect(Math.abs(r.clientRate[1]! - -0.0125)).toBeLessThan(1e-12);
  });

  it("omits the selector key when the binding has none and copies it as stored when it has", () => {
    const plain = row([0.04], 100);
    expect("selector" in plain).toBe(false);
    const b: OverlayBinding = { ...binding("mortgages", 100), selector: { segment: ["retail"] } };
    const sel = clientRateRow(setOf(b), b, stubPath([0.04]), flatCurve(0.04), 1, "base");
    expect(sel.selector).toEqual({ segment: ["retail"] });
  });
});

describe("the kernel boundary and the missing point (vector 8)", () => {
  it("kernel layer alone: assembleClientRate([4.00, null, 4.25], [1.75, 1.75, 1.75]) = [5.75, null, 6.00]", () => {
    expect(flatCarry(1.75, 3)).toEqual([1.75, 1.75, 1.75]);
    expect(assembleClientRate([4.0, null, 4.25], [1.75, 1.75, 1.75])).toEqual([5.75, null, 6.0]);
  });

  it("row builder: a NaN benchmark at k = 1 throws ClientRateBenchmarkError naming month 2", () => {
    let err: unknown;
    try {
      row([0.04, Number.NaN, 0.0425], 175, "commercial-loans", "base");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ClientRateBenchmarkError);
    expect(err).toBeInstanceOf(RateDocumentError);
    expect(err).toBeInstanceOf(rateDocumentModule.RateDocumentError);
    const e = err as ClientRateBenchmarkError;
    expect(e.familyId).toBe("commercial-loans");
    expect(e.scenarioId).toBe("base");
    expect(e.month).toBe(2);
    expect(e.message).toContain("family commercial-loans");
    expect(e.message).toContain("scenario base");
    expect(e.message).toContain("month 2");
  });

  it("names the FIRST missing month when several are missing", () => {
    expect(() => row([0.04, 0.04, Number.POSITIVE_INFINITY, Number.NaN], 100)).toThrow(/month 3/);
  });
});

describe("real curves (vectors 3, 4, 5), flat z = 0.04", () => {
  it("semiannual_bond base: benchmark 0.0404026800535116, client 0.0579026800535116 at k = 0, 1, 12", () => {
    const r = realRow(flatCurve(0.04), { kind: "base" }, 175, 13);
    expect(r.curveConvention).toBe("semiannual_bond");
    expect(r.benchmark.length).toBe(13);
    expect(r.clientRate.length).toBe(13);
    for (const k of [0, 1, 12]) {
      expect(Math.abs(r.benchmark[k]! - 0.0404026800535116)).toBeLessThan(1e-12);
      expect(Math.abs(r.clientRate[k]! - 0.0579026800535116)).toBeLessThan(1e-12);
    }
  });

  it("Delta clientRate == Delta benchmark under +100 bp and -200 bp, and is not the nominal shock", () => {
    const base = realRow(flatCurve(0.04), { kind: "base" }, 175, 13);
    const up = realRow(flatCurve(0.04), { kind: "parallel", shockBp: 100 }, 175, 13);
    const dn = realRow(flatCurve(0.04), { kind: "parallel", shockBp: -200 }, 175, 13);
    expect(Math.abs(up.benchmark[0]! - 0.0506302410488577)).toBeLessThan(1e-12);
    expect(Math.abs(up.clientRate[0]! - 0.0681302410488577)).toBeLessThan(1e-12);
    expect(Math.abs(dn.benchmark[0]! - 0.0201003341683359)).toBeLessThan(1e-12);
    expect(Math.abs(dn.clientRate[0]! - 0.0376003341683359)).toBeLessThan(1e-12);
    for (const k of [0, 1, 12]) {
      const dUpB = up.benchmark[k]! - base.benchmark[k]!;
      const dUpC = up.clientRate[k]! - base.clientRate[k]!;
      expect(Math.abs(dUpB - 0.0102275609953462)).toBeLessThan(1e-12);
      expect(Math.abs(dUpC - dUpB)).toBeLessThanOrEqual(1e-14);
      expect(Math.abs(dUpC - 0.01)).toBeGreaterThan(1e-6);
      const dDnB = dn.benchmark[k]! - base.benchmark[k]!;
      const dDnC = dn.clientRate[k]! - base.clientRate[k]!;
      expect(Math.abs(dDnB - -0.0203023458851757)).toBeLessThan(1e-12);
      expect(Math.abs(dDnC - dDnB)).toBeLessThanOrEqual(1e-14);
      expect(Math.abs(dDnC - -0.02)).toBeGreaterThan(1e-6);
    }
  });

  it("annual_act360 runs without error and records its convention", () => {
    const r = realRow(flatCurve(0.04, "annual_act360"), { kind: "base" }, 175, 2);
    expect(r.curveConvention).toBe("annual_act360");
    expect(Math.abs(r.benchmark[0]! - 0.0402517224911226)).toBeLessThan(1e-12);
    expect(Math.abs(r.clientRate[0]! - 0.0577517224911226)).toBeLessThan(1e-12);
  });
});

describe("the benchmark tenor is the tenor the mortgage refinance incentive reads", () => {
  it("every tenorYears the kernel Mortgage asks the path for is 10 === CLIENT_RATE_BENCHMARK_TENOR_YEARS", () => {
    const seen = new Set<number>();
    const recording: RatePath = {
      nSteps: 360,
      times: Array.from({ length: 361 }, (_, k) => k / 12),
      rateAt: () => 0.04,
      forwardRateAt: (_step: number, tenorYears: number) => {
        seen.add(tenorYears);
        return 0.04;
      },
    };
    new Mortgage({ ...MORTGAGE_DEFAULTS }).generateCashflows(recording);
    expect(seen.size).toBeGreaterThan(0);
    for (const t of seen) {
      expect(t).toBe(10);
      expect(t).toBe(CLIENT_RATE_BENCHMARK_TENOR_YEARS);
    }
    expect(CLIENT_RATE_BENCHMARK_TENOR_YEARS).toBe(10);
  });
});

describe("module layout", () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("clientRate.ts never imports ./rateDocument", () => {
    expect(src("../clientRate.ts")).not.toMatch(/from\s+["']\.\/rateDocument["']/);
  });

  it("errors.ts imports nothing from rates/", () => {
    expect(src("../errors.ts")).not.toMatch(/from\s+["']\.\//);
  });

  it("no engine source this slice adds imports a kernel path naming fitted or Pins", () => {
    for (const rel of ["../clientRate.ts", "../errors.ts", "../rateDocument.ts"]) {
      expect(src(rel)).not.toMatch(/from\s+["'][^"']*(fitted|Pins)[^"']*["']/);
    }
  });

  it("loads in either order and keeps one RateDocumentError class", async () => {
    vi.resetModules();
    const rd1 = await import("../rateDocument");
    const cr1 = await import("../clientRate");
    const er1 = await import("../errors");
    expect(rd1.RateDocumentError).toBe(er1.RateDocumentError);
    expect(rd1.ClientRateBenchmarkError).toBe(er1.ClientRateBenchmarkError);
    expect(typeof cr1.clientRateRow).toBe("function");
    expect(new er1.ClientRateBenchmarkError("f", "s", 1)).toBeInstanceOf(rd1.RateDocumentError);

    vi.resetModules();
    const cr2 = await import("../clientRate");
    const rd2 = await import("../rateDocument");
    expect(typeof cr2.clientRateRow).toBe("function");
    expect(rd2.RateDocumentError).toBe((await import("../errors")).RateDocumentError);
  });
});
