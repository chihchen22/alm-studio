/**
 * The drill refuses an undrawn committed line (piece 7 final review, Minor 4).
 *
 * A commitment is OFF balance sheet: the bank
 * does not own the money, so the line has no present value and no duration.
 * Every fold in the engine honors that by dropping the family or writing a
 * defined zero (see `commitment/offBalanceSheet.ts`).
 *
 * The drill did neither. It priced the line. `CommitmentInstrument` emits
 * `principalPaid: -draw`, so the discounted fold answers a NEGATIVE `pvAllIn`
 * and, because that number is finite and non-zero, an `effectiveDuration`
 * measured off it. A negative price and a duration for an object with no price
 * is the exact defect class this piece caught three times: no throw, a
 * plausible-looking number.
 *
 * The route's TYPED path already refuses a commitment, because
 * `ENGINE_TYPES` in `apps/server/src/http/routes/instrument.ts` does not carry
 * the discriminant. The PICK path does not, because a stored position's terms
 * are taken as validated. The two paths disagreeing is the defect; the refusal
 * belongs in the engine function, which is the thing that must not answer a PV,
 * rather than in one of its callers.
 *
 * THE DISCRIMINANT IS `terms.type`, not a family's `instrumentType`, and that is
 * deliberate: the drill holds terms and no family definition, which is exactly
 * the position `gap/gapEngine.ts` is in. `offBalanceSheet.ts` records that
 * reading the same fact two ways is safe while the mapping holds.
 *
 * NOTHING HERE IS READ BACK from the module under test. The two cases are
 * chosen for what the drill would otherwise ANSWER, and the assertions are on
 * the refusal, not on a number.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { EMPTY_DRAW_PATH, type CommitmentTerms } from "../../commitment";
import type { PositionTerms } from "../../contracts/position";
import type { Scenario } from "../../contracts/scenario";
import { projectInstrument, ProjectInstrumentError } from "../projectInstrument";

const FIXTURE = fileURLToPath(
  new URL("../../../../kernel/public/market_public.json", import.meta.url),
);

let snapshot: MarketSnapshot;

beforeAll(async () => {
  snapshot = await loadMarketSnapshot(FIXTURE);
});

const HORIZON = 60;

/**
 * A committed line. `draw` defaults to a real ramp, because that is the shape a
 * `commitment-draw` overlay leaves on the terms and the shape that produces the
 * wrong number; the undrawn default is passed explicitly by the second case.
 */
function commitmentTerms(draw = { rampRates: [0.35, 0.2], steadyRate: 0.02 }): CommitmentTerms {
  return {
    id: "drill-commit-1",
    type: "commitment",
    label: "Committed revolving line",
    notional: 50_000_000,
    maturityMonths: 60,
    originationOffsetMonths: 0,
    amortType: "bullet",
    side: "asset",
    draw,
  };
}

function scenario(id: string): Scenario {
  return {
    id,
    label: id,
    rateSpec: { kind: "base" },
    assumptionSetId: "none",
    newBusiness: { mode: "static", rules: [] },
  };
}

function drill(terms: CommitmentTerms): ReturnType<typeof projectInstrument> {
  return projectInstrument({
    terms: terms as unknown as PositionTerms,
    familyId: "commit-revolver",
    side: "asset",
    marketSnapshot: snapshot,
    scenarios: [scenario("S0")],
    horizonMonths: HORIZON,
  });
}

/**
 * The outcome as a STRING, so a RED run prints the number the drill answered
 * instead of the bare "did not throw" a `toThrow` matcher gives.
 */
function outcomeOf(terms: CommitmentTerms): string {
  try {
    const r = drill(terms);
    const s = r.byScenario[0];
    return (
      `RETURNED: rows=${s.rows.length} pvAllIn=${s.pvAllIn} pvRiskFree=${s.pvRiskFree} ` +
      `effectiveDuration=${String(s.effectiveDuration)}`
    );
  } catch (err) {
    return err instanceof ProjectInstrumentError
      ? `REFUSED: ${err.message}`
      : `WRONG ERROR (${err instanceof Error ? err.name : typeof err}): ${String(err)}`;
  }
}

describe("projectInstrument refuses a commitment (piece 7 final review, Minor 4)", () => {
  it("refuses a DRAWN line rather than answering a negative price and a duration", () => {
    expect(outcomeOf(commitmentTerms())).toMatch(/^REFUSED: /);
  });

  it("refuses an UNDRAWN line too, so the refusal does not depend on an overlay having bound", () => {
    expect(outcomeOf(commitmentTerms(EMPTY_DRAW_PATH))).toMatch(/^REFUSED: /);
  });

  it("names the field and says why, and the message points at where a draw IS observable", () => {
    let thrown: unknown;
    try {
      drill(commitmentTerms());
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProjectInstrumentError);
    const err = thrown as ProjectInstrumentError;
    expect(err.field).toBe("terms");
    expect(err.message).toMatch(/commitment/);
    expect(err.message).toMatch(/off balance sheet/i);
    expect(err.message).toMatch(/lcr/i);
  });

  it("still projects a non-commitment instrument, so the guard is not a blanket refusal", () => {
    const r = projectInstrument({
      terms: {
        id: "drill-fixed-control",
        type: "fixed-loan",
        label: "Control",
        notional: 1_000_000,
        maturityMonths: 60,
        originationOffsetMonths: 0,
        amortType: "level-pay",
        coupon: 0.06,
      } as unknown as PositionTerms,
      familyId: "fixed-loans",
      side: "asset",
      marketSnapshot: snapshot,
      scenarios: [scenario("S0")],
      horizonMonths: HORIZON,
    });
    expect(r.byScenario[0].rows.length).toBe(HORIZON);
    expect(r.byScenario[0].pvAllIn).toBeGreaterThan(0);
  });
});
