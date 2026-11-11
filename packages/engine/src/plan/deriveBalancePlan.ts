/**
 * deriveBalancePlan: a balance shock as a pure, explicit
 * derivation of one BalancePlan from another.
 *
 * Each op addresses one listed target by familyId, plus an optional knot month,
 * and adds to, scales or sets that target's balance. add and scale results are
 * rounded to 12 significant digits, which removes float noise (100000000 x 1.1)
 * without losing real precision; set stores the value exactly. Ops apply in
 * order, on a deep clone, and compose. No op touches new-business pricing, the
 * as-of date, the target list or the knot list.
 *
 * The result is an ordinary BalancePlan carrying an additive `derivedFrom`
 * record. Before it returns, every target is lowered through the unchanged
 * lowerBalancePlan against the named book, so a plan this function returns is
 * a plan that lowers on that book (a different book, bound later, is lowered
 * again at compile and may be refused). Every refusal is collected and thrown
 * in one BalancePlanDerivationError, in two stages: shape and address of every
 * op first (thrown before anything applies), then the derived values and the
 * lowering. Engine refusal texts pass through verbatim.
 *
 * Additive: the kernel, the run path, lowerBalancePlan and compile are
 * untouched, and no run path imports this module.
 */
import type { BalancePlan } from "../contracts/balancePlan";
import type { BalanceKnotChange, BalancePlanDerivedFrom, BalanceShockOp } from "../contracts/balanceDerivation";
import type { DerivationOpKind, DerivationProblem } from "../contracts/derivation";
import type { ProductFamilyId } from "../contracts/ids";
import type { NewBusinessRule } from "../contracts/scenario";
import { contentHash } from "../runtime/contentHash";
import { DEMONSTRATION_SUFFIX, MAX_DERIVATION_OPS } from "../scenario/deriveAssumptionSet";
import { BalancePlanUnsupported, lowerBalancePlan } from "./lowerBalancePlan";

export const BALANCE_DERIVED_ID_PREFIX = "derived-bp-";

const OP_KEYS: ReadonlySet<string> = new Set(["target", "op", "value"]);
const TARGET_KEYS: ReadonlySet<string> = new Set(["familyId", "month"]);
const OP_KINDS: ReadonlySet<string> = new Set(["add", "scale", "set"]);
/** A balance shock never reaches new-business pricing; these keys get one dedicated refusal. */
const PRICING_KEYS: ReadonlySet<string> = new Set(["newBusinessPricing", "spreadOverIndexBp", "termMonths"]);

/** What the derivation needs of a book: its as-of date and the notional of each position. A PortfolioSpec satisfies it. */
export interface DerivationBook {
  asOf: string;
  positions: ReadonlyArray<{ familyId: string; terms: { notional: number } }>;
}

export interface BalancePlanDeriveOptions {
  /** The book every target is lowered against (opening balances and as-of). */
  book: DerivationBook;
  /** The derived plan's id; default is derivedBalancePlanId(base id, base hash, ops). */
  id?: string;
  /** The derived plan's label; always carries "demonstration values" or "illustrative". */
  label?: string;
}

export interface BalancePlanDeriveResult {
  /** The derived plan, carrying derivedFrom. */
  plan: BalancePlan;
  /** One row per (target, knot) touched, in first-touch order. */
  changes: BalanceKnotChange[];
  /** The lowering of the derived plan against the book: what each family's new business will do. */
  rules: NewBusinessRule[];
}

/** Thrown when a derivation is refused; every problem found is listed. */
export class BalancePlanDerivationError extends Error {
  readonly problems: DerivationProblem[];
  constructor(problems: DerivationProblem[]) {
    super(`derived balance plan refused: ${problems.length} problem(s); every problem is listed: ${problems.map((p) => p.message).join("; ")}`);
    this.name = "BalancePlanDerivationError";
    this.problems = problems;
  }
}

/** The default derived id: "derived-bp-" plus 12 hex of the hash of base id, base hash and normalized ops. */
export function derivedBalancePlanId(baseId: string, baseContentHash: string, ops: readonly BalanceShockOp[]): string {
  return BALANCE_DERIVED_ID_PREFIX + contentHash({ baseId, baseContentHash, ops }).slice(0, 12);
}

const round12 = (v: number): number => {
  const r = Number(v.toPrecision(12));
  return r === 0 ? 0 : r;
};

const noNegZero = (v: number): number => (v === 0 ? 0 : v);

const q = (s: unknown): string => JSON.stringify(typeof s === "string" ? s : String(s));

const isPlainObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** The same per-family sum of notional as compile.ts's private openingBalances. */
function openingsOf(book: DerivationBook): Map<ProductFamilyId, number> {
  const out = new Map<ProductFamilyId, number>();
  for (const p of book.positions) out.set(p.familyId, (out.get(p.familyId) ?? 0) + p.terms.notional);
  return out;
}

interface ParsedOp {
  /** The normalized op, as stored in derivedFrom. */
  op: BalanceShockOp;
  targetIndex: number;
}

export function deriveBalancePlan(base: BalancePlan, ops: readonly unknown[], options: BalancePlanDeriveOptions): BalancePlanDeriveResult {
  // Stage 0: the op count, then a base the derivation can read. Thrown alone.
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new BalancePlanDerivationError([{ at: "ops", message: "a derivation needs at least one op" }]);
  }
  if (ops.length > MAX_DERIVATION_OPS) {
    throw new BalancePlanDerivationError([{ at: "ops", message: `at most ${MAX_DERIVATION_OPS} ops; got ${ops.length}` }]);
  }
  const readable =
    isPlainObject(base) &&
    base.schemaVersion === "1.0.0" &&
    Array.isArray(base.targets) &&
    base.targets.every((t) => isPlainObject(t) && Array.isArray(t.path));
  if (!readable) {
    const id = isPlainObject(base) ? String((base as { id?: unknown }).id) : String(base);
    throw new BalancePlanDerivationError([{ at: "base", message: `balance plan ${q(id)} is not a balance plan the derivation can read` }]);
  }
  // Studio A+E contract 20: the derived plan is assembled from base.targets, so
  // node targets would be dropped and every family under the node would run
  // off. Refused, never approximated, until an op can address a node target.
  if (Array.isArray(base.nodeTargets) && base.nodeTargets.length > 0) {
    throw new BalancePlanDerivationError([
      { at: "base", message: `balance plan ${q(base.id)} carries node targets; a balance shock addresses family targets only, so a plan with node targets cannot be derived` },
    ]);
  }

  // Stage 1: shape and address of every op, all collected, thrown before apply.
  const problems: DerivationProblem[] = [];
  const add = (at: string, message: string): void => void problems.push({ at, message });
  const parsed: ParsedOp[] = [];
  ops.forEach((raw, i) => {
    const at = `ops[${i}]`;
    if (!isPlainObject(raw)) {
      add(at, `${at}: an op must be an object carrying target, op and value`);
      return;
    }
    const targetRaw = raw.target;
    const targetObj = isPlainObject(targetRaw) ? targetRaw : undefined;
    let ok = true;
    // One pricing problem per op, however many pricing keys it carries; the
    // unknown-field loops below skip those keys so none is reported twice.
    if (Object.keys(raw).some((k) => PRICING_KEYS.has(k)) || (targetObj !== undefined && Object.keys(targetObj).some((k) => PRICING_KEYS.has(k)))) {
      add(at, `${at}: new-business pricing cannot be shocked; a balance shock changes the target balance path only`);
      ok = false;
    }
    for (const k of Object.keys(raw)) {
      if (!OP_KEYS.has(k) && !PRICING_KEYS.has(k)) {
        add(at, `${at}: unknown field ${q(k)}; an op carries target, op and value`);
        ok = false;
      }
    }
    if (targetObj !== undefined) {
      for (const k of Object.keys(targetObj)) {
        if (!TARGET_KEYS.has(k) && !PRICING_KEYS.has(k)) {
          add(at, `${at}: unknown target field ${q(k)}; a target carries familyId and month`);
          ok = false;
        }
      }
    }
    const familyId = targetObj?.familyId;
    let targetIndex = -1;
    let knotMonths: number[] = [];
    if (typeof familyId !== "string" || familyId === "") {
      add(at, `${at}: target must name a familyId`);
      ok = false;
    } else {
      const hits: number[] = [];
      base.targets.forEach((t, ti) => {
        if (t.familyId === familyId) hits.push(ti);
      });
      if (hits.length === 0) {
        add(at, `${at}: no target for family ${q(familyId)} in balance plan ${q(base.id)}; a balance shock changes a listed target and cannot add a family`);
        ok = false;
      } else if (hits.length > 1) {
        add(at, `${at}: ${hits.length} targets for family ${q(familyId)} in balance plan ${q(base.id)}; a derivation cannot say which one to change`);
        ok = false;
      } else {
        targetIndex = hits[0]!;
        knotMonths = base.targets[targetIndex]!.path.map((k) => k.month);
      }
    }
    const month = targetObj?.month;
    if (month !== undefined) {
      if (typeof month !== "number" || !Number.isInteger(month)) {
        add(at, `${at}: month must be a whole number naming a knot of the path`);
        ok = false;
      } else if (targetIndex >= 0 && !knotMonths.includes(month)) {
        add(at, `${at}: family ${q(familyId)} has no knot at month ${month}; its knots are at months ${knotMonths.join(", ")}, and a balance shock cannot add a knot`);
        ok = false;
      }
    }
    const kind = raw.op;
    if (typeof kind !== "string" || !OP_KINDS.has(kind)) {
      add(at, `${at}: op must be add, scale or set; got ${q(kind)}`);
      ok = false;
    }
    const value = raw.value;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      add(at, `${at}: value must be a finite number`);
      ok = false;
    } else if (kind === "scale" && value < 0) {
      add(at, `${at}: a scale factor must be at least 0; got ${value}`);
      ok = false;
    }
    if (kind === "set" && month === undefined) {
      add(at, `${at}: set needs a knot month; set changes one knot and never a whole path`);
      ok = false;
    }
    if (!ok) return;
    parsed.push({
      op: {
        target: month === undefined ? { familyId: familyId as string } : { familyId: familyId as string, month: month as number },
        op: kind as DerivationOpKind,
        value: noNegZero(value as number),
      },
      targetIndex,
    });
  });
  if (problems.length > 0) throw new BalancePlanDerivationError(problems);

  // Apply: on a deep clone, in order, composing. One change row per (target, knot), first touch first.
  const targets = JSON.parse(JSON.stringify(base.targets)) as BalancePlan["targets"];
  const changeAt = new Map<string, BalanceKnotChange>();
  const changes: BalanceKnotChange[] = [];
  parsed.forEach(({ op, targetIndex }, i) => {
    for (const knot of targets[targetIndex]!.path) {
      if (op.target.month !== undefined && knot.month !== op.target.month) continue;
      const key = `${targetIndex}:${knot.month}`;
      let row = changeAt.get(key);
      if (row === undefined) {
        row = { targetIndex, familyId: op.target.familyId, month: knot.month, from: knot.balance, to: knot.balance, ops: [] };
        changeAt.set(key, row);
        changes.push(row);
      }
      row.ops.push(i);
      knot.balance = noNegZero(op.op === "add" ? round12(knot.balance + op.value) : op.op === "scale" ? round12(knot.balance * op.value) : op.value);
      row.to = knot.balance;
    }
  });

  const normalized = parsed.map((p) => p.op);
  const baseHash = contentHash(base);
  const id = options.id ?? derivedBalancePlanId(base.id, baseHash, normalized);
  const given = typeof options.label === "string" ? options.label.trim() : "";
  const label =
    given === ""
      ? `Balance shock on ${base.id}${DEMONSTRATION_SUFFIX}`
      : /demonstration|illustrative/i.test(given)
        ? given
        : given + DEMONSTRATION_SUFFIX;
  const derivedFrom: BalancePlanDerivedFrom = { baseId: base.id, baseContentHash: baseHash, ops: JSON.parse(JSON.stringify(normalized)) as BalanceShockOp[] };
  const plan: BalancePlan = {
    schemaVersion: base.schemaVersion,
    id,
    label,
    asOf: base.asOf,
    targets,
    unlistedFamilies: base.unlistedFamilies,
    derivedFrom,
  };

  // Stage 2: the derived values, then the lowering. All collected.
  const bad = new Set<number>();
  plan.targets.forEach((t, ti) => {
    t.path.forEach((k, ki) => {
      if (!Number.isFinite(k.balance) || k.balance < 0) {
        add(`targets[${ti}].path[${ki}].balance`, `${t.familyId} month ${k.month}: the derived target balance is ${String(k.balance)}; a target balance must be finite and at least 0`);
        bad.add(ti);
      }
    });
  });
  if (!changes.some((c) => c.from !== c.to)) {
    add("ops", `the ops change no target balance; the derived plan would carry what balance plan ${q(base.id)} carries`);
  }
  const openings = openingsOf(options.book);
  const lowerStage = (): void => {
    // A horizon is not checked here: a balance plan has none, and knots past a
    // run's horizon stay refused when the plan is validated against that run.
    const horizon = Number.MAX_SAFE_INTEGER;
    const asOf = options.book.asOf;
    const recorded = (at: string, fn: () => unknown): boolean => {
      try {
        fn();
        return true;
      } catch (e) {
        if (!(e instanceof BalancePlanUnsupported)) throw e;
        add(at, e.message);
        return false;
      }
    };
    if (plan.asOf !== asOf) {
      recorded("book", () => lowerBalancePlan({ ...plan, targets: [] }, openings, horizon, asOf));
      return;
    }
    let allPass = true;
    plan.targets.forEach((t, ti) => {
      if (bad.has(ti)) return;
      if (!recorded(`targets[${ti}]`, () => lowerBalancePlan({ ...plan, targets: [t] }, openings, horizon, asOf))) allPass = false;
    });
    // The whole plan once, to catch what no single target shows (a family listed twice).
    if (allPass && bad.size === 0) recorded("targets", () => lowerBalancePlan(plan, openings, horizon, asOf));
  };
  lowerStage();
  if (problems.length > 0) throw new BalancePlanDerivationError(problems);

  const rules = lowerBalancePlan(plan, openings, Number.MAX_SAFE_INTEGER, options.book.asOf);
  return { plan, changes, rules };
}
