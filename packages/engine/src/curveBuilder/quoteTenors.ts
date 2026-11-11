/**
 * Quote-tenor side channel.
 *
 * A curve built under log-linear-df, cubic-zero or monotone-convex carries
 * dense monthly nodes, so curve.t no longer names the quotes it was built
 * from. Key-rate duration and the rate documents need the quote tenors, so
 * they are registered here, keyed on the curve object itself (a WeakMap: the
 * ZeroCurve interface stays the kernel's, and a dropped curve frees its entry).
 * A curve with no registration reports its own nodes, which is the truth for
 * a kernel bootstrap or a quote-node curve.
 */
import type { ZeroCurve } from "@alm/kernel";

const registry = new WeakMap<ZeroCurve, number[]>();

/** Record the quote tenors (years) a curve was built from. Stores a copy. */
export function registerQuoteTenors(curve: ZeroCurve, tenors: readonly number[]): void {
  registry.set(curve, [...tenors]);
}

/** The registered quote tenors, else the curve's own nodes. Always a fresh copy. */
export function quoteTenorsOf(curve: ZeroCurve): number[] {
  const registered = registry.get(curve);
  return registered ? [...registered] : [...curve.t];
}

/**
 * Carry a registration from one curve object to another (a shocked or
 * rehydrated copy of a built curve). No-op when `from` has none.
 */
export function inheritQuoteTenors(from: ZeroCurve, to: ZeroCurve): void {
  const registered = registry.get(from);
  if (registered) registry.set(to, [...registered]);
}
