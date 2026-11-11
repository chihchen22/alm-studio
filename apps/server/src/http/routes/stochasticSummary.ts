/**
 * Single-run stochastic summary routes.
 *
 *   GET /api/runs/:id/stochastic/summary       one stored stochastic envelope
 *                                              read by the engine's
 *                                              summarizeStochastic, as JSON
 *   GET /api/runs/:id/stochastic/summary.csv   the same rows as one long CSV
 *                                              table under the stochastic
 *                                              provenance header
 *
 * The server reads result.json and the request.json submission (portfolio and
 * market ids) and derives nothing itself. A distribution is a statistic
 * of the Monte Carlo path set, never an EVE or an NII. Neither route
 * sits under /api/runs/:id/export/, which serves deterministic tables only.
 *
 * The JSON reply carries the envelope's `gap` block verbatim when it is stored (additive, after `curve`);
 * the CSV is unchanged and never carries it.
 *
 * The JSON reply carries `curve`, the run's curve line
 * (export/curveLine.ts: the envelope's curveDefault stamp, else the stored request's setup, else
 * version 1), beside the engine's summary; the CSV carries its value in the `# curve` header row.
 */
import {
  summarizeStochastic,
  StochasticSummaryError,
  type StochasticRunResult,
  type StochasticRunSummary,
} from "@alm/engine";
import type { PlatformContext } from "../../context";
import type { RunStatus } from "../../jobs/types";
import { renderStochasticSummaryCsv, stochasticProvenanceOf } from "../../export/stochasticCsv";
import { storedRunCurveLine } from "../../export/curveLine";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import type { Router } from "../router";

interface StoredRequest {
  mode?: string;
  submission?: { portfolioId?: string; marketId?: string };
}

export function registerStochasticSummaryRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  /** request.json mode; a missing file or a missing field counts as deterministic. */
  const modeOf = (runId: string): string => {
    if (!store.runFileExists(runId, "request.json")) return "deterministic";
    return store.readRunJson<StoredRequest>(runId, "request.json").mode ?? "deterministic";
  };

  /** 404, then 400, then 409; then the engine's summary of the stored envelope. */
  const readSummary = (
    runId: string,
    what: string,
  ): { envelope: StochasticRunResult; summary: StochasticRunSummary } => {
    if (!store.runFileExists(runId, "status.json")) throw notFound(`run "${runId}" not found`);
    const mode = modeOf(runId);
    if (mode !== "stochastic") {
      throw badRequest(
        `run "${runId}" is a ${mode} run and has no stochastic envelope; its result is served at ` +
          `/api/runs/${runId}/result and its tables export at /api/runs/${runId}/export/<table>.csv. ` +
          `A ${what} exists only for a run submitted with mode: "stochastic".`,
      );
    }
    const status = store.readRunJson<RunStatus>(runId, "status.json");
    if (status.state !== "done") {
      throw conflict(`run "${runId}" is ${status.state}; a ${what} requires state "done"`);
    }
    const envelope = store.readRunJson<StochasticRunResult>(runId, "result.json");
    const sub = store.readRunJson<StoredRequest>(runId, "request.json").submission;
    const side = {
      envelope,
      ...(sub?.portfolioId !== undefined ? { portfolioId: sub.portfolioId } : {}),
      ...(sub?.marketId !== undefined ? { marketId: sub.marketId } : {}),
    };
    try {
      return { envelope, summary: summarizeStochastic(side) };
    } catch (err) {
      if (err instanceof StochasticSummaryError) {
        throw unprocessable(err.message, { error: err.name, field: err.field, value: err.value });
      }
      throw err;
    }
  };

  router.add("GET", "/api/runs/:id/stochastic/summary", (req) => {
    const runId = req.params.id;
    const { envelope, summary } = readSummary(runId, "stochastic summary");
    // The stored gap block, verbatim, when the envelope carries it (additive; absent writes no key, so a
    // reply without it is the bytes it always was). The CSV twin below never carries it: Studio builds the gap CSV.
    return {
      kind: "json",
      value: {
        ...summary,
        curve: storedRunCurveLine(store, runId, envelope)!,
        ...(envelope.gap !== undefined ? { gap: envelope.gap } : {}),
      },
    };
  });

  router.add("GET", "/api/runs/:id/stochastic/summary.csv", (req) => {
    const runId = req.params.id;
    const { envelope, summary } = readSummary(runId, "stochastic CSV");
    const csv = renderStochasticSummaryCsv(summary, stochasticProvenanceOf(envelope, storedRunCurveLine(store, runId, envelope)!), new Date().toISOString());
    return {
      kind: "bytes",
      contentType: "text/csv; charset=utf-8",
      headers: { "content-disposition": `attachment; filename="${runId}-stochastic.csv"` },
      value: Buffer.from(csv, "utf8"),
    };
  });
}
