/**
 * deriveAssumptionSet: a behavioral shock as a pure,
 * explicit derivation of one AssumptionSet from another.
 *
 * Each op addresses one binding of the base by { familyId, kind, selector? }
 * (the family::kind::canonicalPredicate key the stack merge uses; it must match
 * exactly one binding) and adds to, scales or sets one declared number field of
 * that binding's schema. Values are in the field's stored unit and are never
 * converted. add and scale results are rounded to 12 significant digits, which
 * removes float noise (0.8 x 1.1) without losing real precision; set stores the
 * value exactly. Ops apply in order and compose.
 *
 * The result is an ordinary bound AssumptionSet carrying an additive
 * `derivedFrom` record. bindAssumptions hashes bindings only, so derivedFrom
 * moves no bindings hash. The kernel, the run path and bindAssumptions are
 * untouched. Every refusal is collected and thrown in one
 * AssumptionDerivationError; the spread rule between a loan client rate and a
 * four-factor prepay on one family is enforced by refusal and never by moving a
 * value no op names.
 */
import { contentHash } from "../runtime/contentHash";
import {
  overlayKindOf,
  type AssumptionSet,
  type BehavioralOverlay,
  type OverlayBinding,
} from "../contracts/assumptions";
import type { DerivationChange, DerivationOp, DerivationOpKind, DerivationProblem } from "../contracts/derivation";
import type { DimensionPredicate } from "../contracts/dimensions";
import { checkOverlayParams, groupsOf, numberFieldsOf, PARAM_SCHEMAS, schemaKeyOf, valueAt } from "../contracts/paramSchema";
import { canonicalPredicate } from "../plan/dimensions";
import { bindAssumptions } from "./bindAssumptions";
import { checkClientRateSpread } from "./resolveAssumptions";

export const MAX_DERIVATION_OPS = 32;
export const DERIVED_ID_PREFIX = "derived-";
export const DEMONSTRATION_SUFFIX = " (demonstration values)";

const SPREAD_ADVICE = ". Move the total spread and the securitization or primary spread by the same bp in one derivation.";
const OP_KEYS: ReadonlySet<string> = new Set(["target", "path", "op", "value"]);
const TARGET_KEYS: ReadonlySet<string> = new Set(["familyId", "kind", "selector"]);
const OP_KINDS: ReadonlySet<string> = new Set(["add", "scale", "set"]);

/** Thrown when a derivation is refused; every problem found is listed. */
export class AssumptionDerivationError extends Error {
  readonly problems: DerivationProblem[];
  constructor(problems: DerivationProblem[]) {
    super(`derived set refused: ${problems.length} problem(s); every problem is listed: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "AssumptionDerivationError";
    this.problems = problems;
  }
}

export interface DeriveOptions {
  /** The derived set's id; default is derivedSetId(base, ops). */
  id?: string;
  /** The derived set's label; always carries "demonstration values" or ILLUSTRATIVE. */
  label?: string;
}

export interface DerivedSetResult {
  /** The derived set, bound (contentHash filled), carrying derivedFrom. */
  set: AssumptionSet;
  /** One row per (binding, path) touched, in first-touch order. */
  changes: DerivationChange[];
}

/** The default derived id: "derived-" plus 12 hex of the hash of base id, base bindings hash and normalized ops. */
export function derivedSetId(baseId: string, baseContentHash: string, ops: readonly DerivationOp[]): string {
  return DERIVED_ID_PREFIX + contentHash({ baseId, baseContentHash, ops }).slice(0, 12);
}

const round12 = (v: number): number => {
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r;
};

const q = (s: unknown): string => JSON.stringify(typeof s === "string" ? s : String(s));

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** A selector the stack's key can read: an object of tag -> string | non-empty string list, at least one tag. */
function selectorShapeOk(v: unknown): v is DimensionPredicate {
  if (!isPlainObject(v)) return false;
  const entries = Object.entries(v);
  if (entries.length === 0) return false;
  return entries.every(([, x]) => (typeof x === "string" && x.length > 0) || (Array.isArray(x) && x.length > 0 && x.every((y) => typeof y === "string" && y.length > 0)));
}

function setAt(root: Record<string, unknown>, path: string, value: number): void {
  const steps = path.split(".");
  let at = root;
  for (let i = 0; i < steps.length - 1; i++) at = at[steps[i]!] as Record<string, unknown>;
  at[steps[steps.length - 1]!] = value;
}

const selectorClause = (selector: DimensionPredicate | undefined): string =>
  selector === undefined ? "" : ` selector ${canonicalPredicate(selector)}`;

interface ParsedOp {
  op: DerivationOp;
  bindingIndex: number;
}

export function deriveAssumptionSet(base: AssumptionSet, ops: readonly unknown[], options: DeriveOptions = {}): DerivedSetResult {
  // (a) The base must bind; its validation error propagates unchanged.
  const boundBase = bindAssumptions(base);
  const baseHash = boundBase.contentHash!;

  // (b) Stage 1: shape and address of every op.
  const problems: DerivationProblem[] = [];
  const add = (at: string, message: string): void => void problems.push({ at, message });
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new AssumptionDerivationError([{ at: "ops", message: "a derivation needs at least one op" }]);
  }
  if (ops.length > MAX_DERIVATION_OPS) {
    throw new AssumptionDerivationError([{ at: "ops", message: `at most ${MAX_DERIVATION_OPS} ops; got ${ops.length}` }]);
  }
  const keyOf = (familyId: string, kind: string, selector: DimensionPredicate | undefined): string =>
    `${familyId}::${kind}::${canonicalPredicate(selector)}`;
  const parsed: ParsedOp[] = [];
  ops.forEach((raw, i) => {
    const at = `ops[${i}]`;
    if (!isPlainObject(raw)) {
      add(at, `${at}: an op must be an object carrying target, path, op and value`);
      return;
    }
    let ok = true;
    for (const k of Object.keys(raw)) {
      if (!OP_KEYS.has(k)) {
        add(at, `${at}: unknown field ${q(k)}; an op carries target, path, op and value`);
        ok = false;
      }
    }
    // Target and binding.
    let binding: OverlayBinding | undefined;
    let bindingIndex = -1;
    const t = raw.target;
    let targetOk = false;
    if (isPlainObject(t) && typeof t.familyId === "string" && t.familyId !== "" && typeof t.kind === "string" && t.kind !== "") {
      targetOk = true;
      for (const k of Object.keys(t)) {
        if (!TARGET_KEYS.has(k)) {
          add(at, `${at}: unknown target field ${q(k)}; a target carries familyId, kind and selector`);
          targetOk = false;
        }
      }
      if (t.selector !== undefined && !selectorShapeOk(t.selector)) {
        add(at, `${at}: target selector must be an object of tag -> string or string list, naming at least one tag`);
        targetOk = false;
      }
    } else {
      add(at, `${at}: target must name a familyId and a kind`);
    }
    if (targetOk) {
      const tt = t as { familyId: string; kind: string; selector?: DimensionPredicate };
      const want = keyOf(tt.familyId, tt.kind, tt.selector);
      const hits: number[] = [];
      base.bindings.forEach((b, k) => {
        if (keyOf(b.familyId, overlayKindOf(b.overlay), b.selector) === want) hits.push(k);
      });
      const where = `kind ${q(tt.kind)} on family ${q(tt.familyId)}${tt.selector === undefined ? "" : ` with selector ${canonicalPredicate(tt.selector)}`}`;
      if (hits.length === 0) {
        add(at, `${at}: no binding of ${where} in set ${q(base.id)}`);
      } else if (hits.length > 1) {
        add(at, `${at}: ${hits.length} bindings of ${where} match; a derivation cannot say which one to change`);
      } else {
        bindingIndex = hits[0]!;
        binding = base.bindings[bindingIndex]!;
        if (binding.overlay.kind === "registered") {
          add(
            at,
            `${at}: family ${q(binding.familyId)} binds registered kind ${q(binding.overlay.registeredKind)}; a registered overlay's params belong to its plugin and cannot be derived`,
          );
          binding = undefined;
        }
      }
    }
    // Path.
    if (binding !== undefined) {
      const allowed = numberFieldsOf(binding.overlay).map((f) => f.path);
      // A field of an optional group the binding does not carry is named as such.
      const overlay = binding.overlay;
      const absentGroup = typeof raw.path === "string" && !allowed.includes(raw.path)
        ? groupsOf(overlay).find((g) => valueAt(overlay, g.key) === undefined && g.fields.some((f) => f.path === raw.path))
        : undefined;
      if (absentGroup !== undefined) {
        add(at, `${at}: ${q(raw.path)} is a field of the optional group ${absentGroup.label}, which this binding does not carry`);
        binding = undefined;
      } else if (typeof raw.path !== "string" || !allowed.includes(raw.path)) {
        const label = PARAM_SCHEMAS[schemaKeyOf(binding.overlay)!].label;
        add(at, `${at}: ${q(raw.path)} is not a number parameter of ${label}`);
        binding = undefined;
      }
    }
    // Op kind and value.
    const opKind = raw.op;
    if (typeof opKind !== "string" || !OP_KINDS.has(opKind)) {
      add(at, `${at}: op must be add, scale or set; got ${q(opKind)}`);
      ok = false;
    }
    const value = raw.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      add(at, `${at}: value must be a finite number`);
      ok = false;
    } else if (opKind === "scale" && value < 0) {
      add(at, `${at}: a scale factor must be at least 0; got ${String(value)}`);
      ok = false;
    }
    if (!ok || binding === undefined) return;
    const target: DerivationOp["target"] = { familyId: binding.familyId, kind: overlayKindOf(binding.overlay) };
    if (binding.selector !== undefined) target.selector = JSON.parse(JSON.stringify(binding.selector)) as DimensionPredicate;
    parsed.push({
      op: { target, path: raw.path as string, op: opKind as DerivationOpKind, value: value as number },
      bindingIndex,
    });
  });
  if (problems.length > 0) throw new AssumptionDerivationError(problems);
  const normalized = parsed.map((p) => p.op);

  // (c) The id is fixed here so the spread text can carry it.
  const id = options.id ?? derivedSetId(base.id, baseHash, normalized);

  // (d) Stage 2: apply every op in order on a deep clone, then check every built-in binding.
  const bindings = JSON.parse(JSON.stringify(base.bindings)) as OverlayBinding[];
  const touched = new Map<string, { bindingIndex: number; path: string; from: number; ops: number[] }>();
  parsed.forEach(({ op: o, bindingIndex }, i) => {
    const overlay = bindings[bindingIndex]!.overlay as unknown as Record<string, unknown>;
    const old = valueAt(overlay, o.path) as number;
    const next = o.op === "set" ? o.value : o.op === "add" ? round12(old + o.value) : round12(old * o.value);
    setAt(overlay, o.path, next === 0 ? 0 : next);
    const key = `${bindingIndex}|${o.path}`;
    const row = touched.get(key);
    if (row === undefined) touched.set(key, { bindingIndex, path: o.path, from: old, ops: [i] });
    else row.ops.push(i);
  });
  bindings.forEach((b, k) => {
    if (b.overlay.kind === "registered") return;
    for (const issue of checkOverlayParams(b.overlay)) {
      add(
        `bindings[${k}].overlay.${issue.path}`,
        `${b.familyId} ${overlayKindOf(b.overlay)}${selectorClause(b.selector)}: ${issue.label} ${issue.message}`,
      );
    }
  });

  // (e) Stage 3: the client-rate spread rule on every whole-family pair, by refusal.
  const clientIdx: number[] = [];
  const prepayIdx: number[] = [];
  bindings.forEach((b, k) => {
    if (b.selector !== undefined) return;
    if (b.overlay.kind === "loan-client-rate") clientIdx.push(k);
    else if (b.overlay.kind === "prepay") prepayIdx.push(k);
  });
  for (const c of clientIdx) {
    for (const p of prepayIdx) {
      const cb = bindings[c]!;
      const pb = bindings[p]!;
      if (cb.familyId !== pb.familyId) continue;
      try {
        checkClientRateSpread(
          id,
          cb.familyId,
          cb.overlay as Extract<BehavioralOverlay, { kind: "loan-client-rate" }>,
          pb.overlay as Extract<BehavioralOverlay, { kind: "prepay" }>,
        );
      } catch (e) {
        add(`bindings[${c}].overlay.totalSpreadBp`, (e as Error).message + SPREAD_ADVICE);
      }
    }
  }

  // (i) The change rows, from the values after every op.
  const changes: DerivationChange[] = [...touched.values()].map((row) => {
    const b = bindings[row.bindingIndex]!;
    const field = numberFieldsOf(b.overlay).find((f) => f.path === row.path)!;
    const change: DerivationChange = {
      bindingIndex: row.bindingIndex,
      familyId: b.familyId,
      kind: overlayKindOf(b.overlay),
      path: row.path,
      label: field.label,
      unit: field.unit,
      from: row.from,
      to: valueAt(b.overlay, row.path) as number,
      ops: row.ops,
    };
    if (b.selector !== undefined) change.selector = JSON.parse(JSON.stringify(b.selector)) as DimensionPredicate;
    return change;
  });

  // (f) Stage 4: an op list that changes nothing is refused.
  if (!changes.some((c) => c.from !== c.to)) {
    add("ops", `the ops change no value; the derived set would bind what ${base.id} binds`);
  }
  // (g)
  if (problems.length > 0) throw new AssumptionDerivationError(problems);

  // (h) The label rule, then the final bind.
  const given = typeof options.label === "string" ? options.label.trim() : "";
  const label =
    given === ""
      ? `Behavioral shock on ${base.id}${DEMONSTRATION_SUFFIX}`
      : /demonstration|illustrative/i.test(given)
        ? given
        : given + DEMONSTRATION_SUFFIX;
  let set: AssumptionSet;
  try {
    set = bindAssumptions({
      schemaVersion: base.schemaVersion,
      id,
      label,
      bindings,
      // The base's macro mapping, verbatim; no derive op touches it.
      ...(base.macroBindings !== undefined ? { macroBindings: structuredClone(base.macroBindings) } : {}),
      derivedFrom: { baseId: base.id, baseContentHash: baseHash, ops: JSON.parse(JSON.stringify(normalized)) as DerivationOp[] },
    });
  } catch (e) {
    throw new AssumptionDerivationError([{ at: "set", message: (e as Error).message }]);
  }
  return { set, changes };
}
