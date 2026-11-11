/**
 * The drill's one route. Both source paths (pick from
 * a stored book, or type the terms in the body) through one request shape and
 * one reply shape, computed on demand and never stored.
 *
 * The seeded store is the fixture: the vanilla book (nine hand-authored
 * fixed-rate positions), its regulatory slate (five scenarios, S0 first), the
 * vendored market snapshot, and the demo behavioral set whose prepay binding on
 * the "mortgages" family is what the refusal case aims at a fixed loan.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RateSpec } from "@alm/engine";
import { repoRoot } from "../config";
import { buildCommitmentPositions, seedStore, SEED_IDS } from "../../scripts/seed-store";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;

/** The reply shape this route answers with (spec Section 2.2 plus the caption). */
interface DrillReply {
  familyId: string;
  side: string;
  horizonMonths: number;
  durationBumpBp: number;
  overlayApplied: string;
  marketId: string;
  scenarioSource: string;
  terms: { id: string; type: string; notional: number };
  byScenario: Array<{
    scenarioId: string;
    rateSpec: RateSpec;
    rows: Array<{
      month: number;
      pathRate: number;
      couponRate: number;
      balance: number;
      principal: number;
      interest: number;
      payment: number;
    }>;
    repricingMonths: number[];
    walMonths?: number;
    pvAllIn: number;
    pvRiskFree: number;
    effectiveDuration?: number;
  }>;
}

interface ErrorReply {
  error: { code: string; message: string; detail?: unknown };
}

const PATH = "/api/instrument/project";

beforeAll(async () => {
  tp = await bootTestPlatform();
  await seedStore(new FileStore(tp.storeRoot), repoRoot());
}, 300_000);

afterAll(async () => {
  await tp.close();
});

describe("POST /api/instrument/project", () => {
  it("drills a picked position over a stored slate, five scenarios in slate order", async () => {
    // Ruling 3: the drill is a live read. No run id, no queue entry, no
    // store write. The runs collection is the witness, counted either side.
    const before = await api<unknown[]>(tp.base, "GET", "/api/runs");
    const r = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { scenarioSlateId: SEED_IDS.vanillaSlate },
      horizonMonths: 60,
    });
    expect(r.status).toBe(200);
    expect(r.body.marketId).toBe(SEED_IDS.market);
    // The REQUEST's slate id, echoed back, not the slate document's own id field.
    expect(r.body.scenarioSource).toBe(SEED_IDS.vanillaSlate);
    // The book's COA, not the caller, is what says which family and which side.
    expect(r.body.familyId).toBe("fixed-loans");
    expect(r.body.side).toBe("asset");
    expect(r.body.overlayApplied).toBe("none");
    expect(r.body.terms.id).toBe("loan-2");
    expect(r.body.terms.type).toBe("fixed-loan");
    expect(r.body.terms.notional).toBe(150_000_000);
    expect(r.body.byScenario.map((s) => s.scenarioId)).toEqual([
      "S0",
      "S-200",
      "S-100",
      "S100",
      "S200",
    ]);
    const base = r.body.byScenario[0]!;
    expect(base.rows).toHaveLength(60);
    expect(base.rows[0]!.month).toBe(1);
    expect(base.rows[0]!.payment).toBeCloseTo(
      base.rows[0]!.principal + base.rows[0]!.interest,
      6,
    );
    expect(base.repricingMonths).toEqual([]);
    expect(base.walMonths!).toBeGreaterThan(0);
    expect(base.pvAllIn).toBeGreaterThan(0);
    expect(r.body.horizonMonths).toBe(60);
    expect(r.body.durationBumpBp).toBe(100);

    const after = await api<unknown[]>(tp.base, "GET", "/api/runs");
    expect(after.body.length).toBe(before.body.length);
  });

  it("drills hand-typed terms under an inline parallel shock", async () => {
    const r = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: {
        terms: {
          id: "typed-1",
          type: "fixed-loan",
          label: "Hand-typed 3y bullet",
          notional: 1_000_000,
          maturityMonths: 36,
          originationOffsetMonths: 0,
          amortType: "bullet",
          coupon: 0.05,
        },
        familyId: "typed",
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 100 },
      horizonMonths: 36,
    });
    expect(r.status).toBe(200);
    expect(r.body.scenarioSource).toBe("inline");
    expect(r.body.familyId).toBe("typed");
    expect(r.body.byScenario).toHaveLength(1);
    const p = r.body.byScenario[0]!;
    expect(p.scenarioId).toBe("S100");
    expect(p.rateSpec).toEqual({ kind: "parallel", shockBp: 100 });
    expect(p.rows).toHaveLength(36);
    // A bullet pays principal once, at maturity.
    expect(p.rows.filter((row) => row.principal > 0).map((row) => row.month)).toEqual([36]);
  });

  it("an inline shock of zero is the base scenario, id S0", async () => {
    const r = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "fund-1" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 12,
    });
    expect(r.status).toBe(200);
    expect(r.body.side).toBe("liability");
    expect(r.body.byScenario[0]!.scenarioId).toBe("S0");
    expect(r.body.byScenario[0]!.rateSpec).toEqual({ kind: "base" });
  });

  it("404s an unknown position, an unknown book and an unknown market, each naming the id", async () => {
    const noPos = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "no-such-position" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(noPos.status).toBe(404);
    expect(noPos.body.error.message).toContain("no-such-position");

    const noBook = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: "no-such-book", positionId: "loan-1" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(noBook.status).toBe(404);

    const noMarket = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-1" },
      marketId: "no-such-market",
      scenarios: { parallelShockBp: 0 },
    });
    expect(noMarket.status).toBe(404);
  });

  it("400s an unknown body field rather than ignoring it", async () => {
    const r = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-1" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonth: 60,
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("horizonMonth");
  });

  it("400s a body whose instrument names neither a stored position nor typed terms", async () => {
    const r = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("instrument");
  });

  it("422s an overlay that cannot drive the instrument type, with the engine message verbatim", async () => {
    const r = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: {
        terms: {
          id: "typed-2",
          type: "fixed-loan",
          label: "A loan the demo set would prepay",
          notional: 1_000_000,
          maturityMonths: 60,
          originationOffsetMonths: 0,
          amortType: "level-pay",
          coupon: 0.06,
        },
        // The demo behavioral set binds a prepay overlay to this family, and a
        // prepay overlay cannot drive a fixed loan.
        familyId: "mortgages",
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      assumptionSetId: SEED_IDS.demoAssumptions,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'position "typed-2" prepay overlay: position has instrument type "fixed-loan", ' +
        'which a prepay overlay cannot drive; prepay applies only to "mortgage" ' +
        "(position terms disagree with the family's declared instrument type)",
    );
  });

  /**
   * The gate's other side: a set the gate PASSES, drilled on the pick path, and
   * the overlay it licenses visibly drives the schedule. The contrast is the
   * proof: the same position, the same shock, with and without the set.
   */
  it("drills a picked mortgage under a set the gate passes, and the overlay bites", async () => {
    const book = await api<{ positions: Array<{ id: string; familyId: string }> }>(
      tp.base,
      "GET",
      `/api/portfolios/${SEED_IDS.syntheticPortfolio}`,
    );
    expect(book.status).toBe(200);
    const mortgage = book.body.positions.find((p) => p.familyId === "mortgages");
    expect(mortgage).toBeDefined();

    const withSet = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.syntheticPortfolio, positionId: mortgage!.id },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      assumptionSetId: SEED_IDS.demoAssumptions,
      horizonMonths: 12,
    });
    expect(withSet.status).toBe(200);
    expect(withSet.body.familyId).toBe("mortgages");
    expect(withSet.body.overlayApplied).toBe("prepay");

    const without = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.syntheticPortfolio, positionId: mortgage!.id },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 12,
    });
    expect(without.status).toBe(200);
    expect(without.body.overlayApplied).toBe("none");

    // The DEMO set binds the exact kernel default parameters (the limitations page
    // Section 13: it populates provenance without moving a number), and the
    // generated mortgages carry those same defaults, so it cannot be the input
    // contrast: it is applied, and the schedule is identical. The seeded STRESS
    // set is the one that moves the number, minCpr 2 -> 6 and inflection
    // 50 -> 25bp, which is faster prepayment and so more month-1 principal.
    const stressed = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.syntheticPortfolio, positionId: mortgage!.id },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      assumptionSetId: SEED_IDS.stressAssumptions,
      horizonMonths: 12,
    });
    expect(stressed.status).toBe(200);
    expect(stressed.body.overlayApplied).toBe("prepay");
    expect(stressed.body.byScenario[0]!.rows[0]!.principal).toBeGreaterThan(
      without.body.byScenario[0]!.rows[0]!.principal,
    );
  });

  it("400s an unknown key inside instrument or inside scenarios, and a mixed instrument", async () => {
    const badInstrument = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: {
        portfolioId: SEED_IDS.vanillaPortfolio,
        positionId: "loan-1",
        extra: 1,
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(badInstrument.status).toBe(400);
    expect(badInstrument.body.error.message).toContain("extra");

    const badScenarios = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-1" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0, extra: 1 },
    });
    expect(badScenarios.status).toBe(400);
    expect(badScenarios.body.error.message).toContain("extra");

    // A body that names BOTH sources is ambiguous, and the route must not pick
    // one silently: the caller meant one of them and only they know which.
    const mixed = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: {
        portfolioId: SEED_IDS.vanillaPortfolio,
        positionId: "loan-1",
        terms: {
          id: "typed-3",
          type: "fixed-loan",
          label: "Hand-typed 1y bullet",
          notional: 1_000_000,
          maturityMonths: 12,
          originationOffsetMonths: 0,
          amortType: "bullet",
          coupon: 0.05,
        },
        familyId: "typed",
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.message).toContain("both a stored position and typed terms");
  });

  /**
   * Ruling (Task 2 review): the engine's overlay path is the APPLY
   * half only and runs no validation gate, so the route runs the run's gate
   * itself on the PICK path, where a book exists to run it against. A set the
   * run would refuse is refused here too, 422 with the message verbatim.
   */
  it("422s a set the run's own gate would refuse, on the pick path", async () => {
    const overlapping = {
      schemaVersion: "1.0.0",
      id: "drill-overlapping-prepay-v1",
      label: "Two unselected prepay bindings on one family",
      bindings: [
        {
          familyId: "mortgages",
          overlay: { kind: "prepay", model: "constant", annualCpr: 0.08 },
          modelVersion: "kernel-constant-cpr-1",
        },
        {
          familyId: "mortgages",
          overlay: { kind: "prepay", model: "constant", annualCpr: 0.12 },
          modelVersion: "kernel-constant-cpr-1",
        },
      ],
    };
    // Since Piece 4b the POST refuses the pair at bind, in the resolver's words.
    const created = await api<ErrorReply>(tp.base, "POST", "/api/assumption-sets", overlapping);
    expect(created.status).toBe(422);
    expect(created.body.error.message).toBe(
      'invalid assumption set at bindings[1]: family "mortgages" has two "prepay" overlays; one family, one overlay per kind',
    );
    // A set stored before Piece 4b can still hold the pair, so the pick path's own gate is kept and still tested:
    // the set goes into the store directly, as the store held it then.
    new FileStore(tp.storeRoot).putDocument("assumption-sets", overlapping.id, overlapping, { label: overlapping.label, bindingCount: 2 });

    const r = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      assumptionSetId: "drill-overlapping-prepay-v1",
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toBe(
      'family "mortgages" has two "prepay" overlays; one family, one overlay per kind',
    );
  });

  it("400s typed terms whose fields are not the numbers the kernel needs, naming each field", async () => {
    // The pick path's terms came off a book validated at intake; these came off
    // a text field. Each case below answered 200 with a wrong number before the
    // check existed: a null coupon priced every row at a zero coupon, a string
    // notional carried a STRING balance through the schedule, and empty terms
    // made a NaN PV under a present key.
    const typed = (over: Record<string, unknown>) => ({
      instrument: {
        terms: {
          id: "typed-bad",
          type: "fixed-loan",
          label: "Typed",
          notional: 1_000_000,
          maturityMonths: 36,
          originationOffsetMonths: 0,
          amortType: "level-pay",
          coupon: 0.05,
          ...over,
        },
        familyId: "typed",
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 36,
    });

    // `Number("abc")` is NaN and JSON serialises NaN to null: what the viewer
    // sends when a reader fat-fingers the coupon field.
    const nullCoupon = await api<ErrorReply>(tp.base, "POST", PATH, typed({ coupon: null }));
    expect(nullCoupon.status).toBe(400);
    expect(nullCoupon.body.error.message).toContain("coupon");

    const stringNotional = await api<ErrorReply>(
      tp.base,
      "POST",
      PATH,
      typed({ notional: "1000000" }),
    );
    expect(stringNotional.status).toBe(400);
    expect(stringNotional.body.error.message).toContain("notional");

    // An absent coupon is the same defect wearing a missing key.
    const noCoupon = await api<ErrorReply>(tp.base, "POST", PATH, typed({ coupon: undefined }));
    expect(noCoupon.status).toBe(400);
    expect(noCoupon.body.error.message).toContain("coupon");

    // Empty typed terms: 400 naming a field, where before the check this was a
    // 422 from the kernel and the deferred item of the round-1 review.
    const empty = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { terms: {}, familyId: "typed", side: "asset" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toContain("body.instrument.terms");

    // A type outside the engine's six.
    const badType = await api<ErrorReply>(tp.base, "POST", PATH, typed({ type: "swap" }));
    expect(badType.status).toBe(400);
    expect(badType.body.error.message).toContain("type");

    // The floating arm's own three fields.
    const badFloat = await api<ErrorReply>(
      tp.base,
      "POST",
      PATH,
      typed({ type: "floating-loan", coupon: undefined, margin: 0.0125, indexTenorMonths: 1 }),
    );
    expect(badFloat.status).toBe(400);
    expect(badFloat.body.error.message).toContain("resetFrequencyMonths");
  });

  it("400s a horizon or a bump that is PRESENT and not a number, rather than taking a default", async () => {
    // `null` is nullish, so `?? DEFAULT` inside the engine would have answered
    // 200 on a 360-month horizon the caller never asked for.
    const nullHorizon = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: null,
    });
    expect(nullHorizon.status).toBe(400);
    expect(nullHorizon.body.error.message).toContain("horizonMonths");

    const nullBump = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      durationBumpBp: null,
    });
    expect(nullBump.status).toBe(400);
    expect(nullBump.body.error.message).toContain("durationBumpBp");
  });

  it("422s a horizon past the 360-month cap, through the engine's own refusal", async () => {
    const r = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 1_000_000_000,
    });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toContain("horizonMonths");
    expect(r.body.error.message).toContain("360");
  });
  /**
   * Piece 7 final review, Minor 4. Both source paths refuse an undrawn
   * committed line, and they refuse it for the right reason each.
   *
   * The PICK path used to answer 200 with a NEGATIVE pvAllIn and a duration
   * measured off it, because a stored position's terms are taken as validated
   * at intake and nothing downstream asked what type they were. Measured at the
   * engine level before the guard: a 50,000,000 line on a 0.35 / 0.20 / 0.02
   * draw path priced at -40,382,141.42 with a duration of 0.9156.
   *
   * The TYPED path already refused, at a different layer and with a different
   * status: `checkTypedTerms` is a 400 on the request body, because a hand-typed
   * type that is not one of the six engine types is a malformed request. The
   * engine's refusal is a 422, because the terms are well formed and the drill
   * still cannot answer. Both statuses are asserted, so a later change that
   * collapses one into the other is visible.
   *
   * The position id is taken from the seed's own exported builder rather than
   * spelled out here, so a reshaped seed cannot leave this test picking a
   * position that no longer exists and passing for the wrong reason.
   */
  it("refuses a stored commitment on the PICK path with 422, and a typed one with 400", async () => {
    const seeded = buildCommitmentPositions();
    expect(seeded.length).toBeGreaterThan(0);
    const commitment = seeded[0]!;

    const picked = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: {
        portfolioId: SEED_IDS.commitmentPortfolio,
        positionId: commitment.id,
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 60,
    });
    expect(picked.status).toBe(422);
    expect(picked.body.error.message).toContain("commitment");
    expect(picked.body.error.message).toContain("off balance sheet");
    expect(picked.body.error.message).toContain("lcr-scenario");

    const typed = await api<ErrorReply>(tp.base, "POST", PATH, {
      instrument: {
        terms: commitment.terms,
        familyId: commitment.familyId,
        side: "asset",
      },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 60,
    });
    expect(typed.status).toBe(400);
    expect(typed.body.error.message).toContain("terms.type");

    // The control: a funded position on the SAME route and the same shock still
    // drills, so neither refusal is a blanket one.
    const control = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" },
      marketId: SEED_IDS.market,
      scenarios: { parallelShockBp: 0 },
      horizonMonths: 60,
    });
    expect(control.status).toBe(200);
    expect(control.body.byScenario[0]!.pvAllIn).toBeGreaterThan(0);
  });
  /**
   * Studio A+E Slice 1, Task C5 (contract 21): a third scenarios arm, a list of
   * library references resolved by the engine's own resolver over the shipped
   * libraries, so the drill can reproduce a library-based run setup.
   */
  it("accepts { libraryRefs } and echoes scenarioSource library; the two older arms are byte-identical", async () => {
    const pick = { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" };
    const r = await api<DrillReply>(tp.base, "POST", PATH, {
      instrument: pick,
      marketId: SEED_IDS.market,
      scenarios: { libraryRefs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S200"] },
      horizonMonths: 60,
    });
    expect(r.status).toBe(200);
    expect(r.body.scenarioSource).toBe("library");
    expect(r.body.byScenario.map((s) => s.scenarioId)).toEqual(["S0", "S200"]);
    expect(r.body.byScenario[1]!.rateSpec).toEqual({ kind: "parallel", shockBp: 200 });
    expect(r.body.byScenario[0]!.rows).toHaveLength(60);
    // The library S0 and S200 are the inline shocks 0 and 200: the same schedules, row for row.
    const inline0 = await api<DrillReply>(tp.base, "POST", PATH, { instrument: pick, marketId: SEED_IDS.market, scenarios: { parallelShockBp: 0 }, horizonMonths: 60 });
    const inline200 = await api<DrillReply>(tp.base, "POST", PATH, { instrument: pick, marketId: SEED_IDS.market, scenarios: { parallelShockBp: 200 }, horizonMonths: 60 });
    expect(r.body.byScenario[0]).toEqual(inline0.body.byScenario[0]);
    expect(r.body.byScenario[1]).toEqual(inline200.body.byScenario[0]);
    expect(inline0.body.scenarioSource).toBe("inline");
    // A twist library entry runs as authored.
    const twist = await api<DrillReply>(tp.base, "POST", PATH, { instrument: pick, marketId: SEED_IDS.market, scenarios: { libraryRefs: ["steepener-v1#STEEP100"] }, horizonMonths: 60 });
    expect(twist.status).toBe(200);
    expect(twist.body.byScenario.map((s) => s.scenarioId)).toEqual(["STEEP100"]);
    expect(twist.body.byScenario[0]!.rateSpec).toEqual({ kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 });
  });

  it("refuses a bad library reference with the engine's words, and a malformed or mixed libraryRefs with 400", async () => {
    const pick = { portfolioId: SEED_IDS.vanillaPortfolio, positionId: "loan-2" };
    const send = (scenarios: unknown) => api<ErrorReply>(tp.base, "POST", PATH, { instrument: pick, marketId: SEED_IDS.market, scenarios, horizonMonths: 60 });
    const unknownLib = await send({ libraryRefs: ["nope#S0"] });
    expect(unknownLib.status).toBe(422);
    expect(unknownLib.body.error.message).toContain('no library "nope"');
    const unknownScenario = await send({ libraryRefs: ["regulatory-grid-v1#S999"] });
    expect(unknownScenario.status).toBe(422);
    expect(unknownScenario.body.error.message).toContain('library "regulatory-grid-v1" has no scenario "S999"');
    // A ramp has no rate-path model: the engine's refusal, not a silent immediate shock.
    const ramp = await send({ libraryRefs: ["ramp-200-12m-v1#R200"] });
    expect(ramp.status).toBe(422);
    expect(ramp.body.error.message).toContain("R200");
    expect((await send({ libraryRefs: [] })).status).toBe(400);
    expect((await send({ libraryRefs: ["regulatory-grid-v1#S0", 7] })).status).toBe(400);
    expect((await send({ libraryRefs: "regulatory-grid-v1#S0" })).status).toBe(400);
    const mixed = await send({ libraryRefs: ["regulatory-grid-v1#S0"], parallelShockBp: 100 });
    expect(mixed.status).toBe(400);
    expect(mixed.body.error.message).toContain("libraryRefs");
  });
});
