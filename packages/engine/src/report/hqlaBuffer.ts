/**
 * The HQLA buffer, shared by the liquidity metrics: the family
 * classifier piece 5b wrote for `survival-horizon`, moved here unchanged, plus
 * the per-level buffer and the US Level 2 caps the two LCR metrics apply.
 *
 * `survival-horizon` reads the UNCAPPED buffer, the sum of the three levels;
 * the caps are LCR rules, not buffer rules.
 *
 * A family is a buffer family when it is an ASSET and every one of its
 * positions carries the same known `hqla-level`. The classifier returns
 * undefined when ANY family cannot be separated at family grain (mixed tagged
 * and untagged positions, two levels, an unknown level or a list value, a
 * tagged non-asset family): the caller then reports no keys.
 */
import type { PortfolioSpec } from "../contracts/position";
import type { FamilyCashflows } from "../contracts/results";

/** The position tag that marks a buffer asset. */
export const HQLA_DIMENSION = "hqla-level";

/**
 * The public LCR haircuts per level. DEMONSTRATION conventions, not
 * calibrated; changing a value is a code change and a new test expectation.
 */
export const HQLA_HAIRCUT: Readonly<Record<string, number>> = { l1: 0, l2a: 0.15, l2b: 0.5 };

type Level = "l1" | "l2a" | "l2b";

export type BufferClass = { kind: "buffer"; level: Level; haircut: number } | { kind: "other" };

export interface BufferLevels {
  l1: number;
  l2a: number;
  l2b: number;
}

export function classifyBufferFamilies(
  book: PortfolioSpec,
  haircut: Readonly<Record<string, number>> = HQLA_HAIRCUT,
): Map<string, BufferClass> | undefined {
  const tally = new Map<string, { tagged: number; untagged: number; levels: Set<string> }>();
  for (const pos of book.positions) {
    const t = tally.get(pos.familyId) ?? { tagged: 0, untagged: 0, levels: new Set<string>() };
    const raw = pos.dimensions?.[HQLA_DIMENSION];
    if (raw === undefined) {
      t.untagged += 1;
    } else {
      t.tagged += 1;
      // A list value is not a single level; JSON keeps it from matching one.
      t.levels.add(typeof raw === "string" ? raw : JSON.stringify(raw));
    }
    tally.set(pos.familyId, t);
  }
  const out = new Map<string, BufferClass>();
  for (const def of book.coa.families) {
    const t = tally.get(def.id);
    if (t === undefined || t.tagged === 0) {
      out.set(def.id, { kind: "other" });
      continue;
    }
    const level = t.levels.size === 1 ? [...t.levels][0]! : undefined;
    // Own keys only: a level such as "constructor" must not reach the prototype.
    const cut = level !== undefined && Object.hasOwn(haircut, level) ? haircut[level] : undefined;
    if (def.side !== "asset" || t.untagged > 0 || cut === undefined) return undefined;
    out.set(def.id, { kind: "buffer", level: level as Level, haircut: cut });
  }
  return out;
}

export function hasBufferFamily(classes: ReadonlyMap<string, BufferClass>): boolean {
  return [...classes.values()].some((c) => c.kind === "buffer");
}

/** Post-haircut as-of balance per level. A family the classes do not name is skipped. */
export function bufferLevels(
  families: readonly FamilyCashflows[],
  classes: ReadonlyMap<string, BufferClass>,
): BufferLevels {
  const levels: BufferLevels = { l1: 0, l2a: 0, l2b: 0 };
  for (const fam of families) {
    const cls = classes.get(fam.familyId);
    if (cls === undefined || cls.kind !== "buffer") continue;
    levels[cls.level] += (fam.series.balance[0] ?? 0) * (1 - cls.haircut);
  }
  return levels;
}

/**
 * The US Level 2 caps (12 CFR 249.21) on post-haircut levels: Level 2 at most
 * 40 percent of HQLA, Level 2B at most 15 percent. The adjustment is the LARGER
 * of the two excesses, never their sum. Exact fractions, not 0.6667 and 0.1765.
 * The unwind of secured funding and collateral swaps is not modeled.
 */
export function cappedHqla(levels: BufferLevels): number {
  const { l1, l2a, l2b } = levels;
  const excess2B = Math.max(0, l2b - (15 / 85) * (l1 + l2a));
  const excess2 = Math.max(0, l2a + l2b - (2 / 3) * l1);
  return l1 + l2a + l2b - Math.max(excess2B, excess2);
}
