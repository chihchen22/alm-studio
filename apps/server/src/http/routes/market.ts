/**
 * Market snapshot routes (design Sections 3.3, 5.1).
 *
 *   GET  /api/market                  snapshot listing (meta, ImportSummary;
 *                                     derivedFromMarketId on a derived market)
 *   GET /api/market/:id one stored snapshot, verbatim
 *   GET /api/market/:id/curve-default the curve the snapshot builds, as the run stamp names it
 *   POST /api/market/import-workbook  raw .xlsx bytes, X-Filename header;
 *                                     optional ?id= and ?asOf= (fallback
 *                                     calibration date when the filename
 *                                     carries no _YYYYMMDD suffix)
 *
 * Any import may carry ?workspaceId= and, with it, a required ?by= (Studio A+E
 * spec Section 2.4). The date checked against the workspace's cut-off is the
 * snapshot's parsed `calibrationDate`, which is the date the kernel stamps: the
 * `_YYYYMMDD` filename suffix first, the ?asOf= or filename fallback only when
 * the suffix is absent. The check runs after the parse and before the write, so
 * a Production refusal stores nothing and burns no id.
 *
 * Workbook parsing is the kernel's importMarketWorkbook via the intake module
 * (the kernel audit's near-zero-cost unlock); the ImportSummary is stored and
 * returned verbatim.
 */
import type { MarketSnapshot } from "@alm/kernel";
import type { CurveDefaultStamp } from "@alm/engine";
import { curveDefaultStampOf } from "@alm/engine/src/scenario";
import { parseMarketWorkbook } from "../../intake";
import type { PlatformContext } from "../../context";
import { badRequest, unprocessable } from "../errors";
import { mirrorBestEffort, type Router } from "../router";
import { assertSnapshotMovable, assertWritable, checkImportClash, requireByValue, writeBlockOp } from "../../workspaces/rules";

/** Derive an ISO date from a `_YYYYMMDD` filename suffix, if present. */
function dateFromFilename(name: string): string | undefined {
  const m = name.match(/_(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

/** The engine's stamp of what a snapshot builds, or the engine's refusal in its own words. */
function stampOrRefusal(snapshot: MarketSnapshot): CurveDefaultStamp | { kind: "refused"; reason: string } {
  try {
    return curveDefaultStampOf(snapshot);
  } catch (e) {
    return { kind: "refused", reason: e instanceof Error ? e.message : String(e) };
  }
}

/** Store-id shape from a filename stem (best-effort; ?id= overrides). */
function idFromFilename(name: string): string {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(0, 64);
}

export function registerMarketRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/market", () => ({
    kind: "json",
    // Listing per the frozen client interface: bare array; calibrationDate is
    // read from the stored snapshot document itself (never invented).
    value: ctx.store.listMeta("market").map((meta) => {
      const doc = ctx.store.getDocument<{ calibrationDate?: string }>("market", meta.id).doc;
      return {
        id: meta.id,
        label: meta.label,
        ...(typeof doc.calibrationDate === "string" ? { calibrationDate: doc.calibrationDate } : {}),
        importedAt: meta.importedAt,
        ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
        ...(typeof meta.derivedFromMarketId === "string" ? { derivedFromMarketId: meta.derivedFromMarketId } : {}),
      };
    }),
  }));

  // One stored snapshot, verbatim; an unknown id is the store's typed 404.
  // Registered after the literal /api/market routes; the derive and import
  // routes are POST, so no path collides with this GET.
  router.add("GET", "/api/market/:id", (req) => ({
    kind: "json",
    value: ctx.store.getDocument<unknown>("market", req.params.id).doc,
  }));

  // The curve a stored snapshot builds, as the run stamp names it (B4 Task 9 fix round; spec v7 decisions 57,
  // 58, 70, 72): `builds` is what a run on this market builds (a curveSetup block wins), `default` what it
  // builds with the block set aside, which is what "Use the platform default curve" returns a workspace to.
  // Both come from the engine's curveDefaultStampOf, the function the run's provenance stamp uses, so the
  // Studio names the curve without building it in the browser. A market the engine refuses (a curveDefault
  // marker other than 1, a block the validator refuses) reads {kind: "refused", reason}, never a 500. The
  // snapshot route above stays verbatim: this is a sibling, not a field added to the stored document.
  router.add("GET", "/api/market/:id/curve-default", (req) => {
    const id = req.params.id ?? "";
    const doc: unknown = ctx.store.getDocument<unknown>("market", id).doc;
    // A stored document that is not an object (JSON null, an array, a number) reads refused, never a 500.
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
      const refused = { kind: "refused" as const, reason: "the stored market document is not an object" };
      return { kind: "json", value: { marketId: id, builds: refused, default: refused } };
    }
    const { curveSetup, ...withoutBlock } = doc as MarketSnapshot & { curveSetup?: { label?: unknown } | null };
    const builds = stampOrRefusal(doc as MarketSnapshot);
    const label = typeof curveSetup === "object" && curveSetup !== null && typeof curveSetup.label === "string" && curveSetup.label !== "" ? curveSetup.label : undefined;
    return {
      kind: "json",
      value: {
        marketId: id,
        builds: builds.kind === "setup" && label !== undefined ? { ...builds, label } : builds,
        default: stampOrRefusal(withoutBlock as MarketSnapshot),
      },
    };
  });

  router.add("POST", "/api/market/import-workbook", async (req) => {
    const workspaceId = req.query.get("workspaceId");
    const by = workspaceId !== null ? requireByValue(req.query.get("by")) : null;
    if (workspaceId !== null) assertWritable(ctx.workspaces.head(workspaceId));

    const filename = req.raw.headers["x-filename"];
    if (typeof filename !== "string" || filename.length === 0) {
      throw badRequest("missing X-Filename header (the workbook's original filename)");
    }
    if (req.body.length === 0) throw badRequest("empty body; expected raw .xlsx bytes");

    const fallbackDate = req.query.get("asOf") ?? dateFromFilename(filename);
    if (fallbackDate === undefined) {
      throw unprocessable(
        `cannot determine the calibration date: filename "${filename}" has no date in it ` +
          `and no as-of date was given; the platform never invents an as-of date`,
      );
    }

    const outcome = parseMarketWorkbook(req.body, filename, fallbackDate);
    if (!outcome.ok) {
      // detail is the bare error array (the shape the client renders verbatim).
      throw unprocessable(
        `market workbook rejected: ${outcome.errors.length} error(s)`,
        outcome.errors,
      );
    }

    const id = req.query.get("id") ?? idFromFilename(filename);
    if (workspaceId === null || by === null) {
      ctx.store.putDocument("market", id, outcome.snapshot, {
        label: filename,
        summary: outcome.summary,
      });
      // After the store write: the catalog and lineage reads answer for this snapshot at once (best effort).
      mirrorBestEffort(ctx, "market", id);
      return { kind: "json", status: 201, value: { id, summary: outcome.summary } };
    }

    const calibrationDate = outcome.snapshot.calibrationDate;
    const done = await ctx.workspaces.withLock([workspaceId], () => {
      const head = ctx.workspaces.head(workspaceId);
      assertWritable(head);
      ctx.workspaces.assertNoPendingLock(workspaceId);
      const clash = checkImportClash(head, `market snapshot "${id}"`, calibrationDate);
      // Refused before the workbook is stored, so no id is burned (review B, M1).
      assertSnapshotMovable(head.blocks.market);
      const meta = ctx.store.putDocument("market", id, outcome.snapshot, {
        label: filename,
        summary: outcome.summary,
      });
      const after = writeBlockOp(ctx.workspaces, workspaceId, null, by, "market", "set", "market", id, {
        collection: "market",
        id,
        contentHash: meta.contentHash,
        asOf: calibrationDate,
      });
      return {
        kind: "json" as const,
        status: 201,
        value: { id, summary: outcome.summary, workspace: { id: workspaceId, revision: after.revision, clash: clash === "warn" } },
      };
    });
    // After the lock is released and the head is written: the mirror follows the store, never holds the lock.
    mirrorBestEffort(ctx, "market", id);
    return done;
  });
}
