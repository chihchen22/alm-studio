/**
 * Test helper: run one compiled setup row in this process the way the runner child runs a workspace launch
 * (`jobs/runnerEntry.ts`, deterministic arm): the launch's engine options through the run route's
 * `resolveEngineOptions` and the child's `pipelineOptionsOf`, the composed profile mounted over this box's catalog,
 * the compile's run log, profile hash and plan document on the context. Fixed timestamps and run id, so two runs of
 * the same inputs serialize to the same bytes.
 */
import { buildRunResult, resolveDefaultContext } from "@alm/engine/src/run";
import type { PortfolioSpec, RunResult } from "@alm/engine";
import { mountProfile } from "@alm/harness";
import { repoRoot } from "../config";
import { resolveEngineOptions } from "../http/routes/runs";
import { pipelineOptionsOf } from "../jobs/pipelineOptions";
import { loadOperatorPlugins, pluginConfigPath } from "../plugins/load";
import type { CompiledSetupRow } from "../workspaces/setupCompile";

const STAMP = "2026-10-18T00:00:00.000Z";

export function runCompiledRow(row: CompiledSetupRow, portfolio: PortfolioSpec, runId = "in-process"): RunResult {
  const operator = loadOperatorPlugins(pluginConfigPath(repoRoot()));
  const harness = mountProfile(row.profile, operator.catalog);
  try {
    const engineContext = resolveEngineOptions(row.engineOptions as never, row.request.grid.horizonMonths);
    return buildRunResult({ ...row.request, runId, timestamps: { startedAt: STAMP, finishedAt: STAMP } }, portfolio, {
      ...resolveDefaultContext(),
      ...pipelineOptionsOf(engineContext),
      harness,
      planRunLog: row.runLog,
      profileHash: row.profileHash,
      plan: row.planDocument,
    } as never);
  } finally {
    harness.dispose();
  }
}
