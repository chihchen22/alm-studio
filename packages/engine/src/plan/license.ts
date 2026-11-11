/**
 * Which behavioral stage licenses which binding.
 *
 * The stage is the LICENSE and the assumption set keeps the parameters. A
 * binding (familyId, kind) is licensed by a behavioral stage when the stage's
 * component resolves to the plugin that REGISTERED that kind, and the stage's
 * selector matches the family. A binding has exactly one licensee: zero is an
 * unlicensed binding, two is an ambiguous one, and both are compile refusals.
 *
 * Selector matching is split by facet, so one plan has one selector semantics.
 * The FAMILY facets (productFamily, side) go through selectorMatchesFamily; the
 * POSITION facets (behavioralClasses, dimensions) go through
 * stageSelectorMatchesPosition, the same function and the same per-position
 * class set R3 and R4 read. Every facet a selector states must
 * match; a selector that states nothing matches every family.
 *
 * Piece 2a adds two things. The binding INDEX is the identity a licence carries,
 * so two bindings of one kind on one family, split by selector, license
 * separately. And a stage whose selector carries a dimension predicate licenses
 * a binding only when that predicate covers EVERY position the binding matches:
 * a partial cover is an unlicensed binding naming the position it missed, not a
 * silent half-application.
 */
import type { AssumptionSet } from "../contracts/assumptions";
import { overlayKindOf } from "../contracts/assumptions";
import type { ProductFamilyId } from "../contracts/ids";
import type { LicensedBinding, RunPlan, StageSelector } from "../contracts/plan";
import type { PortfolioSpec } from "../contracts/position";
import type { BehavioralRegistry } from "../plugins/services";
import { dimensionsOf } from "../portfolio/dimensions";
import { classesOfPosition, derivedClassesByFamily } from "./behavioralClasses";
import { resolveComponent } from "./componentAliases";
import {
  selectorMatchesBag,
  selectorMatchesFamily,
  stageSelectorMatchesPosition,
} from "./dimensions";

/** One binding with no licensee, or with too many. */
export interface LicenseGap {
  assumptionSetId: string;
  familyId: ProductFamilyId;
  kind: string;
  /** Which binding of the set: two bindings of one kind on one family differ only here. */
  bindingIndex: number;
  /** Stages of the right kind: the ones that did not match, or the ones that both did. */
  candidateStageIds: string[];
  /** Set when the only stage of the right kind matched the family but its selector.dimensions or selector.behavioralClasses missed this position. */
  uncoveredPositionId?: string;
  /**
   * The plugin id that REGISTERED this kind, set only when the plan has no
   * stage of the right kind at all, which is the case where the author has to
   * add a stage and nothing in the plan tells them what to put in `component`.
   * Read off the mounted registry, never off a naming convention, so a
   * third-party plugin names itself. Absent when no mounted plugin registers
   * the kind, because then there is no component that would work.
   */
  licensingComponent?: string;
}

export interface LicenseOutcome {
  licensed: LicensedBinding[];
  unlicensed: LicenseGap[];
  multi: LicenseGap[];
  /** Behavioral stages that license nothing: a tag at compile, a skip at run. */
  unboundStageIds: string[];
}

/**
 * Plugin id to the behavioral kinds it registered, asked of the registry rather
 * than derived from a naming convention: a third-party model's plugin id is
 * whatever its author chose.
 */
export function kindsByPlugin(behavioral: BehavioralRegistry): ReadonlyMap<string, string[]> {
  const out = new Map<string, string[]>();
  for (const kind of behavioral.kinds()) {
    const owner = behavioral.providerOf(kind);
    if (owner === undefined) continue;
    out.set(owner, [...(out.get(owner) ?? []), kind]);
  }
  return out;
}

export function licenseBindings(
  plan: RunPlan,
  assumptionSets: readonly AssumptionSet[],
  portfolio: PortfolioSpec,
  pluginKinds: ReadonlyMap<string, readonly string[]>,
): LicenseOutcome {
  const classes = derivedClassesByFamily([...assumptionSets], portfolio.coa.families);
  const sideOf = new Map(portfolio.coa.families.map((f) => [f.id, f.side as string]));
  const behavioral = plan.stages.filter((s) => s.kind === "behavioral");
  const kindsOfStage = new Map(
    behavioral.map((s) => [s.id, pluginKinds.get(resolveComponent(s.component)) ?? []] as const),
  );
  // The inverse of pluginKinds: which component a plan must name to license a
  // kind. One entry per kind, because a kind has one provider.
  const ownerOfKind = new Map<string, string>();
  for (const [pluginId, kinds] of pluginKinds) for (const k of kinds) ownerOfKind.set(k, pluginId);

  const licensed: LicensedBinding[] = [];
  const unlicensed: LicenseGap[] = [];
  const multi: LicenseGap[] = [];
  const licensedStages = new Set<string>();

  const familyById = new Map(portfolio.coa.families.map((f) => [f.id, f]));
  for (const set of assumptionSets) {
    for (let bindingIndex = 0; bindingIndex < set.bindings.length; bindingIndex++) {
      const binding = set.bindings[bindingIndex]!;
      const kind = overlayKindOf(binding.overlay);
      const rightKind = behavioral.filter((s) => (kindsOfStage.get(s.id) ?? []).includes(kind));
      // The family-level test keeps the productFamily and side facets
      // only. A stage's behavioralClasses facet is settled per position below,
      // so a stage's classes never reach the family-level test.
      const familyMatching = rightKind.filter((s) => {
        const facets: StageSelector = {};
        if (s.selector?.productFamily !== undefined) facets.productFamily = s.selector.productFamily;
        if (s.selector?.side !== undefined) facets.side = s.selector.side;
        return selectorMatchesFamily(
          facets,
          binding.familyId,
          sideOf.get(binding.familyId) ?? "",
          classes.get(binding.familyId) ?? new Set(),
        );
      });
      // Piece 2a, widened in 2d: a stage stating a predicate OR a class set
      // licenses the binding only if EVERY position the binding matches
      // satisfies the stage's position facets, read with the exact class set R3
      // and R4 read. A stage stating neither is settled by the family facets
      // alone, and a binding matching no position is licensed vacuously. The
      // first uncovered position is carried so the refusal names it.
      let uncovered: string | undefined;
      const matching = familyMatching.filter((s) => {
        if (s.selector?.dimensions === undefined && s.selector?.behavioralClasses === undefined) {
          return true;
        }
        const family = familyById.get(binding.familyId);
        if (family === undefined) return true;
        const derived = classes.get(binding.familyId);
        for (const pos of portfolio.positions) {
          if (pos.familyId !== binding.familyId) continue;
          const bag = dimensionsOf(pos, family, portfolio.taxonomy);
          if (!selectorMatchesBag(binding.selector, bag)) continue;
          const posClasses = classesOfPosition(pos, family, derived, portfolio.taxonomy);
          if (!stageSelectorMatchesPosition(s.selector, bag, posClasses)) {
            uncovered ??= pos.id;
            return false;
          }
        }
        return true;
      });
      const gap: LicenseGap = {
        assumptionSetId: set.id,
        familyId: binding.familyId,
        kind,
        bindingIndex,
        candidateStageIds: (matching.length === 0
          ? familyMatching.length === 0
            ? rightKind
            : familyMatching
          : matching
        ).map((s) => s.id),
        ...(matching.length === 0 && uncovered !== undefined ? { uncoveredPositionId: uncovered } : {}),
        ...(rightKind.length === 0 && ownerOfKind.has(kind)
          ? { licensingComponent: ownerOfKind.get(kind)! }
          : {}),
      };
      if (matching.length === 0) {
        unlicensed.push(gap);
        continue;
      }
      if (matching.length > 1) {
        multi.push(gap);
        continue;
      }
      const stageId = matching[0]!.id;
      licensedStages.add(stageId);
      licensed.push({ stageId, assumptionSetId: set.id, familyId: binding.familyId, kind, bindingIndex });
    }
  }

  return {
    licensed,
    unlicensed,
    multi,
    unboundStageIds: behavioral.filter((s) => !licensedStages.has(s.id)).map((s) => s.id),
  };
}
