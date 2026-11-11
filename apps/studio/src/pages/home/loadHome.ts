/**
 * Home loader. Six reads, no computation: the book's lineage and aggregate,
 * then (when a done run exists) the run's eve and nii sections, its lens
 * reading and its stored inputs. Every value is carried verbatim.
 */
import { getCatalogAggregate, getCatalogAggregateGrouped, getCatalogLineage, getCatalogRunInputs, getResultSection, getRunLenses } from "@alm/reader";
import { eveRows, newestDoneRun, niiRows, type EveRow, type NiiRow } from "../../rows/homeRows";

export interface HomeLensRow {
  lensId: string;
  objective: string;
  status: "pass" | "breach" | "unobservable";
  headline: number | undefined;
}

export interface HomeModel {
  bookId: string;
  marketId: string | null;
  /**
   * positionCount from GET /api/catalog/portfolios/:id/positions/aggregate;
   * assetsNotional is groups[key=asset].totalNotional of the same route with
   * groupBy=side (undefined when no asset group is returned), assetsBasis its basis.
   */
  intake: { positionCount: number; assetsNotional: number | null | undefined; assetsBasis: string };
  run: null | {
    runId: string;
    endedAt: string | null;
    platformRequestHash: string;
    engineInputsHash: string | null;
    baseScenarioId: string;
    eve: EveRow[];
    nii: NiiRow[];
    lenses: HomeLensRow[];
  };
}

export async function loadHome(bookId: string, marketId: string | null): Promise<HomeModel> {
  const [lineage, agg, bySide] = await Promise.all([
    getCatalogLineage("portfolios", bookId),
    getCatalogAggregate(bookId, {}),
    getCatalogAggregateGrouped(bookId, {}, "side"),
  ]);
  const assets = bySide.groups.find((g) => g.key === "asset");
  const intake = { positionCount: agg.aggregate.positionCount, assetsNotional: assets?.totalNotional, assetsBasis: bySide.basis };
  const runId = newestDoneRun(lineage);
  if (runId === null) return { bookId, marketId, intake, run: null };
  const [eve, nii, lenses, inputs] = await Promise.all([
    getResultSection(runId, "eve"),
    getResultSection(runId, "nii"),
    getRunLenses(runId),
    getCatalogRunInputs(runId),
  ]);
  return {
    bookId,
    marketId,
    intake,
    run: {
      runId,
      endedAt: inputs.endedAt,
      platformRequestHash: inputs.platformRequestHash,
      engineInputsHash: inputs.engineInputsHash,
      baseScenarioId: lenses.baseScenarioId,
      eve: eveRows(eve),
      nii: niiRows(nii),
      lenses: lenses.lenses.map((l) => ({ lensId: l.lensId, objective: l.objective, status: l.status, headline: l.headline })),
    },
  };
}
