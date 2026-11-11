// apps/studio/src/results/newBusiness.tsx
/**
 * Which scenarios of a run carry new business (ALM Studio P2), read from stored
 * fields only: provenance.scenarioBalancePlanHashes names the mapped scenarios,
 * provenance.balancePlanHash says a plan-level balance plan was read, and the
 * compile tag plan.balance-plan.unused says no scenario took it. Which scenarios
 * took a plan-level plan is not stored, so nothing here infers it.
 */
import type { RunResult } from "@alm/engine";

export interface NewBusinessRead {
  /** Scenario ids in provenance.scenarioBalancePlanHashes, in stored key order. */
  mapped: string[];
  /** provenance.balancePlanHash is stored and no plan.balance-plan.unused tag says no scenario took it. */
  planLevel: boolean;
}

export function newBusinessRead(result: RunResult): NewBusinessRead | null {
  const p = (result as Partial<RunResult>).provenance;
  const mapped = Object.keys(p?.scenarioBalancePlanHashes ?? {});
  const unused = (result.notImplemented ?? []).some((t) => t.layer === "plan.balance-plan.unused");
  const planLevel = p?.balancePlanHash !== undefined && !unused;
  return mapped.length === 0 && !planLevel ? null : { mapped, planLevel };
}

/** The one note the NII table and the Dashboard print when a run carries new business. */
export function newBusinessNote(read: NewBusinessRead): string {
  const parts = ["Scenarios with a balance plan include new-business income. A scenario without one runs off unless it carries its own new-business rules, which the stored fields do not show. A difference between scenarios is then not rate sensitivity alone."];
  if (read.mapped.length > 0) parts.push("Marked New business: the scenarios provenance.scenarioBalancePlanHashes names.");
  if (read.planLevel) parts.push("The plan-level balance plan (provenance.balancePlanHash) feeds every scenario without its own balance plan or new-business rules; the stored fields do not name those scenarios, so they are not marked.");
  return parts.join(" ");
}

/** The FTP bridge note: the bridge reads the contractual book, NII the balance stage. Null when the base runs off. */
export function bridgeNote(read: NewBusinessRead | null, baseId: string): string | null {
  if (read === null) return null;
  if (read.mapped.includes(baseId)) {
    return `The base scenario runs a balance plan (provenance.scenarioBalancePlanHashes names ${baseId}): NII net includes new-business income and the bridge covers the contractual book only, so the two differ by that income.`;
  }
  if (read.planLevel) {
    return "This run names a plan-level balance plan (provenance.balancePlanHash). The base scenario takes it unless it carries its own new-business rules, which the stored fields do not show. If the base runs new business, NII net includes that income and the bridge covers the contractual book only, so the two differ by that income.";
  }
  return null;
}

/** The chip marking a mapped scenario; its title names the stored field. */
export function NewBusinessChip(props: { scenarioId: string }) {
  return <span className="chip" title={`provenance.scenarioBalancePlanHashes[${props.scenarioId}]`}>New business</span>;
}
