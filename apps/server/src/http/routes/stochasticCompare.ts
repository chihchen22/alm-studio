/**
 * Stochastic Compare route.
 *
 *   GET /api/compare/stochastic?runs=a,b   two stored stochastic envelopes
 *                                          aligned by the engine's
 *                                          compareStochastic, as one JSON reply
 *   GET /api/compare/stochastic.csv?runs=a,b its CSV twin
 *
 * The server reads two result.json envelopes and the two request.json
 * submissions (portfolio and market ids, platform metadata) and derives
 * nothing itself: every B - A and the standard-error figure come from the
 * engine package. A distribution is a statistic of the Monte Carlo path
 * set, never an EVE or an NII. Its CSV twin, GET
 * /api/compare/stochastic.csv?runs=a,b, writes the same reply under the
 * stochastic provenance header, whose `# curve` row is
 * each run's curve line read from its stored files (export/curveLine.ts).
 */
import {
  compareStochastic,
  StochasticCompareError,
  type StochasticCompare,
  type StochasticCompareSide,
  type StochasticRunResult,
} from "@alm/engine";
import type { PlatformContext } from "../../context";
import type { RunStatus } from "../../jobs/types";
import { renderStochasticCompareCsv, stochasticProvenanceOf } from "../../export/stochasticCsv";
import { storedRunCurveLine } from "../../export/curveLine";
import { badRequest, conflict, notFound, unprocessable } from "../errors";
import type { RouteRequest, Router } from "../router";

interface StoredRequest {
  mode?: string;
  submission?: { portfolioId?: string; marketId?: string };
}

export function registerStochasticCompareRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  /** request.json mode; a missing file or a missing field counts as deterministic. */
  const modeOf = (runId: string): string => {
    if (!store.runFileExists(runId, "request.json")) return "deterministic";
    return store.readRunJson<StoredRequest>(runId, "request.json").mode ?? "deterministic";
  };

  /**
   * The checks both routes run, in one order: the runs parameter, existence,
   * mode, then state. Only the parameter message names its own route.
   */
  const pairOf = (req: RouteRequest, routeName: string): [string, string] => {
    const runsParam = req.query.get("runs");
    if (runsParam === null) throw badRequest(`${routeName} requires ?runs=a,b`);
    const ids = runsParam.split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (ids.length !== 2) throw badRequest(`runs must name exactly two run ids, got "${runsParam}"`);
    const [idA, idB] = ids as [string, string];

    for (const id of ids) {
      if (!store.runFileExists(id, "status.json")) throw notFound(`run "${id}" not found`);
    }

    const modeA = modeOf(idA);
    const modeB = modeOf(idB);
    const stoA = modeA === "stochastic";
    const stoB = modeB === "stochastic";
    if (!stoA && !stoB) {
      throw badRequest(
        `runs "${idA}" and "${idB}" are deterministic runs; their results compare at ` +
          `/api/compare?runs=${idA},${idB}&table=<table>. /api/compare/stochastic compares ` +
          `two stochastic distribution envelopes only.`,
      );
    }
    if (stoA !== stoB) {
      const det = stoA ? idB : idA;
      const sto = stoA ? idA : idB;
      throw badRequest(
        `run "${det}" is a deterministic run and run "${sto}" is a stochastic run; a ` +
          `deterministic result and a Monte Carlo distribution are not like for like, so no ` +
          `compare aligns them (a distribution is a statistic of the path set, never an EVE ` +
          `or an NII). Compare two deterministic runs at /api/compare, or two stochastic runs here.`,
      );
    }

    for (const id of ids) {
      const status = store.readRunJson<RunStatus>(id, "status.json");
      if (status.state !== "done") {
        throw conflict(`run "${id}" is ${status.state}; stochastic compare requires state "done"`);
      }
    }
    return [idA, idB];
  };

  /** The stored envelope plus the portfolio and market ids from the stored submission. */
  const side = (id: string): StochasticCompareSide => {
    const sub = store.readRunJson<StoredRequest>(id, "request.json").submission;
    return {
      envelope: store.readRunJson<StochasticRunResult>(id, "result.json"),
      ...(sub?.portfolioId !== undefined ? { portfolioId: sub.portfolioId } : {}),
      ...(sub?.marketId !== undefined ? { marketId: sub.marketId } : {}),
    };
  };

  /** The engine's compare; a StochasticCompareError is a typed 422. */
  const compareOr422 = (a: StochasticCompareSide, b: StochasticCompareSide): StochasticCompare => {
    try {
      return compareStochastic(a, b);
    } catch (err) {
      if (err instanceof StochasticCompareError) {
        throw unprocessable(err.message, { error: err.name, field: err.field, a: err.a, b: err.b });
      }
      throw err;
    }
  };

  router.add("GET", "/api/compare/stochastic", (req) => {
    const [idA, idB] = pairOf(req, "compare/stochastic");
    return { kind: "json", value: compareOr422(side(idA), side(idB)) };
  });

  router.add("GET", "/api/compare/stochastic.csv", (req) => {
    const [idA, idB] = pairOf(req, "compare/stochastic.csv");
    const a = side(idA);
    const b = side(idB);
    const csv = renderStochasticCompareCsv(
      compareOr422(a, b),
      stochasticProvenanceOf(a.envelope, storedRunCurveLine(store, idA, a.envelope)!),
      stochasticProvenanceOf(b.envelope, storedRunCurveLine(store, idB, b.envelope)!),
      new Date().toISOString(),
    );
    return {
      kind: "bytes",
      contentType: "text/csv; charset=utf-8",
      headers: {
        "content-disposition": `attachment; filename="compare-stochastic-${idA}-${idB}.csv"`,
      },
      value: Buffer.from(csv, "utf8"),
    };
  });
}
