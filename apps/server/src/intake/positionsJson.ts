/**
 * JSON position intake: the canonical path.
 *
 * Accepts a full PortfolioSpec (contracts/position.ts): the COA travels with
 * the positions and the store keeps the spec verbatim after validation. This
 * module narrows the unknown request body to the PortfolioSpec shape with loud
 * per-field errors, then hands off to the shared validator
 * (validationReport.ts) for referential checks and dry instantiation.
 *
 * Note on non-finite numbers: JSON.parse cannot produce NaN, but it CAN
 * produce Infinity (e.g. the literal 1e999 overflows to Infinity). The shared
 * validator's finiteness checks catch that class.
 */
import type { PortfolioSpec } from "@alm/engine";
import { validatePortfolioSpec, type IntakeResult, type RowError } from "./validationReport";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Parse and validate an unknown request body as a PortfolioSpec. Returns the
 * validated portfolio plus warnings, or ALL errors found.
 */
export function parsePositionsJson(spec: unknown): IntakeResult {
  const errors: RowError[] = [];

  if (!isRecord(spec)) {
    return { errors: [{ message: "portfolio body must be a JSON object (a PortfolioSpec)" }] };
  }

  // Top-level shape gate: without these the sweep below has nothing to walk.
  if (!Array.isArray(spec.positions)) {
    errors.push({ column: "positions", message: "positions must be an array" });
  }
  if (!isRecord(spec.coa)) {
    errors.push({ column: "coa", message: "coa must be an object (ChartOfAccounts)" });
  } else {
    if (!Array.isArray((spec.coa as Record<string, unknown>).nodes)) {
      errors.push({ column: "coa.nodes", message: "coa.nodes must be an array" });
    }
    if (!Array.isArray((spec.coa as Record<string, unknown>).families)) {
      errors.push({ column: "coa.families", message: "coa.families must be an array" });
    }
  }
  if (errors.length > 0) return { errors };

  // Positions must be objects before the field-level sweep runs.
  const positions = spec.positions as unknown[];
  positions.forEach((p, i) => {
    if (!isRecord(p)) {
      errors.push({ row: i + 1, message: `positions[${i}] must be an object` });
    }
  });
  if (errors.length > 0) return { errors };

  const candidate = spec as unknown as PortfolioSpec;
  const { errors: deepErrors, warnings } = validatePortfolioSpec(candidate);
  if (deepErrors.length > 0) return { errors: deepErrors };
  return { portfolio: candidate, warnings };
}
