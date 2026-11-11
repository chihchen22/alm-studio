/**
 * Typed fetch client over the platform HTTP API.
 *
 * THE FROZEN INTERFACE. This file has one function per
 * API endpoint, no
 * invented endpoints and no client-side computation. W1-P4 (ResultsPage, ComparePage, DeltaTable) imports from this
 * file and nothing server-ward of it; W2-P6 integrates it against the live
 * apps/server. Response shapes the design leaves unnamed (listings, run
 * status) are frozen here and described in the module report; the server
 * conforms to these shapes, not the other way round. One route postdates this
 * list: GET /api/runs/:id/pivot, served straight off a
 * stored result beside GET /api/runs/:id/query and read the same way. So does
 * GET /api/compare/stochastic: two stored stochastic envelopes aligned
 * by the engine, every B - A derived there and none here.
 * So do GET /api/runs/:id/stochastic/summary with its CSV twin
 * GET /api/runs/:id/stochastic/summary.csv, and GET /api/compare/stochastic.csv:
 * one stored stochastic envelope read by the engine as rows, and the
 * CSV twins written under a stochastic provenance header.
 *
 * Honesty rules carried from v1: every result-plane value returned here is a
 * verbatim slice of a stored RunResult served by the engine's own reader; this
 * client never rounds, sums, or re-derives a number. Errors arrive as the
 * server's typed { error: { code, message, detail } } body and are rethrown
 * verbatim as ApiError; an engine refusal is never softened in transit.
 */
import type {
  CurveDefaultStamp,
  AssumptionDiff,
  AssumptionSet,
  AttributionResult,
  BalanceKnotChange,
  BalancePlan,
  BalanceShockOp,
  BucketedCashflowResult,
  CurveNodes,
  DerivationChange,
  DerivationOp,
  DerivedMarketSnapshot,
  EVEResult,
  Explanation,
  FtpResult,
  GapResult,
  GateReport,
  InstrumentsFile,
  KernelProvenanceRef,
  LiquidityStressResult,
  LensDefinition,
  MarketDeriveOp,
  RateIndexChange,
  ShortRateVolChange,
  MacroBinding,
  MacroSeriesChange,
  TlpNodeChange,
  NewBusinessRule,
  NIIResult,
  NiiMonthlyReply,
  NotImplemented,
  PivotMetric,
  PivotResult,
  PortfolioSpec,
  ProvenanceRecord,
  RateDocument,
  RateSpec,
  ResultQuery,
  ResultSlice,
  RunLogEntry,
  RunPlan,
  RunResult,
  Scenario,
  ScenarioLibrary,
  SegResult,
  BgmModelOverride,
  StochasticCompare,
  StochasticGapBlock,
  StochasticModel,
  StochasticRunResult,
  StochasticRunSummary,
} from "@alm/engine";
import type { PatchLayer, Profile } from "@alm/harness";
import type { ImportSummary } from "@alm/kernel";
import type { LensReading } from "@alm/engine/src/report/lens";

// --- Error surface -----------------------------------------------------------

/** The server's error body: { error: { code, message, detail? } } (design 3.3). */
export interface ApiErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

/**
 * A non-2xx response, carrying the server's typed error verbatim. `detail`
 * holds per-item validation errors on 422 (e.g. per-row import errors) and is
 * rendered verbatim by the UI, never summarized away.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  /**
   * The whole parsed response body when one parsed, verbatim. A workspace launch refusal carries its
   * gate lists (`blocking`, `acknowledgeable`, `staleRoles`) or its per-row reports (`rows`) beside
   * `error`, and those are not part of `{ code, message, detail }`.
   */
  readonly body: unknown;

  constructor(status: number, code: string, message: string, detail?: unknown, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.body = body;
  }
}

/** One row/position-level validation error inside a 422 detail array. */
export interface ItemError {
  /** CSV row number, when the item came from a CSV import. */
  row?: number;
  /** Offending CSV column, when known. */
  column?: string;
  /** Offending position id, when the item is a position (JSON import / dry instantiation). */
  positionId?: string;
  message: string;
}

// --- Run lifecycle types (status.json shape) -------------

export type RunState = "queued" | "running" | "done" | "error" | "cancelled" | "interrupted";

/** The four-phase progress seam (design 3.4; M2 emits, server forwards). */
export type RunPhase = "resolve" | "project" | "report" | "done";

/**
 * Run execution mode. A stored request.json predating the field is
 * deterministic; the server normalizes that, and so does every consumer here.
 * A stochastic run's result is a SEPARATE StochasticRunResult envelope served
 * at /api/runs/:id/stochastic; the deterministic result routes refuse it with
 * a typed 400 and the UI branches on this field, never on a guess.
 */
export type RunMode = "deterministic" | "stochastic";

/** The stochastic options stored with a run (echoed on run detail). */
export interface StoredStochasticSpec {
  nPaths: number;
  /**
   * The rate model the submission named,
   * verbatim. Absent means "hull-white-1f": every run stored before the slice,
   * and every Hull-White post that named no model, carries no key.
   */
  model?: StochasticModel;
  /**
   * Caller-supplied parameters, recorded verbatim: {a, sigma, reason} for
   * Hull-White (the verification seam), the Rebonato six and a reason for BGM.
   */
  modelParams?: { a: number; sigma: number; reason: string } | BgmModelOverride;
}

/** Scenario display metadata served with a run (the stored slate's entries). */
export interface ScenarioMeta {
  id: string;
  label: string;
  rateSpec: RateSpec;
}

/** References recorded at submission: which stored artifacts the run consumed. */
export interface RunRefs {
  portfolioId: string;
  marketId: string;
  scenarioSlateId: string;
  assumptionSetIds: string[];
}

/** status.json, verbatim (design Section 3.2 store layout). */
export interface RunStatusRecord {
  state: RunState;
  phase?: RunPhase;
  submittedAt: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  pid?: number;
  queuePosition?: number;
  label?: string;
  platformRequestHash: string;
  error?: { code?: string; message: string };
}

/** One entry of GET /api/runs: status.json fields + scenario metadata + refs. */
export interface RunSummary extends RunStatusRecord {
  runId: string;
  /** Absent only for a run whose request.json is missing (half-written store). */
  mode?: RunMode;
  scenarios?: ScenarioMeta[];
  refs?: RunRefs;
}

/**
 * The curve a stored run built on (server export/curveLine.ts): the run's own stamp, else the
 * setup its stored request pinned, else curve default version 1. `line` is the sentence a page shows, for
 * example "Curve: platform default v2, log-linear on discount factor"; `value` is that line after "Curve: ".
 */
export interface RunCurveLine {
  line: string;
  value: string;
  from: "stamp" | "request-setup" | "unstamped";
}

/** GET /api/runs/:id: status.json + the slate's { id, label, rateSpec } metadata. */
export interface RunDetail extends RunStatusRecord {
  runId: string;
  mode?: RunMode;
  /** Present once the run is done, for both modes: the curve line of the stored run. */
  curve?: RunCurveLine;
  /** Present on stochastic runs: the stored submission options, verbatim. */
  stochastic?: StoredStochasticSpec;
  scenarios: ScenarioMeta[];
  refs?: RunRefs;
  /** request.json's grid, served for both modes; absent only where the stored request carries none. */
  grid?: { horizonMonths: number; asOf: string };
}

// --- Store listing types -----------------------------------------------------

/** Intake statistics: arithmetic on INPUTS at import time (labeled). */
export interface IntakeStats {
  assets: number;
  liabilities: number;
  equity: number;
  equityNodeId?: string;
}

export interface PortfolioListItem {
  id: string;
  label: string;
  positionCount: number;
  asOf: string;
  contentHash: string;
  importedAt?: string;
  /** Present when the server computed them at import; UI labels them "intake statistics, not engine output". */
  intakeStats?: IntakeStats;
}

export interface MarketListItem {
  id: string;
  label?: string;
  calibrationDate?: string;
  importedAt?: string;
  /** Present when the snapshot came from a workbook import. */
  summary?: ImportSummary;
  /** The base market a derived market was made from; absent on a plain market. */
  derivedFromMarketId?: string;
}

export interface AssumptionSetListItem {
  id: string;
  label: string;
  /** Engine-populated at bind time; the gate keys on it. */
  contentHash: string;
  bindingCount?: number;
  /** The base set a derived set was made from; absent on a plain set. */
  derivedFromSetId?: string;
  /** The set's macro mapping, verbatim; absent on a set with none (the Macro factors readers card reads it). */
  macroBindings?: MacroBinding[];
  /** The listing's mark on a row whose stored document file is gone (mfu-1); absent when the document is read. */
  documentMissing?: true;
}

/** A stored scenario slate: exactly one rateSpec.kind === "base" among scenarios. */
export interface ScenarioSlate {
  id: string;
  label: string;
  scenarios: Scenario[];
}

// --- Requests ----------------------------------------------------------------

/** POST /api/runs body, verbatim from the endpoint table. */
export interface SubmitRunBody {
  portfolioId: string;
  marketId: string;
  scenarioSlateId: string;
  assumptionSetIds: string[];
  gridHorizonMonths?: number;
  seed?: string;
  engineOptions?: {
    /** ADR-013 measurement policy; "base-only" is the engine default. */
    durationMode?: "base-only" | "per-scenario";
    /** ADR-007 shard policy; byte-identical output at any count, wall-clock only. */
    shards?: number | "auto";
  };
  /**
   * Run mode. Omitted means deterministic. A "stochastic" options
   * block on a deterministic submission is refused typed, never ignored.
   */
  mode?: RunMode;
  /** Stochastic options; admissible only with mode "stochastic". `model` absent is Hull-White. */
  stochastic?: {
    nPaths?: number;
    model?: StochasticModel;
    modelParams?: { a: number; sigma: number; reason: string } | BgmModelOverride;
  };
  /** The run's label in the queue and the run list; the server stores it verbatim. */
  label?: string;
}

export interface SubmitRunResponse {
  runId: string;
  queuePosition: number;
  /** Echo of the resolved mode (W3-A4b 202 body). */
  mode?: RunMode;
  /**
   * Stochastic echo: the path count exactly as it will run (never adjusted)
   * plus the server's honest cost label, rendered verbatim in the cockpit.
   */
  stochastic?: { nPaths: number; costNote: string };
}

/** 201 body of POST /api/portfolios/import: handle + warnings. */
export interface ImportPortfolioResponse {
  id: string;
  positionCount: number;
  asOf: string;
  warnings: string[];
}

export interface ImportWorkbookResponse {
  id: string;
  summary: ImportSummary;
  /**
   * Present only when the call named a workspace (`workspaceId` and `by`): the snapshot was also set on that
   * workspace's market block, after the Production-lock and cut-off-clash checks. `clash` is true when the date
   * differs from the cut-off on a workspace that only warns.
   */
  workspace?: { id: string; revision: number; clash: boolean };
}

/** The optional query of POST /api/market/import-workbook; only the keys that are set reach the URL. */
export interface ImportWorkbookOptions {
  /** Also set the snapshot on this workspace's market block; the route then requires `by`. */
  workspaceId?: string;
  /** The typed name recorded with the workspace write. */
  by?: string;
  /** Fallback calibration date, used only when the filename has no `_YYYYMMDD` suffix. */
  asOf?: string;
  /** The stored snapshot id; defaults to one derived from the filename. */
  id?: string;
}

export interface StaleSeedInfo {
  collection: string;
  id: string;
  storedHash: string;
  currentHash: string;
  differences: Array<{ path: string; stored: unknown; current: unknown }>;
}

/** A retired seed id the store still holds, with the stored runs that name it. */
export interface RetiredSeedInfo {
  collection: string;
  id: string;
  reason: string;
  runs: string[];
}

export interface HealthInfo {
  engineVersion: string;
  kernel: KernelProvenanceRef;
  schemaVersion: string;
  storePath: string;
  queueDepth: number;
  /** ADR-028 boot report, copied verbatim; each list is [] when nothing is stale or retired. */
  seed: { stale: StaleSeedInfo[]; retired: RetiredSeedInfo[] };
}

/** POST /api/assumption-sets/diff body: baseId plus candidate-by-id or inline. */
export type DiffRequest =
  | { baseId: string; candidateId: string }
  | { baseId: string; candidate: AssumptionSet };

/** Response of POST /api/runs/:id/explain: the engine Explanation plus prose. */
export interface ExplainResponse {
  explanation: Explanation;
  prose: string;
}

/** GET /api/runs/:id/result/:section names -> envelope key types. */
export interface ResultSectionMap {
  nii: NIIResult;
  eve: EVEResult;
  gap: GapResult;
  attribution: AttributionResult;
  cashflows: BucketedCashflowResult;
  provenance: ProvenanceRecord;
  notImplemented: NotImplemented[];
  /**
   * The FTP block (server whitelist entry landed with W3-A4b; the
   * exact section key is `ftp`). Absent from envelopes stored before the
   * block existed and from seasoned-book runs (which carry the typed
   * `ftp.seasoned-book` register tag instead); the server 404s typed on an
   * absent block rather than recomputing.
   */
  ftp: FtpResult;
  /** The SEG, EBP and constant-balance NII block (schema 1.9.0). Present only when the run opted in to `seg`; the route 404s with a sentence otherwise. */
  seg: SegResult;
  /** The liquidity stress ladder block (schema 1.9.0). Present only when the run opted in to `liquidityStress`; the route 404s with a sentence otherwise. */
  liquidityStress: LiquidityStressResult;
}
export type ResultSection = keyof ResultSectionMap;

/**
 * Tables of GET /api/runs/:id/export/:table.csv, verbatim from the table. The four of slice A4 and the two of S3d-1
 * (the stress ladder and the survival path) are 409 on a run that does not store them; compare refuses the two.
 */
export type ExportTable =
  | "nii" | "eve" | "repricing-gap" | "liquidity-gap" | "attribution" | "cashflows"
  | "repricing-gap-buckets" | "liquidity-gap-buckets" | "liquidity-gap-interest" | "ftp"
  | "liquidity-stress" | "survival-path";

// --- Transport ---------------------------------------------------------------

const BASE = "/api";

async function parseError(res: Response): Promise<ApiError> {
  let body: ApiErrorBody | undefined;
  try {
    body = (await res.json()) as ApiErrorBody;
  } catch {
    // Non-JSON error body (proxy failure, server down): surface the raw status.
  }
  if (body?.error) {
    return new ApiError(res.status, body.error.code, body.error.message, body.error.detail, body);
  }
  return new ApiError(res.status, "http-error", `${res.status} ${res.statusText}`);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) throw await parseError(res);
  return (await res.json()) as T;
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const enc = encodeURIComponent;

/**
 * The transport, shared with the sibling api modules (workspaces.ts) so they raise the same
 * ApiError and send JSON the same way. Not part of the endpoint table. `apiBase` and `apiParseError`
 * let a sibling read a refusal body as data (the curve setup 422) and raise every other failure as here.
 */
export { request as apiRequest, postJson as apiPostJson, enc as apiEnc, BASE as apiBase, parseError as apiParseError };

// --- Endpoint table, verbatim ---------------------------

/** GET /api/health */
export function getHealth(): Promise<HealthInfo> {
  return request<HealthInfo>("/health");
}

/** GET /api/portfolios */
export function listPortfolios(): Promise<PortfolioListItem[]> {
  return request<PortfolioListItem[]>("/portfolios");
}

/** GET /api/portfolios/:id */
export function getPortfolio(id: string): Promise<PortfolioSpec> {
  return request<PortfolioSpec>(`/portfolios/${enc(id)}`);
}

/** One position as GET /api/portfolios/:id/positions serves it: identity and the facts a drop-down filters and labels by. */
export interface PositionRow {
  id: string;
  familyId: string;
  coaNodeId: string;
  instrumentType: string;
  notional: number;
  maturityMonths?: number;
}

/** The page: `total` is the filtered count, so a client pages by it. Rows keep the book's order. */
export interface PositionsPage {
  total: number;
  limit: number;
  offset: number;
  rows: PositionRow[];
}

/** The filters of the positions read. `q` is a case-sensitive prefix of the position id; the rest are exact; all AND. */
export interface ListPositionsQuery {
  q?: string;
  familyId?: string;
  coaNodeId?: string;
  instrumentType?: string;
  limit?: number;
  offset?: number;
}

/**
 * GET /api/portfolios/:id/positions?q=&familyId=&coaNodeId=&instrumentType=&limit=&offset=
 * (Studio A+E contract 3). Read from the file store, so a book imported this session is
 * visible at once. The server's default limit is 500 and its ceiling 5000; an unknown filter
 * key is a 400. Query keys go out in the order above, skipping any left undefined.
 */
export function listPositions(bookId: string, query: ListPositionsQuery = {}): Promise<PositionsPage> {
  const params = new URLSearchParams();
  const keys = ["q", "familyId", "coaNodeId", "instrumentType", "limit", "offset"] as const;
  for (const k of keys) {
    const v = query[k];
    if (v !== undefined) params.set(k, String(v));
  }
  const qs = params.toString();
  return request<PositionsPage>(`/portfolios/${enc(bookId)}/positions${qs.length > 0 ? `?${qs}` : ""}`);
}

/**
 * POST /api/portfolios/import with a JSON PortfolioSpec body. The raw file
 * text is sent unmodified: the server is the validator, and re-serializing
 * client-side could mask a malformed file.
 */
export function importPortfolioJson(jsonText: string): Promise<ImportPortfolioResponse> {
  return request<ImportPortfolioResponse>("/portfolios/import", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: jsonText,
  });
}

/**
 * POST /api/portfolios/import?format=csv&coaId=&label=&portfolioId=&asOf=
 * with CSV text body. A CSV file cannot state the portfolio id, label, or
 * as-of date, and the platform never invents an as-of date, so all four
 * accompany the file as query parameters (W1-P2 intake step, implemented
 * by the server's import route).
 */
export function importPortfolioCsv(
  csvText: string,
  coaId: string,
  label: string,
  portfolioId: string,
  asOf: string,
): Promise<ImportPortfolioResponse> {
  return request<ImportPortfolioResponse>(
    `/portfolios/import?format=csv&coaId=${enc(coaId)}&label=${enc(label)}&portfolioId=${enc(portfolioId)}&asOf=${enc(asOf)}`,
    { method: "POST", headers: { "content-type": "text/csv" }, body: csvText },
  );
}

/** GET /api/market */
export function listMarket(): Promise<MarketListItem[]> {
  return request<MarketListItem[]>("/market");
}

/**
 * POST /api/market/import-workbook: raw .xlsx bytes, X-Filename header. `opts` becomes the query string
 * (`?workspaceId=&by=&asOf=&id=`, URL-encoded, only the keys that are set); with none the URL is the bare path.
 */
export function importMarketWorkbook(bytes: ArrayBuffer, filename: string, opts?: ImportWorkbookOptions): Promise<ImportWorkbookResponse> {
  const query = (["workspaceId", "by", "asOf", "id"] as const)
    .flatMap((k) => { const v = opts?.[k]; return v === undefined ? [] : [`${k}=${enc(v)}`]; })
    .join("&");
  return request<ImportWorkbookResponse>(`/market/import-workbook${query === "" ? "" : `?${query}`}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "X-Filename": filename },
    body: bytes,
  });
}

/** GET /api/assumption-sets */
export function listAssumptionSets(): Promise<AssumptionSetListItem[]> {
  return request<AssumptionSetListItem[]>("/assumption-sets");
}

/** GET /api/assumption-sets/:id */
export function getAssumptionSet(id: string): Promise<AssumptionSet> {
  return request<AssumptionSet>(`/assumption-sets/${enc(id)}`);
}

/**
 * POST /api/assumption-sets. Send WITHOUT contentHash: the engine's
 * bindAssumptions fills it server-side; a hand-authored hash is a contract
 * violation the server rejects.
 */
export function createAssumptionSet(set: AssumptionSet): Promise<AssumptionSet> {
  return postJson<AssumptionSet>("/assumption-sets", set);
}

/** POST /api/assumption-sets/diff */
export function diffAssumptionSets(body: DiffRequest): Promise<AssumptionDiff> {
  return postJson<AssumptionDiff>("/assumption-sets/diff", body);
}

/** The body of both derive routes. id and label are optional. */
export interface DeriveRequest {
  baseId: string;
  ops: DerivationOp[];
  id?: string;
  label?: string;
}

/** POST /api/assumption-sets/derive/preview: the derived set and one row per value touched; stores nothing. */
export interface DerivedSetPreview {
  set: AssumptionSet;
  changes: DerivationChange[];
}

/** POST /api/assumption-sets/derive: 201 created, or 200 unchanged on an identical re-save. */
export interface DerivedSetSaveReply extends DerivedSetPreview {
  outcome: "created" | "unchanged";
}

/** POST /api/assumption-sets/derive/preview. A refusal is an ApiError with detail.problems. */
export function previewDerivedSet(body: DeriveRequest): Promise<DerivedSetPreview> {
  return postJson<DerivedSetPreview>("/assumption-sets/derive/preview", body);
}

/** POST /api/assumption-sets/derive. 409 if the id holds different content; 422 lists every problem. */
export function saveDerivedSet(body: DeriveRequest): Promise<DerivedSetSaveReply> {
  return postJson<DerivedSetSaveReply>("/assumption-sets/derive", body);
}

/** GET /api/scenario-slates */
export function listScenarioSlates(): Promise<ScenarioSlate[]> {
  return request<ScenarioSlate[]>("/scenario-slates");
}

/** POST /api/scenario-slates */
export function createScenarioSlate(slate: ScenarioSlate): Promise<ScenarioSlate> {
  return postJson<ScenarioSlate>("/scenario-slates", slate);
}

/** POST /api/runs -> 202 { runId, queuePosition }; compute happens in the child. */
export function submitRun(body: SubmitRunBody): Promise<SubmitRunResponse> {
  return postJson<SubmitRunResponse>("/runs", body);
}

/** The SABR parameters of a smile preview; beta is held at 0 (the Hagan normal form). */
export interface VolSmileParams { alpha: number; beta: number; rho: number; nu: number }
export type VolSmileOverrides = Partial<Pick<VolSmileParams, "alpha" | "rho" | "nu">>;

/**
 * GET /api/market/:id/vol-smile: one expiry row of the short-rate volatility surface
 * against the SABR smile at the row's forward. Strikes and vols are decimals; residualBp is model minus stored. A
 * preview only: nothing is fitted, stored or read by a run. A bad query answers 422 in words.
 */
export interface VolSmileReply {
  marketId: string;
  expiryYears: number;
  underlyingTau: number;
  forward: number;
  heuristic: VolSmileParams;
  params: VolSmileParams;
  points: Array<{ strike: number; isAtm: boolean; normalVol: number; modelVol: number; residualBp: number }>;
  curve: Array<{ strike: number; modelVol: number }>;
  note: string;
}

/** The smile route's path under /api, with only the overrides given. */
export function volSmilePath(marketId: string, expiryYears: number, over: VolSmileOverrides = {}): string {
  const q = [`expiryYears=${expiryYears}`, ...(["alpha", "rho", "nu"] as const).flatMap((k) => (over[k] === undefined ? [] : [`${k}=${over[k]}`]))];
  return `/market/${enc(marketId)}/vol-smile?${q.join("&")}`;
}

export function getVolSmile(marketId: string, expiryYears: number, over: VolSmileOverrides = {}): Promise<VolSmileReply> {
  return request<VolSmileReply>(volSmilePath(marketId, expiryYears, over));
}

/** GET /api/runs */
export function listRuns(): Promise<RunSummary[]> {
  return request<RunSummary[]>("/runs");
}

/** GET /api/runs/:id */
export function getRun(id: string): Promise<RunDetail> {
  return request<RunDetail>(`/runs/${enc(id)}`);
}

/** URL of GET /api/runs/:id/events (SSE; consumed by api/sse.ts, not fetch). */
export function runEventsUrl(id: string): string {
  return `${BASE}/runs/${enc(id)}/events`;
}

/** POST /api/runs/:id/cancel -> 200, or 409 (ApiError) in a terminal state. */
export async function cancelRun(id: string): Promise<void> {
  await request<unknown>(`/runs/${enc(id)}/cancel`, { method: "POST" });
}

/** POST /api/runs/:id/label. Platform metadata only; the result envelope is never touched. */
export async function labelRun(id: string, label: string): Promise<void> {
  await postJson<unknown>(`/runs/${enc(id)}/label`, { label });
}

/** GET /api/runs/:id/result: the verbatim stored RunResult envelope. */
export function getResult(id: string): Promise<RunResult> {
  return request<RunResult>(`/runs/${enc(id)}/result`);
}

/**
 * GET /api/runs/:id/stochastic: the verbatim stored StochasticRunResult
 * envelope. Only runs submitted with mode "stochastic"
 * carry it; the server refuses this route on deterministic runs and refuses
 * every deterministic result route on stochastic runs, both typed: a
 * distribution mean can never be read as an EVE.
 */
export function getStochasticResult(id: string): Promise<StochasticRunResult> {
  return request<StochasticRunResult>(`/runs/${enc(id)}/stochastic`);
}

/**
 * GET /api/runs/:id/rates: the run's rate document, served verbatim
 * from rates.json. A run that finished before the document existed answers a
 * 404 whose message says so; it is rethrown as ApiError like every other read.
 */
export function getRates(id: string): Promise<RateDocument> {
  return request<RateDocument>(`/runs/${enc(id)}/rates`);
}

/**
 * GET /api/runs/:id/instruments: the per-position results file, served
 * verbatim from instruments.json. Only a run submitted with
 * instrumentResults.save has one; any other answers a 404 whose message says so,
 * rethrown as ApiError like every other read.
 */
export function getInstruments(id: string): Promise<InstrumentsFile> {
  return request<InstrumentsFile>(`/runs/${enc(id)}/instruments`);
}

/** URL of GET /api/runs/:id/instruments.csv: a download link, one row per position per scenario. */
export function instrumentsCsvUrl(id: string): string {
  return `${BASE}/runs/${enc(id)}/instruments.csv`;
}

export type { InstrumentRow, InstrumentScenarioRow, InstrumentsFile } from "@alm/engine";

/**
 * GET /api/reference/:id: one stored reference document, served verbatim.
 * A tie-out view reads its reconciliation targets through it. An id the store does not hold
 * answers a 404 whose message names the id, rethrown as ApiError like every other read.
 */
export function getReferenceDocument<T>(id: string): Promise<T> {
  return request<T>(`/reference/${enc(id)}`);
}

export interface RunLensesResponse {
  baseScenarioId: string;
  lenses: LensReading[];
}

/** GET /api/runs/:id/lenses: every stored lens read against the run. */
export function getRunLenses(id: string): Promise<RunLensesResponse> {
  return request<RunLensesResponse>(`/runs/${enc(id)}/lenses`);
}

/** One stored lens definition as GET /api/lenses lists it: the stored fields verbatim, plus the store's content hash. */
export interface LensListItem extends LensDefinition {
  contentHash: string;
}

/** GET /api/lenses (Controls, limits): every stored lens definition, ascending id. Read-only; the seed is the only writer. */
export function listLenses(): Promise<LensListItem[]> {
  return request<LensListItem[]>("/lenses");
}

/** GET /api/runs/:id/result/:section: one top-level envelope key, no recompute. */
export function getResultSection<S extends ResultSection>(id: string, section: S): Promise<ResultSectionMap[S]> {
  return request<ResultSectionMap[S]>(`/runs/${enc(id)}/result/${section}`);
}

export type { NiiMonthlyChart, NiiMonthlyFamilyRow, NiiMonthlyReply, NiiMonthlyScenario } from "@alm/engine";

/**
 * GET /api/runs/:id/result/nii/monthly (Studio A+E contract 7): interest income, expense and net
 * per month per family, read by the engine off the stored cash flow block. The reply type is the
 * engine's own, so it cannot drift from the server. 200 with kind "absent" when the run stored no
 * monthly net; 409 for a stochastic run; 422 naming a family the chart of accounts does not carry.
 */
export function getNiiMonthly(runId: string): Promise<NiiMonthlyReply> {
  return request<NiiMonthlyReply>(`/runs/${enc(runId)}/result/nii/monthly`);
}

/** GET /api/runs/:id/query?metric=&scenarioId=&familyId= via the engine's sliceResult. */
export function queryRun(id: string, query: Omit<ResultQuery, "runId">): Promise<ResultSlice> {
  const qs = new URLSearchParams({ metric: query.metric });
  if (query.scenarioId !== undefined) qs.set("scenarioId", query.scenarioId);
  if (query.familyId !== undefined) qs.set("familyId", query.familyId);
  return request<ResultSlice>(`/runs/${enc(id)}/query?${qs.toString()}`);
}

/** GET /api/runs/:id/pivot?view=&metric=&scenarioId= (piece 2b route): rows rolled up from stored cells, nothing recomputed. */
export function getPivot(
  id: string,
  query: { view: string; metric: PivotMetric; scenarioId: string },
): Promise<PivotResult> {
  const qs = new URLSearchParams({ view: query.view, metric: query.metric, scenarioId: query.scenarioId });
  return request<PivotResult>(`/runs/${enc(id)}/pivot?${qs.toString()}`);
}

/** POST /api/runs/:id/explain */
export function explainRun(
  id: string,
  body: { metric: "nii-12m" | "nii-24m" | "eve"; scenarioId: string },
): Promise<ExplainResponse> {
  return postJson<ExplainResponse>(`/runs/${enc(id)}/explain`, body);
}

/**
 * URL of GET /api/runs/:id/export/:table.csv. A download link, not a fetch:
 * the browser saves the attachment; header rows carry runId and inputsHash.
 */
export function exportCsvUrl(id: string, table: ExportTable): string {
  return `${BASE}/runs/${enc(id)}/export/${table}.csv`;
}

/**
 * URL of the quarterly or annual roll-up CSV (GET /api/runs/:id/export/rollup-quarterly.csv or
 * rollup-annual.csv), periods counted from the cut-off unless `align` is "calendar"; `months` rolls the first N months.
 */
export function rollUpCsvUrl(id: string, period: "quarter" | "year", align: "cutoff" | "calendar" = "cutoff", months?: number): string {
  const q = [...(align === "calendar" ? ["align=calendar"] : []), ...(months !== undefined ? [`months=${months}`] : [])];
  return `${BASE}/runs/${enc(id)}/export/${period === "quarter" ? "rollup-quarterly" : "rollup-annual"}.csv${q.length > 0 ? `?${q.join("&")}` : ""}`;
}

/** URL of GET /api/compare.csv?runs=a,b&table=... (deltas labeled derived). */
export function compareCsvUrl(runA: string, runB: string, table: ExportTable): string {
  return `${BASE}/compare.csv?runs=${enc(runA)},${enc(runB)}&table=${table}`;
}

export type CompareCell = string | number | boolean | null;

/** GET /api/compare: compare.csv's aligned table as JSON; `delta` is the labeled derived B - A. */
export interface CompareReply {
  table: ExportTable;
  columns: Array<{ name: string; role: "key" | "num" | "text" }>;
  rows: Array<{ key: Record<string, CompareCell>; a: Record<string, CompareCell> | null; b: Record<string, CompareCell> | null; delta: Record<string, number | null> }>;
  provenance: { a: CompareProvenance; b: CompareProvenance };
  note: string;
}
/** `curve` is the run's curve line value (server export/csv.ts ExportProvenance); a server before B4 sends none. */
export interface CompareProvenance { runId: string; inputsHash: string; curve?: string; schemaVersion: string; engineVersion: string }

export function getCompare(runA: string, runB: string, table: ExportTable): Promise<CompareReply> {
  return request<CompareReply>(`/compare?runs=${enc(runA)},${enc(runB)}&table=${table}`);
}

export type {
  MeanDeltaBasis,
  StochasticCompare,
  StochasticContextRow,
  StochasticDistributionCompare,
  StochasticStatRow,
} from "@alm/engine";

/** GET /api/compare/stochastic: the one engine type, so the reply cannot drift from the server. */
export type StochasticCompareReply = StochasticCompare;

/** GET /api/compare/stochastic?runs=a,b: two stochastic runs, every B - A derived by the engine. */
export function getStochasticCompare(runA: string, runB: string): Promise<StochasticCompareReply> {
  return request<StochasticCompareReply>(`/compare/stochastic?runs=${enc(runA)},${enc(runB)}`);
}

/** URL of GET /api/compare/stochastic.csv?runs=a,b: a download link, the same reply under a stochastic provenance header. */
export function stochasticCompareCsvUrl(runA: string, runB: string): string {
  return `${BASE}/compare/stochastic.csv?runs=${enc(runA)},${enc(runB)}`;
}

export type {
  CalibrationGateState,
  StochasticCalibrationGate,
  StochasticRunSummary,
  StochasticSummaryContextRow,
  StochasticSummaryDistribution,
  StochasticSummaryRow,
} from "@alm/engine";

/**
 * GET /api/runs/:id/stochastic/summary: the one engine type, so the reply cannot drift from the server, and
 * the run's curve line beside it (optional, so a reply from an older server still reads).
 */
/** `gap` is the envelope's stored gap block, verbatim, present only when the run asked for it. */
export type StochasticSummaryReply = StochasticRunSummary & { curve?: RunCurveLine; gap?: StochasticGapBlock };

/** GET /api/runs/:id/stochastic/summary: one stochastic run's stored envelope as rows, every value verbatim. */
export function getStochasticSummary(id: string): Promise<StochasticSummaryReply> {
  return request<StochasticSummaryReply>(`/runs/${enc(id)}/stochastic/summary`);
}

/** URL of GET /api/runs/:id/stochastic/summary.csv: a download link, the same rows under a stochastic provenance header. */
export function stochasticSummaryCsvUrl(id: string): string {
  return `${BASE}/runs/${enc(id)}/stochastic/summary.csv`;
}

// --- Plan front door (harness Plane 4, pieces 1 and 1b) ----------------------

/** What POST /api/plans/validate answers: both gate reports plus the compile block. */
export interface ValidateResponse {
  type: GateReport;
  routing: GateReport;
  /**
   * Round-2 ruling 10: compile runs at validate time, so a unit-level refusal
   * surfaces here. `error` is the refusal class name when the server named one.
   */
  compile: { passed: boolean; detail?: string; error?: string };
  /** The compiler's tags for declared stages no mounted plugin executes (Studio S2); present on a successful compile. */
  notImplemented?: Array<{ layer: string; reason: string }>;
  /** The compiled plan's hash (PlanRef.planHash, Studio S3a); present on a successful compile only. */
  planHash?: string;
  profileHash?: string;
  profile?: Profile;
  runLog?: RunLogEntry[];
}

/** POST /api/plans/validate -> the reports; HTTP 200 even on failures. */
export function validatePlan(plan: unknown, patches: PatchLayer[] = []): Promise<ValidateResponse> {
  return postJson<ValidateResponse>("/plans/validate", { plan, ...(patches.length > 0 ? { patches } : {}) });
}

/**
 * Set Check: POST /api/plans/validate with an unsaved draft of one of the
 * plan's assumption sets. The draft stands in for the stored set with its id
 * in this one compile; nothing is stored. A malformed draft is the Save
 * route's 422, carried as ApiError.
 */
export function checkSetAgainstPlan(plan: unknown, candidate: AssumptionSet): Promise<ValidateResponse> {
  return postJson<ValidateResponse>("/plans/validate", { plan, candidateSets: [candidate] });
}

/** A stored run plan's meta row (Studio S2, GET /api/run-plans). */
export interface RunPlanMeta {
  id: string;
  contentHash: string;
  importedAt: string;
  label?: string;
  positionBook?: string;
  asOf?: string;
  seeded?: boolean;
}

export function listRunPlans(): Promise<RunPlanMeta[]> {
  return request<RunPlanMeta[]>("/run-plans");
}

/** The stored plan exactly as it was saved; key order is the author's. */
export function getRunPlan(id: string): Promise<RunPlan> {
  return request<RunPlan>(`/run-plans/${enc(id)}`);
}

/** 201 on first save, 200 on an identical re-save; 409 when the id holds different content. */
export function saveRunPlan(plan: unknown): Promise<RunPlanMeta> {
  return postJson<RunPlanMeta>("/run-plans", { plan });
}

// --- Approvals (Controls 2, approvals) ---------------------------------------

/** What can be approved: a run's result, a stored run plan, a stored assumption set. */
export type ApprovalTarget = "runs" | "run-plans" | "assumption-sets";
export type ApprovalDecision = "approved" | "revoked";
/** "changed": records exist only for an earlier content hash; "none": no record at all. */
export type ApprovalState = "approved" | "revoked" | "changed" | "none";

/**
 * One stored approval record (GET /api/approvals). `by` is typed by whoever
 * recorded it and is NOT verified: Studio has no sign-in. `id` and `at` are
 * assigned by the server.
 */
export interface ApprovalRecord {
  id: string;
  artifactCollection: ApprovalTarget;
  artifactId: string;
  artifactContentHash: string;
  decision: ApprovalDecision;
  by: string;
  at: string;
  note: string;
}

/** GET /api/approvals/status/:collection/:id */
export interface ApprovalStatus {
  artifactCollection: ApprovalTarget;
  artifactId: string;
  /** The hash a new record must carry: see ApprovalRequest. */
  currentContentHash: string;
  state: ApprovalState;
  /** Newest record at the current hash, or the newest overall when the state is "changed". */
  latest: ApprovalRecord | null;
  records: ApprovalRecord[];
}

/**
 * The body of POST /api/approvals. `artifactContentHash` is the artifact's
 * STORE FILE hash (the hash run_inputs pins), or for a run the sha256 over its
 * result.json. It is never the assumption-set bindings hash that
 * listAssumptionSets calls `contentHash`; take it from
 * getApprovalStatus(...).currentContentHash. `by` is typed text, trimmed on the
 * server, and is not verified. A revocation needs a live approval at that hash.
 */
export interface ApprovalRequest {
  artifactCollection: ApprovalTarget;
  artifactId: string;
  artifactContentHash: string;
  decision: ApprovalDecision;
  by: string;
  note?: string;
}

/** GET /api/approvals: every record, oldest first. */
export function listApprovals(): Promise<ApprovalRecord[]> {
  return request<ApprovalRecord[]>("/approvals");
}

/** GET /api/approvals/:id: one stored record, verbatim. */
export function getApproval(id: string): Promise<ApprovalRecord> {
  return request<ApprovalRecord>(`/approvals/${enc(id)}`);
}

/**
 * GET /api/approvals/status/:collection/:id: the state of one artifact and the
 * current content hash a new record must carry. 409 for a run that is not done.
 */
export function getApprovalStatus(collection: ApprovalTarget, id: string): Promise<ApprovalStatus> {
  return request<ApprovalStatus>(`/approvals/status/${enc(collection)}/${enc(id)}`);
}

/**
 * POST /api/approvals: 201 with the stored record. 409 when the submitted hash
 * is not the artifact's current one, or a revocation has no live approval.
 */
export function recordApproval(body: ApprovalRequest): Promise<ApprovalRecord> {
  return postJson<ApprovalRecord>("/approvals", body);
}

/** What a 202 from POST /api/plans/run carries beyond the ordinary run envelope. */
export type PlanRunResponse = SubmitRunResponse & {
  profileHash?: string;
  runLog?: RunLogEntry[];
  notImplemented?: NotImplemented[];
};

/** POST /api/plans/run -> 202 run envelope, or 422 carried verbatim as ApiError. */
export function runPlan(
  plan: unknown,
  opts: { seed?: string; label?: string; patches?: PatchLayer[] } = {},
): Promise<PlanRunResponse> {
  return postJson<PlanRunResponse>("/plans/run", { plan, ...opts });
}

/** GET /api/plans/library */
export function getPlanLibrary(): Promise<ScenarioLibrary[]> {
  return request<ScenarioLibrary[]>("/plans/library");
}

/** POST /api/scenarios/preview (Studio P3): one rate spec on a stored market snapshot's base zero curve. */
export interface ShockPreview {
  marketSnapshot: string;
  /** The stored snapshot's calibration date. */
  calibrationDate: string;
  /** The base zero curve at its own nodes; `z` continuously compounded. */
  base: CurveNodes;
  /** The shocked curve on the same nodes. */
  shocked: CurveNodes;
  /** `shocked.z` minus `base.z` at each node, in bp, computed by the server. */
  shiftBp: number[];
}

/** 200 with both curves; 404 for an unknown snapshot; 422 with the engine's refusal verbatim; 400 on a malformed body. */
export function previewShock(marketSnapshot: string, rateSpec: RateSpec): Promise<ShockPreview> {
  return postJson<ShockPreview>("/scenarios/preview", { marketSnapshot, rateSpec });
}

/** One row of GET /api/balance-plans. */
export interface BalancePlanListItem {
  id: string;
  contentHash: string;
  label: string;
  /** The stored as-of; "" when the store's meta holds none. */
  asOf: string;
  /** The base plan a derived balance plan was made from; absent on a plain plan. */
  derivedFromPlanId?: string;
}

/** GET /api/balance-plans */
export function listBalancePlans(): Promise<BalancePlanListItem[]> {
  return request<BalancePlanListItem[]>("/balance-plans");
}

/** GET /api/balance-plans/:id: the stored body, verbatim. */
export function getBalancePlan(id: string): Promise<BalancePlan> {
  return request<BalancePlan>(`/balance-plans/${enc(id)}`);
}

/** POST /api/balance-plans: 201 with the stored plan; 409 when the id is taken; 422 on a bad shape. */
export function saveBalancePlan(balancePlan: BalancePlan): Promise<BalancePlan> {
  return postJson<BalancePlan>("/balance-plans", { balancePlan });
}

/** The body of both balance-plan derive routes. id and label are optional. */
export interface BalanceDeriveRequest {
  baseId: string;
  /** The book the derived plan is checked against (it must still lower onto it). */
  bookId: string;
  ops: BalanceShockOp[];
  id?: string;
  label?: string;
}

/** POST /api/balance-plans/derive/preview: the derived plan, one row per knot touched and the lowered rules; stores nothing. */
export interface DerivedBalancePlanPreview {
  plan: BalancePlan;
  changes: BalanceKnotChange[];
  rules: NewBusinessRule[];
}

/** POST /api/balance-plans/derive: 201 created, or 200 unchanged on an identical re-save. */
export interface DerivedBalancePlanSaveReply extends DerivedBalancePlanPreview {
  outcome: "created" | "unchanged";
}

/** POST /api/balance-plans/derive/preview. A refusal is an ApiError with detail.problems. */
export function previewDerivedBalancePlan(body: BalanceDeriveRequest): Promise<DerivedBalancePlanPreview> {
  return postJson<DerivedBalancePlanPreview>("/balance-plans/derive/preview", body);
}

/** POST /api/balance-plans/derive. 409 if the id holds different content; 422 lists every problem. */
export function saveDerivedBalancePlan(body: BalanceDeriveRequest): Promise<DerivedBalancePlanSaveReply> {
  return postJson<DerivedBalancePlanSaveReply>("/balance-plans/derive", body);
}

/** GET /api/market/:id: the stored snapshot, verbatim (a derived market carries derivedFrom). */
export function getMarket(id: string): Promise<DerivedMarketSnapshot> {
  return request<DerivedMarketSnapshot>(`/market/${enc(id)}`);
}

/**
 * One side of GET /api/market/:id/curve-default: the engine's curve stamp (a setup also carries its
 * label when the block names one), or the engine's refusal in its own words.
 */
export type MarketCurveStamp = CurveDefaultStamp | { kind: "setup"; id: string; label: string } | { kind: "refused"; reason: string };

/** GET /api/market/:id/curve-default: what a run on the market builds (a setup wins), and its default with any setup set aside. */
export interface MarketCurveReply {
  marketId: string;
  builds: MarketCurveStamp;
  default: MarketCurveStamp;
}

/** GET /api/market/:id/curve-default. 404 for an unknown id. */
export function getMarketCurve(id: string): Promise<MarketCurveReply> {
  return request<MarketCurveReply>(`/market/${enc(id)}/curve-default`);
}

/** The body of both market derive routes (Piece 7a adds the rate index ops). id and label are optional. */
export interface MarketDeriveRequest {
  baseId: string;
  ops: MarketDeriveOp[];
  id?: string;
  label?: string;
}

/** POST /api/market/derive/preview: the derived snapshot and one row per TLP node touched; stores nothing. */
export interface DerivedMarketPreview {
  id: string;
  label: string;
  snapshot: DerivedMarketSnapshot;
  changes: TlpNodeChange[];
  /** One row per rate index the ops touched; an empty list for a funding-spread-only derive. */
  indexChanges: RateIndexChange[];
  /** One row per expiry row the short-rate volatility ops touched; an empty list when none ran. */
  volChanges: ShortRateVolChange[];
  /** One row per macro series the ops touched; absent when no macro op ran. */
  macroChanges?: MacroSeriesChange[];
  /** How many term-funding quotes the base carried and the derived market does not. */
  termFundingQuotesDropped: number;
}

/** POST /api/market/derive: 201 created, or 200 unchanged on an identical re-save. */
export interface DerivedMarketSaveReply extends DerivedMarketPreview {
  outcome: "created" | "unchanged";
}

/** POST /api/market/derive/preview. A refusal is an ApiError with detail.problems. */
export function previewDerivedMarket(body: MarketDeriveRequest): Promise<DerivedMarketPreview> {
  return postJson<DerivedMarketPreview>("/market/derive/preview", body);
}

/** POST /api/market/derive. 409 if the id holds different content; 422 lists every problem. */
export function saveDerivedMarket(body: MarketDeriveRequest): Promise<DerivedMarketSaveReply> {
  return postJson<DerivedMarketSaveReply>("/market/derive", body);
}

// --- The single-instrument drill (harness Plane 5) -----------------

/** One month of the drilled schedule, exactly as the engine returned it. */
export interface InstrumentScheduleRowView {
  month: number;
  pathRate: number;
  couponRate: number;
  balance: number;
  principal: number;
  interest: number;
  payment: number;
  /** Studio A+E contract 8: the factors the scenario PVs use at month/12, and the row PVs. On a swap both carry the risk-free leg. */
  discountFactorAllIn: number;
  discountFactorRiskFree: number;
  pvAllIn: number;
  pvRiskFree: number;
}

/** One scenario's projection. Absent WAL or duration means unobservable. */
export interface InstrumentScenarioProjectionView {
  scenarioId: string;
  rateSpec: RateSpec;
  rows: InstrumentScheduleRowView[];
  repricingMonths: number[];
  walMonths?: number;
  pvAllIn: number;
  pvRiskFree: number;
  effectiveDuration?: number;
  /** A swap's two signed leg schedules; `rows` is then the net schedule. */
  legs?: { receive: InstrumentScheduleRowView[]; pay: InstrumentScheduleRowView[] };
  /** "notional" when effectiveDuration is per unit of notional (a swap). */
  durationBasis?: "notional";
  /** Studio A+E contract 8: present only for a swap, whose rows carry the risk-free factor in both fields. */
  discountBasisNote?: "swap: risk-free on both bases";
}

/** What POST /api/instrument/project answers: the engine result plus the caption. */
export interface InstrumentDrill {
  terms: Record<string, unknown> & { id: string; type: string; notional: number };
  familyId: string;
  side: string;
  horizonMonths: number;
  durationBumpBp: number;
  overlayApplied: string;
  byScenario: InstrumentScenarioProjectionView[];
  /** The convention the drill ran, present when the request named one. */
  modelConvention?: "corrected-v1" | "book";
  marketId: string;
  /**
   * The caption the route built: the request's scenarioSlateId, or the literal
   * "inline" for a single parallel shock. Rendered verbatim, never rebuilt.
   */
  scenarioSource: string;
}

/** The body the drill route accepts. */
export interface ProjectInstrumentRequest {
  instrument:
    | { portfolioId: string; positionId: string }
    | { terms: Record<string, unknown>; familyId: string; side: "asset" | "liability" };
  marketId: string;
  /** Three arms, one at a time: a stored slate, one inline shock, or shipped-library refs "<library id>#<scenario id>" (contract 21). */
  scenarios: { scenarioSlateId: string } | { parallelShockBp: number } | { libraryRefs: string[] };
  assumptionSetId?: string;
  horizonMonths?: number;
  durationBumpBp?: number;
  /** The model convention the drill walks a CD book on; absent is the original convention. */
  modelConvention?: "corrected-v1" | "book";
}

/**
 * POST /api/instrument/project. Computed on demand and never stored, so there
 * is no run id to poll and nothing to fetch afterwards.
 */
export function projectInstrument(body: ProjectInstrumentRequest): Promise<InstrumentDrill> {
  return postJson<InstrumentDrill>("/instrument/project", body);
}

/** A mounted plugin as GET /api/catalog/plugins serves it. */
export interface MountedPlugin {
  id: string;
  aliases: string[];
  kind: string | null;
}

/** One row of docs/harness/catalog.json components, verbatim. */
export interface CatalogComponentRow {
  id: string;
  kind: string;
  family?: string;
  role?: string;
  label: string;
  consumes: string[];
  produces: string[];
  purpose?: string;
  /** A caveat note in prose, verbatim from catalog.json; not a flag. */
  critical?: string;
}

export interface PluginCatalogReply {
  components: CatalogComponentRow[];
  stageKinds: Array<{ id: string; label: string; note?: string }>;
  mounted: MountedPlugin[];
}

export function getPluginCatalog(): Promise<PluginCatalogReply> {
  return request<PluginCatalogReply>("/catalog/plugins");
}

// --- Hierarchies --------------------------------------------

export type HierarchyKind = "risk" | "liquidity" | "regulatory";

export interface HierarchyLevel {
  id: string;
  label: string;
}

/** One node of the tree. `parentId` is null at the first level; `level` is a level id. */
export interface HierarchyNode {
  id: string;
  parentId: string | null;
  level: string;
}

/** A stored hierarchy: one authored tag mapped into a tree of named levels. `map` is source value to leaf node id. */
export interface Hierarchy {
  schemaVersion: string;
  id: string;
  label: string;
  kind: HierarchyKind;
  sourceDimension: string;
  levels: HierarchyLevel[];
  nodes: HierarchyNode[];
  map: Record<string, string>;
}

/** A stored hierarchy's meta row (GET /api/hierarchies). `checkedBookId` is the book its first save was checked against. */
export interface HierarchyMeta {
  id: string;
  contentHash: string;
  importedAt: string;
  label: string;
  kind: HierarchyKind;
  sourceDimension: string;
  checkedBookId: string;
  seeded?: boolean;
}

export type HierarchySaveReply = HierarchyMeta & { outcome: "created" | "unchanged" };

/** One tag a book declares, with the values a hierarchy must map and why it may not be eligible. */
export interface HierarchySourceDimension {
  id: string;
  label: string;
  eligible: boolean;
  reason: string | null;
  values: string[];
  carried: boolean;
}

/** GET /api/hierarchies/sources/:bookId. taxonomyId is null and dimensions empty for a book with no taxonomy. */
export interface HierarchySources {
  bookId: string;
  taxonomyId: string | null;
  dimensions: HierarchySourceDimension[];
}

/** POST /api/hierarchies/:id/apply: the new book's id and the tags it carries; no figure. */
export interface HierarchyApplyReply {
  outcome: "created" | "unchanged";
  id: string;
  label: string;
  asOf: string;
  positionCount: number;
  contentHash: string;
  sourceBookId: string;
  hierarchyId: string;
  taxonomyId: string | null;
  tags: string[];
  /** Ids of the positions that carry no value for the source tag (so got no hierarchy tag), ascending by code unit. */
  untaggedPositionIds: string[];
}

/** GET /api/hierarchies: the stored hierarchies' meta rows; 200. */
export function listHierarchies(): Promise<HierarchyMeta[]> {
  return request<HierarchyMeta[]>("/hierarchies");
}

/** GET /api/hierarchies/:id: the stored hierarchy verbatim; 200, 404 for an unknown id. */
export function getHierarchy(id: string): Promise<Hierarchy> {
  return request<Hierarchy>(`/hierarchies/${enc(id)}`);
}

/** GET /api/hierarchies/sources/:bookId: the tags a book offers and their values; 200, 404 for an unknown book. */
export function getHierarchySources(bookId: string): Promise<HierarchySources> {
  return request<HierarchySources>(`/hierarchies/sources/${enc(bookId)}`);
}

/** POST /api/hierarchies: 201 created, 200 identical re-save; 404 unknown book, 409 id holds different content, 422 with detail { problems, unmapped }. */
export function saveHierarchy(hierarchy: unknown, bookId: string): Promise<HierarchySaveReply> {
  return postJson<HierarchySaveReply>("/hierarchies", { hierarchy, bookId });
}

/** POST /api/hierarchies/:id/apply: 201 wrote the re-tagged book, 200 already applied; 404, 409 id held by another book, 422 with detail { problems, unmapped }. */
export function applyHierarchy(hierarchyId: string, bookId: string): Promise<HierarchyApplyReply> {
  return postJson<HierarchyApplyReply>(`/hierarchies/${enc(hierarchyId)}/apply`, { bookId });
}
