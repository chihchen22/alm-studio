/**
 * The macro mapping checks at bind (spec v4 Sections 5
 * and 7). An AssumptionSet's optional `macroBindings` maps one macro series to
 * the house-price response of one family's four-factor prepayment. The checks
 * run on the stored data alone; whether the market carries the series, and
 * whether the run's scenarios agree on the mapping, are the run entry's
 * (macro/runMacro.ts resolveRunMacro).
 */
import type { AssumptionSet } from "../contracts/assumptions";
import { MACRO_SERIES_ID_MAX_LENGTH, MACRO_SERIES_ID_PATTERN } from "../macro/macroFactors";
import { macroTargetKey } from "../macro/runMacro";
import { AssumptionValidationError } from "./assumptionValidationError";
import { validateSelector } from "./bindAssumptions";

/** A macro mapping the set cannot carry: shape, feeder, target, series count, or the housing group it needs. */
export class MacroMappingError extends AssumptionValidationError {
  constructor(field: string, detail: string) { super(field, detail); this.name = "MacroMappingError"; }
}

const BINDING_KEYS: ReadonlySet<string> = new Set(["seriesId", "feeder", "familyId", "selector"]);
const FEEDER = "prepay-housing";

/** The selector rule of bindAssumptions, its refusal restated as a MacroMappingError at the same field. */
function selectorOk(selector: unknown, field: string): void {
  try {
    validateSelector(selector, field);
  } catch (e) {
    if (!(e instanceof AssumptionValidationError)) throw e;
    throw new MacroMappingError(e.field, e.message.slice(`invalid assumption set at ${e.field}: `.length));
  }
}

/** Throws MacroMappingError on the first defect of `set.macroBindings`; a set without the field passes untouched. */
export function checkMacroBindings(set: AssumptionSet): void {
  const mb = (set as { macroBindings?: unknown }).macroBindings;
  if (mb === undefined) return;
  if (!Array.isArray(mb) || mb.length === 0) throw new MacroMappingError("macroBindings", "must be a non-empty list; omit the field for a set with no mapping");
  const seen = new Set<string>();
  const series: string[] = [];
  mb.forEach((raw: unknown, i) => {
    const at = `macroBindings[${i}]`;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new MacroMappingError(at, "must be an object carrying seriesId, feeder and familyId");
    const b = raw as Record<string, unknown>;
    for (const k of Object.keys(b)) {
      if (!BINDING_KEYS.has(k)) throw new MacroMappingError(at, `unknown field "${k}"; a macro binding carries seriesId, feeder, familyId and selector`);
    }
    const id = b.seriesId;
    if (typeof id !== "string" || id.length > MACRO_SERIES_ID_MAX_LENGTH || !MACRO_SERIES_ID_PATTERN.test(id)) {
      throw new MacroMappingError(`${at}.seriesId`, `must be a macro series id: lowercase letters, digits and single hyphens, starting with a letter, at most ${MACRO_SERIES_ID_MAX_LENGTH} characters`);
    }
    if (b.feeder !== FEEDER) throw new MacroMappingError(`${at}.feeder`, `unknown feeder "${String(b.feeder)}"; the one feeder is "${FEEDER}"`);
    if (typeof b.familyId !== "string" || b.familyId.length === 0) throw new MacroMappingError(`${at}.familyId`, "must be a non-empty string");
    if (b.selector !== undefined) selectorOk(b.selector, `${at}.selector`);
    const familyId = b.familyId;
    const key = macroTargetKey(familyId, b.selector as never);
    if (seen.has(key)) throw new MacroMappingError(at, `maps family "${familyId}" twice`);
    seen.add(key);
    const carries = set.bindings.some((x) =>
      x.overlay.kind === "prepay" && x.overlay.model === "four-factor-cpr" && x.overlay.housing !== undefined
      && macroTargetKey(x.familyId, x.selector) === key);
    if (!carries) throw new MacroMappingError(at, `maps family "${familyId}" to the house-price response, but its four-factor prepay binding carries no housing group`);
    if (!series.includes(id)) series.push(id);
  });
  if (series.length > 1) throw new MacroMappingError("macroBindings", `maps ${series.length} series (${series.join(", ")}); a run reads one series in 7b`);
}
