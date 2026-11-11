/**
 * Not-implemented conventions (implements errors.ts).
 *
 * Two honest signals for a layer that has not been built:
 *   - makeNotImplemented returns the tagged NotImplemented value, for a result
 *     slot a run can carry to completion (surfaces in RunResult.notImplemented);
 *   - NotImplementedError throws, for a hard precondition the caller must handle.
 *
 * isNotImplemented is the type guard the report layer uses to narrow a
 * `number | NotImplemented` result slot. Neither path ever substitutes a
 * plausible number.
 */
import {
  NOT_IMPLEMENTED,
  type NotImplemented,
  type MakeNotImplemented,
  type IsNotImplemented,
} from "../contracts/errors";

/** Build a tagged NotImplemented value for an unbuilt result slot. */
export const makeNotImplemented: MakeNotImplemented = (layer, reason) => ({
  _tag: NOT_IMPLEMENTED,
  layer,
  reason,
});

/** Narrow an unknown result slot to NotImplemented by its discriminant tag. */
export const isNotImplemented: IsNotImplemented = (x): x is NotImplemented =>
  typeof x === "object" &&
  x !== null &&
  (x as { _tag?: unknown })._tag === NOT_IMPLEMENTED;

/** Thrown by a layer whose precondition to run is not met. */
export class NotImplementedError extends Error {
  readonly layer: string;
  readonly reason: string;

  constructor(layer: string, reason: string) {
    super(`${layer}: ${reason}`);
    this.name = "NotImplementedError";
    this.layer = layer;
    this.reason = reason;
  }
}
