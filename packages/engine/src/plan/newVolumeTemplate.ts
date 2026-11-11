/**
 * The rule a new-volume product template must meet (behavior and deposits). Pure, with no kernel import, so the plan parser, the run setup parser and the Studio check a template by
 * the same function the tranche builder runs.
 */
import {
  FLOATING_INDEX_TENORS_MONTHS,
  type NewBusinessAmortization,
  type NewBusinessBehavior,
  type NewBusinessRateType,
  type NewBusinessTemplate,
} from "../contracts/scenario";

/** Default reinvestment tranche term when a rule omits termMonths. */
export const DEFAULT_NEW_BUSINESS_TERM_MONTHS = 60;

/** The longest term and swap tenor a template may name, in months (the grid's own cap). */
export const MAX_TEMPLATE_TERM_MONTHS = 360;

export const TEMPLATE_RATE_TYPES: readonly NewBusinessRateType[] = ["fixed", "floating", "deposit"];
export const TEMPLATE_AMORTIZATIONS: readonly NewBusinessAmortization[] = ["bullet", "level-pay", "linear", "decay"];
export const TEMPLATE_BEHAVIORS: readonly NewBusinessBehavior[] = ["family"];

/** The instrument types whose new volume is a deposit cohort: the non-interest-bearing and the beta deposit. */
export const DEPOSIT_INSTRUMENT_TYPES: readonly string[] = ["nmd", "nmd-b"];

/**
 * The first problem with a template, its term and (when given) its spread, in a sentence; null when it is one the
 * engine runs. The spread must be a finite number of basis points (fix round L3: a JSON 1e999 reads as Infinity).
 * A deposit template is { rateType "deposit", amortization "decay", indexTenorMonths 1, behavior "family" } at a
 * spread of 0 (its paid rate is the family's model); "decay" is a deposit's repayment only.
 */
export function newVolumeTemplateProblem(template: NewBusinessTemplate, termMonths: number, spreadOverIndexBp?: number): string | null {
  if (spreadOverIndexBp !== undefined && (typeof spreadOverIndexBp !== "number" || !Number.isFinite(spreadOverIndexBp))) {
    return `the spread must be a finite number of basis points, got ${String(spreadOverIndexBp)}`;
  }
  if (!TEMPLATE_RATE_TYPES.includes(template.rateType)) return `rateType must be one of ${TEMPLATE_RATE_TYPES.join(", ")}, got ${JSON.stringify(template.rateType)}`;
  if (!TEMPLATE_AMORTIZATIONS.includes(template.amortization)) return `amortization must be one of ${TEMPLATE_AMORTIZATIONS.join(", ")}, got ${JSON.stringify(template.amortization)}`;
  if (template.behavior !== undefined && !TEMPLATE_BEHAVIORS.includes(template.behavior)) {
    return `behavior must be "family" or left out, got ${JSON.stringify(template.behavior)}`;
  }
  if (!Number.isInteger(termMonths) || termMonths < 1 || termMonths > MAX_TEMPLATE_TERM_MONTHS) {
    return `the term must be a whole number of months from 1 to ${MAX_TEMPLATE_TERM_MONTHS}, got ${termMonths}`;
  }
  const n = template.indexTenorMonths;
  if (template.fixedIndex !== undefined && template.rateType !== "fixed") return `fixedIndex applies to a fixed template only`;
  if (template.fixedIndex !== undefined && template.fixedIndex !== "matched" && template.fixedIndex !== "swap") {
    return `fixedIndex must be "matched" or "swap", got ${JSON.stringify(template.fixedIndex)}`;
  }
  if (template.rateType === "deposit" || template.amortization === "decay") {
    if (template.rateType !== "deposit") return `a "decay" repayment belongs to a deposit template (rateType "deposit") only`;
    if (template.amortization !== "decay") return `a deposit template runs off by its family's decay model: amortization "decay", got ${JSON.stringify(template.amortization)}`;
    if (template.behavior !== "family") return `a deposit template carries its family's decay and repricing: behavior "family"`;
    if (n !== 1) return `a deposit template's paid rate reads the one-month rate: indexTenorMonths 1, got ${n}`;
    if (spreadOverIndexBp !== undefined && spreadOverIndexBp !== 0) {
      return `a deposit template pays its family's own rate, so its spread is 0 basis points, got ${spreadOverIndexBp}`;
    }
    return null;
  }
  if (template.rateType === "fixed") {
    if (!Number.isInteger(n) || n < 1 || n > MAX_TEMPLATE_TERM_MONTHS) {
      return `the swap tenor of a fixed template must be a whole number of months from 1 to ${MAX_TEMPLATE_TERM_MONTHS}, got ${n}`;
    }
    return null;
  }
  if (!FLOATING_INDEX_TENORS_MONTHS.includes(n)) {
    return `the index tenor of a floating template must be one of ${FLOATING_INDEX_TENORS_MONTHS.join(", ")} months, got ${n}`;
  }
  if (n > termMonths) return `the index tenor (${n} months) of a floating template is longer than its term (${termMonths} months)`;
  return null;
}
