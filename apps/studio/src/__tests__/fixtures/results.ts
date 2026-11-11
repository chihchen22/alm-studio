// apps/studio/src/__tests__/fixtures/results.ts
/** Results fixtures (Studio S3a): the viewer's demo envelope (runResult.json), read only, and a run detail for it. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RunResult } from "@alm/engine";
import type { Bundle, RunDetail } from "@alm/reader";

const PATH = fileURLToPath(new URL("../../../../viewer/public/runResult.json", import.meta.url));
const BUNDLE = JSON.parse(readFileSync(PATH, "utf8")) as Bundle;

export const RESULT: RunResult = BUNDLE.runResult;
export const freshResult = (): RunResult => structuredClone(RESULT);

export const DETAIL: RunDetail = {
  runId: "run-fixture",
  state: "done",
  submittedAt: "2026-09-25T01:00:00Z",
  platformRequestHash: "req-hash",
  mode: "deterministic",
  label: "Fixture run",
  scenarios: BUNDLE.generatedFrom.scenarios,
  refs: { portfolioId: BUNDLE.generatedFrom.portfolioId, marketId: "market-public-2026-03-31", scenarioSlateId: "plan-plan-synthetic-2500-v1", assumptionSetIds: [] },
};
