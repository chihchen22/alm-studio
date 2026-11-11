/**
 * Overlay application for the static runoff engine.
 *
 * A Position carries kernel `terms` that structurally include behavioral
 * parameters (a Mortgage's cprParams, an NMD's nmdParams, an NMD-B's sCurve),
 * because the frozen kernel instruments require them at construction. The
 * run's AssumptionSet is the swappable behavioral layer (architecture Section
 * 2): where a family carries an overlay, that overlay's params
 * REPLACE the ones baked into the position's terms, so the AI-authored
 * assumption set is what actually drives the runoff.
 *
 * This module produces an "effective" PortfolioSpec whose positions carry the
 * overlay-merged terms, which the m03 aggregator then runs unchanged. It reuses
 * m04's resolveAssumptions purely as the validation gate (unknown family,
 * duplicate overlay kind on one family, out-of-domain params); the param VALUES
 * it merges come from the raw AssumptionSet bindings, because the resolved
 * prepay overlay exposes only a constructed PrepayModel, not the raw MBSParams
 * the Mortgage instrument needs (see the constant-cpr note below and the module
 * report's contractIssues).
 *
 * Determinism: positions map in array order; a family's overlays apply in
 * binding order. No map-iteration order feeds any merged value.
 */
import {
  overlayKindOf,
  type AssumptionSet,
  type BehavioralOverlay,
} from "../../contracts/assumptions";
import type { DimensionBag, DimensionPredicate } from "../../contracts/dimensions";
import type { MacroTarget } from "../../contracts/macroFactors";
import type { EngineMortgageTerms, PortfolioSpec, PositionTerms } from "../../contracts/position";
import type { ProductFamilyId } from "../../contracts/ids";
import { canonicalPredicate, selectorMatchesBag } from "../../plan/dimensions";
import type { BehavioralApplier, BehavioralRegistry } from "../../plugins/services";
import { dimensionsOf } from "../../portfolio/dimensions";
import { OverlappingBindingError } from "../../run/executorErrors";
import { checkClientRateSpread, resolveAssumptions } from "../../scenario/resolveAssumptions";
import { macroTargetKey } from "../../macro/runMacro";

/**
 * Thrown when an overlay names a change the static engine cannot honor against
 * the frozen kernel instrument. Distinct from a param-domain error (which
 * resolveAssumptions raises): the params are valid, but no execution path
 * exists, so running the position's un-overridden terms would silently ignore
 * the caller's intent. The anti-fabrication rule forbids that, so this throws.
 */
export class StaticOverlayError extends Error {
  readonly positionId: string;
  readonly overlayKind: BehavioralOverlay["kind"];
  constructor(positionId: string, overlayKind: BehavioralOverlay["kind"], detail: string) {
    super(`position "${positionId}" ${overlayKind} overlay: ${detail}`);
    this.name = "StaticOverlayError";
    this.positionId = positionId;
    this.overlayKind = overlayKind;
  }
}

/**
 * Merge one overlay into one position's terms, returning new terms. An overlay
 * that cannot drive this position's instrument type THROWS (D5): the
 * family-level gate in resolveAssumptions already refused any kind/type
 * mismatch declared in the catalogue, so reaching one here means the position's
 * terms disagree with its family's declared instrument type — a misconfigured
 * book, not a no-op. The former silent `return terms` fabricated an
 * un-overridden number against the caller's stated intent.
 *
 *  - prepay (four-factor-cpr) -> mortgage.cprParams (else throws); the midpoint
 *    moves by the position's prepayMidpointOffsetBp when the terms carry one
 *  - prepay (constant-cpr)    -> UNSUPPORTED on the kernel Mortgage (throws);
 *    on a level-pay fixed-loan it writes the engine-side `prepay` group
 *    (a bullet throws)
 *  - deposit-beta             -> nmd-b.sCurve, and nmd-b.fullBeta when the overlay carries a full form (else throws),
 *    and nmd-b.replicatingPortfolio beside it when it carries a credit on a capped life
 *  - nmd-decay                -> nmd.nmdParams / nmd-b.nmdParams (else throws), and nmd.componentDecay when the
 *    overlay carries a component decay form (an nmd-b throws), and
 *    nmd.replicatingPortfolio when it carries a replicating-portfolio credit (an nmd
 *    without a linear decay throws; teach slice E3, ADR-053: a credit on the balance path rides a component form)
 *  - cd-rollover              -> new-business only; no static-runoff effect
 *    (a documented model-scope no-op, not a skipped intent)
 *  - commitment-draw          -> commitment.draw (else throws)
 *  - loan-client-rate         -> mortgage only; no static effect (else throws)
 *
 * Exported in piece 1b so engine.behavioral.* can hold a reference to it; the
 * switch itself is unchanged, which is what keeps the numbers identical.
 */
export function applyOverlayToTerms(
  terms: PositionTerms,
  overlay: BehavioralOverlay,
  positionId: string,
): PositionTerms {
  switch (overlay.kind) {
    case "prepay": {
      // A constant CPR on a level-pay fixed loan writes the engine-side `prepay` group,
      // which the factory reads to build ConstantCprFixedLoan. The four-factor arm stays mortgage only.
      if (terms.type === "fixed-loan" && overlay.model === "constant-cpr") {
        if (terms.amortType !== "level-pay") {
          throw new StaticOverlayError(
            positionId,
            "prepay",
            `a constant CPR applies to a level-pay fixed loan only; this position is ${terms.amortType}`,
          );
        }
        const stress = overlay.stressAnnualCpr;
        return {
          ...terms,
          prepay: { annualCpr: overlay.annualCpr, ...(stress !== undefined ? { stressAnnualCpr: stress } : {}) },
        };
      }
      if (terms.type !== "mortgage") {
        throw new StaticOverlayError(
          positionId,
          "prepay",
          `position has instrument type "${terms.type}", which a prepay overlay cannot drive; prepay applies only to "mortgage" (position terms disagree with the family's declared instrument type)`,
        );
      }
      if (overlay.model === "four-factor-cpr") {
        // A cohort's own midpoint fold relative to its family's binding (EngineMortgageTerms); absent, as written.
        const offset = (terms as EngineMortgageTerms).prepayMidpointOffsetBp;
        if (offset === undefined) return { ...terms, cprParams: overlay.params };
        return { ...terms, cprParams: { ...overlay.params, inflection: overlay.params.inflection + offset } };
      }
      // constant-cpr: the kernel Mortgage builds `new FourFactorCPR(cprParams)`
      // internally and takes no PrepayModel injection, so a flat CPR cannot be
      // wired through terms. Honest failure rather than running four-factor.
      throw new StaticOverlayError(
        positionId,
        "prepay",
        "constant-cpr cannot be applied to the kernel Mortgage: it constructs FourFactorCPR from MBSParams and accepts no ConstantCPR injection through terms",
      );
    }
    case "deposit-beta": {
      if (terms.type !== "nmd-b") {
        throw new StaticOverlayError(
          positionId,
          "deposit-beta",
          `position has instrument type "${terms.type}", which a deposit-beta overlay cannot drive; deposit-beta applies only to "nmd-b" (position terms disagree with the family's declared instrument type)`,
        );
      }
      // A full form rides onto the terms as `fullBeta`, which the factory reads to build
      // FullBetaDeposit; without one the merge is exactly as before.
      if (overlay.fullForm !== undefined) {
        // A replicating-portfolio credit on a capped life rides beside the full form.
        if (overlay.replicatingPortfolio !== undefined) {
          if (overlay.replicatingPortfolio.life?.source !== "capped") {
            throw new StaticOverlayError(positionId, "deposit-beta", "a full-form deposit's balances are flat, so its replicating-portfolio credit reads a capped life: set life.source \"capped\"");
          }
          return { ...terms, sCurve: overlay.params, fullBeta: { ...overlay.fullForm }, replicatingPortfolio: structuredClone(overlay.replicatingPortfolio) };
        }
        return { ...terms, sCurve: overlay.params, fullBeta: { ...overlay.fullForm } };
      }
      if (overlay.replicatingPortfolio !== undefined) {
        throw new StaticOverlayError(positionId, "deposit-beta", "the replicating-portfolio credit of a deposit-beta overlay needs the full beta form beside it");
      }
      return { ...terms, sCurve: overlay.params };
    }
    case "nmd-decay": {
      // A replicating-portfolio construction rides onto nmd terms that carry a linear decay,
      // as `replicatingPortfolio`, which the FTP block reads. Without one the merge is exactly as before.
      // A credit whose life is the balance path rides beside a component decay form.
      if (overlay.replicatingPortfolio !== undefined && overlay.replicatingPortfolio.life !== undefined) {
        const rp = overlay.replicatingPortfolio;
        const life = rp.life!;
        if (terms.type !== "nmd" || life.source !== "balance-path" || overlay.componentDecay === undefined) {
          throw new StaticOverlayError(
            positionId,
            "nmd-decay",
            terms.type !== "nmd"
              ? `position has instrument type "${terms.type}"; the replicating-portfolio credit of an nmd-decay overlay applies only to "nmd"`
              : life.source !== "balance-path"
                ? "an nmd-decay overlay's credit reads the deposit's balance path or its straight-line runoff; a capped life rides a full-form deposit"
                : "the credit reads the balance path of a component decay form, and the overlay carries none",
          );
        }
        if (rp.construction === "static-share" && overlay.componentDecay.staticShare === undefined) {
          throw new StaticOverlayError(positionId, "nmd-decay", "the \"static-share\" construction reads the component form's static share, and the form carries none");
        }
        return { ...terms, nmdParams: overlay.params, componentDecay: { ...overlay.componentDecay }, replicatingPortfolio: structuredClone(rp) };
      }
      if (overlay.replicatingPortfolio !== undefined) {
        if (terms.type !== "nmd" || terms.linearDecay === undefined || overlay.componentDecay !== undefined) {
          throw new StaticOverlayError(
            positionId,
            "nmd-decay",
            terms.type !== "nmd"
              ? `position has instrument type "${terms.type}"; the replicating-portfolio credit applies only to "nmd"`
              : overlay.componentDecay !== undefined
                ? "the overlay carries both a component decay form and a replicating-portfolio credit; the credit reads a linear decay only"
                : "the deposit carries no linear decay; the replicating-portfolio credit reads a straight-line runoff",
          );
        }
        return { ...terms, nmdParams: overlay.params, replicatingPortfolio: structuredClone(overlay.replicatingPortfolio) };
      }
      // A component decay form rides onto nmd terms as `componentDecay`, which the factory
      // reads to build ComponentDecayDeposit; the form is built for nmd only. Without one the merge is exactly as before.
      if (overlay.componentDecay !== undefined) {
        if (terms.type !== "nmd") {
          throw new StaticOverlayError(
            positionId,
            "nmd-decay",
            `position has instrument type "${terms.type}"; the component decay form applies only to "nmd"`,
          );
        }
        return { ...terms, nmdParams: overlay.params, componentDecay: { ...overlay.componentDecay } };
      }
      if (terms.type === "nmd" || terms.type === "nmd-b") {
        return { ...terms, nmdParams: overlay.params };
      }
      throw new StaticOverlayError(
        positionId,
        "nmd-decay",
        `position has instrument type "${terms.type}", which an nmd-decay overlay cannot drive; nmd-decay applies only to "nmd" and "nmd-b" (position terms disagree with the family's declared instrument type)`,
      );
    }
    case "cd-rollover":
      // Rollover is new business; static runoff models contractual + behavioral
      // runoff only, so it has no effect here (it drives the dynamic module).
      return terms;
    case "commitment-draw": {
      if (terms.type !== "commitment") {
        throw new StaticOverlayError(
          positionId,
          "commitment-draw",
          `position has instrument type "${terms.type}", which a commitment-draw overlay cannot drive; commitment-draw applies only to "commitment" (position terms disagree with the family's declared instrument type)`,
        );
      }
      return { ...terms, draw: { rampRates: [...overlay.rampRates], steadyRate: overlay.steadyRate } };
    }
    case "loan-client-rate": {
      if (terms.type !== "mortgage") {
        throw new StaticOverlayError(
          positionId,
          "loan-client-rate",
          `position has instrument type "${terms.type}", which a loan-client-rate overlay cannot drive; loan-client-rate applies only to "mortgage" (position terms disagree with the family's declared instrument type)`,
        );
      }
      // The client rate is produced in the rate document, and nothing in the
      // projection reads it, so the terms come back unchanged.
      return terms;
    }
    case "registered":
      throw new StaticOverlayError(
        positionId,
        "registered",
        `behavioral kind "${overlay.registeredKind}" is owned by a mounted plugin and cannot be ` +
          `applied by the built-in switch; run this book through a pipeline context carrying a harness`,
      );
  }
}

/**
 * Apply the SELECTED overlays of an AssumptionSet to a portfolio, returning an
 * effective PortfolioSpec whose positions carry the overlay-merged terms.
 *
 * `licensed` holds the indices into `assumptions.bindings` this call may apply:
 * a behavioral stage applies exactly the bindings it licenses, onto
 * the book it received from its predecessor in the chain. The VALIDATION gate
 * runs over the WHOLE set regardless, because the checks it performs are
 * set-level (unknown family, an overlay kind the family's instrument type cannot
 * consume, an unregistered behavioral kind, a duplicate kind on one family) and
 * splitting them across stages would let a defect through whichever stage did
 * not happen to see it.
 *
 * An empty `licensed` VALIDATES and then returns the portfolio object it was
 * given, unchanged and object-identical. The gate is not skipped: a stage that
 * licenses none of a defective set must still refuse it, or the defect reaches
 * the contractual pass through whichever stage did not happen to see it.
 *
 * Per-family ORDER is binding-index order, exactly as the one-pass form applied
 * it, so a family whose bindings are split across two stages sees them in chain
 * order. The built-in appliers write disjoint fields of the terms object
 * (cprParams, nmdParams, sCurve), so the merged terms are the same either way;
 * the goldens are what prove it, and the limitation is registered on the limitations page
 * Section 17 at the 1c close.
 *
 * Bindings apply per binding, and a binding with a selector touches
 * only the positions of its family that match. The bag is computed lazily, only
 * when some licensed binding carries a selector, so an untagged book pays
 * nothing.
 */
export function applyLicensedOverlays(
  portfolio: PortfolioSpec,
  assumptions: AssumptionSet,
  licensed: ReadonlySet<number>,
  behavioral?: BehavioralRegistry,
  mappedTargets?: readonly MacroTarget[],
): PortfolioSpec {
  // Validation gate FIRST, and unconditionally: the checks are set-level, so a
  // stage that licenses none of a defective set must still refuse it. Only the
  // APPLICATION is narrowed to the licensed indices.
  resolveAssumptions(assumptions, portfolio.coa.families, behavioral?.kinds() ?? []);
  checkBindingOverlap(portfolio, assumptions);
  if (licensed.size === 0) return portfolio;

  // Resolve the applier ONCE per licensed binding, before any position is
  // touched: the seam is a per-run lookup, never a per-position one.
  interface Entry {
    overlay: BehavioralOverlay;
    applier: BehavioralApplier;
    predicate: DimensionPredicate | undefined;
    /** The binding's family and selector are on the run's macro mapping. */
    mapped: boolean;
  }
  // The run passes its RESOLVED mapping (an inheriting scenario
  // set carries none of its own); outside a run the set's own field is the default.
  const mappedKeys = new Set((mappedTargets ?? assumptions.macroBindings ?? []).map((t) => macroTargetKey(t.familyId, t.selector)));
  const byFamily = new Map<ProductFamilyId, Entry[]>();
  for (let i = 0; i < assumptions.bindings.length; i++) {
    if (!licensed.has(i)) continue;
    const binding = assumptions.bindings[i]!;
    const applier =
      behavioral === undefined ? applyOverlayToTerms : behavioral.get(overlayKindOf(binding.overlay));
    const mapped = mappedKeys.size > 0 && mappedKeys.has(macroTargetKey(binding.familyId, binding.selector));
    const entry: Entry = { overlay: binding.overlay, applier, predicate: binding.selector, mapped };
    const arr = byFamily.get(binding.familyId);
    if (arr) arr.push(entry);
    else byFamily.set(binding.familyId, [entry]);
  }
  const familyById = new Map(portfolio.coa.families.map((f) => [f.id, f]));

  const positions = portfolio.positions.map((pos) => {
    const entries = byFamily.get(pos.familyId);
    if (!entries || entries.length === 0) return pos;
    // Schema 1.9.0: a child of the regulatory deposit convention is frozen by
    // construction (nmd/regulatoryConvention.ts) and its terms already read the
    // parent's effective beta. An overlay keyed on the parent's family would
    // unfreeze a rung (nmd-decay) or refuse a floater or a rung (deposit-beta),
    // so children take no overlay. No authored position carries the field.
    if (pos.parentPositionId !== undefined) return pos;
    let bag: DimensionBag | undefined;
    let terms = pos.terms;
    for (const e of entries) {
      if (e.predicate !== undefined) {
        bag ??= dimensionsOf(pos, familyById.get(pos.familyId)!, portfolio.taxonomy);
        if (!selectorMatchesBag(e.predicate, bag)) continue;
      }
      terms = e.applier(terms, e.overlay, pos.id);
      terms = mergeHousingTerms(terms, e.overlay, e.mapped);
    }
    return terms === pos.terms ? pos : { ...pos, terms };
  });

  return { ...portfolio, positions };
}

/**
 * The house-price group reaches a mortgage's
 * terms only for a family and selector the run's macro mapping names. Mapped
 * and carrying the group: `housing` is written. Otherwise any `housing` key is
 * removed, and a terms object without one is returned as is, so an unmapped
 * book's terms objects stay identical. So `terms.housing` exists exactly when
 * the position's family is mapped, and an unmapped family never builds the
 * HousingMortgage even when its binding carries the group.
 */
export function mergeHousingTerms(terms: PositionTerms, overlay: BehavioralOverlay, mapped: boolean): PositionTerms {
  if (overlay.kind !== "prepay" || terms.type !== "mortgage") return terms;
  const housing = overlay.model === "four-factor-cpr" ? overlay.housing : undefined;
  if (mapped && housing !== undefined) return { ...terms, housing: { ...housing } };
  if (!Object.prototype.hasOwnProperty.call(terms, "housing")) return terms; // unmapped book: the terms object is untouched
  const { housing: _drop, ...rest } = terms as EngineMortgageTerms;
  void _drop;
  return rest as PositionTerms;
}

/**
 * L3 on the applier's path: for every position, at most one binding per kind
 * matches. Linear in positions times bindings; the bag is computed only for a
 * position some selected binding could match.
 */
export function checkBindingOverlap(portfolio: PortfolioSpec, set: AssumptionSet): void {
  const bindingsByFamily = new Map<ProductFamilyId, number[]>();
  let anyPredicate = false;
  for (let i = 0; i < set.bindings.length; i++) {
    const b = set.bindings[i]!;
    if (b.selector !== undefined) anyPredicate = true;
    bindingsByFamily.set(b.familyId, [...(bindingsByFamily.get(b.familyId) ?? []), i]);
  }
  if (!anyPredicate) return; // resolveAssumptions already refused unselected duplicates
  const familyById = new Map(portfolio.coa.families.map((f) => [f.id, f]));
  for (const pos of portfolio.positions) {
    const indexes = bindingsByFamily.get(pos.familyId);
    if (indexes === undefined || indexes.length < 2) continue;
    // The compiler is a second caller of this check, on a book that has not yet
    // passed the run's own resolution, so an unknown family is skipped rather
    // than asserted away: resolveAssumptions refuses a binding naming one.
    const family = familyById.get(pos.familyId);
    if (family === undefined) continue;
    let bag: DimensionBag | undefined;
    const owners = new Map<string, number>();
    for (const i of indexes) {
      const b = set.bindings[i]!;
      if (b.selector !== undefined) {
        bag ??= dimensionsOf(pos, family, portfolio.taxonomy);
        if (!selectorMatchesBag(b.selector, bag)) continue;
      }
      const kind = overlayKindOf(b.overlay);
      const prev = owners.get(kind);
      if (prev !== undefined) {
        throw new OverlappingBindingError(
          set.id,
          pos.id,
          kind,
          prev,
          i,
          canonicalPredicate(set.bindings[prev]!.selector),
          canonicalPredicate(b.selector),
        );
      }
      owners.set(kind, i);
    }
    // Where a four-factor prepay and a loan client-rate both govern this
    // position, their spreads must agree. Whole-family pairs were already checked
    // by bindAssumptions and resolveAssumptions; this covers the selected pairs.
    const p = owners.get("prepay");
    const c = owners.get("loan-client-rate");
    if (p !== undefined && c !== undefined) {
      const clientBinding = set.bindings[c]!;
      const prepayBinding = set.bindings[p]!;
      const text = canonicalPredicate(clientBinding.selector ?? prepayBinding.selector);
      checkClientRateSpread(
        set.id,
        pos.familyId,
        clientBinding.overlay as Extract<BehavioralOverlay, { kind: "loan-client-rate" }>,
        prepayBinding.overlay as Extract<BehavioralOverlay, { kind: "prepay" }>,
        text === "" ? undefined : text,
      );
    }
  }
}

/**
 * Apply EVERY overlay of an AssumptionSet to a portfolio. The pre-1c entry
 * point, unchanged in behavior: it is `applyLicensedOverlays` over every binding
 * index, and it is still what the dynamic projection and the stochastic envelope
 * call. Throws UnknownFamilyError / IncompatibleOverlayError /
 * DuplicateOverlayError / OverlayParamError on a bad set, and StaticOverlayError
 * on an overlay the kernel instrument cannot execute.
 *
 * Positions in a family with no overlay pass through untouched (same object).
 *
 * `behavioral` is the mounted behavioral registry. Omitted, the
 * built-in switch applies every overlay exactly as before; supplied, each
 * overlay is applied by whichever plugin registered its kind, and the built-in
 * kinds resolve to this same switch, so no number moves.
 */
export function applyStaticOverlays(
  portfolio: PortfolioSpec,
  assumptions: AssumptionSet,
  behavioral?: BehavioralRegistry,
  mappedTargets?: readonly MacroTarget[],
): PortfolioSpec {
  const all = new Set<number>();
  for (let i = 0; i < assumptions.bindings.length; i++) all.add(i);
  return applyLicensedOverlays(portfolio, assumptions, all, behavioral, mappedTargets);
}
