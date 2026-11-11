/**
 * Platform server assembly: store + queue + router over node:http, bound to
 * 127.0.0.1 only. Factored apart from main.ts so tests and the smoke
 * script can boot a full server on an ephemeral port with a scratch store.
 */
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { BIND_HOST, type PlatformConfig } from "./config";
import type { PlatformContext } from "./context";
import type { SeedReport, StaleDocument } from "../scripts/seed-store";
import { FileStore } from "./store/store";
import { RunQueue } from "./jobs/queue";
import { WorkspaceStore } from "./workspaces/workspaceStore";
import { Router, writeError } from "./http/router";
import { toHttpError, notFound } from "./http/errors";
import { serveStatic } from "./http/static";
import { registerHealthRoutes } from "./http/routes/health";
import { registerPortfolioRoutes } from "./http/routes/portfolios";
import { registerMarketRoutes } from "./http/routes/market";
import { registerVolSmileRoutes } from "./http/routes/volSmile";
import { registerDerivedMarketRoutes } from "./http/routes/derivedMarkets";
import { registerAssumptionSetRoutes } from "./http/routes/assumptionSets";
import { registerDerivedBalancePlanRoutes } from "./http/routes/derivedBalancePlans";
import { registerDerivedSetRoutes } from "./http/routes/derivedSets";
import { registerScenarioSlateRoutes } from "./http/routes/scenarioSlates";
import { registerScenarioPreviewRoutes } from "./http/routes/scenarioPreview";
import { registerRunRoutes } from "./http/routes/runs";
import { registerExportRoutes } from "./http/routes/exportCsv";
import { registerStochasticCompareRoutes } from "./http/routes/stochasticCompare";
import { registerStochasticSummaryRoutes } from "./http/routes/stochasticSummary";
import { registerCatalogRoutes } from "./http/routes/catalog";
import { registerPlanRoutes } from "./http/routes/plans";
import { registerRunPlanRoutes } from "./http/routes/runPlans";
import { registerInstrumentRoutes } from "./http/routes/instrument";
import { registerLensRoutes } from "./http/routes/lenses";
import { registerReferenceRoutes } from "./http/routes/reference";
import { registerApprovalRoutes } from "./http/routes/approvals";
import { registerHierarchyRoutes } from "./http/routes/hierarchies";
import { registerWorkspaceRoutes } from "./http/routes/workspaces";
import { registerWorkspaceCloneRoutes } from "./http/routes/workspaceClone";
import { registerRunSetupRoutes } from "./http/routes/runSetups";
import { registerCurveSetupRoutes } from "./http/routes/curveSetups";
import { registerDerivedCurveRoutes } from "./http/routes/derivedCurves";
import { registerIndexHistoryRoutes } from "./http/routes/indexHistories";
import { registerCalibrationRoutes } from "./http/routes/calibrations";
import { registerGuidedRoutes } from "./http/routes/guided";
import { registerFeatureDemoRoutes } from "./http/routes/featureDemos";

export interface PlatformServer {
  context: PlatformContext;
  server: Server;
  /** The bound port (useful when config.port was 0 = ephemeral). */
  port: number;
  bootScan: { interrupted: string[]; requeued: string[] };
  close(): Promise<void>;
}

export interface StartPlatformOptions {
  /** The boot seed report; only its stale and retired findings are carried (GET /api/health). */
  seedReport?: { stale: StaleDocument[] } & Partial<Omit<SeedReport, "stale">>;
}

/** Build and start the platform server. Resolves once listening. */
export async function startPlatformServer(
  config: PlatformConfig,
  options: StartPlatformOptions = {},
): Promise<PlatformServer> {
  const store = new FileStore(config.storeRoot);
  store.init();
  const workspaces = new WorkspaceStore(config.storeRoot);
  const queue = new RunQueue(store, config.repoRoot, config.maxConcurrent);
  const context: PlatformContext = {
    store,
    workspaces,
    queue,
    config,
    seedReport: { stale: options.seedReport?.stale ?? [], retired: options.seedReport?.retired ?? [] },
  };

  // Boot scan BEFORE accepting requests: orphaned running -> interrupted,
  // queued re-enqueued in submittedAt order.
  const bootScan = queue.bootScan();

  // Workspace reconcile BEFORE any route registers (Section 2.3): heads rewritten from a history
  // line that was ahead, pending supersedes completed forward, runs attached from a request.json no
  // runs.ndjson line covers, crashed launches completed, and approved Production locks completed. A
  // torn final line is logged and ignored; boot never refuses on it.
  const reconciled = workspaces.reconcileAll(store);
  for (const id of reconciled.reconciledHeads) console.log(`platform: workspace ${id}: head rewritten from history`);
  for (const id of reconciled.attached) console.log(`platform: workspace reconcile attached run ${id}`);
  for (const id of reconciled.completedSupersedes) console.log(`platform: workspace ${id}: pending supersede completed`);
  for (const msg of reconciled.stuckSupersedes) console.log(`platform: ${msg}`);
  for (const id of reconciled.lockedAtBoot) console.log(`platform: workspace ${id}: sign-off lock completed`);
  for (const l of reconciled.completedLaunches) console.log(`platform: workspace ${l.workspaceId}: launch ${l.launchNo} completed`);
  for (const msg of reconciled.torn) console.log(`platform: ${msg}`);
  workspaces.writeServerMarker(process.pid);

  const router = new Router();
  registerHealthRoutes(router, context);
  registerPortfolioRoutes(router, context);
  registerMarketRoutes(router, context);
  registerVolSmileRoutes(router, context);
  registerDerivedMarketRoutes(router, context);
  registerAssumptionSetRoutes(router, context);
  registerDerivedSetRoutes(router, context);
  registerDerivedBalancePlanRoutes(router, context);
  registerScenarioSlateRoutes(router, context);
  registerScenarioPreviewRoutes(router, context);
  registerRunRoutes(router, context);
  registerExportRoutes(router, context);
  registerStochasticCompareRoutes(router, context);
  registerStochasticSummaryRoutes(router, context);
  registerCatalogRoutes(router, context);
  registerPlanRoutes(router, context);
  registerRunPlanRoutes(router, context);
  registerInstrumentRoutes(router, context);
  registerLensRoutes(router, context);
  registerReferenceRoutes(router, context);
  registerApprovalRoutes(router, context);
  registerHierarchyRoutes(router, context);
  registerWorkspaceRoutes(router, context);
  registerWorkspaceCloneRoutes(router, context);
  registerRunSetupRoutes(router, context);
  registerCurveSetupRoutes(router, context);
  registerDerivedCurveRoutes(router, context);
  registerIndexHistoryRoutes(router, context);
  registerCalibrationRoutes(router, context);
  registerGuidedRoutes(router, context);
  // The feature demos on the example bank.
  registerFeatureDemoRoutes(router, context);

  const viewerDist = config.staticDirs?.viewer ?? join(config.repoRoot, "apps", "viewer", "dist");
  const studioDist = config.staticDirs?.studio ?? join(config.repoRoot, "apps", "studio", "dist");

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const handled = await router.dispatch(req, res);
        if (handled) return;
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.startsWith("/api/")) {
          writeError(res, notFound(`no route for ${req.method} ${url.pathname}`));
          return;
        }
        if (
          (req.method ?? "GET") === "GET" &&
          (url.pathname === "/studio" || url.pathname.startsWith("/studio/"))
        ) {
          const sub = url.pathname.replace(/^\/studio\/?/, "/");
          if (serveStatic(res, studioDist, sub)) return;
          writeError(
            res,
            notFound(
              `not found: ${url.pathname} (Studio build absent? run npm run build --workspace @alm/studio)`,
            ),
          );
          return;
        }
        // The root is Studio's front door; the older Workbench shell is no longer
        // offered at "/" (its /assets files still serve for any bookmarked tab).
        if (
          (req.method ?? "GET") === "GET" &&
          (url.pathname === "/" || url.pathname === "/index.html")
        ) {
          res.writeHead(302, { location: "/studio/" });
          res.end();
          return;
        }
        if ((req.method ?? "GET") === "GET" && serveStatic(res, viewerDist, url.pathname)) return;
        writeError(
          res,
          notFound(
            `not found: ${url.pathname} (workbench static build absent? run the viewer build, ` +
              `or use the Vite dev server with its /api proxy)`,
          ),
        );
      } catch (err) {
        writeError(res, toHttpError(err));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only, never configurable.
    server.listen(config.port, BIND_HOST, () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    context,
    server,
    port,
    bootScan,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
