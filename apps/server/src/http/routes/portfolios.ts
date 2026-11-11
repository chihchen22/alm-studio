/**
 * Portfolio routes (design Sections 3.3, 5.1).
 *
 *   GET  /api/portfolios            listing with meta + intake stats
 *   GET  /api/portfolios/:id        full PortfolioSpec
 *   GET  /api/coa                   the stored charts of accounts, { coa: [{ id, label, contentHash }] } by id
 *   GET  /api/portfolios/:id/positions
 *                                   paged, filtered, prefix-searchable read of a
 *                                   stored book, from the FILE store (spec v3.1
 *                                   Section 2.9): a book imported this session is
 *                                   visible at once, which the SQLite mirror's
 *                                   boot-time sync cannot promise
 *   POST /api/portfolios/import     JSON PortfolioSpec, or CSV with
 *                                   ?format=csv&coaId=&label=&portfolioId=&asOf=
 *                                   and an optional &taxonomyId= for dim.<id>
 *                                   tag columns
 *
 * Any import may carry ?workspaceId= and, with it, a required ?by= (Studio A+E
 * spec Section 2.4): the book's as-of is checked against the workspace's cut-off
 * BEFORE anything is stored (422 on Production, a warned clash on every other
 * type), a locked, archived or superseded workspace refuses with 409, and the
 * stored book is set as the workspace's position book in the same lock.
 *
 * Validation and dry instantiation live in the intake module; this
 * route resolves the stored COA for the CSV path and persists the accepted
 * book. The meta stats recorded here are intake-plane aggregation — counts of
 * inputs, labeled as such — never engine output.
 */
import type { PortfolioSpec, ChartOfAccounts, DimensionTaxonomy } from "@alm/engine";
import { parsePositions, type ParsePositionsInput } from "../../intake";
import type { PlatformContext } from "../../context";
import { unprocessable, badRequest } from "../errors";
import { mirrorBestEffort, type Router } from "../router";
import type { DocumentMeta, FileStore } from "../../store/store";
import { assertWritable, checkImportClash, requireByValue, writeBlockOp } from "../../workspaces/rules";
import { getParsedBook } from "../../store/parsedBookCache";

/** Query keys the positions read accepts; any other key is a 400 (the catalog routes' convention). */
const POSITIONS_QUERY_KEYS = ["q", "familyId", "coaNodeId", "instrumentType", "limit", "offset"] as const;
const POSITIONS_DEFAULT_LIMIT = 500;
const POSITIONS_MAX_LIMIT = 5000;

/** One position as the read serves it: the identity and the facts the drop-down filters and labels by. */
interface PositionRow {
  id: string;
  familyId: string;
  coaNodeId: string;
  instrumentType: string;
  notional: number;
  maturityMonths?: number;
}

/** An integer query parameter within [min, max], or the fallback when absent; anything else is a 400 naming it. */
function boundedInt(raw: string | null, name: string, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`query parameter "${name}" must be an integer in [${min}, ${max}], got "${raw}"`);
  }
  return n;
}

/**
 * Intake statistics: arithmetic on INPUTS at import time (which
 * names exactly this fold — summing position notionals by side for the
 * portfolio browser). Counts by family plus notional sums by side; equity is
 * the derived plug (assets minus liabilities). Labeled, never engine output.
 */
function intakeStats(spec: PortfolioSpec): Record<string, unknown> {
  const byFamily = new Map<string, number>();
  for (const p of spec.positions) byFamily.set(p.familyId, (byFamily.get(p.familyId) ?? 0) + 1);
  const famOf = new Map(spec.coa.families.map((f) => [f.id, f]));
  let assets = 0;
  let liabilities = 0;
  for (const p of spec.positions) {
    const fam = famOf.get(p.familyId);
    // A swap's notional (a "derivative" family) and a commitment's undrawn capacity are off the
    // balance sheet, so neither enters the sums; no book imported before S3a-1 could hold either, so no stored meta moves.
    if (fam?.side === "derivative" || fam?.instrumentType === "commitment") continue;
    if (fam?.side === "asset") assets += p.terms.notional;
    else liabilities += p.terms.notional;
  }
  return {
    basis: "intake statistics, not engine output",
    positionCount: spec.positions.length,
    positionsByFamily: spec.coa.families.map((f) => ({
      familyId: f.id,
      positions: byFamily.get(f.id) ?? 0,
    })),
    assets,
    liabilities,
    /** Derived plug over inputs: assets - liabilities (intake-plane, labeled). */
    equity: assets - liabilities,
  };
}

/**
 * Store one accepted book plus its meta. The one put path for a book: the
 * import route passes freshly computed intake statistics; the hierarchy apply
 * route passes the source book's stored block verbatim and its lineage in
 * `extra`, so it sums nothing.
 */
export function putBook(
  store: FileStore,
  spec: PortfolioSpec,
  intake: Record<string, unknown> | undefined,
  extra: Record<string, unknown> = {},
): DocumentMeta {
  return store.putDocument("portfolios", spec.id, spec, {
    label: spec.label,
    asOf: spec.asOf,
    positionCount: spec.positions.length,
    ...(intake !== undefined ? { intake } : {}),
    ...extra,
  });
}

/** Listing item per the frozen client interface (W1-P3 report): meta fields
 * flattened; `intakeStats` present only when the stored intake block carries
 * the notional sums (older stores degrade to absent, never invented). */
function toListItem(meta: Record<string, unknown>): Record<string, unknown> {
  const intake = meta.intake as Record<string, unknown> | undefined;
  const hasSums = intake !== undefined && typeof intake.assets === "number" && typeof intake.liabilities === "number";
  return {
    id: meta.id,
    label: meta.label,
    positionCount: meta.positionCount,
    asOf: meta.asOf,
    contentHash: meta.contentHash,
    importedAt: meta.importedAt,
    ...(hasSums ? { intakeStats: intake } : {}),
  };
}

export function registerPortfolioRoutes(router: Router, ctx: PlatformContext): void {
  router.add("GET", "/api/portfolios", () => ({
    kind: "json",
    value: ctx.store.listMeta("portfolios").map(toListItem),
  }));

  // The stored charts of accounts, by id: what the positions import form offers as a pick instead of a blank id.
  // Read from the file store listing so a chart stored this session is offered at once; the route writes nothing.
  router.add("GET", "/api/coa", () => ({
    kind: "json",
    value: {
      coa: ctx.store
        .listMeta("coa")
        .map((m) => ({ id: m.id, label: String(m.label ?? ""), contentHash: m.contentHash }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    },
  }));

  router.add("GET", "/api/portfolios/:id", (req) => ({
    kind: "json",
    value: ctx.store.getDocument<PortfolioSpec>("portfolios", req.params.id).doc,
  }));

  // The type-ahead read behind the single-instrument drop-down. `q` is a case-sensitive
  // PREFIX of the position id; the other filters are exact matches; all combine as an AND.
  // `total` is the filtered count, so a client pages by it. Rows keep the book's order.
  router.add("GET", "/api/portfolios/:id/positions", (req) => {
    const unknown = [...new Set([...req.query.keys()])].filter((k) => !(POSITIONS_QUERY_KEYS as readonly string[]).includes(k));
    if (unknown.length > 0) {
      throw badRequest(
        `unknown query parameter(s) ${unknown.map((k) => `"${k}"`).join(", ")}; ` +
          `allowed: ${POSITIONS_QUERY_KEYS.join(", ")} (an unrecognized filter is refused, not silently ignored)`,
      );
    }
    const limit = boundedInt(req.query.get("limit"), "limit", POSITIONS_DEFAULT_LIMIT, 1, POSITIONS_MAX_LIMIT);
    const offset = boundedInt(req.query.get("offset"), "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    const q = req.query.get("q");
    const familyId = req.query.get("familyId");
    const coaNodeId = req.query.get("coaNodeId");
    const instrumentType = req.query.get("instrumentType");

    const { book } = getParsedBook(ctx.store, req.params.id);
    const matched: PositionRow[] = [];
    for (const p of book.positions) {
      const terms = p.terms as unknown as Record<string, unknown>;
      const type = String(terms.type);
      if (q !== null && q !== "" && !p.id.startsWith(q)) continue;
      if (familyId !== null && p.familyId !== familyId) continue;
      if (coaNodeId !== null && p.coaNodeId !== coaNodeId) continue;
      if (instrumentType !== null && type !== instrumentType) continue;
      matched.push({
        id: p.id,
        familyId: p.familyId,
        coaNodeId: p.coaNodeId,
        instrumentType: type,
        notional: p.terms.notional,
        ...(typeof terms.maturityMonths === "number" ? { maturityMonths: terms.maturityMonths } : {}),
      });
    }
    return { kind: "json", value: { total: matched.length, limit, offset, rows: matched.slice(offset, offset + limit) } };
  });

  router.add("POST", "/api/portfolios/import", async (req) => {
    // The workspace hook: `by` is validated and the status checked before a byte is parsed.
    const workspaceId = req.query.get("workspaceId");
    const by = workspaceId !== null ? requireByValue(req.query.get("by")) : null;
    if (workspaceId !== null) assertWritable(ctx.workspaces.head(workspaceId));

    const format = req.query.get("format") ?? "json";
    let input: ParsePositionsInput;
    if (format === "csv") {
      const coaId = req.query.get("coaId");
      const label = req.query.get("label");
      const portfolioId = req.query.get("portfolioId");
      const asOf = req.query.get("asOf");
      // OPTIONAL. A file with no dim. column needs no taxonomy, and a
      // dim. column in a file that named none is a header refusal, not a guess.
      const taxonomyId = req.query.get("taxonomyId");
      const missing = [
        coaId === null ? "coaId" : null,
        label === null ? "label" : null,
        portfolioId === null ? "portfolioId" : null,
        asOf === null ? "asOf" : null,
      ].filter((m): m is string => m !== null);
      if (missing.length > 0) {
        throw badRequest(
          `CSV import requires query parameters: ${missing.join(", ")} ` +
            `(a CSV file cannot state them, and the platform never invents an as-of date)`,
        );
      }
      input = {
        kind: "csv",
        text: req.body.toString("utf8"),
        coaId: coaId!,
        ...(taxonomyId !== null ? { taxonomyId } : {}),
        label: label!,
        portfolioId: portfolioId!,
        asOf: asOf!,
      };
    } else if (format === "json") {
      input = { kind: "json", spec: req.json() };
    } else {
      throw badRequest(`unknown import format "${format}"; use "json" or "csv"`);
    }

    const outcome = parsePositions(input, {
      resolveCoa: (coaId: string): ChartOfAccounts | undefined =>
        ctx.store.has("coa", coaId)
          ? ctx.store.getDocument<ChartOfAccounts>("coa", coaId).doc
          : undefined,
      resolveTaxonomy: (taxonomyId: string): DimensionTaxonomy | undefined =>
        ctx.store.has("taxonomy", taxonomyId)
          ? ctx.store.getDocument<DimensionTaxonomy>("taxonomy", taxonomyId).doc
          : undefined,
    });

    if ("errors" in outcome) {
      // detail is the bare RowError array — the shape the frozen client
      // interface renders verbatim ({ row?, column?, positionId?, message }).
      throw unprocessable(
        `portfolio import rejected: ${outcome.errors.length} error(s); every error is listed, not just the first`,
        outcome.errors,
      );
    }

    const spec = outcome.portfolio;
    const reply = (meta: DocumentMeta, workspace?: { id: string; revision: number; clash: boolean }) => ({
      kind: "json" as const,
      status: 201,
      value: {
        id: spec.id,
        label: spec.label,
        asOf: spec.asOf,
        positionCount: spec.positions.length,
        contentHash: meta.contentHash,
        warnings: outcome.warnings,
        ...(workspace ? { workspace } : {}),
      },
    });
    if (workspaceId === null || by === null) {
      const meta = putBook(ctx.store, spec, intakeStats(spec));
      // After the store write: the catalog and lineage reads answer for this book at once (best effort).
      mirrorBestEffort(ctx, "portfolios", spec.id);
      return reply(meta);
    }

    // Inside the workspace lock: re-read the head, refuse a Production date clash BEFORE storing, store
    // the book, then set the block (a warned clash adds its own history line).
    const stored = await ctx.workspaces.withLock([workspaceId], () => {
      const head = ctx.workspaces.head(workspaceId);
      assertWritable(head);
      ctx.workspaces.assertNoPendingLock(workspaceId);
      const outcomeClash = checkImportClash(head, `position book "${spec.id}"`, spec.asOf);
      const meta = putBook(ctx.store, spec, intakeStats(spec));
      const after = writeBlockOp(ctx.workspaces, workspaceId, null, by, "positions", "set", "portfolios", spec.id, {
        collection: "portfolios",
        id: spec.id,
        contentHash: meta.contentHash,
        asOf: spec.asOf,
      });
      return { meta, workspace: { id: workspaceId, revision: after.revision, clash: outcomeClash === "warn" } };
    });
    // After the lock is released and the head is written: the mirror follows the store, never holds the lock.
    mirrorBestEffort(ctx, "portfolios", spec.id);
    return reply(stored.meta, stored.workspace);
  });
}
