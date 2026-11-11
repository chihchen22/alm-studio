/**
 * The effective bag and the intake checks (spec Sections 2.2 and 4.1).
 *
 * dimensionsOf is the ONE function every reader of a bag calls: the intake
 * validator, the selector matcher, the routing gate and provenance. It is pure
 * and allocates one small object per call, so a caller that loops 100k
 * positions computes it once per position per run, never per binding.
 *
 * validateDimensions returns every problem rather than the first: intake
 * reports all rows, as it does for the term checks.
 */
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import {
  DERIVED_DIMENSION_IDS,
  type DimensionBag,
  type DimensionDef,
  type DimensionTaxonomy,
} from "../contracts/dimensions";
import { BEHAVIORAL_CLASS_IDS } from "../contracts/plan";
import type { PortfolioSpec, Position } from "../contracts/position";

export interface DimensionProblem {
  rule: "D1" | "D2" | "D3" | "D4";
  /** 0-based index into positions[]; absent for a taxonomy-level problem. */
  positionIndex?: number;
  positionId?: string;
  dimension: string;
  value?: string;
  message: string;
}

/**
 * The derived tags a position may never author. behavioralClasses is derived
 * too, but a position contributes its own classes to the union, so it is the
 * one derived id an authored bag may carry. Exported since piece 2d: the CSV
 * intake path decides which `dim.<id>` columns are legal, and it must read the
 * same set rule D2 refuses against rather than a second copy of it.
 */
export const UNAUTHORABLE_DIMENSION_IDS: ReadonlySet<string> = new Set(
  DERIVED_DIMENSION_IDS.filter((d) => d !== "behavioralClasses"),
);
const CLASS_IDS: ReadonlySet<string> = new Set(BEHAVIORAL_CLASS_IDS);

/** D1: the taxonomy itself. */
function validateTaxonomy(tax: DimensionTaxonomy): DimensionProblem[] {
  const out: DimensionProblem[] = [];
  const seen = new Set<string>();
  for (const d of tax.dimensions) {
    if (typeof d.id !== "string" || d.id.length === 0) {
      out.push({ rule: "D1", dimension: String(d.id), message: "dimension id must be a non-empty string" });
      continue;
    }
    if (seen.has(d.id)) out.push({ rule: "D1", dimension: d.id, message: `dimension "${d.id}" is declared twice` });
    seen.add(d.id);
    if (d.id === "behavioralClasses") {
      if (d.multiValued !== true) {
        out.push({ rule: "D1", dimension: d.id, message: `"behavioralClasses" must be declared multiValued: true` });
      }
      for (const v of d.values ?? []) {
        if (!CLASS_IDS.has(v)) {
          out.push({ rule: "D1", dimension: d.id, value: v, message: `"behavioralClasses" value "${v}" is not a behavioral class id (${[...CLASS_IDS].join(", ")})` });
        }
      }
    }
    for (const v of d.values ?? []) {
      if (typeof v !== "string" || v.length === 0) out.push({ rule: "D1", dimension: d.id, value: String(v), message: `dimension "${d.id}" declares an empty value` });
    }
  }
  return out;
}

/** D2 to D4: one position's authored bag against the taxonomy. */
function validateBag(
  bag: DimensionBag,
  defs: ReadonlyMap<string, DimensionDef>,
  hasTaxonomy: boolean,
  positionIndex: number,
  positionId: string,
): DimensionProblem[] {
  const out: DimensionProblem[] = [];
  for (const [dim, raw] of Object.entries(bag)) {
    const at = { positionIndex, positionId, dimension: dim };
    if (UNAUTHORABLE_DIMENSION_IDS.has(dim)) {
      out.push({ rule: "D2", ...at, message: `"${dim}" is derived from the family and may not be authored on a position` });
      continue;
    }
    const def = defs.get(dim);
    if (def === undefined) {
      out.push({ rule: "D2", ...at, message: hasTaxonomy ? `tag "${dim}" is not declared in the taxonomy` : `tag "${dim}" carried by a book that declares no taxonomy` });
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (Array.isArray(raw) && def.multiValued !== true) {
      out.push({ rule: "D4", ...at, message: `tag "${dim}" is single-valued; got a list of ${raw.length}` });
      continue;
    }
    for (const v of values) {
      if (typeof v !== "string" || v.length === 0) {
        out.push({ rule: "D3", ...at, value: String(v), message: `tag "${dim}" carries an empty value` });
      } else if (def.values !== undefined && !def.values.includes(v)) {
        out.push({ rule: "D3", ...at, value: v, message: `tag "${dim}" value "${v}" is not one of [${def.values.join(", ")}]` });
      } else if (dim === "behavioralClasses" && !CLASS_IDS.has(v)) {
        out.push({ rule: "D3", ...at, value: v, message: `"behavioralClasses" value "${v}" is not a behavioral class id` });
      }
    }
  }
  return out;
}

export function validateDimensions(spec: PortfolioSpec): DimensionProblem[] {
  const out: DimensionProblem[] = [];
  const tax = spec.taxonomy;
  if (tax !== undefined) out.push(...validateTaxonomy(tax));
  const defs = new Map<string, DimensionDef>((tax?.dimensions ?? []).map((d) => [d.id, d]));
  for (let i = 0; i < spec.positions.length; i++) {
    const p = spec.positions[i]!;
    if (p.dimensions === undefined) continue;
    out.push(...validateBag(p.dimensions, defs, tax !== undefined, i, p.id));
  }
  return out;
}

/**
 * The effective bag: authored tags, then the three derived ones on top. The
 * class list is the union of the family's declared classes and the position's
 * own, in that order, de-duplicated.
 */
export function dimensionsOf(
  position: Position,
  family: ProductFamilyDef,
  _taxonomy: DimensionTaxonomy | undefined,
): DimensionBag {
  const authored = position.dimensions ?? {};
  const own = authored.behavioralClasses;
  const ownList = own === undefined ? [] : Array.isArray(own) ? own : [own];
  const classes: string[] = [];
  for (const c of [...(family.behavioralClasses ?? []), ...ownList]) if (!classes.includes(c)) classes.push(c);
  const bag: DimensionBag = { ...authored, productFamily: family.id, side: family.side, behavioralClasses: classes };
  return bag;
}
