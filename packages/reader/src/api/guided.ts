/**
 * The guided Analysis path's reads: apps/server/src/http/routes/guided.ts. Replies
 * are returned verbatim; nothing here rounds or derives a number.
 */
import type { BalancePlan, BehavioralOverlay, BgmSolverOptions, CalibrationFit, CalibrationPins, NewBusinessTemplate, NewVolumeTemplateSpec, SavedCalibration } from "@alm/engine";
import { apiBase, apiEnc as enc, apiPostJson as postJson, apiRequest as request } from "./client";

export interface ExampleBookRow {
  id: string;
  label: string;
  asOf: string;
  positionCount: number;
  /** The book ships a finished guided analysis (GET /api/guided/examples/:id/analysis). */
  analysis?: boolean;
}

/**
 * The finished guided analysis an example book ships with, as the server serves it: the
 * illustrative behavior bindings, the balance targets, the new-volume products, the going-concern choice and the
 * deposit history as the run option, with its source and terms.
 */
export interface ExampleAnalysis {
  schemaVersion: string;
  bookId: string;
  label: string;
  behavior: { label: string; modelVersion: string; bindings: Array<{ familyId: string; overlay: BehavioralOverlay; modelVersion: string }> };
  targets: { label: string; unlistedFamilies: "runoff"; targets: BalancePlan["targets"] };
  templates: NewVolumeTemplateSpec[];
  goingConcern: boolean;
  nmdWarmup: { kind: "history"; series: { label: string; firstMonth: string; valuesPct: number[] } };
  warmupSource: { file: string; source: string; sourceUrl: string; notice: string; termsUrl: string; firstMonth: string; lastMonth: string };
}

export type GuidedBehaviorRole = "prepayment" | "decay" | "repricing";

export interface GuidedBehaviorModel {
  key: string;
  role: GuidedBehaviorRole;
  label: string;
  instrumentTypes: string[];
  overlay: BehavioralOverlay;
  modelVersion: string;
  preview: string;
  source: string;
  /** The short badge shown beside these values (the server's words). */
  badge?: string;
}

export interface GuidedBehaviorPreview {
  title: string;
  xLabel: string;
  yLabel: string;
  xUnit: "bp" | "month" | "percent";
  yUnit: "percent" | "ratio";
  points: Array<[number, number]>;
  note: string;
}

/** GET /api/guided/examples: the example books the server can hand out. */
export function listExampleBooks(): Promise<ExampleBookRow[]> {
  return request<ExampleBookRow[]>("/guided/examples");
}

/** GET /api/guided/examples/:id: one example book, the PortfolioSpec as its file holds it. */
export function getExampleBook(id: string): Promise<unknown> {
  return request<unknown>(`/guided/examples/${enc(id)}`);
}

/** GET /api/guided/examples/:id/analysis: the finished analysis an example book ships with. */
export function getExampleAnalysis(id: string): Promise<ExampleAnalysis> {
  return request<ExampleAnalysis>(`/guided/examples/${enc(id)}/analysis`);
}

/** One feature demo an example book ships, as GET /api/guided/examples/:id/demos lists it. */
export interface ExampleDemoRow {
  id: string;
  title: string;
  /** The setup slot the demo opens in on the example workspace. */
  lineageId: string;
  /** The seeded setup document. */
  setupId: string;
  /** The seeded assumption sets the setup names. */
  setIds: string[];
  /** False on a store seeded before the demos existed: the card then shows no Open button. */
  stored: boolean;
}

/** GET /api/guided/examples/:id/demos: the feature demos an example book ships; empty for a book with none. */
export async function listExampleDemos(id: string): Promise<ExampleDemoRow[]> {
  const r = await request<{ demos: ExampleDemoRow[] }>(`/guided/examples/${enc(id)}/demos`);
  return r.demos;
}

/** Download links for the two position templates. */
export const POSITIONS_CSV_TEMPLATE_URL = `${apiBase}/guided/templates/positions.csv`;
export const POSITIONS_JSON_TEMPLATE_URL = `${apiBase}/guided/templates/positions.json`;
/** The stored chart of accounts the CSV template's family and node ids belong to. */
export const POSITIONS_CSV_TEMPLATE_COA = "mid-size-bank-coa-v1";

/** What GET /api/guided/deposit-history serves: the shipped public SOFR monthly history. */
export interface GuidedDepositHistory {
  file: string;
  nmdWarmup: { kind: "history"; series: { label: string; firstMonth: string; valuesPct: number[] } };
  firstMonth: string;
  lastMonth: string;
  source: string;
  sourceUrl: string;
  notice: string;
  termsUrl: string;
}

/** GET /api/guided/deposit-history: the deposit history a new analysis reads. */
export function getDepositHistory(): Promise<GuidedDepositHistory> {
  return request<GuidedDepositHistory>("/guided/deposit-history");
}

/** GET /api/guided/behavior-models: the published illustrative defaults, per role and instrument type. */
export async function listGuidedBehaviorModels(): Promise<GuidedBehaviorModel[]> {
  const r = await request<{ models: GuidedBehaviorModel[] }>("/guided/behavior-models");
  return r.models;
}

/** POST /api/guided/behavior-preview: one curve of an overlay, computed by the kernel's own functions. */
export function previewGuidedBehavior(overlay: BehavioralOverlay, ratePct?: number): Promise<GuidedBehaviorPreview> {
  return postJson<GuidedBehaviorPreview>("/guided/behavior-preview", ratePct === undefined ? { overlay } : { overlay, ratePct });
}

/** One run the guided Run step launched on POST /api/runs, linked to its workspace and setup by id (fix round 1, H2). */
export interface GuidedRunRow {
  runId: string;
  setupLineageId: string;
  setupDocId: string;
  at: string;
  by: string;
  status: { state: "queued" | "running" | "done" | "error" | "cancelled" | "interrupted"; label?: string; submittedAt: string; endedAt?: string } | null;
}

/** POST /api/workspaces/:id/guided-runs: link a launched run to the workspace and the setup document it ran. */
export function linkGuidedRun(workspaceId: string, body: { runId: string; setupLineageId: string; setupDocId: string; by: string }): Promise<unknown> {
  return postJson<unknown>(`/workspaces/${enc(workspaceId)}/guided-runs`, body);
}

/** What a template mints today: a 100-unit tranche at month 0 on the workspace's base path. */
export interface GuidedTemplatePreview {
  indexRate: number;
  couponRate: number;
  /** A fixed template only: its matched funding rate today and the margin over it (fix round M3). */
  transferRate?: number;
  margin?: number;
  months: Array<{ month: number; balance: number; couponRate: number }>;
  /** A behavioral template only, the model its tranches run, or why they are contractual. */
  behavior?: { model: GuidedNewVolumeModel; applied: boolean; source: "assumption-set" | "position" | "none"; modelVersions?: string[]; note: string };
  /** A loan tranche that runs a prepayment model, its annual CPR by month (decimal), month 1 first. */
  cprByMonth?: number[];
}

/** The behavioral models new volume can carry. */
export type GuidedNewVolumeModel = "four-factor-cpr" | "constant-cpr" | "nmd-decay" | "nmd-decay-beta" | "none";

/** One family of the New volume step's preview, as apps/server/src/http/routes/newVolumePreview.ts builds it. */
export interface GuidedNewVolumeFamily {
  familyId: string;
  label: string;
  side: string;
  instrumentType: string;
  opening: number;
  suggested: { template: NewBusinessTemplate; termMonths: number; basis: string } | null;
  preview?: GuidedTemplatePreview;
  target?: { balance: number[]; monthlyGrowthRate: number | null; annualGrowthPct: number | null };
  /** The model a new position of the family runs, whatever product is chosen. */
  model: { model: GuidedNewVolumeModel; label: string; source: "assumption-set" | "position" | "none"; modelVersions: string[]; reason?: string };
}

export interface GuidedNewVolumePreview {
  calibrationDate: string;
  todayRule: GuidedTemplatePreview;
  families: GuidedNewVolumeFamily[];
  problems: string[];
}

/** POST /api/workspaces/:id/new-volume-preview: per family the suggested product, a template's preview and the target path. */
export function previewNewVolume(workspaceId: string, body: { templates?: NewVolumeTemplateSpec[]; plan?: BalancePlan | null; months?: number }): Promise<GuidedNewVolumePreview> {
  return postJson<GuidedNewVolumePreview>(`/workspaces/${enc(workspaceId)}/new-volume-preview`, body);
}

/** GET /api/workspaces/:id/guided-runs: this workspace's linked runs only, newest first. */
export function listGuidedRuns(workspaceId: string): Promise<GuidedRunRow[]> {
  return request<GuidedRunRow[]>(`/workspaces/${enc(workspaceId)}/guided-runs`);
}

// ---------------------------------------------------------------------------
// Saved calibration: apps/server/src/http/routes/calibrations.ts
// ---------------------------------------------------------------------------

/** POST /api/calibrations/fit: the fit on a stored snapshot, nothing written. */
export interface CalibrationFitReply {
  fit: CalibrationFit;
  pins: CalibrationPins;
  /** "0.89 bp against a 5 bp gate: within its gate" */
  verdict: string;
}

export function fitRateModel(body: { marketId: string; model: "hull-white-1f" | "bgm-lmm-2f"; solver?: BgmSolverOptions }): Promise<CalibrationFitReply> {
  return postJson<CalibrationFitReply>("/calibrations/fit", body);
}

/** POST /api/calibrations: fit again on the server and save; a fit outside its gate needs `reason`. */
export function saveCalibration(body: { marketId: string; model: "hull-white-1f" | "bgm-lmm-2f"; solver?: BgmSolverOptions; label: string; by: string; reason?: string }): Promise<SavedCalibration> {
  return postJson<SavedCalibration>("/calibrations", body);
}

/** GET /api/calibrations?marketId=: the saved fits, newest first. */
export function listCalibrations(marketId?: string): Promise<SavedCalibration[]> {
  return request<{ calibrations: SavedCalibration[] }>(`/calibrations${marketId === undefined ? "" : `?marketId=${enc(marketId)}`}`).then((r) => r.calibrations);
}
