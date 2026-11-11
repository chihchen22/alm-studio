/**
 * Going-concern EVE: run-off EVE plus the net value of the new volume each scenario's
 * balance plan makes. Run-off EVE, the regulatory measure, stays the default block and is not touched.
 *
 * Which new volume (ruling 2026-11-03): the tranches made in the first `span.months` months. The sweep makes a
 * tranche at bucket k = 1, 2, ... (never 0): it replaces the runoff of month k (bucket k - 1) and is funded at the end
 * of month k, time k / 12. So "made in the first n months" is k = 1 .. n, the rule k <= span.months; a grid too short
 * to make a tranche in some month simply has none. By default 12 months (the NII window when it is shorter), because forecast errors compound
 * further out; a run may extend it up to the NII window, never past it. Each counted tranche is valued over its whole
 * life, past the grid where it runs past it.
 *
 * How it is valued (fix round M2). Month m of a tranche made at bucket k lands in bucket k + m - 1, which run-off EVE
 * discounts at (k + m) / 12; its notional is paid out (or taken in) when the runoff it replaces came back, the end of
 * bucket k - 1, time k / 12.
 *
 *   risk-free basis: on the scenario's risk-free curve from t0, as run-off EVE discounts:
 *     value = sum over m of P((k + m) / 12) x (principal_m + interest_m) - notional x P(k / 12)   (an asset)
 *   all-in (and spread-consistent) basis: priced where the tranche was priced, then brought back. At origination, on the
 *   construction its matched rate and its FTP charge use: the scenario path's one-month rates from k, D(m) =
 *   D(m - 1) / (1 + r(k + m - 1) / 12), times the liquidity premium term structure anchored at origination,
 *   exp(-tlp(m / 12) m / 12) (and the family's own spread, exp(-s m / 12), on the spread-consistent basis):
 *     value_k = sum over m of D(m) exp(-(tlp(m / 12) + s) m / 12) x (principal_m + interest_m) - notional
 *   then value = df(k / 12) x value_k, with df the run-off discount function of the family.
 *   A tranche at its matched rate plus 0 bp is then worth 0 (the par condition of parMatchedRate), and one at +x bp is
 *   worth the present value of its x bp.
 *   A liability takes the opposite sign.
 *
 * On the risk-free basis a loan priced at its matched rate shows the liquidity premium it earns as value, and a deposit
 * the premium it saves. going-concern EVE = run-off EVE + the sum of the tranches' values. No duration is measured.
 */
import type { TLPCurve, ZeroCurve } from "@alm/kernel";
import { isCommitmentFamily } from "../commitment/offBalanceSheet";
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { Position } from "../contracts/position";
import type { EVEResult, GoingConcernEveResult, ScenarioGoingConcernEve } from "../contracts/results";
import type { Scenario } from "../contracts/scenario";
import type { SweptTranche } from "../projection/dynamic";
import { shockedCurve } from "../scenario/rateEnvironment";
import { isDerivativeFamily } from "../swap/derivatives";
import { discountFunction } from "./discount";
import { familyDiscountSpreadBp } from "./pv";

/** The span's words, as the note and the Studio state them. */
export function goingConcernSpanWords(span: GoingConcernEveResult["span"]): string {
  return `new volume made in the first ${span.months} month${span.months === 1 ? "" : "s"}`;
}

/** The default span (ruling 2026-11-03): 12 months, or the NII window when it is shorter. */
export const GOING_CONCERN_DEFAULT_MONTHS = 12;
export function defaultGoingConcernMonths(windowMonths: number): number {
  return Math.min(GOING_CONCERN_DEFAULT_MONTHS, windowMonths);
}

export function goingConcernNote(span: GoingConcernEveResult["span"]): string {
  return `Going-concern EVE adds to run-off EVE the value of the ${goingConcernSpanWords(span)}, each tranche over its full life on the same discount basis; it is a management view, and the regulatory measure is run-off EVE.`;
}

/** The net value of one tranche on a risk-free discount function from t0: its cash flows less its funding at origination, by side. */
export function trancheValue(t: SweptTranche, side: "asset" | "liability", df: (tYears: number) => number): number {
  const k = t.bucket;
  let pv = 0;
  for (const cf of t.instrument.generateCashflows(t.path)) pv += df((k + cf.monthOffset) / 12) * (cf.principalPaid + cf.interestPaid);
  const funding = t.notional * df(k / 12);
  return side === "liability" ? funding - pv : pv - funding;
}

/**
 * The net value of one tranche at its origination (fix round M2), on the construction its matched rate uses: the
 * discount factors read off its own forward-started path's one-month rates, times the liquidity premium anchored at
 * origination (and a spread, in bp). Not yet brought back to t0.
 */
export function trancheValueAtOrigination(t: SweptTranche, side: "asset" | "liability", tlp: TLPCurve, spreadBp = 0): number {
  const s = spreadBp / 1e4;
  let pv = 0;
  let D = 1;
  let m = 0;
  for (const cf of t.instrument.generateCashflows(t.path)) {
    while (m < cf.monthOffset) {
      D = D / (1 + t.path.rateAt(m) / 12);
      m++;
    }
    const time = cf.monthOffset / 12;
    const dfAll = s === 0 ? D * Math.exp(-tlp.tlp(time) * time) : D * Math.exp(-(tlp.tlp(time) + s) * time);
    pv += dfAll * (cf.principalPaid + cf.interestPaid);
  }
  return side === "liability" ? t.notional - pv : pv - t.notional;
}

export interface GoingConcernInputs {
  eve: EVEResult;
  coa: ChartOfAccounts;
  /** The book run-off EVE measured, for the spread-consistent basis's family spreads. */
  positions: readonly Position[];
  scenarios: readonly Scenario[];
  tranchesByScenario: ReadonlyMap<string, readonly SweptTranche[]> | undefined;
  baseCurve: ZeroCurve;
  tlp: TLPCurve;
  /** The span of new volume counted: the tranches made in the first `months` months. */
  span: GoingConcernEveResult["span"];
}

export function computeGoingConcernEve(inputs: GoingConcernInputs): GoingConcernEveResult {
  const { eve, coa, scenarios, baseCurve, tlp, span } = inputs;
  const basis = eve.discountBasis;
  const byId = new Map(scenarios.map((s) => [s.id, s] as const));
  const families = coa.families.filter((f) => !isCommitmentFamily(f) && !isDerivativeFamily(f) && (f.side === "asset" || f.side === "liability"));
  const spreadBp = new Map<string, number>();
  if (basis === "spread-consistent") {
    for (const f of families) spreadBp.set(f.id, familyDiscountSpreadBp(f.id, inputs.positions.filter((p) => p.familyId === f.id)));
  }
  // A tranche at bucket k is made at the end of month k (it replaces month k's runoff): months 1 .. n are k <= n.
  const counted = (t: SweptTranche): boolean => t.bucket <= span.months;
  const rows: ScenarioGoingConcernEve[] = eve.byScenario.map((sc) => {
    const scenario = byId.get(sc.scenarioId);
    if (scenario === undefined) throw new Error(`computeGoingConcernEve: no scenario "${sc.scenarioId}"`);
    const curve = shockedCurve(baseCurve, scenario.rateSpec);
    const dfCache = new Map<number, (t: number) => number>();
    const dfOf = (familyId: string): ((t: number) => number) => {
      const bp = spreadBp.get(familyId) ?? 0;
      let d = dfCache.get(bp);
      if (d === undefined) {
        d = discountFunction(curve, tlp, 0, basis, bp);
        dfCache.set(bp, d);
      }
      return d;
    };
    const tranches = (inputs.tranchesByScenario?.get(sc.scenarioId) ?? []).filter(counted);
    const byFamily: ScenarioGoingConcernEve["byFamily"] = [];
    let newVolumeValue = 0;
    for (const f of families) {
      const own = tranches.filter((t) => t.familyId === f.id);
      if (own.length === 0) continue;
      const df = dfOf(f.id);
      const side = f.side as "asset" | "liability";
      const bp = spreadBp.get(f.id) ?? 0;
      let value = 0;
      let notional = 0;
      for (const t of own) {
        value += basis === "risk-free" ? trancheValue(t, side, df) : df(t.bucket / 12) * trancheValueAtOrigination(t, side, tlp, bp);
        notional += t.notional;
      }
      byFamily.push({ familyId: f.id, trancheCount: own.length, notional, value });
      newVolumeValue += value;
    }
    return { scenarioId: sc.scenarioId, runoffEve: sc.eve, newVolumeValue, eve: sc.eve + newVolumeValue, deltaEveVsBase: 0, deltaEvePct: 0, byFamily };
  });
  const baseId = scenarios.find((s) => s.rateSpec.kind === "base")?.id;
  const base = rows.find((r) => r.scenarioId === baseId);
  if (base !== undefined) {
    for (const r of rows) {
      r.deltaEveVsBase = r.scenarioId === base.scenarioId ? 0 : r.eve - base.eve;
      r.deltaEvePct = base.eve === 0 ? 0 : r.deltaEveVsBase / base.eve;
    }
  }
  return { note: goingConcernNote(span), span: { ...span }, byScenario: rows };
}
