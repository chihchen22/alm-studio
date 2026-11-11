/**
 * In-memory portfolio registry.
 *
 * Backs the loadPortfolio side effect (tools.ts EngineTools.loadPortfolio): a
 * portfolio is registered once, keyed by its id, and looked up by id when a run
 * projects it. The store is a Map used ONLY for keyed get/set; its iteration
 * order never enters a computational path, so it introduces no reproducibility
 * hazard (the risk register's map-order concern is about aggregation, not
 * lookup). A repeated id overwrites the prior registration, matching the
 * documented side effect.
 */
import type { PortfolioId } from "../contracts/ids";
import type { PortfolioHandle, PortfolioSpec } from "../contracts/position";

const store = new Map<PortfolioId, PortfolioSpec>();

/**
 * Register a portfolio and return a handle. SIDE EFFECT: writes the store keyed
 * by spec.id; a repeated id overwrites the prior portfolio.
 */
export function loadPortfolio(spec: PortfolioSpec): PortfolioHandle {
  store.set(spec.id, spec);
  return { id: spec.id, positionCount: spec.positions.length, asOf: spec.asOf };
}

/** Look up a registered portfolio. Throws on an unknown id (never a fake empty book). */
export function getPortfolio(id: PortfolioId): PortfolioSpec {
  const spec = store.get(id);
  if (spec === undefined) {
    throw new Error(`getPortfolio: no portfolio registered for id "${id}"`);
  }
  return spec;
}

/** True if a portfolio is registered under `id`. */
export function hasPortfolio(id: PortfolioId): boolean {
  return store.has(id);
}

/** Drop all registrations. For test isolation and explicit teardown. */
export function clearPortfolios(): void {
  store.clear();
}
