/**
 * Typed HTTP errors and the one mapping rule: errors are
 * { error: { code, message, detail? } } with 400 (malformed), 404 (unknown id),
 * 409 (state conflict), 422 (validation, per-item detail). Engine and compiler
 * exceptions map to 422 with the engine's message VERBATIM; the platform never
 * rewrites an engine refusal into something softer.
 */
import { InvalidIdError } from "../store/paths";
import { AlreadyExistsError, NotFoundError } from "../store/store";
import { ConflictError } from "../jobs/queue";
import { LockPending, RevisionConflict } from "../workspaces/workspaceStore";

export interface ErrorBody {
  error: { code: string; message: string; detail?: unknown };
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: unknown): HttpError =>
  new HttpError(400, "bad-request", message, detail);
export const notFound = (message: string): HttpError => new HttpError(404, "not-found", message);
export const conflict = (message: string): HttpError => new HttpError(409, "conflict", message);
export const unprocessable = (message: string, detail?: unknown): HttpError =>
  new HttpError(422, "validation", message, detail);
/** A capability whose owning module is not present yet: explicit, never faked. */
export const notImplementedHere = (message: string): HttpError =>
  new HttpError(501, "not-implemented", message);

/** Map any thrown value to a typed HTTP error per the design's table. */
export function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof NotFoundError) return notFound(err.message);
  if (err instanceof AlreadyExistsError) return conflict(err.message);
  if (err instanceof ConflictError) return conflict(err.message);
  // A workspace write whose expectedRevision is behind the head: 409 with both numbers.
  if (err instanceof RevisionConflict) {
    return new HttpError(409, "revision-conflict", err.message, { expected: err.expected, actual: err.actual });
  }
  // A write to a Production workspace whose sign-off lock is still outstanding (review B m2).
  if (err instanceof LockPending) return new HttpError(409, "conflict", err.message, { approvalId: err.approvalId });
  if (err instanceof InvalidIdError) return unprocessable(err.message);
  if (err instanceof Error) {
    // Engine/compiler refusals surface verbatim as 422 validation errors:
    // DuplicateAssumptionSetError, AssumptionValidationError, ScenarioSpecError,
    // UnknownFamilyError, ViewDefinitionError, CellBudgetError,
    // PivotUnavailableError, LensUnavailableError, DerivativeOverlayError,
    // ClientRateSpreadMismatchError, kernel domain errors.
    // Anything not thrown as an Error subclass with a recognized name still
    // carries its message verbatim.
    const validationNames = new Set([
      "DuplicateAssumptionSetError",
      "AssumptionValidationError",
      "ScenarioSpecError",
      "UnknownFamilyError",
      // The view-refusal family. The routes that raise them catch them
      // first (by class or as ExecutorError); this is the net under any that does not.
      "ViewDefinitionError",
      "CellBudgetError",
      "PivotUnavailableError",
      // The lens refusal. The lens routes catch it first and attach the
      // lens id; this is the net under any caller that does not.
      "LensUnavailableError",
      // A behavioral overlay bound to a swap family, refused in
      // resolveAssumptions on the live run route. A request error, not a crash.
      "DerivativeOverlayError",
      // Piece 9, the client-rate spread refusal; a request error, not a crash.
      "ClientRateSpreadMismatchError",
      // A derivation refusal. The derive routes catch it first and attach
      // detail.problems; this is the net under any caller that does not.
      "AssumptionDerivationError",
      // Stochastic Compare: a pair whose horizon, basis or quantile set differs. The
      // route catches it first and attaches the field; this is the net under any other caller.
      "StochasticCompareError",
      // Studio A+E contract 7: the monthly NII reader's refusal. The route catches it first
      // and attaches the family; this is the net under any other caller.
      "NiiMonthlyUnavailableError",
    ]);
    if (validationNames.has(err.name)) return unprocessable(err.message);
    return new HttpError(500, "internal", err.message);
  }
  return new HttpError(500, "internal", String(err));
}

export function errorBody(err: HttpError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.detail !== undefined ? { detail: err.detail } : {}),
    },
  };
}
