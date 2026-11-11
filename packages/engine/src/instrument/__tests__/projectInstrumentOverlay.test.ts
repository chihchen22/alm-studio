/**
 * Piece 3d, spec Section 2.3 step 3 and ruling 2: the OPTIONAL overlay.
 *
 * When the drill is handed an assumption set, the binding whose familyId
 * matches, and whose selector matches the position's dimension bag, applies to
 * the terms through the SAME function the static pass applies it with. When it
 * is handed none, the schedule is contractual. An overlay that cannot drive the
 * instrument type raises the engine's own StaticOverlayError, verbatim.
 *
 * The month-1 comparison is against the SCHEDULED principal restated here from
 * the amortization formula, not against a second call of the drill: a zero-CPR
 * mortgage pays exactly B r / ((1+r)^n - 1) in its first month, which is the
 * level-pay principal, and a prepaying one pays more.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  loadMarketSnapshot,
  MBS_DEFAULTS,
  type FixedLoanTerms,
  type MarketSnapshot,
  type MBSParams,
  type MortgageTerms,
} from "@alm/kernel";
import type { AssumptionSet } from "../../contracts/assumptions";
import type { Scenario } from "../../contracts/scenario";
import { StaticOverlayError } from "../../projection/static/applyOverlays";
import { projectInstrument } from "../projectInstrument";

const FIXTURE = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

let snapshot: MarketSnapshot;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
});

const HORIZON = 120;

/** CPR parameters that prepay nothing: the schedule is pure amortization. */
const NO_PREPAY: MBSParams = { ...MBS_DEFAULTS, minCpr: 0, maxCpr: 0 };
/** CPR parameters that prepay hard at every incentive level. */
const FAST_PREPAY: MBSParams = { ...MBS_DEFAULTS, minCpr: 30, maxCpr: 30 };
/** Harder still, to prove binding ORDER by which one wins. */
const FASTER_PREPAY: MBSParams = { ...MBS_DEFAULTS, minCpr: 50, maxCpr: 50 };

function mortgageTerms(): MortgageTerms {
  return {
    id: "drill-mtg-1",
    type: "mortgage",
    label: "Mortgage 30y",
    notional: 400_000,
    originalBalance: 400_000,
    originalTermMonths: 360,
    ageMonths: 0,
    maturityMonths: 360,
    originationOffsetMonths: 0,
    amortType: "level-pay",
    noteRate: 0.065,
    cprParams: NO_PREPAY,
  };
}

function fixedTerms(): FixedLoanTerms {
  return {
    id: "drill-fixed-1",
    type: "fixed-loan",
    label: "Term loan 5y",
    notional: 1_000_000,
    maturityMonths: 60,
    originationOffsetMonths: 0,
    amortType: "level-pay",
    coupon: 0.06,
  };
}

const BASE: Scenario = {
  id: "S0",
  label: "Base",
  rateSpec: { kind: "base" },
  assumptionSetId: "none",
  newBusiness: { mode: "static", rules: [] },
};

function prepaySet(
  bindings: Array<{ familyId: string; params: MBSParams; selector?: Record<string, string> }>,
): AssumptionSet {
  return {
    schemaVersion: "1.0.0",
    id: "AS-DRILL",
    label: "Drill overlay fixture",
    bindings: bindings.map((b) => ({
      familyId: b.familyId,
      overlay: { kind: "prepay", model: "four-factor-cpr", params: b.params },
      modelVersion: "kernel-four-factor-cpr-1",
      ...(b.selector !== undefined ? { selector: b.selector } : {}),
    })),
  };
}

/**
 * The scheduled (no-prepay) month-1 principal, restated: with a level-pay
 * balance B, monthly rate r and n months remaining, the scheduled principal is
 * B r / ((1+r)^n - 1), which is the level payment less the month's interest.
 */
function scheduledPrincipalMonth1(notional: number, annualRate: number, term: number): number {
  const r = annualRate / 12;
  return (notional * r) / (Math.pow(1 + r, term) - 1);
}

function drill(over: Partial<Parameters<typeof projectInstrument>[0]> = {}) {
  return projectInstrument({
    terms: mortgageTerms(),
    familyId: "mortgages",
    side: "asset",
    marketSnapshot: snapshot,
    scenarios: [BASE],
    horizonMonths: HORIZON,
    ...over,
  });
}

describe("projectInstrument, the optional overlay", () => {
  it("with no assumption set the schedule is contractual, month 1 restated from the amortization formula", () => {
    const result = drill();
    const want = scheduledPrincipalMonth1(400_000, 0.065, 360);
    expect(result.overlayApplied).toBe("none");
    expect(result.byScenario[0]!.rows[0]!.principal).toBeCloseTo(want, 6);
    expect(result.byScenario[0]!.rows[0]!.interest).toBeCloseTo((400_000 * 0.065) / 12, 6);
  });

  it("a prepay binding on the position's family drives the terms and lifts principal above the contractual schedule from month 1", () => {
    const result = drill({ assumptions: prepaySet([{ familyId: "mortgages", params: FAST_PREPAY }]) });
    const contractual = scheduledPrincipalMonth1(400_000, 0.065, 360);
    expect(result.overlayApplied).toBe("prepay");
    expect(result.byScenario[0]!.rows[0]!.principal).toBeGreaterThan(contractual);
    // The overlaid terms, not the input terms, are what the reply reports.
    expect((result.terms as { cprParams: MBSParams }).cprParams.minCpr).toBe(30);
    // Faster prepayment shortens the average life.
    const slow = drill();
    expect(result.byScenario[0]!.walMonths!).toBeLessThan(slow.byScenario[0]!.walMonths!);
  });

  it("a binding for ANOTHER family applies nothing at all", () => {
    const withOther = drill({ assumptions: prepaySet([{ familyId: "mbs", params: FAST_PREPAY }]) });
    const bare = drill();
    expect(withOther.overlayApplied).toBe("none");
    expect(JSON.stringify(withOther.byScenario)).toBe(JSON.stringify(bare.byScenario));
  });

  it("a selector applies only when the position's dimension bag matches it", () => {
    const set = prepaySet([
      { familyId: "mortgages", params: FAST_PREPAY, selector: { rateType: "fixed" } },
    ]);
    const matched = drill({ assumptions: set, dimensions: { rateType: "fixed" } });
    const unmatched = drill({ assumptions: set, dimensions: { rateType: "floating" } });
    // A typed instrument carries no bag at all, so no selector can match it.
    const noBag = drill({ assumptions: set });
    const bare = drill();

    expect(matched.overlayApplied).toBe("prepay");
    expect(matched.byScenario[0]!.rows[0]!.principal).toBeGreaterThan(
      bare.byScenario[0]!.rows[0]!.principal,
    );
    expect(unmatched.overlayApplied).toBe("none");
    expect(JSON.stringify(unmatched.byScenario)).toBe(JSON.stringify(bare.byScenario));
    expect(noBag.overlayApplied).toBe("none");
    expect(JSON.stringify(noBag.byScenario)).toBe(JSON.stringify(bare.byScenario));
  });

  it("two bindings on one family apply in BINDING ORDER, so the later one is what runs", () => {
    // This fixture is one a RUN refuses: checkBindingOverlap rejects two prepay
    // bindings on one family as a duplicate, so what is pinned here is the
    // drill's apply order alone, not a set the validation gate would pass.
    const both = drill({
      assumptions: prepaySet([
        { familyId: "mortgages", params: FAST_PREPAY },
        { familyId: "mortgages", params: FASTER_PREPAY },
      ]),
    });
    const laterAlone = drill({
      assumptions: prepaySet([{ familyId: "mortgages", params: FASTER_PREPAY }]),
    });
    const earlierAlone = drill({
      assumptions: prepaySet([{ familyId: "mortgages", params: FAST_PREPAY }]),
    });
    expect(JSON.stringify(both.byScenario)).toBe(JSON.stringify(laterAlone.byScenario));
    expect(JSON.stringify(both.byScenario)).not.toBe(JSON.stringify(earlierAlone.byScenario));
  });

  it("a prepay binding on a fixed loan raises the engine's own StaticOverlayError, verbatim", () => {
    const call = () =>
      projectInstrument({
        terms: fixedTerms(),
        familyId: "mortgages",
        side: "asset",
        marketSnapshot: snapshot,
        scenarios: [BASE],
        horizonMonths: HORIZON,
        assumptions: prepaySet([{ familyId: "mortgages", params: FAST_PREPAY }]),
      });
    expect(call).toThrow(StaticOverlayError);
    expect(call).toThrow(
      'position "drill-fixed-1" prepay overlay: position has instrument type "fixed-loan", ' +
        'which a prepay overlay cannot drive; prepay applies only to "mortgage" ' +
        "(position terms disagree with the family's declared instrument type)",
    );
  });
});
