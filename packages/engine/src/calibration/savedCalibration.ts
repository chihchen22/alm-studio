/**
 * Calibration as its own action, and a saved fit a stochastic run can use.
 *
 * A fit calls the kernel's own `calibrateHW` and `calibrateBGM` (no kernel change) on exactly the inputs the
 * stochastic run fits on at run time: the base curve the run builds from the snapshot (`buildBaseCurve`), the
 * at-the-money cap column for Hull-White, the kernel's default subset of the long-yield surface for BGM. With no
 * solver option a fit reproduces the run-time fit bit for bit. BGM solver options (the iteration cap and the
 * starting points) exist here only; the run-time BGM fit is unchanged. SABR has no fitter: it stays a preview.
 *
 * A saved fit is a document pinned to the market snapshot's stored bytes (its hash) and to the curve the run would
 * build (a fingerprint of its discount factors and the curve default it used). A run that names it reads its
 * parameters through the engine's override seam and records a `saved-calibration` arm in the envelope, never the
 * `override` arm: the arm carries the fit diagnostics, the gate verdict, the acceptance and the pins. A run on another
 * snapshot or curve is refused, in one plain sentence.
 *
 * A fit outside its gate is reported, never refused, and may be saved only with a written reason; the document and
 * every run that uses it say "outside its gate".
 */
import { calibrateBGM, calibrateHW, isDefaultCalibrationSwaption, BGM_CEV_BETA_OF_RECORD, BGM_DISPLACEMENT_OF_RECORD, type MarketSnapshot } from "@alm/kernel";
import { BGM_RMSE_GATE_BP, BGM_SUBSET_MIN_POINTS, HW_RMSE_GATE_BP, type StochasticModel } from "../contracts/stochastic";
import { contentHash } from "../runtime/contentHash";
import { buildBaseCurve, curveDefaultStampOf } from "../scenario/rateEnvironment";
import { StochasticCapVolsError } from "../scenario/stochasticEnvironment";
import { BgmSubsetError, StochasticLongYieldVolsError } from "../scenario/bgmEnvironment";
import { shortRateVolOpCount } from "../market/shortRateVolOps";

export const SAVED_CALIBRATION_SCHEMA_VERSION = "1.0.0";

/** The BGM solver options the calibration action offers (the kernel's own option names). */
export interface BgmSolverOptions {
  maxIterations?: number;
  aInit?: number;
  bInit?: number;
  cInit?: number;
  dInit?: number;
  betaInit?: number;
  volScalarInit?: number;
}

export const BGM_SOLVER_KEYS = ["maxIterations", "aInit", "bInit", "cInit", "dInit", "betaInit", "volScalarInit"] as const;

/** The fitted parameters of either model. */
export type CalibrationParameters =
  | { model: "hull-white-1f"; a: number; sigma: number }
  | { model: "bgm-lmm-2f"; a: number; b: number; c: number; d: number; beta: number; volScalar: number; displacement: number; cevBeta: number };

/** One quote of the fit: the market's at-the-money normal vol beside the model's, in basis points. */
export interface CalibrationQuote {
  expiryYears: number;
  /** BGM only: the swap tenor of the point, years. */
  tenorYears?: number;
  marketVolBp: number;
  modelVolBp: number;
  residualBp: number;
}

/** What the run would fit on, pinned: the snapshot and the curve the run builds from it. */
export interface CalibrationPins {
  marketId: string;
  /** SHA-256 of the market snapshot's stored bytes, as the store hashes them. */
  marketHash: string;
  /** The curve default the base curve was built under (version and method). */
  curveDefault: string;
  /** Content hash of the base curve's discount factors at months 1 to 360. */
  curveFingerprint: string;
}

/** A fit, before it is saved. */
export interface CalibrationFit {
  model: StochasticModel;
  parameters: CalibrationParameters;
  rmseBp: number;
  gateBp: number;
  /** True when the fit error is above the gate: reported, never refused. */
  breached: boolean;
  iterations: number;
  nQuotes: number;
  /** Hull-White only: the caplet accrual, years. */
  underlyingTau?: number;
  /** The solver options the fit used; empty for the run-time defaults. */
  solver: BgmSolverOptions;
  quotes: CalibrationQuote[];
  curveDefault: string;
  curveFingerprint: string;
}

/** A saved fit (the `calibrations` collection). */
export interface SavedCalibration {
  schemaVersion: string;
  id: string;
  label: string;
  fit: CalibrationFit;
  pins: CalibrationPins;
  /** Within its gate, or saved outside its gate with the reason a person wrote. */
  acceptance: { kind: "within-gate" } | { kind: "outside-gate"; reason: string };
  createdBy: string;
  createdAt: string;
}

/** What a run reads of a saved fit: the request carries it verbatim, so the child never reads the store. */
export interface SavedCalibrationUse {
  calibrationId: string;
  model: StochasticModel;
  parameters: CalibrationParameters;
  rmseBp: number;
  gateBp: number;
  breached: boolean;
  acceptance: SavedCalibration["acceptance"];
  pins: CalibrationPins;
}

/** The envelope arm of a run that used a saved fit (stochastic schema 0.5.0). */
export interface SavedCalibrationArm {
  source: "saved-calibration";
  model: StochasticModel;
  calibrationId: string;
  parameters: CalibrationParameters;
  rmseBp: number;
  rmseGateBp: number;
  rmseGateBreached: boolean;
  /** Present when the fit was saved outside its gate: the reason written at save time. */
  outsideGateReason?: string;
  marketId: string;
  marketHash: string;
  curveFingerprint: string;
}

/** The plain words of a fit's verdict, written on the document's every reader. */
export function gateText(fit: Pick<CalibrationFit, "rmseBp" | "gateBp" | "breached">): string {
  return `${fit.rmseBp.toFixed(2)} bp against a ${fit.gateBp} bp gate: ${fit.breached ? "outside its gate" : "within its gate"}`;
}

/** The curve default stamp in one string. */
function stampText(snapshot: MarketSnapshot): string {
  const s = curveDefaultStampOf(snapshot) as unknown as Record<string, unknown>;
  return JSON.stringify(s);
}

/** The fingerprint of the base curve a stochastic run builds from this snapshot: its discount factors at months 1 to 360. */
export function curveFingerprintOf(snapshot: MarketSnapshot): { curveDefault: string; curveFingerprint: string } {
  const curve = buildBaseCurve(snapshot);
  const dfs: number[] = [];
  for (let m = 1; m <= 360; m++) dfs.push(curve.discountFactor(m / 12));
  return { curveDefault: stampText(snapshot), curveFingerprint: contentHash({ dfs }) };
}

/** A typed refusal of a fit the market cannot support, or of options the action does not take. */
export class CalibrationFitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalibrationFitError";
  }
}

/** The BGM solver options, checked: whole positive iteration cap at most 2000, finite starting points. */
export function bgmSolverOptionsOf(raw: unknown): BgmSolverOptions {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CalibrationFitError("solver options must be an object of the BGM solver's options");
  const out: BgmSolverOptions = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BGM_SOLVER_KEYS as readonly string[]).includes(k)) throw new CalibrationFitError(`unknown solver option "${k}"; the BGM solver takes ${BGM_SOLVER_KEYS.join(", ")}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new CalibrationFitError(`solver option "${k}" must be a finite number`);
    if (k === "maxIterations" && (!Number.isInteger(v) || v < 1 || v > 2000)) throw new CalibrationFitError("the iteration cap must be a whole number from 1 to 2000");
    (out as Record<string, number>)[k] = v;
  }
  return out;
}

/**
 * Fit a model on a snapshot, as the run would. Hull-White takes no solver option here (its run-time fit passes its
 * gate on the public pack); BGM takes the solver options above. A snapshot carrying a short-rate volatility shock is
 * refused: a saved fit is consumed through the override seam, which never reads a shocked surface.
 */
export function fitCalibration(snapshot: MarketSnapshot, model: StochasticModel, solver: BgmSolverOptions = {}): CalibrationFit {
  if (shortRateVolOpCount(snapshot) > 0) {
    throw new CalibrationFitError("This market carries a volatility shock; a saved fit cannot carry it into a run. Fit at run time on this market instead.");
  }
  const curve = buildBaseCurve(snapshot);
  const { curveDefault, curveFingerprint } = curveFingerprintOf(snapshot);
  if (model === "hull-white-1f") {
    if (Object.keys(solver).length > 0) throw new CalibrationFitError("solver options apply to the BGM fit only");
    if (!snapshot.capQuotes.some((q) => q.isAtm)) throw new StochasticCapVolsError();
    const fit = calibrateHW(snapshot, curve);
    return {
      model,
      parameters: { model, a: fit.a, sigma: fit.sigma },
      rmseBp: fit.rmseBp,
      gateBp: HW_RMSE_GATE_BP,
      breached: fit.rmseBp > HW_RMSE_GATE_BP,
      iterations: fit.iterations,
      nQuotes: fit.expiries.length,
      underlyingTau: fit.underlyingTau,
      solver: {},
      quotes: fit.expiries.map((expiryYears, i) => ({ expiryYears, marketVolBp: fit.marketVols[i]! * 1e4, modelVolBp: fit.modelVols[i]! * 1e4, residualBp: fit.residualsBp[i]! })),
      curveDefault,
      curveFingerprint,
    };
  }
  if (snapshot.swaptionATMQuotes.length === 0) throw new StochasticLongYieldVolsError();
  const subset = snapshot.swaptionATMQuotes.filter(isDefaultCalibrationSwaption);
  if (subset.length < BGM_SUBSET_MIN_POINTS) throw new BgmSubsetError(subset.length);
  // With no option this is the run-time call exactly (bgmEnvironment.ts): the same subset, the same defaults.
  const fit = Object.keys(solver).length === 0 ? calibrateBGM({ ...snapshot, swaptionATMQuotes: subset }, curve) : calibrateBGM({ ...snapshot, swaptionATMQuotes: subset }, curve, { ...solver });
  return {
    model,
    parameters: { model, a: fit.a, b: fit.b, c: fit.c, d: fit.d, beta: fit.beta, volScalar: fit.volScalar, displacement: fit.displacement, cevBeta: fit.cevBeta },
    rmseBp: fit.rmseBp,
    gateBp: BGM_RMSE_GATE_BP,
    breached: fit.rmseBp > BGM_RMSE_GATE_BP,
    iterations: fit.iterations,
    nQuotes: fit.expiries.length,
    solver: { ...solver },
    quotes: fit.expiries.map((expiryYears, i) => ({ expiryYears, tenorYears: fit.tenors[i]!, marketVolBp: fit.marketVols[i]! * 1e4, modelVolBp: fit.modelVols[i]! * 1e4, residualBp: fit.residualsBp[i]! })),
    curveDefault,
    curveFingerprint,
  };
}

/** The BGM fixed values a saved fit must hold for the override seam to reproduce it (the seam fixes them). */
export function bgmFixedValuesHold(p: CalibrationParameters): boolean {
  return p.model !== "bgm-lmm-2f" || (p.displacement === BGM_DISPLACEMENT_OF_RECORD && p.cevBeta === BGM_CEV_BETA_OF_RECORD);
}

/** What a run reads of a saved document. */
export function savedCalibrationUseOf(doc: SavedCalibration): SavedCalibrationUse {
  return {
    calibrationId: doc.id,
    model: doc.fit.model,
    parameters: doc.fit.parameters,
    rmseBp: doc.fit.rmseBp,
    gateBp: doc.fit.gateBp,
    breached: doc.fit.breached,
    acceptance: doc.acceptance,
    pins: doc.pins,
  };
}

/**
 * The refusal sentence of a saved fit on a run's market, or null when it may be used: the same snapshot (by id and
 * stored hash) and the same curve (by fingerprint).
 */
export function savedCalibrationMismatch(use: Pick<SavedCalibrationUse, "calibrationId" | "pins">, marketId: string, marketHash: string, curve: { curveFingerprint: string }): string | null {
  if (use.pins.marketId !== marketId || use.pins.marketHash !== marketHash) {
    return `The saved calibration ${use.calibrationId} was fitted on market snapshot "${use.pins.marketId}", and this run reads "${marketId}"${use.pins.marketId === marketId ? " with different contents" : ""}: fit the model again on this market, or run on that one.`;
  }
  if (use.pins.curveFingerprint !== curve.curveFingerprint) {
    return `The saved calibration ${use.calibrationId} was fitted on a different curve from the one this run builds on market snapshot "${marketId}": fit the model again, or run on the curve it was fitted on.`;
  }
  return null;
}

/** The envelope arm a run records when it used a saved fit. */
export function savedCalibrationArmOf(use: SavedCalibrationUse): SavedCalibrationArm {
  return {
    source: "saved-calibration",
    model: use.model,
    calibrationId: use.calibrationId,
    parameters: use.parameters,
    rmseBp: use.rmseBp,
    rmseGateBp: use.gateBp,
    rmseGateBreached: use.breached,
    ...(use.acceptance.kind === "outside-gate" ? { outsideGateReason: use.acceptance.reason } : {}),
    marketId: use.pins.marketId,
    marketHash: use.pins.marketHash,
    curveFingerprint: use.pins.curveFingerprint,
  };
}
