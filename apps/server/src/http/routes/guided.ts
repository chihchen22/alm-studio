/**
 * The guided Analysis path's reads. Read-only: nothing here writes the store.
 *
 *   GET  /api/guided/examples                 the example books under examples/: { id, label, asOf, positionCount }
 *   GET  /api/guided/examples/:id             one example book, the PortfolioSpec as the file holds it
 *   GET  /api/guided/examples/:id/analysis    the finished guided analysis an example book ships with (Studio slice
 *                                             S3a-1): its illustrative behavior bindings, balance targets,
 *                                             new-volume products, the going-concern choice and the deposit history,
 *                                             the dated series resolved from its file; 404 for a book with none
 *   GET  /api/guided/templates/positions.csv  the plain CSV position template (examples/positions-template-v1.csv),
 *                                             written against the stored demo chart of accounts `demo-coa-v1`
 *   GET  /api/guided/templates/positions.json the JSON position template: the example book, as a download
 *   GET  /api/guided/behavior-models          the behavioral models a family can start on, each with the kernel's
 *                                             published illustrative default values and the instrument types it drives
 *   POST /api/workspaces/:id/guided-runs      { runId, setupLineageId, setupDocId, by }: link a run the guided Run step
 *                                             posted on POST /api/runs to its workspace and setup (fix round 1, H2)
 *   GET  /api/workspaces/:id/guided-runs      the workspace's linked runs, newest first, each with its status
 *   POST /api/guided/behavior-preview         { overlay, ratePct? } -> one curve of that overlay, computed by the
 *                                             kernel's own functions: CPR by refinancing incentive, the share of
 *                                             balance left by month at a flat rate, or deposit beta by rate level
 *   POST /api/workspaces/:id/new-volume-preview  { templates?, plan?, months? } -> per family the suggested product,
 *                                             what a template mints today and the target path (newVolumePreview.ts)
 *
 * The defaults are the kernel's published constants (MBS_DEFAULTS, NMD_DEFAULTS, the IB deposit's own decay
 * parameters in NMD_B_TERMS_DEFAULTS, BETA_S_CURVE_DEFAULTS). They are illustrative and not fitted to any bank's data;
 * the Studio badges each one with the row's `badge`: "default, not fitted", and on the beta S-curve "illustrative
 * textbook default, not fitted to any data". The Studio never names these constants itself (its
 * own test holds that); it reads them here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BETA_S_CURVE_DEFAULTS,
  betaAtRate,
  buildWarmupSOFR1M,
  MBS_DEFAULTS,
  NMD_B_TERMS_DEFAULTS,
  NMD_DEFAULTS,
  runNMDOnPaths,
  sCurveData,
  type BetaSCurveParams,
  type MBSParams,
  type NMDParams,
} from "@alm/kernel";
import { checkOverlayParams } from "@alm/engine/src/contracts/paramSchema";
import type { BehavioralOverlay } from "@alm/engine";
import type { PlatformContext } from "../../context";
import type { RunStatus, StoredRunRequest } from "../../jobs/types";
import { assertWritable, requireByValue } from "../../workspaces/rules";
import { badRequest, notFound, unprocessable } from "../errors";
import type { Router } from "../router";
import { registerNewVolumePreviewRoute } from "./newVolumePreview";

/** An example book id: the file stem, letters, digits and dashes. */
const EXAMPLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The CSV template is v2, written against the example bank's own chart of accounts (stored by the
 * seed as `mid-size-bank-coa-v1`), so it can show a swap, a cd cohort book, a commitment, a floating liability and
 * liquidityRole tags; the JSON template is the example bank itself. The v1 files stay in examples/.
 */
export const POSITIONS_CSV_TEMPLATE = "positions-template-v2.csv";
export const POSITIONS_JSON_TEMPLATE = "mid-size-bank-v1.json";
/** The stored chart of accounts the CSV template's family and node ids belong to. */
export const POSITIONS_CSV_TEMPLATE_COA = "mid-size-bank-coa-v1";

export interface ExampleBookRow {
  id: string;
  label: string;
  asOf: string;
  positionCount: number;
  /** The book ships a finished guided analysis (`<id>.analysis.json` beside it). */
  analysis: boolean;
}

/** The finished guided analysis file an example book ships with, as the file holds it. */
interface ExampleAnalysisFile {
  schemaVersion: string;
  bookId: string;
  label: string;
  behavior: { label: string; modelVersion: string; bindings: Array<{ familyId: string; overlay: BehavioralOverlay; modelVersion: string }> };
  targets: { label: string; unlistedFamilies: "runoff"; targets: unknown[] };
  templates: unknown[];
  warmup: { file: string };
  goingConcern: boolean;
}

/** The dated series file a "history" deposit warmup reads: the published series and its source and terms. */
interface SeriesFile {
  id: string;
  label: string;
  firstMonth: string;
  lastMonth: string;
  source: string;
  sourceUrl: string;
  notice: string;
  termsUrl: string;
  valuesPct: number[];
}

/** What GET /api/guided/examples/:id/analysis serves: the file with its warmup resolved to the run option. */
export interface ExampleAnalysis extends Omit<ExampleAnalysisFile, "warmup"> {
  nmdWarmup: { kind: "history"; series: { label: string; firstMonth: string; valuesPct: number[] } };
  /** Where the deposit history comes from and on what terms, for the Studio's Details. */
  warmupSource: { file: string; source: string; sourceUrl: string; notice: string; termsUrl: string; firstMonth: string; lastMonth: string };
}

/** The shipped public deposit history: new analyses read it instead of the kernel's series. */
export const DEPOSIT_HISTORY_FILE = "sofr-monthly-v1.json";

/** What GET /api/guided/deposit-history serves: the shipped series as the run option, with its source and span. */
export interface DepositHistory {
  file: string;
  nmdWarmup: { kind: "history"; series: { label: string; firstMonth: string; valuesPct: number[] } };
  firstMonth: string;
  lastMonth: string;
  source: string;
  sourceUrl: string;
  notice: string;
  termsUrl: string;
}

/** A series file in examples/ as the run option, the one the example analysis and new analyses both read. */
export function depositHistoryOf(dir: string, file: string): DepositHistory {
  const series = JSON.parse(readFileSync(join(dir, file), "utf8")) as SeriesFile;
  return {
    file,
    nmdWarmup: { kind: "history", series: { label: `${series.label} (${series.source})`, firstMonth: series.firstMonth, valuesPct: [...series.valuesPct] } },
    firstMonth: series.firstMonth,
    lastMonth: series.lastMonth,
    source: series.source,
    sourceUrl: series.sourceUrl,
    notice: series.notice,
    termsUrl: series.termsUrl,
  };
}

/** The analysis an example book ships with, or null. Throws a sentence when the files are there but malformed. */
export function exampleAnalysis(dir: string, id: string): ExampleAnalysis | null {
  const path = join(dir, `${id}.analysis.json`);
  if (!existsSync(path)) return null;
  const file = JSON.parse(readFileSync(path, "utf8")) as ExampleAnalysisFile;
  if (file.bookId !== id) throw new Error(`examples/${id}.analysis.json names book "${file.bookId}", not "${id}"`);
  if (!/^[a-z0-9][a-z0-9.-]{0,63}\.json$/.test(file.warmup.file)) throw new Error(`examples/${id}.analysis.json: warmup.file must be a file name in examples/`);
  const h = depositHistoryOf(dir, file.warmup.file);
  const { warmup, ...rest } = file;
  return {
    ...rest,
    nmdWarmup: h.nmdWarmup,
    warmupSource: { file: warmup.file, source: h.source, sourceUrl: h.sourceUrl, notice: h.notice, termsUrl: h.termsUrl, firstMonth: h.firstMonth, lastMonth: h.lastMonth },
  };
}

/** The role a model plays for a family: how its positions prepay, decay or reprice. */
export type BehaviorRole = "prepayment" | "decay" | "repricing";

export interface BehaviorModelRow {
  /** Stable key of this row: `<role>/<instrument type>`. */
  key: string;
  role: BehaviorRole;
  label: string;
  /** The instrument types this default is published for. */
  instrumentTypes: string[];
  /** The overlay a binding carries, with the published default values. */
  overlay: BehavioralOverlay;
  /** The model version the guided path writes on a binding that starts on this default. */
  modelVersion: string;
  /** What the preview draws. */
  preview: string;
  /** One sentence on where the values come from. */
  source: string;
  /**
   * The short badge the Studio shows beside these values. "default, not fitted" on the kernel's
   * illustrative defaults; on the beta S-curve, whose values are round illustrative textbook values, that it is an
   * illustrative textbook default, not fitted to any data.
   */
  badge: string;
}

/** The badge on a published illustrative default, and on the beta S-curve, an illustrative textbook default. */
export const DEFAULT_BADGE = "default, not fitted";
export const BETA_BADGE = "illustrative textbook default, not fitted to any data";

/** The model version every guided binding on a published default carries, so provenance says what it is. */
export const PUBLISHED_DEFAULT_VERSION = "published-default-v1";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The rows, in a fixed order. Fresh objects on every call. */
export function behaviorModels(): BehaviorModelRow[] {
  return [
    {
      key: "prepayment/mortgage",
      role: "prepayment",
      label: "Four-factor CPR prepayment",
      instrumentTypes: ["mortgage"],
      overlay: { kind: "prepay", model: "four-factor-cpr", params: clone<MBSParams>(MBS_DEFAULTS) },
      modelVersion: PUBLISHED_DEFAULT_VERSION,
      preview: "CPR by refinancing incentive",
      source: "The kernel's published mortgage defaults: refinancing S-curve, seasoning ramp, seasonality and burnout.",
      badge: DEFAULT_BADGE,
    },
    {
      key: "decay/nmd",
      role: "decay",
      label: "Deposit decay",
      instrumentTypes: ["nmd"],
      overlay: { kind: "nmd-decay", params: clone<NMDParams>(NMD_DEFAULTS) },
      modelVersion: PUBLISHED_DEFAULT_VERSION,
      preview: "Share of balance left by month",
      source: "The kernel's published non-interest deposit defaults: closure ramp, rate incentive and account-size buckets.",
      badge: DEFAULT_BADGE,
    },
    {
      key: "decay/nmd-b",
      role: "decay",
      label: "Deposit decay",
      instrumentTypes: ["nmd-b"],
      overlay: { kind: "nmd-decay", params: clone<NMDParams>(NMD_B_TERMS_DEFAULTS.nmdParams) },
      modelVersion: PUBLISHED_DEFAULT_VERSION,
      preview: "Share of balance left by month",
      source: "The kernel's published interest-bearing deposit defaults: the decay parameters an interest-bearing deposit carries by default.",
      badge: DEFAULT_BADGE,
    },
    {
      key: "repricing/nmd-b",
      role: "repricing",
      label: "Deposit repricing beta",
      instrumentTypes: ["nmd-b"],
      overlay: { kind: "deposit-beta", params: clone<BetaSCurveParams>(BETA_S_CURVE_DEFAULTS) },
      modelVersion: PUBLISHED_DEFAULT_VERSION,
      preview: "Deposit beta by market rate",
      source:
        "The kernel's beta S-curve: the share of a market rate move the deposit rate follows. Its values are round illustrative textbook values, not fitted to any data or to your book.",
      badge: BETA_BADGE,
    },
  ];
}

export interface BehaviorPreview {
  title: string;
  xLabel: string;
  yLabel: string;
  /** "bp", "month" or "percent": what x is in. */
  xUnit: "bp" | "month" | "percent";
  /** "percent" (CPR, share of balance) or "ratio" (beta). */
  yUnit: "percent" | "ratio";
  points: Array<[number, number]>;
  note: string;
}

/** How many months the decay preview draws, and the default flat rate it draws them at. */
export const DECAY_PREVIEW_MONTHS = 120;
export const DECAY_PREVIEW_RATE_PCT = 4;

/** One curve of an overlay. Throws a sentence for an overlay this preview does not draw or values the schema refuses. */
export function behaviorPreview(overlay: BehavioralOverlay, ratePct: number = DECAY_PREVIEW_RATE_PCT): BehaviorPreview {
  const issues = overlay.kind === "registered" ? [] : checkOverlayParams(overlay);
  if (issues.length > 0) throw new Error(`the values do not pass the model's checks: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`);
  if (overlay.kind === "prepay" && overlay.model === "four-factor-cpr") {
    return {
      title: "CPR by refinancing incentive",
      xLabel: "Note rate less market mortgage rate",
      yLabel: "CPR",
      xUnit: "bp",
      yUnit: "percent",
      points: sCurveData(overlay.params).map((p) => [p.diffBps, p.cpr]),
      note: "The refinancing S-curve alone, before seasoning, seasonality and burnout scale it.",
    };
  }
  if (overlay.kind === "deposit-beta") {
    const points: Array<[number, number]> = [];
    for (let i = 0; i <= 32; i++) {
      const r = i * 0.25;
      points.push([r, betaAtRate(r, overlay.params)]);
    }
    return {
      title: "Deposit beta by market rate",
      xLabel: "Market rate level",
      yLabel: "Beta",
      xUnit: "percent",
      yUnit: "ratio",
      points,
      note: "The share of a market rate move the deposit rate follows, at each market rate level.",
    };
  }
  if (overlay.kind === "nmd-decay") {
    if (!Number.isFinite(ratePct) || ratePct < -5 || ratePct > 20) throw new Error(`ratePct must be a number from -5 to 20, got ${String(ratePct)}`);
    const path = new Float64Array(DECAY_PREVIEW_MONTHS).fill(ratePct / 100);
    const out = runNMDOnPaths([path], overlay.params, buildWarmupSOFR1M());
    const points: Array<[number, number]> = [[0, 100]];
    // balMean is already a percent of the opening balance (the kernel divides by balanceSize and multiplies by 100).
    for (let m = 0; m < out.balMean.length; m++) points.push([m + 1, out.balMean[m]!]);
    return {
      title: "Share of balance left by month",
      xLabel: "Month",
      yLabel: "Balance left",
      xUnit: "month",
      yUnit: "percent",
      points,
      note: `At a flat market rate of ${ratePct}% for ${DECAY_PREVIEW_MONTHS} months, after the kernel's own warm-up history.`,
    };
  }
  throw new Error(`no preview for a ${overlay.kind === "prepay" ? `${overlay.kind} ${overlay.model}` : overlay.kind} overlay; the guided path draws four-factor CPR, deposit decay and deposit beta`);
}

function exampleRows(dir: string): ExampleBookRow[] {
  const rows: ExampleBookRow[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  for (const name of names) {
    const id = name.slice(0, -".json".length);
    if (!EXAMPLE_ID.test(id)) continue;
    try {
      const doc = JSON.parse(readFileSync(join(dir, name), "utf8")) as { id?: unknown; label?: unknown; asOf?: unknown; positions?: unknown };
      if (doc.id !== id || !Array.isArray(doc.positions) || typeof doc.asOf !== "string") continue;
      rows.push({ id, label: typeof doc.label === "string" ? doc.label : id, asOf: doc.asOf, positionCount: doc.positions.length, analysis: existsSync(join(dir, `${id}.analysis.json`)) });
    } catch {
      continue;
    }
  }
  return rows;
}

export function registerGuidedRoutes(router: Router, ctx: PlatformContext): void {
  // The New volume step's preview (templates, today's rule, target paths), read only.
  registerNewVolumePreviewRoute(router, ctx);
  const dir = join(ctx.config.repoRoot, "examples");

  router.add("GET", "/api/guided/examples", () => ({ kind: "json", value: exampleRows(dir) }));

  router.add("GET", "/api/guided/examples/:id", (req) => {
    const id = req.params.id ?? "";
    if (!exampleRows(dir).some((r) => r.id === id)) throw notFound(`no example book "${id}"; GET /api/guided/examples lists them`);
    return { kind: "json", value: JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as unknown };
  });

  router.add("GET", "/api/guided/examples/:id/analysis", (req) => {
    const id = req.params.id ?? "";
    if (!exampleRows(dir).some((r) => r.id === id)) throw notFound(`no example book "${id}"; GET /api/guided/examples lists them`);
    const analysis = exampleAnalysis(dir, id);
    if (analysis === null) throw notFound(`example book "${id}" ships no finished analysis`);
    return { kind: "json", value: analysis };
  });

  // The shipped public SOFR monthly history a new analysis's deposits read.
  router.add("GET", "/api/guided/deposit-history", () => ({ kind: "json", value: depositHistoryOf(dir, DEPOSIT_HISTORY_FILE) }));

  router.add("GET", "/api/guided/templates/positions.csv", () => ({
    kind: "bytes",
    contentType: "text/csv; charset=utf-8",
    value: readFileSync(join(dir, POSITIONS_CSV_TEMPLATE)),
    headers: { "content-disposition": `attachment; filename="${POSITIONS_CSV_TEMPLATE}"` },
  }));

  router.add("GET", "/api/guided/templates/positions.json", () => ({
    kind: "bytes",
    contentType: "application/json; charset=utf-8",
    value: readFileSync(join(dir, POSITIONS_JSON_TEMPLATE)),
    headers: { "content-disposition": `attachment; filename="${POSITIONS_JSON_TEMPLATE}"` },
  }));

  // A stochastic run the guided Run step launched, linked to its workspace and setup by id: no label matching (H2).
  router.add("POST", "/api/workspaces/:id/guided-runs", (req) => {
    const id = req.params.id ?? "";
    const head = ctx.workspaces.head(id);
    const body = req.json<{ runId?: unknown; setupLineageId?: unknown; setupDocId?: unknown; by?: unknown }>();
    const by = requireByValue(typeof body.by === "string" ? body.by : null);
    assertWritable(head);
    for (const k of ["runId", "setupLineageId", "setupDocId"] as const) {
      if (typeof body[k] !== "string" || (body[k] as string).length === 0) throw badRequest(`"${k}" is required: a non-empty string`);
    }
    const runId = body.runId as string;
    if (!ctx.store.runFileExists(runId, "request.json")) throw notFound(`no run "${runId}"`);
    const request = ctx.store.readRunJson<StoredRunRequest>(runId, "request.json");
    const book = head.blocks.positions.book?.id ?? null;
    if (book === null || request.portfolioRef.id !== book) {
      throw unprocessable(`run "${runId}" ran book "${request.portfolioRef.id}", not this workspace's book${book === null ? " (it has none)" : ` "${book}"`}`);
    }
    if (!head.blocks.run.setups.some((s) => s.setupLineageId === body.setupLineageId)) throw unprocessable(`workspace "${id}" has no setup slot "${String(body.setupLineageId)}"`);
    if (ctx.workspaces.readGuidedRuns(id).some((l) => l.runId === runId)) throw unprocessable(`run "${runId}" is already linked to workspace "${id}"`);
    const line = { runId, setupLineageId: body.setupLineageId as string, setupDocId: body.setupDocId as string, at: new Date().toISOString(), by };
    ctx.workspaces.appendGuidedRun(id, line);
    return { kind: "json", status: 201, value: line };
  });

  router.add("GET", "/api/workspaces/:id/guided-runs", (req) => {
    const id = req.params.id ?? "";
    ctx.workspaces.head(id); // 404 for an unknown workspace
    const rows = ctx.workspaces.readGuidedRuns(id).map((l) => ({
      ...l,
      status: ctx.store.runFileExists(l.runId, "status.json") ? ctx.store.readRunJson<RunStatus>(l.runId, "status.json") : null,
    }));
    rows.sort((a, b) => ((a.status?.submittedAt ?? a.at) < (b.status?.submittedAt ?? b.at) ? 1 : -1));
    return { kind: "json", value: rows };
  });

  router.add("GET", "/api/guided/behavior-models", () => ({ kind: "json", value: { models: behaviorModels() } }));

  router.add("POST", "/api/guided/behavior-preview", (req) => {
    const body = req.json<{ overlay?: unknown; ratePct?: unknown }>();
    if (typeof body !== "object" || body === null || typeof body.overlay !== "object" || body.overlay === null) {
      throw badRequest(`the body needs "overlay": a behavioral overlay object, as an assumption set binding carries it`);
    }
    if (body.ratePct !== undefined && typeof body.ratePct !== "number") throw badRequest(`"ratePct" must be a number of percent when given`);
    try {
      return { kind: "json", value: behaviorPreview(body.overlay as BehavioralOverlay, body.ratePct as number | undefined) };
    } catch (e) {
      throw unprocessable(`behavior preview refused: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}
