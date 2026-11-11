/**
 * Studio slice S2b-2 on the platform: behavioral templates on the run setup, the two opt-in views, and the
 * New volume step's preview of the behavior each new tranche carries.
 *
 *  - a deposit template and a behavioral loan template round-trip through the setup parser; a deposit at a spread,
 *    and "decay" on a loan, are refused by the engine's own rule, naming the row;
 *  - `eve.goingConcern` and `gap.forecast` compile to their engine options only when on, and an earlier setup keeps
 *    its bytes; the run route hands them to the pipeline and refuses them on a stochastic run;
 *  - a deposit template on a family that is not a deposit is refused at compile;
 *  - the preview names each family's effective model (from the saved set or the positions' values) and, on the
 *    example book, draws a mortgage tranche's CPR by month (checked against the model's definition at age 0: the
 *    seasoning ramp) and a new deposit's balance left by month (decaying, starting at 100).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AssumptionSet, PortfolioSpec, NewVolumeTemplateSpec } from "@alm/engine";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { newVolumePreview } from "../http/routes/newVolumePreview";
import { resolveEngineOptions } from "../http/routes/runs";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import { FileStore } from "../store/store";
import { parseRunSetup } from "../workspaces/runSetupParse";
import { engineOptionsOfSetup } from "../workspaces/setupCompile";
import { standardAlcoSetup } from "../workspaces/standardAlco";
import type { RunSetup } from "../workspaces/types";
import { api, bootTestPlatform, type TestPlatform } from "./harness";
import type { RunRequest } from "@alm/engine";
import { resolveDefaultContext } from "@alm/engine/src/run/engine";
import { buildRunResult } from "@alm/engine/src/run/orchestrate";

function alco(): Omit<RunSetup, "id"> {
  const { id: _id, ...s } = standardAlcoSetup("ws-s2b2");
  return s;
}

const DEPOSIT: NewVolumeTemplateSpec = { familyId: "ex-savings", rateType: "deposit", amortization: "decay", indexTenorMonths: 1, behavior: "family", termMonths: 360, spreadOverIndexBp: 0 };
const MORTGAGE: NewVolumeTemplateSpec = { familyId: "ex-mortgages", rateType: "fixed", amortization: "level-pay", indexTenorMonths: 360, fixedIndex: "matched", behavior: "family", termMonths: 360, spreadOverIndexBp: 0 };

describe("behavioral templates on the run setup", () => {
  it("a deposit template and a behavioral loan template round-trip; an S2b-1 template keeps its bytes", () => {
    const s = alco();
    const withT = { ...s, nii: { ...s.nii, templates: [MORTGAGE, DEPOSIT] } };
    expect(parseRunSetup(withT).nii.templates).toEqual([MORTGAGE, DEPOSIT]);
    const s2b1 = { ...s, nii: { ...s.nii, templates: [{ familyId: "x", rateType: "fixed" as const, amortization: "bullet" as const, indexTenorMonths: 60, fixedIndex: "swap" as const, termMonths: 60, spreadOverIndexBp: 0 }] } };
    expect(JSON.stringify(parseRunSetup(s2b1))).toBe(JSON.stringify(s2b1));
  });

  it("refuses a deposit at a spread, a loan that decays, and an unknown behavior, naming the row", () => {
    const s = alco();
    const at = (t: object) => ({ ...s, nii: { ...s.nii, templates: [t] } });
    expect(() => parseRunSetup(at({ ...DEPOSIT, spreadOverIndexBp: 25 }))).toThrow(/nii\.templates\[0\].*spread is 0 basis points/);
    expect(() => parseRunSetup(at({ ...MORTGAGE, amortization: "decay" }))).toThrow(/nii\.templates\[0\].*deposit template/);
    expect(() => parseRunSetup(at({ ...MORTGAGE, behavior: "always" }))).toThrow(/nii\.templates\[0\]\.behavior/);
    expect(() => parseRunSetup(at({ ...DEPOSIT, behavior: undefined }))).toThrow(/behavior "family"/);
  });

  it("the two views compile to engine options only when on, and the pipeline reads them", () => {
    const s = alco();
    const off = engineOptionsOfSetup(s);
    expect("goingConcernEve" in off || "forecastGap" in off).toBe(false);
    expect(JSON.stringify(parseRunSetup(s))).toBe(JSON.stringify(s));
    const on = { ...s, eve: { ...s.eve, goingConcern: true }, gap: { ...s.gap, forecast: true } };
    const parsed = parseRunSetup(on);
    expect(parsed.eve.goingConcern).toBe(true);
    expect(parsed.gap.forecast).toBe(true);
    const o = engineOptionsOfSetup(parsed);
    expect(o.goingConcernEve).toBe(true);
    expect(o.forecastGap).toBe(true);
    const { goingConcernEve: _g, forecastGap: _f, ...rest } = o;
    expect(rest).toEqual(off);
    const stored = resolveEngineOptions({ goingConcernEve: true, forecastGap: true }, 360);
    expect(pipelineOptionsOf(stored)).toMatchObject({ goingConcernEve: true, forecastGap: true });
    expect("goingConcernEve" in pipelineOptionsOf(resolveEngineOptions({}, 360))).toBe(false);
    expect(() => resolveEngineOptions({ goingConcernEve: "yes" as unknown as boolean }, 360)).toThrow(/goingConcernEve must be a boolean/);
  });
});

describe("the run route", () => {
  let t: TestPlatform;
  beforeAll(async () => {
    t = await bootTestPlatform();
    await seedStore(new FileStore(t.storeRoot), repoRoot());
  }, 120_000);
  afterAll(() => t.close());
  it("refuses the forecast gap and going-concern EVE on a stochastic run", async () => {
    for (const key of ["forecastGap", "goingConcernEve"]) {
      const r = await api<{ error: { message: string } }>(t.base, "POST", "/api/runs", { portfolioId: "p", marketId: "m", scenarioSlateId: "s", assumptionSetIds: ["a"], mode: "stochastic", engineOptions: { [key]: true } });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(new RegExp(`engineOptions\\.${key} applies to a deterministic run only`));
    }
  });
});

describe("the New volume step's preview of behavior", () => {
  let market: MarketSnapshot;
  const book = JSON.parse(readFileSync(join(repoRoot(), "examples", "example-book-v1.json"), "utf8")) as PortfolioSpec;
  beforeAll(async () => { market = await loadMarketSnapshot(join(repoRoot(), "packages", "kernel", "public", "market_public.json")); });

  it("names each family's model: the positions' own values without a set, the set's binding with one", () => {
    const own = newVolumePreview(book, market, [], null, 60, null);
    const m = (id: string, p = own) => p.families.find((f) => f.familyId === id)!.model;
    expect(m("ex-mortgages")).toMatchObject({ model: "four-factor-cpr", source: "position", modelVersions: [] });
    expect(m("ex-savings")).toMatchObject({ model: "nmd-decay-beta", source: "position" });
    expect(m("ex-checking")).toMatchObject({ model: "nmd-decay", source: "position" });
    expect(m("ex-term-loans")).toMatchObject({ model: "none", source: "none", reason: expect.stringMatching(/no prepayment model/) });
    expect(m("ex-floaters").model).toBe("none");
    const cpr = { ...(book.positions.find((p) => p.familyId === "ex-mortgages")!.terms as unknown as { cprParams: Record<string, number> }).cprParams, seasoningRamp: 12 };
    const set: AssumptionSet = { schemaVersion: "1.0.0", id: "g", label: "g", bindings: [{ familyId: "ex-mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: cpr as never }, modelVersion: "guided-v9" }] };
    const withSet = newVolumePreview(book, market, [], null, 60, set);
    expect(m("ex-mortgages", withSet)).toMatchObject({ model: "four-factor-cpr", source: "assumption-set", modelVersions: ["guided-v9"] });
  });

  it("draws a mortgage tranche's CPR by month, seasoned from age 0, and a new deposit's balance left by month", () => {
    const p = newVolumePreview(book, market, [MORTGAGE, DEPOSIT], null, 60, null);
    expect(p.problems).toEqual([]);
    const mort = p.families.find((f) => f.familyId === "ex-mortgages")!.preview!;
    expect(mort.behavior).toMatchObject({ model: "four-factor-cpr", applied: true, source: "position" });
    const c = mort.cprByMonth!;
    expect(c).toHaveLength(360);
    // The curve drawn is the CPR the tranche's own balances imply, month by month: with B the balance at the start of
    // month m, the note rate c / 12 and the remaining term n, the scheduled principal is B c / ((1 + c)^n - 1), the
    // prepaid principal is the rest of the fall in balance, SMM = prepaid / (B - scheduled), CPR = 1 - (1 - SMM)^12.
    const c12 = mort.couponRate / 12;
    for (let m = 1; m <= 36; m++) {
      const b = mort.months[m - 1]!.balance;
      const next = mort.months[m]!.balance;
      const scheduled = b * (c12 / (Math.pow(1 + c12, 360 - m + 1) - 1));
      const smm = (b - next - scheduled) / (b - scheduled);
      expect(Math.abs(1 - Math.pow(1 - smm, 12) - c[m - 1]!)).toBeLessThan(1e-9);
    }
    // Seasoned from age 0: the first month prepays at a fraction of the speed it reaches after the ramp.
    const ramp = (book.positions.find((x) => x.familyId === "ex-mortgages")!.terms as unknown as { cprParams: { seasoningRamp: number } }).cprParams.seasoningRamp;
    expect(c[0]!).toBeLessThan(c[ramp - 1]! / 2);
    const dep = p.families.find((f) => f.familyId === "ex-savings")!.preview!;
    expect(dep.behavior).toMatchObject({ model: "nmd-decay-beta", applied: true });
    expect(dep.months[0]!.balance).toBeCloseTo(100, 10);
    for (let m = 1; m < 24; m++) expect(dep.months[m]!.balance).toBeLessThan(dep.months[m - 1]!.balance);
    expect(dep.cprByMonth).toBeUndefined();
  });

  it("a deposit product on a loan family is a problem in a sentence, not a preview", () => {
    const p = newVolumePreview(book, market, [{ ...DEPOSIT, familyId: "ex-term-loans" }], null, 60, null);
    expect(p.problems.join(" ")).toMatch(/Fixed-Rate Term Loans: a deposit product needs a deposit family's decay model/);
    expect(p.families.find((f) => f.familyId === "ex-term-loans")!.preview).toBeUndefined();
  });
});

describe("fix round M3: a deposit family on a form new deposits cannot carry opens on the stand-in, and the guided run runs", () => {
  let market: MarketSnapshot;
  const book = JSON.parse(readFileSync(join(repoRoot(), "examples", "example-book-v1.json"), "utf8")) as PortfolioSpec;
  beforeAll(async () => { market = await loadMarketSnapshot(join(repoRoot(), "packages", "kernel", "public", "market_public.json")); });
  const sCurve = (book.positions.find((p) => p.familyId === "ex-savings")!.terms as unknown as { sCurve: Record<string, number> }).sCurve;
  const FULL = { alphaPct: 0.1, deltaUp: 0.2, deltaDown: 0.1, volRatio: 1, baseShortRatePct: 3.6, baseLastMove: "rise", balances: "flat" };
  const fullSet: AssumptionSet = { schemaVersion: "1.0.0", id: "full", label: "full", bindings: [{ familyId: "ex-savings", overlay: { kind: "deposit-beta", params: sCurve, fullForm: FULL } as never, modelVersion: "full-v1" }] };

  it("the preview suggests nothing for it (today's stand-in) and says why in one sentence; a deposit product on it is a problem", () => {
    const p = newVolumePreview(book, market, [], null, 60, fullSet);
    const sav = p.families.find((f) => f.familyId === "ex-savings")!;
    expect(sav.suggested).toBeNull();
    expect(sav.model).toMatchObject({ model: "none", reason: "new deposits of Money Market and Savings cannot carry its full beta form yet, so its new volume is the fixed-rate stand-in" });
    // The other deposit family keeps its deposit product.
    expect(p.families.find((f) => f.familyId === "ex-checking")!.suggested!.template.rateType).toBe("deposit");
    // The full beta form runs on run-off scenarios only, so the step says no plan that replaces balances can run on it.
    const runOff = "Money Market and Savings: its full beta form runs on run-off only, so balances cannot be replaced or follow targets while it is bound; choose \"They run off\", or bind another deposit model on the Behavior step.";
    expect(p.problems).toEqual([runOff]);
    const refused = newVolumePreview(book, market, [{ ...DEPOSIT, familyId: "ex-savings" }], null, 60, fullSet);
    expect(refused.problems).toEqual([runOff, "Money Market and Savings: new deposits of Money Market and Savings cannot carry its full beta form yet; choose Fixed rate to use the stand-in."]);
  });

  it("on a deposit form the run does carry dynamically (a linear decay), the products a new guided setup opens on run end to end", () => {
    // Non-interest checking runs off in a straight line over its 360 months: a form new deposits do not carry yet, so the
    // family opens on the stand-in, and nothing stops a plan that replaces balances.
    const linear: PortfolioSpec = { ...book, positions: book.positions.map((q) => (q.familyId === "ex-checking" ? { ...q, terms: { ...q.terms, linearDecay: { horizonMonths: 360 } } as typeof q.terms } : q)) };
    const p = newVolumePreview(linear, market, [], null, 60, null);
    expect(p.problems).toEqual([]);
    const chk = p.families.find((f) => f.familyId === "ex-checking")!;
    expect(chk.suggested).toBeNull();
    expect(chk.model.reason).toBe("new deposits of Non-Interest Checking cannot carry its linear decay form yet, so its new volume is the fixed-rate stand-in");
    // As the Studio saves them: each suggested product, the stand-in (no template) where none is suggested.
    const templates: NewVolumeTemplateSpec[] = p.families.filter((f) => f.suggested !== null).map((f) => ({ familyId: f.familyId, ...f.suggested!.template, termMonths: f.suggested!.termMonths, spreadOverIndexBp: 0 }) as NewVolumeTemplateSpec);
    expect(templates.some((t) => t.familyId === "ex-checking")).toBe(false);
    // The guided compile sets each family's template on its flat rule (compilePlan's template step); the request is
    // written here the same way, every family flat, the ones without a product on today's bullet.
    const byFamily = new Map(templates.map((t) => [t.familyId, t] as const));
    const rules = p.families.map((f) => {
      const t = byFamily.get(f.familyId);
      if (t === undefined) return { familyId: f.familyId, reinvest: "flat" as const, termMonths: 60, spreadOverIndexBp: 0 };
      const { familyId, termMonths, spreadOverIndexBp, ...template } = t;
      return { familyId, reinvest: "flat" as const, termMonths, spreadOverIndexBp, template };
    });
    const set: AssumptionSet = { schemaVersion: "1.0.0", id: "AS-M3", label: "none", bindings: [] };
    const request: RunRequest = {
      runId: "RUN-M3", portfolioId: linear.id, marketSnapshot: market, seed: "1",
      scenarios: [
        { id: "S0", label: "Base", rateSpec: { kind: "base" }, assumptionSetId: set.id, newBusiness: { mode: "dynamic", rules } },
        { id: "S100", label: "+100", rateSpec: { kind: "parallel", shockBp: 100 }, assumptionSetId: set.id, newBusiness: { mode: "dynamic", rules } },
      ],
      assumptionSets: [set], grid: { horizonMonths: 360, asOf: book.asOf },
      timestamps: { startedAt: "2026-11-03T00:00:00.000Z", finishedAt: "2026-11-03T00:00:01.000Z" },
    };
    const r = buildRunResult(request, linear, { ...resolveDefaultContext(), discountBasis: "risk-free", goingConcernEve: true, forecastGap: true });
    expect(r.eve.goingConcern!.byScenario.length).toBe(2);
    const nb = r.nii.byScenario[0]!.newBusiness!;
    expect(nb.find((n) => n.familyId === "ex-checking")!.product).toMatchObject({ source: "fixed-bullet" });
    expect(nb.find((n) => n.familyId === "ex-savings")!.product).toMatchObject({ rateType: "deposit", behavior: { applied: true } });
  }, 300_000);
});

describe("fix round L1: the preview reads the run's macro mapping", () => {
  let market: MarketSnapshot;
  const book = JSON.parse(readFileSync(join(repoRoot(), "examples", "example-book-v1.json"), "utf8")) as PortfolioSpec;
  beforeAll(async () => { market = await loadMarketSnapshot(join(repoRoot(), "packages", "kernel", "public", "market_public.json")); });
  it("a mortgage family mapped to a house-price path reads no model in the preview, as its new volume runs in the run", () => {
    const cpr = (book.positions.find((p) => p.familyId === "ex-mortgages")!.terms as unknown as { cprParams: Record<string, number> }).cprParams;
    const H = { asOfLtv: 0.7, refiLtvMid: 0.97, refiLtvSlope: 20, turnoverLtvMid: 1, turnoverLtvSlope: 10, turnoverFloorShare: 0.75, turnoverCprFloor: 1.5 };
    const mapped: AssumptionSet = {
      schemaVersion: "1.0.0", id: "hpi", label: "hpi",
      bindings: [{ familyId: "ex-mortgages", overlay: { kind: "prepay", model: "four-factor-cpr", params: cpr, housing: H } as never, modelVersion: "hpi-v1" }],
      macroBindings: [{ seriesId: "hpi-down-30", feeder: "prepay-housing", familyId: "ex-mortgages" }] as never,
    };
    const m = newVolumePreview(book, market, [MORTGAGE], null, 60, mapped);
    const mort = m.families.find((f) => f.familyId === "ex-mortgages")!;
    expect(mort.model).toMatchObject({ model: "none", reason: expect.stringMatching(/house-price path/) });
    expect(mort.preview!.behavior).toMatchObject({ applied: false });
    expect(mort.preview!.cprByMonth).toBeUndefined();
    // Unmapped, the same binding runs its four-factor model.
    const { macroBindings: _m, ...unmapped } = mapped;
    expect(newVolumePreview(book, market, [MORTGAGE], null, 60, unmapped as AssumptionSet).families.find((f) => f.familyId === "ex-mortgages")!.model.model).toBe("four-factor-cpr");
  });
});

describe("ruling 2026-11-03: the going-concern span on the setup, 12 months by default, never past the earnings horizon", () => {
  it("is absent by default, extends to the earnings horizon, and is refused past it in one sentence", () => {
    const s = alco();
    expect(s.nii.horizonMonths).toBe(60);
    // Absent: no span is sent, so the engine's default (12 months on a 60-month horizon) applies.
    expect("goingConcernSpan" in engineOptionsOfSetup(parseRunSetup({ ...s, eve: { ...s.eve, goingConcern: true } }))).toBe(false);
    // Extended to the whole horizon.
    const whole = parseRunSetup({ ...s, eve: { ...s.eve, goingConcern: true, goingConcernSpan: 60 } });
    expect(whole.eve.goingConcernSpan).toBe(60);
    expect(engineOptionsOfSetup(whole)).toMatchObject({ goingConcernEve: true, goingConcernSpan: 60 });
    // Past the horizon: refused, naming the field.
    expect(() => parseRunSetup({ ...s, eve: { ...s.eve, goingConcern: true, goingConcernSpan: 61 } })).toThrow(/eve\.goingConcernSpan.*within the earnings horizon: at most 60 months, got 61/);
    // The removed whole-projection word is refused.
    expect(() => parseRunSetup({ ...s, eve: { ...s.eve, goingConcernSpan: "projection" } })).toThrow(/eve\.goingConcernSpan/);
    // Without the opt-in a span is kept on the document but sends nothing.
    expect("goingConcernSpan" in engineOptionsOfSetup(parseRunSetup({ ...s, eve: { ...s.eve, goingConcernSpan: 24 } }))).toBe(false);
  });

  it("the run route holds the span to the NII window and needs the opt-in", () => {
    expect(pipelineOptionsOf(resolveEngineOptions({ goingConcernEve: true, goingConcernSpan: 60 }, 360))).toMatchObject({ goingConcernSpan: 60 });
    expect(() => resolveEngineOptions({ goingConcernEve: true, goingConcernSpan: 61 }, 360)).toThrow(/a whole number from 1 to 60, got 61/);
    expect(() => resolveEngineOptions({ goingConcernEve: true, windowMonths: 24, goingConcernSpan: 36 }, 360)).toThrow(/a whole number from 1 to 24, got 36/);
    expect(() => resolveEngineOptions({ goingConcernSpan: 12 }, 360)).toThrow(/send it with engineOptions\.goingConcernEve: true/);
    expect("goingConcernSpan" in pipelineOptionsOf(resolveEngineOptions({ goingConcernEve: true }, 360))).toBe(false);
  });
});
