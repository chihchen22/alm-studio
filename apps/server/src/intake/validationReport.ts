/**
 * Shared portfolio validation and the 422 error shape.
 *
 * Validation is the point of the intake layer, and it is total: every check
 * runs over every row and ALL failures come back together, each naming the row
 * and the field. A practitioner importing a real book needs the complete error
 * list, not the first failure.
 *
 * Two validation planes run here, in order:
 *
 *   1. Structural and referential checks driven by the GENERATED column
 *      contract (types, enums, finiteness, id discipline, COA integrity,
 *      the family-to-instrument mapping).
 *   2. DRY INSTANTIATION: every structurally clean position is constructed
 *      through the engine's instrument factory so kernel domain errors (a
 *      non-finite rate, an impossible term, a bad behavioral parameter block)
 *      surface at import time with the offending position id attached, rather
 *      than at minute 40 of a run. Kernel messages pass through verbatim; the
 *      platform never rewrites an engine refusal into something softer.
 *
 * A floating-loan may carry rateIndexId (JSON intake only; the CSV
 * contract has no such column). Its shape is checked here; a missing index is
 * the run's refusal. The dry instantiation runs on the terms without it.
 *
 * The engine-side types (a swap on a "derivative" family, a cd cohort book and an
 * off-balance-sheet commitment) are admitted on both paths, checked field by field (engineTerms.ts) and then by the
 * engine's own validator, whose refusal is reported against the field its code names. `fundingTenorMonths` and
 * `linearDecay` are read by the engine, so they are checked fields, never "unrecognized"; a `liquidityRole` tag must
 * be one of the stress ladder's six roles.
 */
import type { ChartOfAccounts, PortfolioSpec, Position, PositionTerms } from "@alm/engine";
import { isRateIndexId, validateDimensions, withoutRateIndex } from "@alm/engine";
import { makeInstrument } from "@alm/engine/src/runtime/instrumentFactory";
import { markCdTerms } from "@alm/engine/src/cd/corrections";
import { seasoningRefusals } from "@alm/engine/src/portfolio/seasoning";
import { getCsvColumnContract, type TermsContract } from "./columnContract";
import {
  ENGINE_OBJECT_FIELDS,
  ENGINE_TERMS_COLUMNS,
  ENGINE_TERMS_TYPES,
  engineDomainError,
  engineFieldErrors,
  extensionFieldErrors,
  isEngineTermsType,
  liquidityRoleErrors,
  type EngineTermsType,
} from "./engineTerms";

/** One validation failure. `row` and `column` are present when they apply. */
export interface RowError {
  /** Row locator: CSV physical line number, or 1-based index into positions[]. */
  row?: number;
  /** The position the error belongs to, when known. */
  positionId?: string;
  /** Field or CSV column name, when the error is field-scoped. */
  column?: string;
  message: string;
}

/** Successful parse: the validated portfolio plus loud, non-fatal notes. */
export interface IntakeSuccess {
  portfolio: PortfolioSpec;
  warnings: string[];
}

/** Failed parse: every error found, never just the first. */
export interface IntakeFailure {
  errors: RowError[];
}

export type IntakeResult = IntakeSuccess | IntakeFailure;

/** Store-safe id shape (ids double as filenames in the platform store). */
export const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Piece 8 refused every swap at intake with this sentence. Studio slice S3a-1 admits swaps on both paths, so
 * no refusal carries it any more; it is kept for the record of what changed.
 */
export const SWAPS_SEED_ONLY =
  "interest rate swaps are seed-only in this release: neither POST /api/portfolios/import nor the " +
  "CSV path admits a swap family or a swap position";

/** The one rule joining a "derivative" family and the swap type, both ways. */
export const DERIVATIVE_IS_SWAP =
  'a "derivative" family holds swaps and only swaps: its instrumentType is "swap", and a swap family\'s side is "derivative"';

/** The row error for rateIndexId on any terms type but floating-loan. */
export const RATE_INDEX_FLOATING_ONLY =
  "rateIndexId is read on floating-loan terms only; a swap's floating leg stays on the one-month benchmark";

const ISO_DATE =/^\d{4}-\d{2}-\d{2}$/;

/** Shape intake errors as the platform's 422 body. */
export function toValidationResponse(errors: RowError[]): {
  error: { code: "VALIDATION"; message: string; detail: { errors: RowError[] } };
} {
  return {
    error: {
      code: "VALIDATION",
      message: `import rejected: ${errors.length} validation error${errors.length === 1 ? "" : "s"}`,
      detail: { errors },
    },
  };
}

/** Every number reachable inside `value` must be finite; report each offender. */
function checkDeepFinite(
  value: unknown,
  pathLabel: string,
  report: (path: string, actual: string) => void,
): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) report(pathLabel, String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkDeepFinite(v, `${pathLabel}[${i}]`, report));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      checkDeepFinite(v, `${pathLabel}.${k}`, report);
    }
  }
}

export interface ValidatePortfolioOptions {
  /**
   * Maps a position's 0-based index in positions[] to the reported row number.
   * The CSV path supplies physical line numbers; the JSON path defaults to the
   * 1-based array index.
   */
  rowOf?: (positionIndex: number) => number;
}

/**
 * Validate a structurally complete PortfolioSpec: portfolio header, COA
 * integrity, per-position referential and scalar checks from the generated
 * contract, then dry instantiation of every clean position. Returns ALL
 * errors plus warnings for lawful-but-notable content.
 */
export function validatePortfolioSpec(
  spec: PortfolioSpec,
  options: ValidatePortfolioOptions = {},
): { errors: RowError[]; warnings: string[] } {
  const errors: RowError[] = [];
  const warnings: string[] = [];
  const rowOf = options.rowOf ?? ((i: number) => i + 1);
  const contract = getCsvColumnContract();
  const contractByType = new Map<string, TermsContract>(
    contract.contracts.map((c) => [c.termsType, c]),
  );

  // --- Portfolio header ------------------------------------------------------
  if (typeof spec.id !== "string" || !ID_PATTERN.test(spec.id)) {
    errors.push({
      column: "id",
      message: `portfolio id ${JSON.stringify(spec.id)} must match ${ID_PATTERN} (ids double as store filenames)`,
    });
  }
  if (typeof spec.label !== "string" || spec.label.trim().length === 0) {
    errors.push({ column: "label", message: "portfolio label must be a non-empty string" });
  }
  if (typeof spec.asOf !== "string" || !ISO_DATE.test(spec.asOf) || Number.isNaN(Date.parse(spec.asOf))) {
    errors.push({
      column: "asOf",
      message: `asOf ${JSON.stringify(spec.asOf)} must be an ISO date (YYYY-MM-DD)`,
    });
  }

  // --- Chart of accounts -----------------------------------------------------
  const coaErrors = validateCoa(spec.coa);
  errors.push(...coaErrors);
  const nodeById = new Map(spec.coa.nodes.map((n) => [n.id, n]));
  const familyById = new Map(spec.coa.families.map((f) => [f.id, f]));

  // --- Positions -------------------------------------------------------------
  const seenIds = new Map<string, number>();
  for (let i = 0; i < spec.positions.length; i++) {
    const p = spec.positions[i];
    const row = rowOf(i);
    const positionId = typeof p.id === "string" ? p.id : undefined;
    let clean = true;
    const push = (e: Omit<RowError, "row" | "positionId">) => {
      errors.push({ row, positionId, ...e });
      clean = false;
    };

    if (typeof p.id !== "string" || !ID_PATTERN.test(p.id)) {
      push({ column: "position_id", message: `position id ${JSON.stringify(p.id)} must match ${ID_PATTERN}` });
    } else if (seenIds.has(p.id)) {
      push({
        column: "position_id",
        message: `duplicate position id "${p.id}" (first seen at row ${seenIds.get(p.id)})`,
      });
    } else {
      seenIds.set(p.id, row);
    }

    const fam = typeof p.familyId === "string" ? familyById.get(p.familyId) : undefined;
    if (!fam) {
      push({
        column: "family_id",
        message: `familyId ${JSON.stringify(p.familyId)} is not declared in coa.families`,
      });
    } else if (fam.side === "derivative") {
      if (fam.instrumentType !== "swap") {
        push({ column: "family_id", message: `family "${fam.id}" has side "derivative" but instrumentType "${fam.instrumentType}"; ${DERIVATIVE_IS_SWAP}` });
      }
    } else if (fam.side !== "asset" && fam.side !== "liability") {
      push({
        column: "family_id",
        message: `family "${fam.id}" has side "${fam.side}"; positions may only attach to asset or liability families`,
      });
    }

    const node = typeof p.coaNodeId === "string" ? nodeById.get(p.coaNodeId) : undefined;
    if (!node) {
      push({
        column: "coa_node_id",
        message: `coaNodeId ${JSON.stringify(p.coaNodeId)} is not a node in the chart of accounts`,
      });
    } else if (!node.isLeaf) {
      push({
        column: "coa_node_id",
        message: `coaNodeId "${p.coaNodeId}" is a summation node; positions attach only to leaf nodes`,
      });
    } else if (fam && fam.coaNodeId !== p.coaNodeId) {
      push({
        column: "coa_node_id",
        message: `coaNodeId "${p.coaNodeId}" does not match family "${fam.id}"'s declared leaf "${fam.coaNodeId}"`,
      });
    }

    // Terms: contract-driven scalar checks.
    const terms = p.terms as unknown;
    if (terms === null || typeof terms !== "object") {
      push({ column: "terms", message: "terms must be an object" });
      continue;
    }
    const t = terms as Record<string, unknown>;
    const termsType = t.type;
    // An engine-side type takes its own branch (engineTerms.ts) on the kernel contract's shared fields.
    if (isEngineTermsType(termsType)) {
      if (validateEngineTerms(termsType, t, fam, positionId, push, warnings, row, contract.baseColumns) && clean) {
        for (const r of seasoningRefusals({ positions: [p] })) {
          errors.push({ row, positionId, column: "originationOffsetMonths", message: r.message });
        }
      }
      continue;
    }
    const tc = typeof termsType === "string" ? contractByType.get(termsType) : undefined;
    if (!tc) {
      push({
        column: "terms_type",
        message: `terms.type ${JSON.stringify(termsType)} is not one of the instrument types intake reads (${[...contractByType.keys(), ...ENGINE_TERMS_TYPES].join(", ")})`,
      });
      continue;
    }
    if (fam && fam.instrumentType !== tc.termsType) {
      push({
        column: "terms_type",
        message: `terms.type "${tc.termsType}" contradicts family "${fam.id}"'s instrumentType "${fam.instrumentType}" (mapping)`,
      });
    }
    if (positionId !== undefined && t.id !== positionId) {
      push({
        column: "terms.id",
        message: `terms.id ${JSON.stringify(t.id)} must equal the position id "${positionId}"`,
      });
    }

    const knownFields = new Set<string>(["id", "type"]);
    for (const col of [...contract.baseColumns, ...tc.columns]) {
      knownFields.add(col.name);
      const v = t[col.name];
      if (v === undefined) {
        if (col.required) {
          push({ column: col.name, message: `required field "${col.name}" is missing` });
        }
        continue;
      }
      if (col.kind === "number") {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          push({
            column: col.name,
            message: `field "${col.name}" must be a finite number, got ${JSON.stringify(v)}`,
          });
        }
      } else if (col.kind === "enum") {
        if (typeof v !== "string" || !col.enumValues!.includes(v)) {
          push({
            column: col.name,
            message: `field "${col.name}" must be one of ${col.enumValues!.join(" | ")}, got ${JSON.stringify(v)}`,
          });
        }
      } else if (typeof v !== "string") {
        push({
          column: col.name,
          message: `field "${col.name}" must be a string, got ${JSON.stringify(v)}`,
        });
      }
    }
    for (const block of tc.paramBlocks) {
      knownFields.add(block.field);
      const v = t[block.field];
      if (v === null || typeof v !== "object" || Array.isArray(v)) {
        push({
          column: block.field,
          message: `field "${block.field}" (${block.typeName}) must be an object`,
        });
        continue;
      }
      checkDeepFinite(v, block.field, (pathLabel, actual) =>
        push({
          column: block.field,
          message: `non-finite number at terms.${pathLabel}: ${actual}`,
        }),
      );
    }
    // A floating loan may name a market rate index. Intake checks the
    // field's shape only; whether the run's market carries the index is the run's
    // refusal, because the market is not known at import time. On any other
    // terms type the field is an error, never a warning: an author must not
    // believe a swap or a fixed loan floats on the named index.
    if (t.rateIndexId !== undefined) {
      if (tc.termsType === "floating-loan") {
        knownFields.add("rateIndexId");
        if (!isRateIndexId(t.rateIndexId)) {
          push({
            column: "rateIndexId",
            message:
              'field "rateIndexId" must be a rate index id of lowercase letters, digits and single hyphens, ' +
              "starting with a letter, at most 40 characters; got " + JSON.stringify(t.rateIndexId),
          });
        }
      } else {
        push({ column: "rateIndexId", message: RATE_INDEX_FLOATING_ONLY });
      }
    }
    // The house-price group is engine-only. It reaches a mortgage's terms
    // from the assumption set's four-factor binding, and only for a mapped family;
    // a raw key on any position is a row error before the dry instantiation.
    if (t.housing !== undefined) {
      knownFields.add("housing");
      push({
        column: "housing",
        message: 'field "housing" is engine-only: a house-price response comes from the assumption set\'s four-factor prepay binding and its macro mapping, never from position terms',
      });
    }
    // A mortgage's midpoint offset is read by a four-factor prepay overlay
    // (EngineMortgageTerms), so it is a known field there and a row error anywhere else.
    if (t.prepayMidpointOffsetBp !== undefined) {
      knownFields.add("prepayMidpointOffsetBp");
      const v = t.prepayMidpointOffsetBp;
      if (tc.termsType !== "mortgage") {
        push({
          column: "prepayMidpointOffsetBp",
          message: 'field "prepayMidpointOffsetBp" applies to mortgage terms only: it moves the midpoint of a four-factor prepay overlay',
        });
      } else if (typeof v !== "number" || !Number.isFinite(v)) {
        push({
          column: "prepayMidpointOffsetBp",
          message: `field "prepayMidpointOffsetBp" must be a finite number of basis points, got ${JSON.stringify(v)}`,
        });
      } else if (Math.abs(v) > 500) {
        // A cohort's note sits a few tens of basis points off its family's; 500bp is far past that and catches a unit slip.
        push({
          column: "prepayMidpointOffsetBp",
          message: `field "prepayMidpointOffsetBp" must lie between -500 and 500 basis points, got ${v}`,
        });
      }
    }
    // The two engine-extension fields a position may carry itself are read by the engine: checked, never
    // reported as unread.
    for (const k of extensionFieldErrors(tc.termsType, t, (column, message) => push({ column, message }))) knownFields.add(k);
    const unknown = Object.keys(t).filter((k) => !knownFields.has(k));
    if (unknown.length > 0) {
      warnings.push(
        `position "${positionId ?? `#${row}`}": unrecognized terms field${unknown.length === 1 ? "" : "s"} ${unknown
          .map((k) => `"${k}"`)
          .join(", ")} stored verbatim, ignored by the engine`,
      );
    }

    // Dry instantiation, only for rows that are structurally clean: the kernel
    // constructor is the domain authority, and its message passes through
    // verbatim with the position id attached.
    if (clean) {
      try {
        // The factory refuses a named index it was not given a table for, and
        // intake has no market: dry-instantiate the terms the kernel owns.
        // A `walk` in the file is never read, so the dry instantiation drops it too.
        const dry = withoutRateIndex(p.terms as PositionTerms);
        makeInstrument(dry.type === "cd" ? markCdTerms(dry, undefined) : dry);
      } catch (err) {
        errors.push({
          row,
          positionId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      // Studio blank path D4: the seasoning re-anchor the run applies is the engine's
      // seasoningOffsetOf; a position it refuses would import, validate, then fail the run.
      // Its message passes through verbatim, against the offset column.
      for (const r of seasoningRefusals({ positions: [p] })) {
        errors.push({ row, positionId, column: "originationOffsetMonths", message: r.message });
      }
    }
  }

  // --- Dimension bag (D1 to D4) ---------------------------------------
  // The engine owns the rules; intake only reshapes each problem into the row
  // error every other intake refusal already uses. A taxonomy-level problem
  // carries no position, so it reports against the taxonomy column instead.
  const flagged = new Set<string>();
  for (const p of validateDimensions(spec)) {
    if (p.positionIndex !== undefined) flagged.add(`${p.positionIndex}::${p.dimension}`);
    errors.push({
      ...(p.positionIndex !== undefined ? { row: rowOf(p.positionIndex) } : {}),
      ...(p.positionId !== undefined ? { positionId: p.positionId } : {}),
      column: p.positionIndex === undefined ? `taxonomy.${p.dimension}` : `dimensions.${p.dimension}`,
      message: `${p.rule}: ${p.message}`,
    });
  }
  // A liquidityRole tag the stress ladder cannot read, unless the engine's tag rules already named that cell.
  spec.positions.forEach((p, i) => {
    if (flagged.has(`${i}::liquidityRole`)) return;
    for (const message of liquidityRoleErrors(p, familyById.get(p.familyId))) {
      errors.push({ row: rowOf(i), ...(typeof p.id === "string" ? { positionId: p.id } : {}), column: "dimensions.liquidityRole", message });
    }
  });

  return { errors, warnings };
}

/**
 * The checks for one engine-side position: the family maps to the type, every shared and type-specific field
 * has its type, the object fields have their shape, then the engine's own validator, whose refusal names its field.
 * Returns true when the position is clean (the seasoning check then runs, as for a kernel type).
 */
function validateEngineTerms(
  type: EngineTermsType,
  t: Record<string, unknown>,
  fam: ChartOfAccounts["families"][number] | undefined,
  positionId: string | undefined,
  pushRow: (e: Omit<RowError, "row" | "positionId">) => void,
  warnings: string[],
  row: number,
  baseColumns: TermsContract["columns"],
): boolean {
  let clean = true;
  const push = (column: string, message: string) => {
    pushRow({ column, message });
    clean = false;
  };
  if (fam && fam.instrumentType !== type) {
    push("terms_type", `terms.type "${type}" contradicts family "${fam.id}"'s instrumentType "${fam.instrumentType}" (mapping)`);
  }
  if (positionId !== undefined && t.id !== positionId) {
    push("terms.id", `terms.id ${JSON.stringify(t.id)} must equal the position id "${positionId}"`);
  }
  const known = new Set<string>(["id", "type", ...ENGINE_OBJECT_FIELDS[type]]);
  for (const col of [...baseColumns, ...ENGINE_TERMS_COLUMNS[type]]) {
    known.add(col.name);
    const v = t[col.name];
    if (v === undefined) {
      if (col.required) push(col.name, `required field "${col.name}" is missing`);
      continue;
    }
    if (col.name === "side" || col.name === "amortType") continue; // engineFieldErrors states each type's own rule
    if (col.kind === "number" && (typeof v !== "number" || !Number.isFinite(v))) push(col.name, `field "${col.name}" must be a finite number, got ${JSON.stringify(v)}`);
    else if (col.kind === "enum" && (typeof v !== "string" || !col.enumValues!.includes(v))) push(col.name, `field "${col.name}" must be one of ${col.enumValues!.join(" | ")}, got ${JSON.stringify(v)}`);
    else if (col.kind === "string" && typeof v !== "string") push(col.name, `field "${col.name}" must be a string, got ${JSON.stringify(v)}`);
  }
  engineFieldErrors(type, t, push);
  // S3a-1 follow-up: a stated side must be the family's (the cd book's and the book balance's side is optional).
  if ((type === "non-rate-sensitive" || type === "cd") && t.side !== undefined && fam !== undefined && (fam.side === "asset" || fam.side === "liability") && t.side !== fam.side) {
    push("side", `field "side" ${JSON.stringify(t.side)} contradicts family "${fam.id}"'s side "${fam.side}"`);
  }
  if (t.rateIndexId !== undefined) {
    known.add("rateIndexId");
    push("rateIndexId", RATE_INDEX_FLOATING_ONLY);
  }
  const unknown = Object.keys(t).filter((k) => !known.has(k));
  if (unknown.length > 0) {
    warnings.push(
      `position "${positionId ?? `#${row}`}": unrecognized terms field${unknown.length === 1 ? "" : "s"} ${unknown.map((k) => `"${k}"`).join(", ")} stored verbatim, not read by the engine`,
    );
  }
  if (!clean) return false;
  const domain = engineDomainError(type, t);
  if (domain !== null) {
    push(domain.column, domain.message);
    return false;
  }
  return true;
}

function validateCoa(coa: ChartOfAccounts): RowError[] {
  const errors: RowError[] = [];
  const contract = getCsvColumnContract();
  // Family-level instrument types: the CSV row contract's kernel types plus the engine-side arms (a cd cohort book,
  // W3-A2b; a commitment, piece 7; a swap), each admitted at intake since Studio slice S3a-1.
  const knownTypes = new Set<string>([...contract.contracts.map((c) => c.termsType), ...ENGINE_TERMS_TYPES]);

  if (!Array.isArray(coa.nodes) || coa.nodes.length === 0) {
    errors.push({ column: "coa.nodes", message: "coa.nodes must be a non-empty array" });
    return errors;
  }
  if (!Array.isArray(coa.families) || coa.families.length === 0) {
    errors.push({ column: "coa.families", message: "coa.families must be a non-empty array" });
    return errors;
  }

  const nodeIds = new Set<string>();
  for (const n of coa.nodes) {
    if (typeof n.id !== "string" || !ID_PATTERN.test(n.id)) {
      errors.push({ column: "coa.nodes", message: `coa node id ${JSON.stringify(n.id)} must match ${ID_PATTERN}` });
      continue;
    }
    if (nodeIds.has(n.id)) {
      errors.push({ column: "coa.nodes", message: `duplicate coa node id "${n.id}"` });
    }
    nodeIds.add(n.id);
  }
  for (const n of coa.nodes) {
    if (n.parentId !== null && !nodeIds.has(n.parentId)) {
      errors.push({
        column: "coa.nodes",
        message: `coa node "${n.id}" references missing parent "${n.parentId}"`,
      });
    }
  }

  const nodeById = new Map(coa.nodes.map((n) => [n.id, n]));
  const familyIds = new Set<string>();
  for (const f of coa.families) {
    if (typeof f.id !== "string" || !ID_PATTERN.test(f.id)) {
      errors.push({ column: "coa.families", message: `family id ${JSON.stringify(f.id)} must match ${ID_PATTERN}` });
      continue;
    }
    if (familyIds.has(f.id)) {
      errors.push({ column: "coa.families", message: `duplicate family id "${f.id}"` });
    }
    familyIds.add(f.id);
    if ((f.instrumentType === "swap") !== (f.side === "derivative")) {
      errors.push({
        column: "coa.families",
        message: `family "${f.id}" declares side "${f.side}" and instrumentType "${f.instrumentType}"; ${DERIVATIVE_IS_SWAP}`,
      });
    } else if (f.instrumentType === "commitment" && f.side !== "asset") {
      errors.push({
        column: "coa.families",
        message: `family "${f.id}" declares instrumentType "commitment" with side "${f.side}"; a committed line is extended by the bank, so its family's side is "asset" (the line stays off the balance sheet)`,
      });
    } else if (!knownTypes.has(f.instrumentType)) {
      errors.push({
        column: "coa.families",
        message: `family "${f.id}" declares unknown instrumentType ${JSON.stringify(f.instrumentType)} (known: ${[...knownTypes].join(", ")})`,
      });
    }
    const leaf = nodeById.get(f.coaNodeId);
    if (!leaf) {
      errors.push({
        column: "coa.families",
        message: `family "${f.id}" references missing coa node "${f.coaNodeId}"`,
      });
    } else if (!leaf.isLeaf) {
      errors.push({
        column: "coa.families",
        message: `family "${f.id}" attaches to summation node "${f.coaNodeId}"; families attach to leaf nodes`,
      });
    }
  }

  return errors;
}

/** Re-export for callers that only need the position shape. */
export type { Position };
