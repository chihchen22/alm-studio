// apps/studio/src/rows/basisLabel.ts
/**
 * The balance sheet basis label of a stored run (spec v3.1 Sections 5.4 and 6.1), read from the run's own record and
 * never from a setup. The record is the run's `request.json` `{ plan, scenarios }`; the plan document is the stored
 * `planDocument` (it names the balance plan ids the request carries only as hashes) or null.
 *
 * The grouping and wording are the server's (`basisLabelOf` in apps/server/src/workspaces/setupCompile.ts): a run
 * whose scenarios agree reads as one phrase; a mixed run reads one phrase per group, in first-appearance order. The
 * workspace runs route serves that label for every attached run (`WorkspaceRunRow.basisLabel`); this copy labels the
 * runs the route does not cover and the envelope read when no row is at hand.
 */
import type { RunResult } from "@alm/engine";

export interface RunRecordForLabel {
  plan?: {
    balanceBasis?: { kind: string };
    balancePlanHash?: string;
    scenarioBalancePlanHashes?: Record<string, string>;
  };
  scenarios: Array<{ id: string; newBusiness?: { mode: "static" | "dynamic" } }>;
}

export interface PlanDocumentForLabel {
  balancePlan?: string;
  scenarioBalancePlans?: Record<string, string>;
}

type Group = { key: string; name: string; plan?: string; ids: string[] };

const PLAN_NOT_STORED = "plan id not stored";

/** The label of one run: one whole-run phrase when every scenario agrees, else one phrase per group. */
export function basisLabelOf(record: RunRecordForLabel, planDocument: PlanDocumentForLabel | null): string {
  const plan = record.plan ?? {};
  const groups: Group[] = [];
  for (const s of record.scenarios) {
    let name: string;
    let planId: string | undefined;
    const mode = s.newBusiness?.mode ?? "static";
    if (plan.scenarioBalancePlanHashes?.[s.id] !== undefined) {
      name = "Custom dynamic";
      planId = planDocument?.scenarioBalancePlans?.[s.id] ?? planDocument?.balancePlan ?? PLAN_NOT_STORED;
    } else if (mode === "static") {
      name = "Runoff";
    } else if (plan.balancePlanHash !== undefined) {
      name = "Custom dynamic";
      planId = planDocument?.balancePlan ?? PLAN_NOT_STORED;
    } else if (plan.balanceBasis !== undefined) {
      name = "Flat";
    } else {
      name = "Own dynamic strategy";
    }
    const key = `${name}\u0000${planId ?? ""}`;
    const group = groups.find((g) => g.key === key);
    if (group === undefined) groups.push({ key, name, ...(planId !== undefined ? { plan: planId } : {}), ids: [s.id] });
    else group.ids.push(s.id);
  }
  if (groups.length === 1) {
    const g = groups[0]!;
    if (g.name === "Flat") return "Flat (simple top-up)";
    if (g.name === "Runoff") return "Runoff";
    if (g.name === "Custom dynamic") return `Custom dynamic (${g.plan})`;
  }
  return groups.map((g) => `${g.name} on ${g.ids.join(", ")}${g.plan !== undefined ? ` (${g.plan})` : ""}`).join(", ");
}

export const UNRECORDED_DYNAMIC = "Dynamic new business (basis not recorded on this envelope)";

/**
 * The label read off a stored envelope alone, for a run no workspace row labels. The envelope carries the balance
 * plan hashes in provenance and, since contract 24, a `newBusiness` arm on every dynamic scenario; it does not carry
 * the Flat stamp, so a dynamic scenario with no plan hash is reported as not recorded, never guessed to be Flat.
 */
export function envelopeBasisLabel(result: RunResult): string {
  const prov = (result as Partial<RunResult>).provenance;
  const scenarios = result.nii?.byScenario ?? [];
  const hashes = prov?.scenarioBalancePlanHashes ?? {};
  const planHash = prov?.balancePlanHash;
  const unused = (result.notImplemented ?? []).some((t) => t.layer === "plan.balance-plan.unused");
  const hasArm = (s: (typeof scenarios)[number]): boolean => s.newBusiness !== undefined || s.shortfalls !== undefined;
  const anyArm = scenarios.some(hasArm);
  let unknown = false;
  const rows = scenarios.map((s) => {
    const own = hashes[s.scenarioId] !== undefined;
    // A plan-level balance plan feeds every scenario that carries no rules of its own. An envelope from before the
    // arm existed has no arms at all: then the plan-level hash alone says the run was dynamic.
    const planned = !own && planHash !== undefined && !unused && (hasArm(s) || !anyArm);
    const dynamic = own || planned || hasArm(s);
    if (dynamic && !own && !planned) unknown = true;
    return { id: s.scenarioId, newBusiness: { mode: (dynamic ? "dynamic" : "static") as "static" | "dynamic" } };
  });
  if (unknown) return UNRECORDED_DYNAMIC;
  return basisLabelOf(
    {
      plan: { ...(planHash !== undefined && !unused ? { balancePlanHash: planHash } : {}), ...(Object.keys(hashes).length > 0 ? { scenarioBalancePlanHashes: hashes } : {}) },
      scenarios: rows,
    },
    null,
  );
}

/** Which standing note a label calls for: the Flat disclosure, the Runoff banner, or both on a mixed run. */
export function basisKinds(label: string | null): { flat: boolean; runoff: boolean; dynamic: boolean } {
  if (label === null || label === "") return { flat: false, runoff: false, dynamic: false };
  const flat = label.startsWith("Flat") || label.includes(", Flat ");
  const runoff = label === "Runoff" || label.includes("Runoff on ");
  return { flat, runoff, dynamic: label !== "Runoff" };
}
