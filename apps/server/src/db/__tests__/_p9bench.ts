/**
 * W3-P9 bench probe: measured catalog query timings at the 100k-position
 * scale. A verification instrument, not a suite member (vitest collects only
 * *.test.ts; the A5/A7 probe-file precedent). Run directly:
 *
 *   npx tsx apps/server/src/db/__tests__/_p9bench.ts
 *
 * Generates the 100k synthetic book into a scratch store, mirrors it, then
 * times the read surface.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePortfolio, DEFAULT_GENERATOR_CONFIG } from "@alm/data";
import { FileStore } from "../../store/store";
import { defaultDbPath, openPlatformDb } from "../database";
import { syncStoreToDb } from "../ingest";
import { Catalog } from "../queries";

function time<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  console.log(`${label}: ${(performance.now() - t0).toFixed(1)} ms`);
  return out;
}

const root = mkdtempSync(join(tmpdir(), "alm-p9-bench-"));
try {
  const store = new FileStore(root);
  store.init();
  const spec = time("generate 100k book", () =>
    generatePortfolio({
      ...DEFAULT_GENERATOR_CONFIG,
      portfolioId: "bench-100k",
      portfolioLabel: "bench",
      targetPositions: 100_000,
    }),
  );
  console.log(`positions emitted: ${spec.positions.length}`);
  time("store put (JSON write)", () =>
    store.putDocument("portfolios", spec.id, spec, {
      label: spec.label,
      asOf: spec.asOf,
      positionCount: spec.positions.length,
    }),
  );
  const db = openPlatformDb(defaultDbPath(root));
  const report = time("db mirror (documents + position rows)", () => syncStoreToDb(store, db));
  console.log(`rows inserted: ${report.positionsInserted}`);
  db.close();

  const cat = Catalog.open(defaultDbPath(root));
  time("ungrouped aggregate (count/notional/wavg rate/wavg maturity)", () =>
    cat.positionsAggregate("bench-100k", {}),
  );
  time("grouped aggregate by family", () =>
    cat.positionsAggregateGrouped("bench-100k", {}, "family"),
  );
  time("grouped aggregate by instrumentType", () =>
    cat.positionsAggregateGrouped("bench-100k", {}, "instrumentType"),
  );
  const fam = spec.positions[0].familyId;
  time(`filtered aggregate (familyId=${fam})`, () =>
    cat.positionsAggregate("bench-100k", { familyId: fam }),
  );
  time("first page (limit 5,000)", () => cat.positionsPage("bench-100k", {}, 5_000, 0));
  time("deep page (limit 5,000, offset 90,000)", () =>
    cat.positionsPage("bench-100k", {}, 5_000, 90_000),
  );
  const t0 = performance.now();
  let n = 0;
  let offset = 0;
  for (;;) {
    const page = cat.positionsPage("bench-100k", {}, 5_000, offset);
    n += page.positions.length;
    if (page.positions.length < 5_000) break;
    offset += 5_000;
  }
  console.log(
    `full paginated walk (${Math.ceil(n / 5_000)} pages of 5,000): ${(performance.now() - t0).toFixed(1)} ms, ${n} rows`,
  );
  cat.close();
} finally {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // temp cleaner owns leftovers
  }
}
