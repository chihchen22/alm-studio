/**
 * Calibration as its own saved action.
 *
 *   POST /api/calibrations/fit   { marketId, model, solver? }                    the fit, nothing written
 *   POST /api/calibrations       { marketId, model, solver?, label, by, reason? } fit again and save; 201 the document
 *   GET  /api/calibrations?marketId=                                             the saved fits, newest first
 *   GET  /api/calibrations/:id                                                   one saved fit
 *
 * The save never trusts a client's numbers: it fits again on the stored snapshot, with the same solver options,
 * through the engine's `fitCalibration` (the kernel's calibrateHW or calibrateBGM, nothing else). The document is
 * content-addressed, `cal-<16 hex>` of the document without its author and time, and append-only: saving the same fit
 * again answers the stored one. A fit outside its gate is saved only with a written reason. A snapshot whose lineage
 * carries a short-rate volatility shock, or cannot be followed, is refused: a saved fit reaches a run through the
 * override seam, which reads no surface. BGM solver options exist here only; SABR has no fitter (it stays a preview).
 */
import {
  bgmSolverOptionsOf,
  BgmSubsetError,
  CalibrationFitError,
  fitCalibration,
  gateText,
  SAVED_CALIBRATION_SCHEMA_VERSION,
  StochasticCapVolsError,
  StochasticLongYieldVolsError,
  type CalibrationFit,
  type SavedCalibration,
  type StochasticModel,
} from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import type { PlatformContext } from "../../context";
import { shortRateVolShockLineage } from "../../derivedSets/derivedMarkets";
import { AlreadyExistsError, NotFoundError } from "../../store/store";
import { requireByValue } from "../../workspaces/rules";
import { notFound, unprocessable } from "../errors";
import type { Router } from "../router";

type Body = Record<string, unknown>;

const MODELS: readonly StochasticModel[] = ["hull-white-1f", "bgm-lmm-2f"];
const LABEL_MAX = 120;
const REASON_MAX = 1000;

function bodyOf(raw: unknown): Body {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw unprocessable("the request body must be a JSON object");
  return raw as Body;
}

/** Read and fit: the stored snapshot, its lineage checked, the model's fit with the options given. */
function fitOf(ctx: PlatformContext, body: Body): { marketId: string; marketHash: string; fit: CalibrationFit } {
  const marketId = body.marketId;
  if (typeof marketId !== "string" || marketId === "") throw unprocessable('"marketId" must name a stored market snapshot', { field: "marketId" });
  const model = body.model;
  if (typeof model !== "string" || !(MODELS as readonly string[]).includes(model)) throw unprocessable('"model" must be "hull-white-1f" or "bgm-lmm-2f" (SABR has no fitter: its smile is a preview)', { field: "model" });
  let market: MarketSnapshot;
  let marketHash: string;
  try {
    market = ctx.store.getDocument<MarketSnapshot>("market", marketId).doc;
    marketHash = ctx.store.getMeta("market", marketId).contentHash;
  } catch (err) {
    if (err instanceof NotFoundError) throw unprocessable(`no stored market snapshot "${marketId}"`, { field: "marketId" });
    throw err;
  }
  const lineage = shortRateVolShockLineage(ctx.store, marketId, market);
  if (lineage.kind === "shocked") throw unprocessable("This market carries a volatility shock; a saved fit cannot carry it into a run. Fit at run time on this market instead.", { field: "marketId" });
  if (lineage.kind === "broken") throw unprocessable("This market's lineage cannot be followed to its base, so it cannot be shown to carry no volatility shock. Fit at run time instead.", { field: "marketId" });
  try {
    const solver = bgmSolverOptionsOf(body.solver);
    return { marketId, marketHash, fit: fitCalibration(market, model as StochasticModel, solver) };
  } catch (err) {
    if (err instanceof CalibrationFitError || err instanceof StochasticCapVolsError || err instanceof StochasticLongYieldVolsError || err instanceof BgmSubsetError) {
      throw unprocessable(err.message, { field: "solver" });
    }
    throw err;
  }
}

/** The document's id: the content hash of everything but its author and time. */
export function calibrationIdOf(doc: Omit<SavedCalibration, "id" | "createdBy" | "createdAt">): string {
  return `cal-${contentHash(doc).slice(0, 16)}`;
}

export function registerCalibrationRoutes(router: Router, ctx: PlatformContext): void {
  const { store } = ctx;

  router.add("POST", "/api/calibrations/fit", (req) => {
    const { marketId, marketHash, fit } = fitOf(ctx, bodyOf(req.json()));
    return { kind: "json", value: { fit, pins: { marketId, marketHash, curveDefault: fit.curveDefault, curveFingerprint: fit.curveFingerprint }, verdict: gateText(fit) } };
  });

  router.add("POST", "/api/calibrations", (req) => {
    const body = bodyOf(req.json());
    const by = requireByValue(body.by);
    const label = body.label;
    if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX) throw unprocessable(`"label" must name the fit in 1 to ${LABEL_MAX} characters`, { field: "label" });
    if (body.reason !== undefined && (typeof body.reason !== "string" || body.reason.length > REASON_MAX)) throw unprocessable(`"reason" must be text of at most ${REASON_MAX} characters`, { field: "reason" });
    const reason = typeof body.reason === "string" ? body.reason.trim() : "";
    const { marketId, marketHash, fit } = fitOf(ctx, body);
    if (fit.breached && reason === "") {
      throw unprocessable(`This fit is outside its gate (${gateText(fit)}). Write the reason you accept it to save it.`, { field: "reason" });
    }
    const content: Omit<SavedCalibration, "id" | "createdBy" | "createdAt"> = {
      schemaVersion: SAVED_CALIBRATION_SCHEMA_VERSION,
      label: label.trim(),
      fit,
      pins: { marketId, marketHash, curveDefault: fit.curveDefault, curveFingerprint: fit.curveFingerprint },
      acceptance: fit.breached ? { kind: "outside-gate", reason } : { kind: "within-gate" },
    };
    const id = calibrationIdOf(content);
    if (store.has("calibrations", id)) return { kind: "json", status: 200, value: store.getDocument<SavedCalibration>("calibrations", id).doc };
    const doc: SavedCalibration = { ...content, id, createdBy: by, createdAt: new Date().toISOString() };
    try {
      store.putDocument("calibrations", id, doc, { label: doc.label, model: fit.model, marketId, rmseBp: fit.rmseBp, breached: fit.breached, createdAt: doc.createdAt });
    } catch (err) {
      if (!(err instanceof AlreadyExistsError)) throw err;
      return { kind: "json", status: 200, value: store.getDocument<SavedCalibration>("calibrations", id).doc };
    }
    return { kind: "json", status: 201, value: doc };
  });

  router.add("GET", "/api/calibrations", (req) => {
    const marketId = req.query.get("marketId");
    const docs = store
      .listMeta("calibrations")
      .map((m) => store.getDocument<SavedCalibration>("calibrations", m.id).doc)
      .filter((d) => marketId === null || d.pins.marketId === marketId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
    return { kind: "json", value: { calibrations: docs } };
  });

  router.add("GET", "/api/calibrations/:id", (req) => {
    const id = req.params.id ?? "";
    if (!store.has("calibrations", id)) throw notFound(`no saved calibration "${id}"`);
    return { kind: "json", value: store.getDocument<SavedCalibration>("calibrations", id).doc };
  });
}
