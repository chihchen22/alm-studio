// apps/studio/src/__tests__/fixtures/run.ts
/** Run page fixtures (Studio S3a): small stored plans and a fetch mock with a status per route. */
import { vi } from "vitest";
import type { RunPlan } from "@alm/engine";

type StageIn = { id: string; component: string; dependsOn?: string[] };

export function planDoc(planId: string, stages: StageIn[], book = "synthetic-2500-v1"): RunPlan {
  return {
    schemaVersion: "1.4.0",
    planId,
    label: `Plan ${planId}`,
    authoredBy: "person",
    asOf: "2026-03-31",
    grid: { horizonMonths: 360 },
    inputs: { marketSnapshot: "market-public-2026-03-31", positionBook: book, routingPolicy: "model-map-default-v1", assumptionSets: ["demo-behavioral-v1"] },
    stages: stages.map((s) => ({ kind: "metric", consumes: [], produces: [], ...s })) as RunPlan["stages"],
    scenarios: [{ ref: "regulatory-grid-v1#S0" }],
    reports: [],
    validationRules: { typeGate: ["T1"], routingGate: ["R1"] },
  };
}

const STAGES: StageIn[] = [
  { id: "st-curve", component: "alm-yield-curve" },
  { id: "st-cashflow", component: "engine.contractual", dependsOn: ["st-curve"] },
  { id: "st-ftp", component: "engine.metric.ftp", dependsOn: ["st-curve", "st-cashflow"] },
];

export const SEEDED = planDoc("plan-synthetic-2500-v1", STAGES);
export const EDITED = planDoc(
  "plan-synthetic-2500-v1-edit-1",
  STAGES.map((s) => (s.id === "st-ftp" ? { ...s, component: "alm-ftp" } : s)),
);

/**
 * Stub fetch: the first key the URL contains answers, with its status (200 by
 * default). List longer keys first: "/api/run-plans/plan-x" also contains
 * "/api/run-plans".
 */
export function mockFetch(table: Array<[string, unknown, number?]>) {
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
    const url = String(input);
    const hit = table.find(([k]) => url.includes(k));
    if (!hit) return new Response(JSON.stringify({ error: { code: "not-found", message: `no fixture for ${url}` } }), { status: 404 });
    return new Response(JSON.stringify(hit[1]), { status: hit[2] ?? 200, headers: { "content-type": "application/json" } });
  }));
}
