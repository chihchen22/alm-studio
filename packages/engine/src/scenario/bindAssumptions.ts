/**
 * bindAssumptions: validate an AssumptionSet and fill its contentHash.
 *
 * The set is DATA, not code; this call runs no behavioral model (that is
 * resolveAssumptions' job). It does two things:
 *   1. Validation: recognized overlay kinds, required fields present, and, for
 *      every built-in overlay, the parameter schema check
 *      (contracts/paramSchema.ts): presence, type,
 *      finiteness, hard bounds and cross rules at every level, `sens` and
 *      `buckets` included. The resolve-time checks in resolveAssumptions stay as
 *      a second guard. A registered overlay's params belong to its plugin.
 *      Two bindings of one kind on one family, neither with a selector, are
 *      refused here too, with the resolver's own words.
 *   2. Hashing: a content hash over `bindings` ONLY, or over `bindings` and
 *      `macroBindings` when the set carries a macro mapping (runtime/assumptionSetHash.ts). Idempotent (re-binding an already-bound
 *      set reproduces the same hash), and the hash moves iff a binding param
 *      or the mapping changes, never on a label or id edit.
 */
import { assumptionSetHash } from "../runtime/assumptionSetHash";
import { wholeFamilyKey, type AssumptionSet, type BehavioralOverlay, type OverlayBinding } from "../contracts/assumptions";
import { checkOverlayParams } from "../contracts/paramSchema";
import { checkClientRateSpreadPairs, DuplicateOverlayError } from "./resolveAssumptions";
import { AssumptionValidationError } from "./assumptionValidationError";
import { checkMacroBindings, MacroMappingError } from "./macroBindings";

export { AssumptionValidationError };

const OVERLAY_KINDS: ReadonlySet<BehavioralOverlay["kind"]> = new Set([
  "prepay",
  "nmd-decay",
  "deposit-beta",
  "cd-rollover",
  "commitment-draw",
  "loan-client-rate",
  "registered",
]);

function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new AssumptionValidationError(field, "must be a non-empty string");
  }
}

/** Shape only: the taxonomy check runs at compile, where the book is known. Exported for the macroBindings selector rule. */
export function validateSelector(selector: unknown, field: string): void {
  if (selector === null || typeof selector !== "object" || Array.isArray(selector)) {
    throw new AssumptionValidationError(field, "must be an object of tag -> value | value[]");
  }
  const entries = Object.entries(selector as Record<string, unknown>);
  // An empty selector says what no selector says, and reads as an author who
  // meant to narrow and did not. Refusing it here lets the provenance key rule
  // and the assumption diff key both treat an empty canonical predicate as
  // "whole family" without a second shape to reason about.
  if (entries.length === 0) {
    throw new AssumptionValidationError(field, "must name at least one tag; omit selector to bind the whole family");
  }
  for (const [k, v] of entries) {
    const at = `${field}.${k}`;
    if (typeof v === "string") {
      if (v.length === 0) throw new AssumptionValidationError(at, "must be a non-empty string");
    } else if (Array.isArray(v)) {
      if (v.length === 0) throw new AssumptionValidationError(at, "must list at least one value");
      for (const x of v) if (typeof x !== "string" || x.length === 0) throw new AssumptionValidationError(at, "every value must be a non-empty string");
    } else {
      throw new AssumptionValidationError(at, "must be a string or a string list");
    }
  }
}

function validateBinding(binding: OverlayBinding, index: number): void {
  const where = `bindings[${index}]`;
  requireNonEmptyString(binding.familyId, `${where}.familyId`);
  requireNonEmptyString(binding.modelVersion, `${where}.modelVersion`);
  // Before the `registered` arm's early return, so a registered binding's
  // selector is checked too; only the plugin's own params are left unread.
  if (binding.selector !== undefined) validateSelector(binding.selector, `${where}.selector`);
  if (binding.overlay === null || typeof binding.overlay !== "object") {
    throw new AssumptionValidationError(`${where}.overlay`, "must be an overlay object");
  }
  const kind = (binding.overlay as { kind?: unknown }).kind;
  if (typeof kind !== "string" || !OVERLAY_KINDS.has(kind as BehavioralOverlay["kind"])) {
    throw new AssumptionValidationError(`${where}.overlay.kind`, `unrecognized overlay kind ${String(kind)}`);
  }
  // A registered overlay's params belong to the plugin that registered the kind,
  // and the engine cannot vouch for their shape; the plugin's applier validates
  // them. Returning early keeps the schema check off a foreign param block.
  if (kind === "registered") {
    const registeredKind = (binding.overlay as { registeredKind?: unknown }).registeredKind;
    if (typeof registeredKind !== "string" || registeredKind.length === 0) {
      throw new AssumptionValidationError(
        `${where}.overlay.registeredKind`,
        "a registered overlay must name the kind its plugin registered",
      );
    }
    return;
  }
  // The schema walk replaces the one-level finite scan, which
  // stepped past nmd-decay's `sens` object and `buckets` array.
  const issues = checkOverlayParams(binding.overlay);
  if (issues.length > 0) {
    const first = issues[0]!;
    // A defect in the optional house-price group is a mapping refusal.
    const Refusal = first.path === "housing" || first.path.startsWith("housing.") ? MacroMappingError : AssumptionValidationError;
    throw new Refusal(`${where}.overlay.${first.path}`, `${first.label} ${first.message}`);
  }
}

function validate(set: AssumptionSet): void {
  requireNonEmptyString(set.schemaVersion, "schemaVersion");
  requireNonEmptyString(set.id, "id");
  if (!Array.isArray(set.bindings)) {
    throw new AssumptionValidationError("bindings", "must be an array");
  }
  set.bindings.forEach(validateBinding);
  refuseWholeFamilyDuplicates(set.bindings);
  // A client-rate spread that disagrees with the same family's four-factor
  // prepay spreads is refused at save, unwrapped. Selected pairs are per position
  // and stay with checkBindingOverlap.
  checkClientRateSpreadPairs(set);
  // The macro mapping, after every binding is known good.
  checkMacroBindings(set);
}

/**
 * Two bindings of one kind on one family, neither with a selector. The run
 * refuses the pair at resolve (DuplicateOverlayError) whatever the book, and
 * the plan validate route does not see it (checkBindingOverlap returns early
 * when no binding has a selector), so without this a duplicate is stored and
 * first refused when a run starts. The refusal carries the resolver's own
 * words. With a selector, overlap depends on the book's positions and stays
 * with compile (L3, checkBindingOverlap). The key is wholeFamilyKey, the
 * resolver's own, so two plugin kinds on one family stay distinct.
 */
function refuseWholeFamilyDuplicates(bindings: readonly OverlayBinding[]): void {
  const seen = new Set<string>();
  bindings.forEach((b, i) => {
    const key = wholeFamilyKey(b);
    if (key === null) return;
    if (seen.has(key)) {
      throw new AssumptionValidationError(`bindings[${i}]`, new DuplicateOverlayError(b.familyId, b.overlay.kind).message);
    }
    seen.add(key);
  });
}

/**
 * Validate `set` and return a copy with `contentHash` populated. The hash is
 * assumptionSetHash: over `bindings` alone for a set with no macro mapping, and
 * over `bindings` and `macroBindings` for a mapped one, so it is invariant to
 * id/label edits and to a pre-existing contentHash (making the call idempotent).
 */
export function bindAssumptions(set: AssumptionSet): AssumptionSet {
  validate(set);
  return { ...set, contentHash: assumptionSetHash(set) };
}
