/**
 * Acceptance check: catalog-read-surface (anchored W6-C1).
 *
 * The capability is the /api/catalog/* read surface over the database
 * mirror; its aggregates (count, total notional, notional-weighted rate and
 * maturity) are computed IN SQL and served verbatim. Anchor, per the standing
 * step in declared-deferred.json and the limitations page: AGGREGATE
 * RECONCILIATION — this check independently recomputes the same aggregates
 * from the store DOCUMENTS (a JS fold over the portfolio JSON, the non-SQL
 * path) and asserts the two independent representations agree within 1e-12
 * relative (counts exact), per family and for the whole book, over the seeded
 * synthetic portfolio (11 families, 2,351 positions at the committed generator
 * seed) in a scratch store (the same in-process
 * mirror technique database.ts uses; no HTTP server is booted).
 *
 * The honesty edge the catalog carries is asserted in the same line:
 * weightedAvgRate is notional-weighted over RATE-BEARING rows only (basis:
 * ratedNotional; nmd-b beta-s-curve and cd cohort-book scalar rates are
 * honestly NULL), so a family with no rate-bearing notional reports NULL —
 * never a fabricated 0 — while a genuine zero-rate family (dda: nmd with
 * depositRate 0) reports exactly 0, never NULL.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortfolioSpec } from "@alm/engine";
import { FileStore } from "../../../../apps/server/src/store/store";
import { seedStore, SEED_IDS } from "../../../../apps/server/scripts/seed-store";
import { defaultDbPath } from "../../../../apps/server/src/db/database";
import { Catalog, type PositionsAggregate } from "../../../../apps/server/src/db/queries";
import type { CapabilityCheck, CheckLine } from "./types";

const RECONCILE_BOUND = 1e-12;

/**
 * The scalar-rate convention the D1 ingest documents (rateOf), re-derived
 * independently here from the DOCUMENT terms — never from the database.
 */
function docRateOf(terms: Record<string, unknown> & { type: string }): number | null {
  switch (terms.type) {
    case "fixed-loan":
      return terms.coupon as number;
    case "floating-loan":
      return terms.margin as number;
    case "mortgage":
      return terms.noteRate as number;
    case "nmd":
      return terms.depositRate as number;
    default:
      return null; // nmd-b (beta S-curve) and cd (cohort book): model-implied
  }
}

interface Fold {
  count: number;
  notional: number;
  rateNotional: number; // sum(rate * notional) over rate-bearing rows
  ratedNotional: number; // sum(notional) over rate-bearing rows
  maturityNotional: number; // sum(maturity * notional)
  remainingNotional: number; // sum((maturity + offset) * notional)
}

function emptyFold(): Fold {
  return {
    count: 0,
    notional: 0,
    rateNotional: 0,
    ratedNotional: 0,
    maturityNotional: 0,
    remainingNotional: 0,
  };
}

function foldByFamily(positions: PortfolioSpec["positions"]): Map<string, Fold> {
  const out = new Map<string, Fold>();
  for (const p of positions) {
    const t = p.terms as unknown as Record<string, unknown> & {
      type: string;
      notional: number;
      maturityMonths: number;
      originationOffsetMonths?: number;
    };
    const f = out.get(p.familyId) ?? emptyFold();
    const rate = docRateOf(t);
    f.count += 1;
    f.notional += t.notional;
    if (rate !== null) {
      f.rateNotional += rate * t.notional;
      f.ratedNotional += t.notional;
    }
    f.maturityNotional += t.maturityMonths * t.notional;
    f.remainingNotional += (t.maturityMonths + (t.originationOffsetMonths ?? 0)) * t.notional;
    out.set(p.familyId, f);
  }
  return out;
}

/** What the SQL layer must report for a fold, under its own NULL semantics. */
function expectedAggregate(f: Fold): Omit<PositionsAggregate, "positionCount"> {
  return {
    totalNotional: f.notional,
    weightedAvgRate: f.ratedNotional > 0 ? f.rateNotional / f.ratedNotional : null,
    ratedNotional: f.ratedNotional > 0 ? f.ratedNotional : null,
    weightedAvgMaturityMonths: f.notional !== 0 ? f.maturityNotional / f.notional : null,
    weightedAvgRemainingMaturityMonths: f.notional !== 0 ? f.remainingNotional / f.notional : null,
  };
}

/** Relative deviation; Infinity on a null-vs-number disagreement (fails the bound). */
function relDev(actual: number | null, expected: number | null): number {
  if (actual === null || expected === null) return actual === expected ? 0 : Infinity;
  return Math.abs(actual - expected) / Math.max(Math.abs(expected), 1);
}

function maxDevOf(actual: PositionsAggregate, expected: Omit<PositionsAggregate, "positionCount">): number {
  return Math.max(
    relDev(actual.totalNotional, expected.totalNotional),
    relDev(actual.weightedAvgRate, expected.weightedAvgRate),
    relDev(actual.ratedNotional, expected.ratedNotional),
    relDev(actual.weightedAvgMaturityMonths, expected.weightedAvgMaturityMonths),
    relDev(actual.weightedAvgRemainingMaturityMonths, expected.weightedAvgRemainingMaturityMonths),
  );
}

export const catalogCheck: CapabilityCheck = {
  capabilityId: "catalog-read-surface",
  title: "Catalog read surface: SQL aggregates reconcile to the document fold",
  async run({ repoRoot }) {
    const lines: CheckLine[] = [];
    const storeRoot = mkdtempSync(join(tmpdir(), "alm-accept-catalog-"));
    let catalog: Catalog | undefined;
    try {
      const store = new FileStore(storeRoot);
      await seedStore(store, repoRoot); // seeds AND mirrors into platform.db
      catalog = Catalog.open(defaultDbPath(storeRoot)); // PRAGMA query_only = ON

      // Independent recompute: fold the stored DOCUMENT (the non-SQL path).
      const doc = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.syntheticPortfolio).doc;
      const fold = foldByFamily(doc.positions);

      // SQL side: per-family groups plus the ungrouped whole-book aggregate.
      const groups = catalog.positionsAggregateGrouped(SEED_IDS.syntheticPortfolio, {}, "family");
      const total = catalog.positionsAggregate(SEED_IDS.syntheticPortfolio, {});

      const familiesMatch =
        groups.length === fold.size && groups.every((g) => fold.has(g.key as string));
      let countsExact = familiesMatch;
      let maxDev = 0;
      for (const g of groups) {
        const f = fold.get(g.key as string);
        if (f === undefined) continue;
        if (g.positionCount !== f.count) countsExact = false;
        maxDev = Math.max(maxDev, maxDevOf(g, expectedAggregate(f)));
      }
      const whole = [...fold.values()].reduce((a, f) => ({
        count: a.count + f.count,
        notional: a.notional + f.notional,
        rateNotional: a.rateNotional + f.rateNotional,
        ratedNotional: a.ratedNotional + f.ratedNotional,
        maturityNotional: a.maturityNotional + f.maturityNotional,
        remainingNotional: a.remainingNotional + f.remainingNotional,
      }), emptyFold());
      if (total.positionCount !== whole.count || whole.count !== doc.positions.length) countsExact = false;
      maxDev = Math.max(maxDev, maxDevOf(total, expectedAggregate(whole)));

      // Honesty edge, from the document side of the reconciliation: families
      // with NO rate-bearing notional must report NULL (never 0); families
      // whose every rate-bearing row carries rate 0 must report 0 (never NULL).
      const nullFamilies = [...fold.entries()].filter(([, f]) => f.ratedNotional === 0).map(([k]) => k);
      const zeroFamilies = [...fold.entries()]
        .filter(([, f]) => f.ratedNotional > 0 && f.rateNotional === 0)
        .map(([k]) => k);
      const byKey = new Map(groups.map((g) => [g.key as string, g]));
      const nullEdgeOk =
        nullFamilies.length > 0 &&
        nullFamilies.every((k) => byKey.get(k)?.weightedAvgRate === null && byKey.get(k)?.ratedNotional === null);
      const zeroEdgeOk =
        zeroFamilies.length > 0 &&
        zeroFamilies.every((k) => {
          const g = byKey.get(k);
          return g !== undefined && g.weightedAvgRate === 0 && (g.ratedNotional ?? 0) > 0;
        });

      const ok = familiesMatch && countsExact && maxDev <= RECONCILE_BOUND && nullEdgeOk && zeroEdgeOk;
      lines.push({
        id: "aggregate-reconciliation",
        status: ok ? "pass" : "fail",
        detail:
          `catalog SQL aggregates over the mirrored synthetic book (${groups.length} families, ` +
          `${total.positionCount.toLocaleString("en-US")} positions) reconcile to an independent JS fold over the store ` +
          `DOCUMENT (the non-SQL path): counts exact ${countsExact}, max relative deviation ` +
          `${maxDev.toExponential(2)} <= 1e-12 across notional/rate/maturity metrics, per family and whole-book; ` +
          `honesty edge: ${nullFamilies.join("+")} (no rate-bearing notional) report weightedAvgRate NULL not 0 (${nullEdgeOk}), ` +
          `${zeroFamilies.join("+")} (genuine zero-rate) reports 0 not NULL (${zeroEdgeOk}) ` +
          `(anchor: two independent computation paths over two independent representations; rate basis = ratedNotional)`,
      });

      return { lines, observedNotImplemented: [] };
    } finally {
      try {
        catalog?.close();
      } catch {
        // already closed
      }
      try {
        rmSync(storeRoot, { recursive: true, force: true });
      } catch {
        // Windows file locking (McAfee); the OS temp cleaner owns the leftovers.
      }
    }
  },
};
