// apps/studio/src/format/scenarios.ts
/**
 * Scenario labels (ALM Studio): the label the EVE layer prints for a scenario,
 * formatted from its stored rateSpec, with the id as the fallback. Shared by the
 * Results tabs and the Dashboard view model, so no model imports a page module.
 *
 * The six SRP31 prescribed shocks are custom
 * knot vectors of eleven knots, which the reader would name "Custom (11 knots)",
 * the same for all six. Their stored label is the honest name, so for those six
 * ids, and only those, the stored label wins.
 */
import { formatScenarioLabel, type RunDetail } from "@alm/reader";
import { SRP31_USD } from "@alm/engine/src/scenario/library";

/** The ids the engine library writes for the six SRP31 shocks (scenario/library.ts). */
const SRP31_IDS: ReadonlySet<string> = new Set(SRP31_USD.scenarios.map((s) => s.id));

export function scenarioLabeller(detail: RunDetail): (id: string) => string {
  const map = new Map(detail.scenarios.map((s) => [s.id, s]));
  return (id) => {
    const meta = map.get(id);
    if (meta !== undefined && SRP31_IDS.has(id) && meta.rateSpec.kind === "custom" && meta.label !== "") return meta.label;
    return formatScenarioLabel(meta, id);
  };
}
