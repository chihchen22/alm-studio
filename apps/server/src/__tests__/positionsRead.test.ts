// apps/server/src/__tests__/positionsRead.test.ts
// Studio A+E Slice 1, Task C5 (contract 3): the file-store positions read, its type-ahead,
// the parsed-book cache, and the drill staying open and write-free on a locked workspace
// (spec v3.1 Sections 2.9 and 5.3; ruling 15). Expected values are restated by hand from
// the vanilla book's source (data/src/vanilla.ts): nine fixed-rate positions in the order
// cash-1, loan-1..loan-5, fund-1..fund-3.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PortfolioSpec } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { getParsedBook } from "../store/parsedBookCache";
import type { HistoryLine, WorkspaceManifest } from "../workspaces/types";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
}, 300_000);
afterAll(() => t.close());

type Row = { id: string; familyId: string; coaNodeId: string; instrumentType: string; notional: number; maturityMonths?: number };
type Page = { total: number; limit: number; offset: number; rows: Row[] };
const positions = (id: string, query = "") => api<Page>(t.base, "GET", `/api/portfolios/${id}/positions${query}`);
const VANILLA_IDS = ["cash-1", "loan-1", "loan-2", "loan-3", "loan-4", "loan-5", "fund-1", "fund-2", "fund-3"];

describe("GET /api/portfolios/:id/positions", () => {
  it("pages, filters by family and prefix, and sees a book imported this session without a restart", async () => {
    const all = await positions(SEED_IDS.syntheticPortfolio, "?limit=50");
    expect(all.status).toBe(200); expect(all.body.rows).toHaveLength(50); expect(all.body.total).toBe(2351);
    expect(all.body.limit).toBe(50); expect(all.body.offset).toBe(0);
    const dda = await positions(SEED_IDS.syntheticPortfolio, "?familyId=dda&limit=5000");
    expect(dda.body.rows.every((r) => r.familyId === "dda")).toBe(true); expect(dda.body.total).toBe(dda.body.rows.length);
    const prefix = all.body.rows[0]!.id.slice(0, 4);
    const q = await positions(SEED_IDS.syntheticPortfolio, `?q=${prefix}`);
    expect(q.body.rows.length).toBeGreaterThan(0);
    expect(q.body.rows.every((r) => r.id.startsWith(prefix))).toBe(true);
    expect((await positions(SEED_IDS.syntheticPortfolio, "?limit=5001")).status).toBe(400);
    expect((await positions(SEED_IDS.syntheticPortfolio, "?bogus=1")).status).toBe(400);
    const book = (await api<Record<string, unknown>>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    expect((await api(t.base, "POST", "/api/portfolios/import?format=json", { ...book, id: "fresh-book", label: "fresh" })).status).toBe(201);
    const fresh = await positions("fresh-book");
    expect(fresh.status).toBe(200); expect(fresh.body.total).toBe(9);
  });

  it("carries id, family, node, instrument type, notional and term on every row, in book order", async () => {
    const r = await positions(SEED_IDS.vanillaPortfolio);
    expect(r.status).toBe(200);
    expect(r.body.limit).toBe(500); expect(r.body.offset).toBe(0); expect(r.body.total).toBe(9);
    expect(r.body.rows.map((x) => x.id)).toEqual(VANILLA_IDS);
    expect(r.body.rows[2]).toEqual({ id: "loan-2", familyId: "fixed-loans", coaNodeId: "coa-fixed-loans", instrumentType: "fixed-loan", notional: 150_000_000, maturityMonths: 60 });
    expect(r.body.rows[8]).toEqual({ id: "fund-3", familyId: "fhlb", coaNodeId: "coa-fhlb", instrumentType: "fixed-loan", notional: 250_000_000, maturityMonths: 60 });
  });

  it("filters by family, node and type, prefixes by id, and pages by offset over the filtered rows", async () => {
    const loans = await positions(SEED_IDS.vanillaPortfolio, "?q=loan-");
    expect(loans.body.rows.map((x) => x.id)).toEqual(["loan-1", "loan-2", "loan-3", "loan-4", "loan-5"]);
    expect(loans.body.total).toBe(5);
    const fhlb = await positions(SEED_IDS.vanillaPortfolio, "?familyId=fhlb");
    expect(fhlb.body.rows.map((x) => x.id)).toEqual(["fund-1", "fund-2", "fund-3"]);
    const node = await positions(SEED_IDS.vanillaPortfolio, "?coaNodeId=coa-cash");
    expect(node.body.rows.map((x) => x.id)).toEqual(["cash-1"]);
    const type = await positions(SEED_IDS.vanillaPortfolio, "?instrumentType=fixed-loan");
    expect(type.body.total).toBe(9);
    expect((await positions(SEED_IDS.vanillaPortfolio, "?instrumentType=nmd")).body).toMatchObject({ total: 0, rows: [] });
    // Filters combine as an AND: loan-prefixed rows of the fhlb family are none.
    expect((await positions(SEED_IDS.vanillaPortfolio, "?q=loan-&familyId=fhlb")).body.total).toBe(0);
    // The page is a slice of the filtered rows, and total is the filtered count, not the page's.
    const page = await positions(SEED_IDS.vanillaPortfolio, "?q=loan-&limit=2&offset=1");
    expect(page.body.rows.map((x) => x.id)).toEqual(["loan-2", "loan-3"]);
    expect(page.body.total).toBe(5); expect(page.body.limit).toBe(2); expect(page.body.offset).toBe(1);
    // The prefix is a prefix, not a substring: "an-2" sits inside loan-2 and matches nothing.
    expect((await positions(SEED_IDS.vanillaPortfolio, "?q=an-2")).body.total).toBe(0);
  });

  it("refuses a bad page, an unknown key, an unknown book, and a non-integer", async () => {
    expect((await positions(SEED_IDS.vanillaPortfolio, "?limit=0")).status).toBe(400);
    expect((await positions(SEED_IDS.vanillaPortfolio, "?limit=-1")).status).toBe(400);
    expect((await positions(SEED_IDS.vanillaPortfolio, "?offset=-1")).status).toBe(400);
    expect((await positions(SEED_IDS.vanillaPortfolio, "?limit=abc")).status).toBe(400);
    expect((await positions(SEED_IDS.vanillaPortfolio, "?limit=5000")).status).toBe(200);
    const unknownKey = await positions(SEED_IDS.vanillaPortfolio, "?family=fhlb");
    expect(unknownKey.status).toBe(400); expect(unknownKey.text).toMatch(/family/);
    expect((await positions("no-such-book")).status).toBe(404);
  });
});

/** Every file under the store root, relative path to content hash; the platform's SQLite files are not store documents. */
function storeSnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (/\.db(-wal|-shm|-journal)?$/.test(name)) continue;
      out[relative(root, full)] = createHash("sha256").update(readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return out;
}

describe("the drill on a locked Production workspace", () => {
  it("answers 200 for a position of a book imported this session and writes nothing", async () => {
    const book = (await api<PortfolioSpec>(t.base, "GET", `/api/portfolios/${SEED_IDS.vanillaPortfolio}`)).body;
    const asOf = book.asOf;
    const created = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { id: "ws-c5-lock", name: "C5 lock", owner: "o", by: "tester", type: "production", cutoffDate: asOf });
    expect(created.status).toBe(201);
    const imp = await api(t.base, "POST", "/api/portfolios/import?format=json&workspaceId=ws-c5-lock&by=tester", { ...book, id: "locked-book-ws", label: "locked ws" });
    expect(imp.status).toBe(201);
    const head = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-c5-lock")).body;
    const signed = await api<WorkspaceManifest>(t.base, "POST", "/api/workspaces/ws-c5-lock/sign-off", { expectedRevision: head.revision, by: "signer", signedHash: head.signedHash });
    expect(signed.status).toBe(200); expect(signed.body.status).toBe("locked");

    const historyBefore = (await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-c5-lock/history")).body;
    const headBefore = (await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-c5-lock")).body;
    const filesBefore = storeSnapshot(t.storeRoot);
    const runsBefore = (await api<unknown[]>(t.base, "GET", "/api/runs")).body.length;

    // The drop-down read, then the drill of the position it offered, on the library arm.
    const list = await positions("locked-book-ws", "?q=loan-");
    expect(list.status).toBe(200); expect(list.body.total).toBe(5);
    // The snapshot sees the store: the workspace directory and the imported book are in it.
    expect(Object.keys(filesBefore).some((k) => k.includes("ws-c5-lock"))).toBe(true);
    expect(Object.keys(filesBefore).some((k) => k.includes("locked-book-ws"))).toBe(true);
    type DrillRow = { principal: number; interest: number; discountFactorAllIn: number; discountFactorRiskFree: number; pvAllIn: number; pvRiskFree: number };
    const drill = await api<{ scenarioSource: string; byScenario: Array<{ scenarioId: string; rows: DrillRow[] }> }>(t.base, "POST", "/api/instrument/project", {
      instrument: { portfolioId: "locked-book-ws", positionId: list.body.rows[1]!.id },
      marketId: SEED_IDS.market,
      scenarios: { libraryRefs: ["regulatory-grid-v1#S0", "regulatory-grid-v1#S200"] },
      horizonMonths: 24,
    });
    expect(drill.status).toBe(200);
    expect(drill.body.scenarioSource).toBe("library");
    expect(drill.body.byScenario.map((s) => s.scenarioId)).toEqual(["S0", "S200"]);
    expect(drill.body.byScenario[0]!.rows).toHaveLength(24);
    // The reply carries the discount factors and row PVs: pv = factor * (principal + interest).
    const row = drill.body.byScenario[0]!.rows[0]!;
    expect(row.discountFactorAllIn).toBeGreaterThan(0); expect(row.discountFactorAllIn).toBeLessThanOrEqual(1);
    expect(row.pvAllIn).toBeCloseTo(row.discountFactorAllIn * (row.principal + row.interest), 4);
    expect(row.pvRiskFree).toBeCloseTo(row.discountFactorRiskFree * (row.principal + row.interest), 4);

    // Nothing moved: every stored file, the workspace history and head, and the run list.
    expect(storeSnapshot(t.storeRoot)).toEqual(filesBefore);
    expect((await api<HistoryLine[]>(t.base, "GET", "/api/workspaces/ws-c5-lock/history")).body).toEqual(historyBefore);
    expect((await api<WorkspaceManifest>(t.base, "GET", "/api/workspaces/ws-c5-lock")).body).toEqual(headBefore);
    expect(headBefore.status).toBe("locked");
    expect((await api<unknown[]>(t.base, "GET", "/api/runs")).body.length).toBe(runsBefore);
  });
});

describe("getParsedBook", () => {
  /** A stub store: counts document reads per id, and lets a test move an id's content hash. */
  function stub(hashes: Record<string, string>) {
    const reads: string[] = [];
    const store = {
      getMeta: (_c: string, id: string) => ({ id, contentHash: hashes[id]! }),
      getDocument: (_c: string, id: string) => {
        reads.push(id);
        return { id, doc: { id, label: id, asOf: "2026-03-31", positions: [] } as unknown as PortfolioSpec, meta: { id, contentHash: hashes[id]! } };
      },
    };
    return { store: store as unknown as FileStore, reads, hashes };
  }

  it("parses once per content hash and re-reads when the hash moves", () => {
    const s = stub({ "pc-a": "h1" });
    const first = getParsedBook(s.store, "pc-a");
    expect(first.contentHash).toBe("h1"); expect(first.book.id).toBe("pc-a");
    expect(getParsedBook(s.store, "pc-a").book).toBe(first.book);
    expect(s.reads).toEqual(["pc-a"]);
    s.hashes["pc-a"] = "h2";
    const second = getParsedBook(s.store, "pc-a");
    expect(second.contentHash).toBe("h2"); expect(second.book).not.toBe(first.book);
    expect(s.reads).toEqual(["pc-a", "pc-a"]);
  });

  it("keeps at most eight books and evicts the least recently used", () => {
    const ids = ["lru-1", "lru-2", "lru-3", "lru-4", "lru-5", "lru-6", "lru-7", "lru-8", "lru-9"];
    const s = stub(Object.fromEntries(ids.map((id) => [id, `hash-${id}`])));
    for (const id of ids.slice(0, 8)) getParsedBook(s.store, id);
    expect(s.reads).toHaveLength(8);
    getParsedBook(s.store, "lru-1");               // a hit: lru-1 becomes the most recent, lru-2 the oldest
    expect(s.reads).toHaveLength(8);
    getParsedBook(s.store, "lru-9");               // the ninth entry evicts lru-2
    expect(s.reads).toHaveLength(9);
    getParsedBook(s.store, "lru-1");               // still cached
    expect(s.reads).toHaveLength(9);
    getParsedBook(s.store, "lru-2");               // evicted: read again
    expect(s.reads).toHaveLength(10);
    expect(s.reads[9]).toBe("lru-2");
  });
});
