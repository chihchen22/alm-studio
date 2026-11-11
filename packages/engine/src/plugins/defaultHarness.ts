/**
 * The process-wide default context. resolveDefaultContext() does NOT build one,
 * so a caller that never touches plugins pays nothing; buildRunResult builds it
 * lazily the first time a run reaches a seam without a caller-supplied harness.
 */
import type { Context } from "@alm/harness";
import { mountProfile, profileHash } from "@alm/harness";
import { BUILTIN_CATALOG, DEFAULT_PROFILE } from "./catalog";

let memo: Context | undefined;
let hashMemo: string | undefined;

export function defaultHarness(): Context {
  if (memo === undefined) memo = mountProfile(DEFAULT_PROFILE, BUILTIN_CATALOG);
  return memo;
}

/**
 * True when this context IS the process default. Identity, and it never builds
 * one: a caller who supplied their own harness must not pay for a default they
 * never asked for, and if the default path was taken the memo is already set.
 */
export function isDefaultHarness(ctx: Context): boolean {
  return memo !== undefined && ctx === memo;
}

/**
 * The provenance identity of the default profile. Memoized because it is pure
 * over a module constant; the run stamps it only when the run actually used the
 * default context (a caller-mounted context carries its own hash on the
 * pipeline context, or none at all — a stamp is never guessed).
 */
export function defaultProfileHash(): string {
  if (hashMemo === undefined) hashMemo = profileHash(DEFAULT_PROFILE);
  return hashMemo;
}

/**
 * Drop the memo. For tests that mount a changed default; not used by the run path.
 *
 * The memo is cleared BEFORE the unwind, so a teardown that throws
 * (DisposeFailedError) still surfaces to the caller without wedging the process
 * on a poisoned context: the next defaultHarness() builds a fresh one.
 */
export function resetDefaultHarness(): void {
  const doomed = memo;
  memo = undefined;
  doomed?.dispose();
}
