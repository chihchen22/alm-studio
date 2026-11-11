/**
 * GET /api/health — engine version, kernel reference, result schema version,
 * store path, queue depth, and the boot seed report's
 * stale and retired findings. Engine values are read from the engine's own
 * context resolution, never restated by hand; the seed findings are copied
 * verbatim from the report main.ts produced at boot.
 */
import { resolveDefaultContext } from "@alm/engine";
import { RUN_RESULT_SCHEMA_VERSION } from "@alm/engine/src/run";
import type { PlatformContext } from "../../context";
import type { Router } from "../router";

export function registerHealthRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/health", () => {
    const engine = resolveDefaultContext();
    return {
      kind: "json",
      value: {
        engineVersion: engine.engineVersion,
        kernel: engine.kernel,
        schemaVersion: RUN_RESULT_SCHEMA_VERSION,
        storePath: ctx.store.paths.root,
        queueDepth: ctx.queue.depth,
        seed: { stale: ctx.seedReport.stale, retired: ctx.seedReport.retired },
      },
    };
  });
}
