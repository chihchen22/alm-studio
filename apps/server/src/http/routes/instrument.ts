/**
 * The single-instrument drill route (harness Plane 5).
 *
 *   POST /api/instrument/project   one position, one or more scenarios ->
 *                                  the monthly schedule and its valuation
 *
 * Ruling 3: the result is computed ON DEMAND and NOT STORED. There is no
 * run id, no queue entry, no store write and no catalog row here; the plan path
 * stays the audited route and this is the live read beside it.
 *
 * The route RESOLVES and does not compute. It turns stored ids into the engine
 * function's input (a book's position and its family's side, a market snapshot,
 * a slate's scenarios or one inline shock, an assumption set) and hands the
 * arithmetic to `projectInstrument`. Every engine refusal surfaces as a 422
 * carrying the engine's message verbatim, through `validated`.
 *
 * ONE SOURCE, NEVER TWO. The instrument is either picked from a stored book or
 * typed in the body. A body naming both is refused 400 rather than resolved by
 * precedence, because a silently-taken precedence is a wrong number and not an
 * error.
 *
 * THREE SCENARIO ARMS. A stored slate, one inline parallel shock, or a list of
 * shipped-library references (`{ libraryRefs }`, Studio A+E contract 21) that
 * the engine's own `resolveScenarios` turns into scenarios, so the drill can
 * reproduce a library-based run setup. The drill stays open on a locked
 * workspace (ruling 15): it reads inputs and stores nothing.
 *
 * THE OVERLAY GATE. `projectInstrument` is the APPLY half of the overlay path
 * and runs no validation gate of its own, so on the PICK path this route runs
 * the run's own set-level gate first (`resolveAssumptions` plus
 * `checkBindingOverlap`, in the order `applyLicensedOverlays` runs them): a set
 * the run would refuse is refused here too, and for the same reason with the
 * same words. On the TYPE path there is no book, hence no chart of accounts and
 * no positions to gate against, so no gate runs there and a typed instrument's
 * overlay is checked only by the applier that tries to drive it.
 *
 * THE TYPED-TERMS GATE. The pick path's terms came off a stored book that was
 * validated at intake; the type path's came off a text field. So `checkTypedTerms`
 * runs on the type path alone, and it refuses 400 rather than letting the kernel
 * price a coupon of null at zero or carry a string notional through every row.
 */
import {
  checkBindingOverlap,
  dimensionsOf,
  isRateIndexId,
  modelConventionConfigError,
  namedHistoryIdsOf,
  projectInstrument,
  resolveScenarios,
  SHIPPED_LIBRARIES,
  type AssumptionSet,
  type BalanceSheetSide,
  type ModelConvention,
  type PortfolioSpec,
  type Position,
  type PositionTerms,
  type ProjectInstrumentResult,
  type Scenario,
} from "@alm/engine";
import { defineScenario, resolveAssumptions } from "@alm/engine/src/scenario";
import type { MarketSnapshot } from "@alm/kernel";
import type { PlatformContext } from "../../context";
import { badRequest, notFound } from "../errors";
import { validated, type RouteRequest, type Router } from "../router";
import { storedIndexHistories } from "../../workspaces/indexHistoryPins";

/** A stored scenario slate document. */
interface StoredSlate {
  id: string;
  label: string;
  scenarios: Scenario[];
}

/** The body this route accepts, verbatim from the spec's Section 3. */
interface ProjectInstrumentBody {
  instrument?:
    | { portfolioId?: string; positionId?: string }
    | { terms?: PositionTerms; familyId?: string; side?: "asset" | "liability" };
  marketId?: string;
  scenarios?: { scenarioSlateId?: string } | { parallelShockBp?: number } | { libraryRefs?: string[] };
  assumptionSetId?: string;
  horizonMonths?: number;
  durationBumpBp?: number;
  /** "corrected-v1" or "book", as a run names it; absent is the original convention. */
  modelConvention?: unknown;
}

const BODY_KEYS = [
  "instrument",
  "marketId",
  "scenarios",
  "assumptionSetId",
  "horizonMonths",
  "durationBumpBp",
  "modelConvention",
] as const;

const INSTRUMENT_KEYS = ["portfolioId", "positionId", "terms", "familyId", "side"] as const;

const SCENARIO_KEYS = ["scenarioSlateId", "parallelShockBp", "libraryRefs"] as const;

/**
 * Refuse unknown keys at every level of the body: a misspelled field is a
 * request the caller did not mean, never a default silently taken.
 */
function rejectUnknownKeys(value: unknown, allowed: readonly string[], at: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${at}: expected an object`);
  }
  const unknown = Object.keys(value as Record<string, unknown>).filter(
    (k) => !allowed.includes(k),
  );
  if (unknown.length > 0) {
    throw badRequest(
      `${at}: unknown field(s) ${unknown.map((k) => `"${k}"`).join(", ")}; ` +
        `allowed: ${allowed.join(", ")} (an unrecognized field is refused, not silently ignored)`,
    );
  }
}

/**
 * The six instrument types the engine's position layer accepts: the five frozen
 * kernel types plus the engine-side `cd` cohort arm.
 */
const ENGINE_TYPES = [
  "fixed-loan",
  "floating-loan",
  "mortgage",
  "nmd",
  "nmd-b",
  "cd",
] as const;

/** The amortization styles the kernel executes (kernel AmortType). */
const AMORT_TYPES = ["level-pay", "bullet"] as const;

/** A finite number, or a refusal naming the field. */
function finiteNumberAt(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw badRequest(
      `${at}: expected a finite number, got ${value === null ? "null" : typeof value}` +
        ` (${JSON.stringify(value) ?? "undefined"})`,
    );
  }
  return value;
}

/**
 * Check hand-typed terms BEFORE the kernel sees them.
 *
 * The typed path has no book behind it, so nothing upstream has ever looked at
 * these fields. The kernel constructors check some of them and the arithmetic
 * silently absorbs the rest: a `coupon` of null (what a viewer sends once
 * `Number("abc")` becomes NaN and JSON serialises it) prices every row at a
 * zero coupon and answers 200; an absent `coupon` makes NaN, which the fold
 * carries into a null `pvAllIn`; a `notional` of "1000000" makes a STRING
 * balance on every row. Each of those is a wrong number answered as a right
 * one, so each is a 400 here, naming the field the caller has to fix.
 *
 * What is checked is the base every type carries plus the scalar fields the two
 * scalar-termed types need, and the optional rateIndexId of a floating loan
 * (any other type carrying it is refused). `mortgage`, `nmd`, `nmd-b` and `cd` carry parameter
 * BLOCKS (a prepay parameter set, a decay surface, a cohort table) that the
 * kernel and the engine adapters validate themselves, so those are checked for
 * the base fields and the discriminant alone: restating their interiors here
 * would be a second copy of a validation that already exists and can drift.
 */
function checkTypedTerms(terms: Record<string, unknown>): void {
  const at = "body.instrument.terms";
  const type = terms.type;
  if (typeof type !== "string" || !ENGINE_TYPES.includes(type as (typeof ENGINE_TYPES)[number])) {
    throw badRequest(
      `${at}.type: expected one of ${ENGINE_TYPES.join(", ")}, got ${JSON.stringify(type) ?? "undefined"}`,
    );
  }
  if (typeof terms.id !== "string" || terms.id.length === 0) {
    throw badRequest(`${at}.id: expected a non-empty string naming the instrument`);
  }
  const notional = finiteNumberAt(terms.notional, `${at}.notional`);
  if (notional <= 0) {
    throw badRequest(`${at}.notional: expected a positive number of dollars, got ${notional}`);
  }
  const maturityMonths = finiteNumberAt(terms.maturityMonths, `${at}.maturityMonths`);
  if (!Number.isInteger(maturityMonths) || maturityMonths <= 0) {
    throw badRequest(
      `${at}.maturityMonths: expected a positive integer number of months, got ${maturityMonths}`,
    );
  }
  const offset = finiteNumberAt(terms.originationOffsetMonths, `${at}.originationOffsetMonths`);
  if (!Number.isInteger(offset)) {
    throw badRequest(
      `${at}.originationOffsetMonths: expected an integer number of months ` +
        `(negative = seasoned, 0 = anchored at the as-of date), got ${offset}`,
    );
  }
  if (
    typeof terms.amortType !== "string" ||
    !AMORT_TYPES.includes(terms.amortType as (typeof AMORT_TYPES)[number])
  ) {
    throw badRequest(
      `${at}.amortType: expected one of ${AMORT_TYPES.join(", ")}, ` +
        `got ${JSON.stringify(terms.amortType) ?? "undefined"}`,
    );
  }
  if (type === "fixed-loan") {
    finiteNumberAt(terms.coupon, `${at}.coupon`);
  } else if (type === "floating-loan") {
    finiteNumberAt(terms.margin, `${at}.margin`);
    const reset = finiteNumberAt(terms.resetFrequencyMonths, `${at}.resetFrequencyMonths`);
    if (!Number.isInteger(reset) || reset < 1) {
      throw badRequest(
        `${at}.resetFrequencyMonths: expected an integer of at least 1 month, got ${reset}`,
      );
    }
    const tenor = finiteNumberAt(terms.indexTenorMonths, `${at}.indexTenorMonths`);
    if (!Number.isInteger(tenor) || tenor < 1) {
      throw badRequest(
        `${at}.indexTenorMonths: expected an integer of at least 1 month, got ${tenor}`,
      );
    }
    // Optional. The named index is resolved against the market the
    // request names; a market that does not carry it is the engine's 422.
    if (terms.rateIndexId !== undefined && !isRateIndexId(terms.rateIndexId)) {
      throw badRequest(
        `${at}.rateIndexId: expected a lowercase rate index id of letters, digits and single hyphens, ` +
          `starting with a letter, at most 40 characters, got ${JSON.stringify(terms.rateIndexId)}`,
      );
    }
  }
  if (type !== "floating-loan" && terms.rateIndexId !== undefined) {
    throw badRequest(
      `${at}.rateIndexId: rateIndexId is read on floating-loan terms only; a swap's floating ` +
        "leg stays on the one-month benchmark",
    );
  }
}

/** The scenario id an inline shock carries: S0, S100, S-100. */
function inlineScenarioId(shockBp: number): string {
  return `S${shockBp}`;
}

export function registerInstrumentRoutes(router: Router, ctx: PlatformContext): void {
  router.add("POST", "/api/instrument/project", (req: RouteRequest) => {
    const body = req.json<ProjectInstrumentBody>();
    rejectUnknownKeys(body, BODY_KEYS, "body");
    if (typeof body.marketId !== "string" || body.marketId.length === 0) {
      throw badRequest("body.marketId: expected a non-empty string naming a stored market snapshot");
    }
    // PRESENT and not a number is a 400, not a default. `null` is nullish, so
    // `?? DEFAULT` inside the engine would silently answer on 360 months and a
    // 100 bp bump for a caller who asked for neither: a number nobody requested
    // is worse than a refusal that names the field.
    if (body.horizonMonths !== undefined) {
      finiteNumberAt(body.horizonMonths, "body.horizonMonths");
    }
    if (body.durationBumpBp !== undefined) {
      finiteNumberAt(body.durationBumpBp, "body.durationBumpBp");
    }
    if (body.modelConvention !== undefined) {
      const problem = modelConventionConfigError(body.modelConvention, "body.modelConvention");
      if (problem !== undefined) throw badRequest(problem);
    }
    rejectUnknownKeys(body.instrument, INSTRUMENT_KEYS, "body.instrument");
    rejectUnknownKeys(body.scenarios, SCENARIO_KEYS, "body.scenarios");

    const marketSnapshot = ctx.store.getDocument<MarketSnapshot>("market", body.marketId).doc;

    // --- The optional overlay ------------------------------------------------
    // Read BEFORE the instrument so the pick path can gate it against the book.
    const assumptions =
      body.assumptionSetId === undefined
        ? undefined
        : ctx.store.getDocument<AssumptionSet>("assumption-sets", body.assumptionSetId).doc;

    // --- The instrument: picked from a book, or typed in the body ------------
    // The cast is safe and deliberate: rejectUnknownKeys has already refused
    // anything that is not a plain object, so the union (and its undefined arm)
    // is narrowed by that check rather than by the type system.
    const inst = body.instrument as unknown as Record<string, unknown>;
    // A body naming BOTH sources is ambiguous, and silently taking one of them
    // is the wrong number rather than an error: the caller meant one, and only
    // the caller knows which.
    const namesPick = inst.portfolioId !== undefined || inst.positionId !== undefined;
    const namesTyped =
      inst.terms !== undefined || inst.familyId !== undefined || inst.side !== undefined;
    if (namesPick && namesTyped) {
      throw badRequest(
        "body.instrument names both a stored position and typed terms; send one, " +
          "either { portfolioId, positionId } or { terms, familyId, side }",
      );
    }
    let terms: PositionTerms;
    let familyId: string;
    let side: BalanceSheetSide;
    let dimensions: ReturnType<typeof dimensionsOf> | undefined;

    if (typeof inst.portfolioId === "string" && typeof inst.positionId === "string") {
      const portfolio = ctx.store.getDocument<PortfolioSpec>("portfolios", inst.portfolioId).doc;
      const position: Position | undefined = portfolio.positions.find(
        (p) => p.id === inst.positionId,
      );
      if (position === undefined) {
        throw notFound(
          `portfolio "${inst.portfolioId}" carries no position "${String(inst.positionId)}"`,
        );
      }
      const family = portfolio.coa.families.find((f) => f.id === position.familyId);
      if (family === undefined) {
        throw notFound(
          `portfolio "${inst.portfolioId}" position "${position.id}" names family ` +
            `"${position.familyId}", which its chart of accounts does not declare`,
        );
      }
      terms = position.terms;
      familyId = family.id;
      side = family.side;
      dimensions = dimensionsOf(position, family, portfolio.taxonomy);
      // The run's gate, run here because the drill's apply path does not run it.
      // Both halves, in the order applyLicensedOverlays runs them: the set-level
      // checks (unknown family, incompatible kind, unselected duplicate,
      // out-of-domain params) first, then the per-position selector overlap.
      if (assumptions !== undefined) {
        validated(() => {
          resolveAssumptions(assumptions, portfolio.coa.families);
          checkBindingOverlap(portfolio, assumptions);
        });
      }
    } else if (
      typeof inst.terms === "object" &&
      inst.terms !== null &&
      typeof inst.familyId === "string" &&
      (inst.side === "asset" || inst.side === "liability")
    ) {
      // Nothing upstream has ever looked at these fields: check them here or
      // the kernel prices whatever the caller typed.
      checkTypedTerms(inst.terms as Record<string, unknown>);
      terms = inst.terms as PositionTerms;
      familyId = inst.familyId;
      side = inst.side;
    } else {
      throw badRequest(
        "body.instrument: expected either { portfolioId, positionId } naming a stored position, " +
          'or { terms, familyId, side } with side "asset" or "liability"',
      );
    }

    // --- The scenarios: a stored slate, or one inline parallel shock ---------
    const scen = body.scenarios as unknown as Record<string, unknown>;
    let scenarios: Scenario[];
    let scenarioSource: string;
    if (scen.libraryRefs !== undefined) {
      // Contract 21: "<library id>#<scenario id>" references, resolved by the engine's own
      // resolver over the shipped libraries, so a library-based setup is reproducible here.
      // Naming another arm beside it is refused: a precedence silently taken is a wrong number.
      if (scen.scenarioSlateId !== undefined || scen.parallelShockBp !== undefined) {
        throw badRequest(
          "body.scenarios names libraryRefs and another scenario source; send one of " +
            "{ scenarioSlateId }, { parallelShockBp } or { libraryRefs }",
        );
      }
      const refs = scen.libraryRefs;
      if (!Array.isArray(refs) || refs.length === 0 || !refs.every((r) => typeof r === "string" && r.length > 0)) {
        throw badRequest(
          'body.scenarios.libraryRefs: expected a non-empty array of "<library id>#<scenario id>" strings',
        );
      }
      // Static new business and the body's assumption set are the drill's defaults for an
      // inline shock too: the drill runs one position as runoff, so a strategy is never read.
      const resolved = validated(() =>
        resolveScenarios(
          (refs as string[]).map((ref) => ({ ref })),
          SHIPPED_LIBRARIES,
          () => ({ mode: "static", rules: [] }),
          body.assumptionSetId ?? "none",
          body.horizonMonths ?? 360,
        ),
      );
      scenarios = resolved.scenarios;
      scenarioSource = "library";
    } else if (typeof scen.scenarioSlateId === "string") {
      const slateId = scen.scenarioSlateId;
      const slate = ctx.store.getDocument<StoredSlate>("scenario-slates", slateId).doc;
      scenarios = slate.scenarios;
      // The id the REQUEST named, echoed back, so the caption says what was
      // asked for; a stored document's own `id` field is not the lookup key.
      scenarioSource = slateId;
    } else if (typeof scen.parallelShockBp === "number" && Number.isFinite(scen.parallelShockBp)) {
      const shockBp = scen.parallelShockBp;
      scenarios = [
        validated(() =>
          defineScenario({
            id: inlineScenarioId(shockBp),
            label: shockBp === 0 ? "Base" : `Parallel ${shockBp > 0 ? "+" : ""}${shockBp}bp`,
            rateSpec: shockBp === 0 ? { kind: "base" } : { kind: "parallel", shockBp },
            // The drill reads the assumption set OBJECT, never this id, so the
            // literal "none" is a label and not a lookup.
            assumptionSetId: body.assumptionSetId ?? "none",
            newBusiness: { mode: "static", rules: [] },
          }),
        ),
      ];
      scenarioSource = "inline";
    } else {
      throw badRequest(
        "body.scenarios: expected either { scenarioSlateId } naming a stored slate, " +
          "{ parallelShockBp } with a finite number of basis points, or { libraryRefs } naming shipped library scenarios",
      );
    }

    // Piece B, step B3b (R1, N9): every history the market names that the store holds. Tolerant on purpose: the drill
    // builds its one-position book inside the engine, which refuses only a position whose lag needs a history it was
    // not given, naming it; a missing history the drilled position does not read does not refuse the drill.
    const named = storedIndexHistories(ctx.store, namedHistoryIdsOf(marketSnapshot));
    const result: ProjectInstrumentResult = validated(() =>
      projectInstrument({
        terms,
        familyId,
        side,
        marketSnapshot,
        scenarios,
        ...(assumptions !== undefined ? { assumptions } : {}),
        ...(dimensions !== undefined ? { dimensions } : {}),
        ...(body.horizonMonths !== undefined ? { horizonMonths: body.horizonMonths } : {}),
        ...(body.durationBumpBp !== undefined ? { durationBumpBp: body.durationBumpBp } : {}),
        ...(named.length > 0 ? { indexHistories: named } : {}),
        ...(body.modelConvention !== undefined ? { modelConvention: body.modelConvention as ModelConvention } : {}),
      }),
    );

    return { kind: "json", value: { ...result, marketId: body.marketId, scenarioSource } };
  });
}
