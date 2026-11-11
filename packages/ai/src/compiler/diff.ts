/**
 * Deterministic field-level diff between two assumption sets.
 *
 * The diff is the heart of the show-before-run step: it lists exactly the
 * overlay params that moved, with their from and to values, so a reviewer sees
 * the mechanical effect of an instruction before any number is computed. It
 * does no arithmetic on the book; it only compares two data objects.
 *
 * Determinism: bindings are matched by (familyId, overlayKind, canonical
 * predicate), overlay leaves are flattened with keys sorted, and deltas are
 * emitted in base-binding order then sorted by path. No Map iteration order
 * enters the output.
 */
import { canonicalPredicate } from "@alm/engine";
import { canonicalize } from "@alm/engine/src/runtime/contentHash";
import type {
  AssumptionDelta,
  AssumptionDiff,
  AssumptionSet,
  BehavioralOverlay,
  DimensionPredicate,
  OverlayBinding,
} from "@alm/engine";

type Leaf = number | string | boolean | null;

function isLeaf(v: unknown): v is Leaf {
  return (
    v === null ||
    typeof v === "number" ||
    typeof v === "string" ||
    typeof v === "boolean"
  );
}

/**
 * Flatten an overlay to a map of dotted-path -> leaf value. Object keys are
 * visited in sorted order and arrays by ascending index, so the traversal is
 * independent of how the object was constructed. Paths are rooted at the
 * overlay (e.g. "params.betaMax", "offeredSpreadBp", "params.buckets.0.share").
 */
function collectLeaves(
  value: unknown,
  prefix: string,
  out: Map<string, Leaf>,
): void {
  if (isLeaf(value)) {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((el, i) => collectLeaves(el, prefix ? `${prefix}.${i}` : String(i), out));
    return;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of Object.keys(obj).sort()) {
      collectLeaves(obj[key], prefix ? `${prefix}.${key}` : key, out);
    }
  }
}

/** Stable match key for a binding: family, kind, and the canonical predicate. */
function bindingKey(b: OverlayBinding): string {
  return `${b.familyId}::${b.overlay.kind}::${canonicalPredicate(b.selector)}`;
}

/**
 * Diff one matched pair (or a one-sided binding). For a matched pair, emit a
 * delta per leaf whose value moved. For an added binding (base side absent),
 * from is null; for a removed binding (candidate side absent), to is null. A
 * leaf that is genuinely null on both sides is not a change.
 */
function diffBinding(
  familyId: string,
  overlayKind: BehavioralOverlay["kind"],
  baseOverlay: BehavioralOverlay | undefined,
  candOverlay: BehavioralOverlay | undefined,
  selector: DimensionPredicate | undefined,
): AssumptionDelta[] {
  const baseLeaves = new Map<string, Leaf>();
  const candLeaves = new Map<string, Leaf>();
  if (baseOverlay) collectLeaves(baseOverlay, "", baseLeaves);
  if (candOverlay) collectLeaves(candOverlay, "", candLeaves);

  const paths = new Set<string>([...baseLeaves.keys(), ...candLeaves.keys()]);
  const deltas: AssumptionDelta[] = [];
  for (const path of [...paths].sort()) {
    const hasBase = baseLeaves.has(path);
    const hasCand = candLeaves.has(path);
    const from = hasBase ? (baseLeaves.get(path) as Leaf) : null;
    const to = hasCand ? (candLeaves.get(path) as Leaf) : null;
    if (hasBase && hasCand && Object.is(from, to)) continue;
    // The `kind` discriminant is identical for a matched pair and only differs
    // across a one-sided binding, where it is redundant with the added/removed
    // signal; keep it out of the leaf report to avoid a noise delta.
    if (path === "kind") continue;
    deltas.push({
      familyId,
      overlayKind,
      path,
      from,
      to,
      ...(selector !== undefined ? { selector } : {}),
    });
  }
  return deltas;
}

/**
 * Diff `candidate` against `base`, field by field over the overlay bindings.
 * The result lists exactly the changed overlay params with their from and to.
 */
export function diffAssumptions(
  base: AssumptionSet,
  candidate: AssumptionSet,
): AssumptionDiff {
  const baseByKey = new Map<string, OverlayBinding>();
  for (const b of base.bindings) baseByKey.set(bindingKey(b), b);
  const candByKey = new Map<string, OverlayBinding>();
  for (const b of candidate.bindings) candByKey.set(bindingKey(b), b);

  const deltas: AssumptionDelta[] = [];

  // Base-order pass covers matched and removed bindings.
  for (const b of base.bindings) {
    const key = bindingKey(b);
    const cand = candByKey.get(key);
    deltas.push(
      ...diffBinding(b.familyId, b.overlay.kind, b.overlay, cand?.overlay, b.selector),
    );
  }
  // Candidate-order pass appends bindings the base never had.
  for (const b of candidate.bindings) {
    if (baseByKey.has(bindingKey(b))) continue;
    deltas.push(
      ...diffBinding(b.familyId, b.overlay.kind, undefined, b.overlay, b.selector),
    );
  }

  // The macro mapping is listed whole when it differs, never as leaf deltas.
  const from = base.macroBindings ?? null;
  const to = candidate.macroBindings ?? null;
  if (canonicalize(from) !== canonicalize(to)) return { baseId: base.id, deltas, macroBindings: { from, to } };
  return { baseId: base.id, deltas };
}
