// apps/studio/src/pages/plan/loadPlan.ts
/** Plan route reads: the stored plans and the plugin catalog. Nothing is computed. */
import { getPluginCatalog, listRunPlans, type PluginCatalogReply, type RunPlanMeta } from "@alm/reader";

export async function loadPlanPage(): Promise<{ plans: RunPlanMeta[]; catalog: PluginCatalogReply }> {
  const [plans, catalog] = await Promise.all([listRunPlans(), getPluginCatalog()]);
  return { plans, catalog };
}

export function defaultPlanId(plans: RunPlanMeta[], bookId: string | null, requested: string | undefined): string | null {
  if (requested !== undefined && plans.some((p) => p.id === requested)) return requested;
  return plans.find((p) => bookId !== null && p.positionBook === bookId)?.id ?? plans[0]?.id ?? null;
}
