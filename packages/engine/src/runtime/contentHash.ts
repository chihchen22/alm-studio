/**
 * Deterministic content-hash utility.
 *
 * Every run stamps an inputsHash so two runs with the same inputs and seed are
 * provably the same computation (provenance.ts, ADR determinism). The hash must
 * therefore depend only on the *content* of the input, never on how a JS object
 * happened to be built:
 *
 *   - Object keys are canonicalized in sorted order, so insertion order does not
 *     change the digest.
 *   - Arrays keep their order (an array is ordered data, not a key set).
 *   - An explicit `undefined` property and a missing property hash alike, mirroring
 *     JSON's own drop-undefined behavior, so optional fields do not perturb it.
 *   - Non-finite numbers throw rather than collapsing to null (JSON's coercion),
 *     which would let NaN and Infinity collide with each other and with null.
 *
 * No clock, no randomness: SHA-256 over the canonical string is a pure function.
 */
import { createHash } from "node:crypto";
import { canonicalize } from "./canonicalize";

export { canonicalize };

/** SHA-256 (lowercase hex) of the canonical serialization of `value`. */
export function contentHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

/** SHA-256 (lowercase hex) of a text already in canonical form. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
