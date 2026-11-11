/**
 * W3-P9 catalog HTTP surface tests: the routes serve the query layer verbatim
 * over the wire, GET-only, with typed 404/422 mapping. The server here is a
 * minimal Router + node:http assembly (127.0.0.1, ephemeral port) because
 * registration in server.ts is a NOTE, not this module's edit.
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BIND_HOST, repoRoot, type PlatformConfig } from "../config";
import { FileStore } from "../store/store";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { Router, writeError } from "../http/router";
import { toHttpError } from "../http/errors";
import { registerCatalogRoutes } from "../http/routes/catalog";
import { Catalog } from "../db/queries";
import { defaultDbPath } from "../db/database";

let storeRoot: string;
let server: Server;
let base: string;

function makeConfig(root: string): PlatformConfig {
  return { host: BIND_HOST, port: 0, storeRoot: root, maxConcurrent: 1, repoRoot: repoRoot() };
}

function bootCatalogServer(root: string): Promise<{ server: Server; base: string }> {
  const router = new Router();
  registerCatalogRoutes(router, { config: makeConfig(root) });
  const srv = createServer((req, res) => {
    void (async () => {
      try {
        const handled = await router.dispatch(req, res);
        if (!handled) writeError(res, toHttpError(new Error(`no route for ${req.url}`)));
      } catch (err) {
        writeError(res, toHttpError(err));
      }
    })();
  });
  return new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, BIND_HOST, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ server: srv, base: `http://${BIND_HOST}:${port}` });
    });
  });
}

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  storeRoot = mkdtempSync(join(tmpdir(), "alm-p9-routes-"));
  const store = new FileStore(storeRoot);
  await seedStore(store, repoRoot()); // seeds AND mirrors into platform.db
  ({ server, base } = await bootCatalogServer(storeRoot));
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try {
    rmSync(storeRoot, { recursive: true, force: true });
  } catch {
    // Windows file locking; OS temp cleaner owns leftovers.
  }
});

describe("catalog HTTP surface", () => {
  it("lists mirrored portfolios with position counts", async () => {
    const { status, body } = await getJson("/api/catalog/portfolios");
    expect(status).toBe(200);
    const ids = body.map((p: { id: string }) => p.id);
    expect(ids).toContain(SEED_IDS.vanillaPortfolio);
    expect(ids).toContain(SEED_IDS.syntheticPortfolio);
    const vanilla = body.find((p: { id: string }) => p.id === SEED_IDS.vanillaPortfolio);
    expect(vanilla.positionCount).toBe(9);
    expect(vanilla.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pages positions with default limit and echoes page metadata", async () => {
    const { status, body } = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions`,
    );
    expect(status).toBe(200);
    expect(body.page.limit).toBe(500);
    expect(body.page.offset).toBe(0);
    expect(body.page.returned).toBe(500);
    expect(body.page.total).toBeGreaterThan(2_000);
    expect(body.positions.length).toBe(500);
    const row = body.positions[0];
    expect(typeof row.positionId).toBe("string");
    expect(typeof row.notional).toBe("number");
    expect(typeof row.rateKind).toBe("string");
  });

  it("serves SQL aggregates verbatim: the wire numbers === the query layer's numbers", async () => {
    const direct = Catalog.open(defaultDbPath(storeRoot));
    try {
      const expected = direct.positionsAggregateGrouped(SEED_IDS.syntheticPortfolio, {}, "family");
      const { status, body } = await getJson(
        `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions/aggregate?groupBy=family`,
      );
      expect(status).toBe(200);
      expect(body.groupBy).toBe("family");
      // JSON round-trip of IEEE doubles is exact: verbatim means ===.
      expect(body.groups).toEqual(JSON.parse(JSON.stringify(expected)));
    } finally {
      direct.close();
    }
  });

  it("filters by family and instrument type through the query string", async () => {
    const agg = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions/aggregate`,
    );
    expect(agg.status).toBe(200);
    const grouped = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions/aggregate?groupBy=instrumentType`,
    );
    expect(grouped.status).toBe(200);
    const oneType = grouped.body.groups[0].key as string;
    const filtered = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions?instrumentType=${oneType}&limit=50`,
    );
    expect(filtered.status).toBe(200);
    for (const p of filtered.body.positions) expect(p.instrumentType).toBe(oneType);
    expect(filtered.body.page.total).toBe(
      grouped.body.groups.find((g: { key: string }) => g.key === oneType).positionCount,
    );
  });

  it("refuses unknown query parameters and malformed pagination, typed 422", async () => {
    const typo = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions?familyid=x`,
    );
    expect(typo.status).toBe(422);
    expect(typo.body.error.code).toBe("validation");
    expect(typo.body.error.message).toContain("familyid");
    const big = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions?limit=100000`,
    );
    expect(big.status).toBe(422);
    expect(big.body.error.message).toMatch(/pagination is mandatory/);
    const bad = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions?limit=abc`,
    );
    expect(bad.status).toBe(422);
    const badGroup = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions/aggregate?groupBy=color`,
    );
    expect(badGroup.status).toBe(422);
  });

  it("an unmirrored portfolio and an unknown filter value 404 by name, never an empty 200", async () => {
    const missing = await getJson("/api/catalog/portfolios/no-such-book/positions");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not-found");
    expect(missing.body.error.message).toContain("no-such-book");
    const badFamily = await getJson(
      `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions?familyId=no-such-family`,
    );
    expect(badFamily.status).toBe(404);
    expect(badFamily.body.error.message).toContain("no-such-family");
  });

  it("serves market snapshot, curve series, and refuses unknown curves", async () => {
    const markets = await getJson("/api/catalog/markets");
    expect(markets.status).toBe(200);
    // Re-expectation: the listing orders by as-of then id, and the seeded macro-demo-v1
    // (same as-of as its base) sorts ahead of market-public-2026-03-31, so the base is the second row.
    expect(markets.body.map((m: { id: string }) => m.id).slice(0, 2)).toEqual(["macro-demo-v1", SEED_IDS.market]);
    expect(markets.body[1].curvePoints).toBeGreaterThan(0);
    const snap = await getJson(`/api/catalog/markets/${SEED_IDS.market}`);
    expect(snap.status).toBe(200);
    expect(snap.body.curves["risk-free"].length).toBeGreaterThan(0);
    expect(snap.body.curves["term-funding"].length).toBeGreaterThan(0);
    expect(snap.body.curves.tlp.length).toBeGreaterThan(0);
    expect(snap.body.capVolSurface.length).toBeGreaterThan(0);
    expect(snap.body.asOf).toBeTruthy();
    const series = await getJson("/api/catalog/curves/term-funding/series");
    expect(series.status).toBe(200);
    expect(series.body.series[0].asOf).toBe(snap.body.asOf);
    const badCurve = await getJson("/api/catalog/curves/libor/series");
    expect(badCurve.status).toBe(422);
    const retiredCurve = await getJson("/api/catalog/curves/sofr-ois/series");
    expect(retiredCurve.status).toBe(422);
    const missingMarket = await getJson("/api/catalog/markets/no-such-market");
    expect(missingMarket.status).toBe(404);
  });

  it("run and lineage endpoints refuse the unmirrored, typed", async () => {
    const runs = await getJson("/api/catalog/runs");
    expect(runs.status).toBe(200);
    expect(runs.body).toEqual([]); // no run in this scratch store: honest empty listing
    const inputs = await getJson("/api/catalog/runs/no-such-run/inputs");
    expect(inputs.status).toBe(404);
    expect(inputs.body.error.message).toContain("no-such-run");
    const lineage = await getJson(`/api/catalog/lineage/portfolios/${SEED_IDS.vanillaPortfolio}`);
    expect(lineage.status).toBe(200);
    expect(lineage.body.consumedBy).toEqual([]);
    const badCollection = await getJson(`/api/catalog/lineage/coa/${SEED_IDS.demoCoa}`);
    expect(badCollection.status).toBe(422);
  });

  it("registers no mutating routes: the surface is GET-only by construction", () => {
    const router = new Router();
    registerCatalogRoutes(router, { config: makeConfig(storeRoot) });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(router.match(method, "/api/catalog/portfolios")).toBeNull();
      expect(
        router.match(method, `/api/catalog/portfolios/${SEED_IDS.syntheticPortfolio}/positions`),
      ).toBeNull();
      expect(router.match(method, "/api/catalog/runs")).toBeNull();
    }
  });

  it("a store with no platform database 404s with the cure named, not a 500", async () => {
    const empty = mkdtempSync(join(tmpdir(), "alm-p9-nodb-http-"));
    try {
      const boot = await bootCatalogServer(empty);
      try {
        const res = await fetch(`${boot.base}/api/catalog/portfolios`);
        expect(res.status).toBe(404);
        const body = await res.json();
        expect(body.error.message).toMatch(/platform database not found/);
      } finally {
        await new Promise<void>((resolve) => boot.server.close(() => resolve()));
      }
    } finally {
      try {
        rmSync(empty, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  });
});
