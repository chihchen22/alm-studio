/**
 * Lowering of a balance plan onto the existing new-business rules. One rate per
 * family is the only shape NewBusinessRule carries, so a flat path becomes
 * reinvest "flat", a single geometric path from the opening balance becomes
 * reinvest "growth", and every other path is refused with a typed error naming
 * the family and the first knot that breaks the shape. Never approximated.
 *
 * Shape matching is relative at 1e-6, not tighter: a planner states knots in
 * whole dollars, and compounding a rate anchored on a rounded early knot out to
 * month 360 on a multi-million balance drifts by a few dollars. At 1e-9 those
 * dollar-rounded geometric paths were refused as non-geometric. The rate is
 * anchored on the last knot for the same reason: dividing by the largest month
 * damps the anchor knot's rounding error instead of compounding it.
 */
import { isNonRateFamily } from "../nonRate";
import type { BalancePlan, BalanceTarget } from "../contracts/balancePlan";
import type { ChartOfAccounts } from "../contracts/chartOfAccounts";
import type { ProductFamilyId } from "../contracts/ids";
import type { RunLogEntry } from "../contracts/runLog";
import type { NewBusinessRule } from "../contracts/scenario";

const REL_TOL = 1e-6;

/**
 * A balance plan the lowering will not execute. `familyId` is null for a
 * plan-level refusal belonging to no single target (the as-of check); the
 * per-target message format is unchanged, because the piece-1 tests pin it.
 */
export class BalancePlanUnsupported extends Error {
  readonly familyId: ProductFamilyId | null;
  readonly month: number | null;
  /** The compile's run log as far as it got, attached by compilePlan on the way out. */
  runLog?: RunLogEntry[];
  constructor(familyId: ProductFamilyId | null, month: number | null, detail: string) {
    super(`balance plan${familyId === null ? "" : ` target for family "${familyId}"`}${month === null ? "" : ` at month ${month}`}: ${detail}`);
    this.name = "BalancePlanUnsupported";
    this.familyId = familyId;
    this.month = month;
  }
}

/**
 * The families a node target covers (contract 20), in chart family order, split
 * by the allocation rule. A family at or under the node (walked by parentId to
 * the root) is eligible when its side is asset or liability and its opening
 * balance is strictly positive, the same rule the Flat basis applies. Every
 * other family under the node (a swap, an equity plug, a zero balance) is
 * skipped: it takes no share and gets no rule. A node the chart does not carry
 * covers nothing.
 */
export function nodeTargetCoverage(
  coaNodeId: string,
  coa: ChartOfAccounts,
  openingBalances: Map<ProductFamilyId, number>,
): { eligible: ProductFamilyId[]; skipped: ProductFamilyId[] } {
  const byId = new Map(coa.nodes.map((n) => [n.id, n] as const));
  const under = (id: string): boolean => {
    let cur = byId.get(id);
    while (cur) {
      if (cur.id === coaNodeId) return true;
      cur = cur.parentId === null ? undefined : byId.get(cur.parentId);
    }
    return false;
  };
  const eligible: ProductFamilyId[] = [];
  const skipped: ProductFamilyId[] = [];
  for (const f of coa.families) {
    if (!under(f.coaNodeId)) continue;
    // S3a-1 follow-up: a non-rate-sensitive family is held at book and takes no target.
    const onSide = (f.side === "asset" || f.side === "liability") && !isNonRateFamily(f);
    if (onSide && (openingBalances.get(f.id) ?? 0) > 0) eligible.push(f.id);
    else skipped.push(f.id);
  }
  return { eligible, skipped };
}

/**
 * Flat path -> reinvest "flat". Geometric path from the opening balance ->
 * reinvest "growth" at the implied monthly rate, anchored on the LAST knot so
 * the largest month divides that knot's rounding error. Anything else ->
 * refused, naming the first knot in path order that misses the implied path.
 *
 * Node targets (contract 20) expand first into family targets: each family at
 * or under the node on the asset or liability side with a positive opening
 * balance (nodeTargetCoverage) takes the node path scaled
 * by its share of the node's opening balance. Every knot scales by the same
 * share, so a flat node path lowers to flat family rules and a geometric node
 * path to one shared growth rate. The chart of accounts is required only when
 * the plan carries node targets.
 */
export function lowerBalancePlan(
  plan: BalancePlan,
  openingBalances: Map<ProductFamilyId, number>,
  horizonMonths: number,
  portfolioAsOf: string,
  coa?: ChartOfAccounts,
): NewBusinessRule[] {
  if (plan.asOf !== portfolioAsOf) {
    throw new BalancePlanUnsupported(
      null,
      null,
      `balance plan "${plan.id}" is as of ${plan.asOf} and the portfolio is as of ${portfolioAsOf}; ` +
        `a target path anchored on a different date would be lowered against the wrong opening balance`,
    );
  }
  const expanded: BalanceTarget[] = [...plan.targets];
  if (plan.nodeTargets !== undefined && plan.nodeTargets.length > 0) {
    if (coa === undefined) throw new BalancePlanUnsupported(null, null, `balance plan "${plan.id}" carries nodeTargets and no chart of accounts was supplied to allocate them`);
    const familyTargets = new Set(plan.targets.map((t) => t.familyId));
    for (const nt of plan.nodeTargets) {
      if (!coa.nodes.some((n) => n.id === nt.coaNodeId)) throw new BalancePlanUnsupported(null, null, `node target "${nt.coaNodeId}" names no chart-of-accounts node`);
      const fams = nodeTargetCoverage(nt.coaNodeId, coa, openingBalances).eligible;
      if (fams.length === 0) throw new BalancePlanUnsupported(null, null, `node target "${nt.coaNodeId}" covers no family with a positive opening balance on the asset or liability side`);
      const total = fams.reduce((s, f) => s + openingBalances.get(f)!, 0);
      for (const f of fams) {
        if (familyTargets.has(f)) throw new BalancePlanUnsupported(f, null, `family "${f}" is covered by more than one target (node "${nt.coaNodeId}" and its own row)`);
        const share = openingBalances.get(f)! / total;
        expanded.push({ familyId: f, path: nt.path.map((k) => ({ month: k.month, balance: k.balance * share })), newBusinessPricing: nt.newBusinessPricing });
      }
    }
  }
  const rules: NewBusinessRule[] = [];
  const seen = new Set<ProductFamilyId>();
  for (const t of expanded) {
    const famDef = coa?.families.find((f) => f.id === t.familyId);
    if (famDef !== undefined && isNonRateFamily(famDef)) {
      throw new BalancePlanUnsupported(t.familyId, null, `family "${t.familyId}" is non-rate-sensitive: it is held at book value and does not run off, so new volume has nothing to replace; leave it out of the plan`);
    }
    if (seen.has(t.familyId)) throw new BalancePlanUnsupported(t.familyId, null, "family appears in more than one target");
    seen.add(t.familyId);
    const open = openingBalances.get(t.familyId);
    if (open === undefined || !(open > 0)) throw new BalancePlanUnsupported(t.familyId, null, `family "${t.familyId}" has no opening balance in the book`);
    if (t.path.length === 0) throw new BalancePlanUnsupported(t.familyId, null, "path is empty");
    let prev = 0;
    for (const k of t.path) {
      if (!Number.isInteger(k.month) || k.month <= prev) throw new BalancePlanUnsupported(t.familyId, k.month, "months must be ascending integers starting at 1");
      if (k.month > horizonMonths) throw new BalancePlanUnsupported(t.familyId, k.month, `month ${k.month} exceeds horizon ${horizonMonths}`);
      if (!Number.isFinite(k.balance) || k.balance < 0) throw new BalancePlanUnsupported(t.familyId, k.month, "balance must be a finite non-negative number");
      prev = k.month;
    }
    // Ruling 11: a target ending at zero is a runoff instruction wearing a
    // target's clothes, and no single reinvest rate expresses it.
    const lastKnot = t.path[t.path.length - 1];
    if (lastKnot !== undefined && lastKnot.balance === 0) {
      throw new BalancePlanUnsupported(
        t.familyId,
        lastKnot.month,
        `target for family "${t.familyId}" ends at zero balance at month ${lastKnot.month}; ` +
          `omit the family from the plan to run it off (unlistedFamilies is "runoff")`,
      );
    }
    const base: Pick<NewBusinessRule, "familyId" | "spreadOverIndexBp" | "termMonths"> = {
      familyId: t.familyId,
      spreadOverIndexBp: t.newBusinessPricing.spreadOverIndexBp,
      termMonths: t.newBusinessPricing.termMonths,
    };
    const flat = t.path.every((k) => Math.abs(k.balance - open) <= REL_TOL * open);
    if (flat) { rules.push({ ...base, reinvest: "flat" }); continue; }
    const last = t.path[t.path.length - 1]!;
    const g = Math.pow(last.balance / open, 1 / last.month) - 1;
    for (const k of t.path) {
      const implied = open * Math.pow(1 + g, k.month);
      if (Math.abs(k.balance - implied) > REL_TOL * Math.max(1, implied)) {
        throw new BalancePlanUnsupported(t.familyId, k.month, `path is not a single geometric growth from the opening balance (implied ${implied}, got ${k.balance}); one rate per family is the only shape the new-business rule carries`);
      }
    }
    rules.push({ ...base, reinvest: "growth", monthlyGrowthRate: g });
  }
  return rules;
}
