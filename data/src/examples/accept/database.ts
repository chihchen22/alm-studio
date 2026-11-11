/**
 * Acceptance check: platform-database-mirror.
 *
 * Anchor, per the mandate: BYTE PARITY. The SQLite mirror qualifies as a
 * run-input source only if a run composed from DB-resolved inputs is
 * byte-identical to the same run composed from the file store (the platform's
 * proven path), with every artifact pinned by content hash. The check seeds a
 * SCRATCH store (never the live var/store), lets the seed mirror it into
 * platform.db, then:
 *
 *   1. composes the vanilla run request BOTH ways and byte-compares the
 *      serialized requests (Buffer.compare === 0);
 *   2. runs both requests through the engine and byte-compares the serialized
 *      results, asserting the DB-side run reproduces the pinned vanilla golden
 *      effectiveDurationEquity 5.3663292287711295 EXACTLY (an oracle neither
 *      composition path can influence; 5.366960016565166 before curve default 2);
 *   3. asserts the DB-side pins equal the file store's own content hashes.
 *
 * ADR-022 scope, stated: parity QUALIFIES the DB to become the run path;
 * the file store remains the byte store of record and the live run path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssumptionSet, PortfolioSpec, RunRequest, Scenario } from "@alm/engine";
import type { MarketSnapshot } from "@alm/kernel";
import { buildRunResult, resolveDefaultContext } from "@alm/engine";
import { FileStore } from "../../../../apps/server/src/store/store";
import { seedStore, SEED_IDS } from "../../../../apps/server/scripts/seed-store";
import { defaultDbPath, openPlatformDb } from "../../../../apps/server/src/db/database";
import { composeRunInputsFromDb } from "../../../../apps/server/src/db/resolve";
import type { CapabilityCheck, CheckLine } from "./types";

// Re-pinned 5.366960016565166 -> 5.3663292287711295 on curve default 2 (log-linear on discount factor;
// interpolation only). The same run on the curveDefault: 1 market reproduces the old literal exactly.
const PINNED_DURATION = 5.3663292287711295;
const FIXED_STAMP = "2026-08-02T00:00:00.000Z";

interface SlateDoc {
  id: string;
  label: string;
  scenarios: Scenario[];
}

export const databaseCheck: CapabilityCheck = {
  capabilityId: "platform-database-mirror",
  title: "Platform database: content-hash-verified mirror, byte parity",
  async run({ repoRoot }) {
    const lines: CheckLine[] = [];
    const storeRoot = mkdtempSync(join(tmpdir(), "alm-accept-db-"));
    let db: ReturnType<typeof openPlatformDb> | undefined;
    try {
      const store = new FileStore(storeRoot);
      await seedStore(store, repoRoot);
      db = openPlatformDb(defaultDbPath(storeRoot));

      // File-store composition, field-for-field the way routes/runs.ts does.
      const runId = "accept-db-parity-1";
      const portfolioMeta = store.getMeta("portfolios", SEED_IDS.vanillaPortfolio);
      const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
      const slate = store.getDocument<SlateDoc>("scenario-slates", SEED_IDS.vanillaSlate).doc;
      const set = store.getDocument<AssumptionSet>("assumption-sets", SEED_IDS.vanillaAssumptions).doc;
      const portfolio = store.getDocument<PortfolioSpec>("portfolios", SEED_IDS.vanillaPortfolio).doc;
      const fileRequest: RunRequest = {
        runId,
        portfolioId: SEED_IDS.vanillaPortfolio,
        marketSnapshot: market,
        scenarios: slate.scenarios,
        assumptionSets: [set],
        grid: { horizonMonths: 360, asOf: portfolioMeta.asOf as string },
        seed: "platform-0",
        timestamps: { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP },
      };

      // DB-side composition from the mirror alone.
      const dbSide = composeRunInputsFromDb(db, {
        runId,
        portfolioId: SEED_IDS.vanillaPortfolio,
        marketId: SEED_IDS.market,
        scenarioSlateId: SEED_IDS.vanillaSlate,
        assumptionSetIds: [SEED_IDS.vanillaAssumptions],
        gridHorizonMonths: 360,
        seed: "platform-0",
        engineContext: { durationMode: "base-only", shards: "auto" },
      });
      dbSide.request.timestamps = { startedAt: FIXED_STAMP, finishedAt: FIXED_STAMP };

      const reqA = Buffer.from(JSON.stringify(fileRequest), "utf8");
      const reqB = Buffer.from(JSON.stringify(dbSide.request), "utf8");
      const reqParity = Buffer.compare(reqA, reqB) === 0;
      lines.push({
        id: "request-parity",
        status: reqParity ? "pass" : "fail",
        detail:
          `run request composed from the file store vs from the DB mirror alone: ` +
          `Buffer.compare === 0 over ${reqA.length.toLocaleString("en-US")} bytes: ${reqParity} ` +
          `(anchor: two independent storage representations must agree byte-for-byte before ` +
          `either feeds an engine)`,
      });

      const context = { ...resolveDefaultContext(), durationMode: "base-only" as const, shards: "auto" as const };
      const fileResult = buildRunResult(fileRequest, portfolio, context);
      const dbResult = buildRunResult(dbSide.request, dbSide.portfolio, context);
      const resA = Buffer.from(JSON.stringify(fileResult), "utf8");
      const resB = Buffer.from(JSON.stringify(dbResult), "utf8");
      const resParity = Buffer.compare(resA, resB) === 0;
      const dur = dbResult.eve.byScenario.find((s) => s.scenarioId === "S0")?.effectiveDurationEquity;
      const golden = Object.is(dur, PINNED_DURATION);
      lines.push({
        id: "result-parity-and-golden",
        status: resParity && golden ? "pass" : "fail",
        detail:
          `results byte-identical (${resA.length.toLocaleString("en-US")} bytes): ${resParity}; ` +
          `DB-side run reproduces the pinned vanilla golden effectiveDurationEquity ` +
          `${PINNED_DURATION} exactly: ${golden} (measured ${dur}) (anchor: the golden is an ` +
          `oracle neither composition path can influence)`,
      });

      const pin = dbSide.pins.find((p) => p.role === "portfolio");
      const pinOk = pin?.contentHash === portfolioMeta.contentHash;
      lines.push({
        id: "content-hash-pins",
        status: pinOk ? "pass" : "fail",
        detail:
          `DB-side portfolio pin ${pin?.contentHash?.slice(0, 12)}... equals the file store's own ` +
          `meta contentHash: ${pinOk} (anchor: tamper-evidence — every artifact the DB resolves ` +
          `is re-hashed against the store's pin)`,
      });

      return {
        lines,
        observedNotImplemented: [
          ...fileResult.notImplemented.map((t) => t.layer),
          ...dbResult.notImplemented.map((t) => t.layer),
        ],
      };
    } finally {
      try {
        db?.close();
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
