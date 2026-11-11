// apps/server/src/__tests__/indexHistoryReadiness.test.ts
// Piece B, step B3b, Task 8 (decisions 49 and 52; Review Focus 1): readiness on a market whose lagged formula reads an
// index history. The rates item checks the market with the stored histories, so a history market is no longer an
// Error; it reads Valid with the history's reading at the cut-off, or Warning where a history stops short of a month a
// lag reads (acknowledged at launch). A roll-forward re-applies the history market without refusal and keeps the
// history id. The `indexHistory:<id>` roles a validation or a run consumed are current while the stored bytes still
// hash to the pin, and Stale when they move or the document is gone. A workspace launch on a history market completes
// end to end, with and without an active curve setup. Helpers are copied from indexHistoryLaunch.test.ts and
// indexKindsServer.test.ts. Every expected value and sentence is restated by hand; none is read back from the code
// under test.
import { renameSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurveSetupBlock, IndexHistory } from "@alm/engine";
import { monthExactSnapshot, setupFromSnapshot } from "@alm/engine/src/curveBuilder/__tests__/helpers";
import type { MarketSnapshot } from "@alm/kernel";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { deriveMarketSnapshot } from "@alm/engine/src/market";
import { derivedMarketMeta } from "../derivedSets/derivedMarkets";
import { derivedCurveIdOf } from "../workspaces/derivedCurveSlot";
import { compileSetupRow } from "../workspaces/setupCompile";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { RunSetup, WorkspaceManifest } from "../workspaces/types";
import type { RunStatus, StoredRunRequest } from "../jobs/types";

let t: TestPlatform;
let store: FileStore;
beforeAll(async () => {
  t = await bootTestPlatform();
  store = new FileStore(t.storeRoot);
  await seedStore(store, repoRoot());
}, 120_000);
afterAll(() => t.close());

/** Seeded ids, restated as literals (seed-store.ts SEED_IDS). */
const PUBLIC = "market-public-2026-03-31";
const INDICES = "rate-indices-demo-v1";
const INDEXED_BOOK = "synthetic-2500-indexed-v1";
/** The readiness id a compile's standing warnings are acknowledged under (restated from setupEvents.test.ts). */
const WARNINGS = "run/setup-warnings";
/** The readiness id of the rates item, as the launch list names it. */
const RATES = "market/Rate indices and derived markets";

const ws = (id: string) => api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const clone = (id: string, rev: number, body: object) => api<{ manifest: WorkspaceManifest; readiness: unknown }>(t.base, "POST", `/api/workspaces/${id}/clone`, { expectedRevision: rev, by: "tester", ...body });
const reapply = (id: string, rev: number) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/market/reapply`, { expectedRevision: rev, by: "tester" });
const derive = (body: object) => api<{ id: string; snapshot: { rateIndices: unknown[]; derivedFrom: { ops: unknown[] } } }>(t.base, "POST", "/api/market/derive", body);

interface ErrBody { error: { code: string; message: string } }
type Note = { layer: string; reason: string };
type Result = Record<string, unknown> & { provenance: unknown; notImplemented: Note[] };
type StoredMarket = Record<string, unknown> & { rateIndices: Array<Record<string, unknown> & { id: string }>; curveSetup?: unknown; derivedFrom?: { baseId: string; ops: Array<{ op: string }> } };
interface Item { section: string; item: string; state: string; detail: string; staleRoles?: Array<{ role: string; pinned: string; current: string | null }> }

const itemOf = async (wsId: string, section: string, item: string): Promise<Item> => {
  const r = await api<{ items: Item[] }>(t.base, "GET", `/api/workspaces/${wsId}/readiness`);
  expect(r.status, r.text).toBe(200);
  return r.body.items.find((i) => i.section === section && i.item === item)!;
};
const ratesItem = (wsId: string) => itemOf(wsId, "market", "Rate indices and derived markets");
const setupsItem = (wsId: string) => itemOf(wsId, "run", "Run setups");
const newestItem = (wsId: string) => itemOf(wsId, "results", "Newest result");

/**
 * A workspace on the public snapshot (derivedCurveLaunch.test.ts `ready`). `derived` markets are added in order
 * (each derives from the snapshot or an earlier entry); `use` re-saves the run setup so its market input names that
 * derived market by its definitionKey.
 */
async function ready(id: string, opts: { derived?: string[]; use?: string; book?: string } = {}): Promise<WorkspaceManifest> {
  const created = await create({ id });
  expect(created.status).toBe(201);
  let w = created.body;
  const step = async (body: object) => {
    const r = await blocks(id, w.revision, body);
    expect(r.status).toBe(201);
    w = r.body;
  };
  await step({ block: "positions", op: "set", ref: { collection: "portfolios", id: opts.book ?? SEED_IDS.vanillaPortfolio } });
  await step({ block: "market", op: "set", ref: { collection: "market", id: PUBLIC } });
  for (const d of opts.derived ?? []) await step({ block: "market", op: "add", ref: { collection: "market", id: d } });
  await step({ block: "assumptions", op: "add", ref: { collection: "assumption-sets", id: SEED_IDS.vanillaAssumptions } });
  await step({ block: "assumptions", op: "set", ref: { collection: "routing-policies", id: SEED_IDS.routingPolicy } });
  if (opts.use !== undefined) {
    const slot = w.blocks.run.setups[0]!;
    const current = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
    const { id: _drop, ...rest } = current;
    void _drop;
    const setup = { ...rest, inputs: { ...rest.inputs, market: { role: "derived", definitionKey: opts.use } } };
    const r = await api<{ manifest: WorkspaceManifest }>(t.base, "POST", "/api/run-setups", { workspaceId: id, setupLineageId: slot.setupLineageId, expectedRevision: w.revision, by: "tester", setup });
    expect(r.status).toBe(201);
    w = r.body.manifest;
  }
  return w;
}

const slotOf = async (wsId: string) => (await ws(wsId)).body.blocks.run.setups[0]!.setupLineageId;

/** The setup compile of the workspace's first slot, as the validate and launch routes run it (derivedCurveLaunch.test.ts). */
function compile(wsId: string) {
  const wsStore = new WorkspaceStore(t.storeRoot);
  const head = wsStore.head(wsId);
  const slot = head.blocks.run.setups[0]!;
  const setup = store.getDocument<RunSetup>("run-setups", slot.current.id).doc;
  return compileSetupRow(t.platform.context, wsStore, head, slot, setup, null);
}

const validate = async (wsId: string) => {
  const v = await api<{ outcome: string; consumed: Record<string, { collection: string; id: string; contentHash: string }> }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/validate`, { by: "tester" });
  expect(v.status, v.text).toBe(200);
  return v.body;
};

/** Launch the workspace's first setup with `acknowledge`, wait for the run, and answer its id once it is done. */
async function launchDone(wsId: string, acknowledge: string[] = [WARNINGS]): Promise<string> {
  const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/launch`, { by: "tester", acknowledge });
  expect(l.status, l.text).toBe(200);
  const runId = l.body.runIds[0]!;
  const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 480_000);
  expect(done.body).toEqual(expect.objectContaining({ state: "done" }));
  return runId;
}

// ---------------------------------------------------------------------------
// The synthetic histories and the markets that read them
// ---------------------------------------------------------------------------

const MONTHLY = "date,rate\n2025-10,4.10\n2025-11,4.15\n2025-12,4.20\n2026-01,4.25\n2026-02,4.30\n2026-03,4.35\n";
/** The same series cut at 2025-12: a lag of 2 at the 2026-03 cut-off reads 2026-02 and 2026-01, both after it. */
const SHORT = "date,rate\n2025-10,4.10\n2025-11,4.15\n2025-12,4.20\n";
/** A series that starts at the cut-off month: it serves no month a lag reads (no look-ahead). */
const LATE = "date,rate\n2026-03,4.35\n2026-04,4.40\n";
const importHistory = async (text: string, name = "synthetic-rfr-1m.csv") => {
  const res = await fetch(`${t.base}/api/index-histories/import?unit=percent`, { method: "POST", headers: { "content-type": "application/octet-stream", "X-Filename": name }, body: Buffer.from(text) });
  expect([200, 201]).toContain(res.status);
  return (await res.json()) as { id: string; history: IndexHistory };
};
const PRIME_LAG = { op: "set-index", id: "prime-demo", label: "Prime-style rate, two months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 2, basisBp: 300 };
const HIST_MARKET = "b3b-prime-lag-v1";

/** A market on the seeded indices whose rfr-1m carries the history of `text` and whose prime-demo lags 2 on it. */
async function historyMarket(text = MONTHLY, id = HIST_MARKET): Promise<{ marketId: string; historyId: string }> {
  const { id: historyId } = await importHistory(text);
  const r = await derive({ baseId: INDICES, ops: [{ op: "set-index-history", indexId: "rfr-1m", historyId }, PRIME_LAG], id });
  expect([200, 201]).toContain(r.status);
  return { marketId: id, historyId };
}

const docPath = (id: string) => new FileStore(t.storeRoot).paths.documentPath("index-histories", id);
/** Run `fn` with the stored history document renamed away, restoring it after. */
async function withHistoryAway<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const path = docPath(id);
  renameSync(path, `${path}.away`);
  try {
    return await fn();
  } finally {
    renameSync(`${path}.away`, path);
  }
}

/** The history clause the readiness and the note print for a full history at the 2026-03 cut-off (decision 52). */
const fullClause = (historyId: string) =>
  `rfr-1m (history ${historyId}, read by prime-demo): history covers every month a lag reads; at 2026-03 the history is 4.35 percent and the curve's month 0 is `;

// ---------------------------------------------------------------------------
// The rates item
// ---------------------------------------------------------------------------

describe("the rates item on a history market", () => {
  it("reads Valid and prints the history read, with the gap at the cut-off", async () => {
    const { historyId } = await historyMarket();
    await ready("ws-ihr-valid", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const item = await ratesItem("ws-ihr-valid");
    expect(item.state, item.detail).toBe("valid");
    const head = `Every rate index a position names resolves on the setup's market. Index history read: ${fullClause(historyId)}`;
    expect(item.detail.startsWith(head), item.detail).toBe(true);
    expect(item.detail.slice(head.length)).toMatch(/^[0-9.]+ percent, a gap of -?[0-9.]+ bp\.$/);
  });

  it("a market without history keeps today's Valid text exactly", async () => {
    await ready("ws-ihr-window", { derived: [INDICES], use: INDICES, book: INDEXED_BOOK });
    const item = await ratesItem("ws-ihr-window");
    expect(item.state).toBe("valid");
    expect(item.detail).toBe("Every rate index a position names resolves on the setup's market.");
  });

  it("warns where a history stops short; the launch needs the acknowledge, then completes with the note", async () => {
    const { historyId } = await historyMarket(SHORT, "b3b-prime-lag-short-v1");
    await ready("ws-ihr-short", { derived: [INDICES, "b3b-prime-lag-short-v1"], use: "b3b-prime-lag-short-v1", book: INDEXED_BOOK });
    const item = await ratesItem("ws-ihr-short");
    expect(item.state, item.detail).toBe("warning");
    expect(item.detail).toContain(
      `An index history stops short of a month a lag reads: rfr-1m (history ${historyId}, read by prime-demo): history ends 2025-12; 2 months filled flat; the history has no value at 2026-03; the curve's month 0 is `,
    );
    // The explanation follows the reading (B3b follow-up item 2): this history ends early and starts in time.
    expect(item.detail).toContain(
      ". Months after a history's last month read the index's cut-off value on the unshocked curve. Acknowledge the warning to launch, or import a longer history on Market > Rate indices.",
    );
    expect(item.detail).not.toContain("read its first value");

    // Without the rates item acknowledged, the launch asks for it.
    const blocked = await api<ErrBody>(t.base, "POST", `/api/workspaces/ws-ihr-short/setups/${await slotOf("ws-ihr-short")}/launch`, { by: "tester", acknowledge: [WARNINGS] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain(`"${RATES}"`);

    const runId = await launchDone("ws-ihr-short", [WARNINGS, RATES]);
    const result = store.readRunJson<Result>(runId, "result.json");
    const notes = result.notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain(`rfr-1m (history ${historyId}, read by prime-demo): history ends 2025-12; 2 months filled flat`);
  }, 600_000);

  it("a history that starts at or after the cut-off counts the lag months as flat and warns", async () => {
    const { historyId } = await historyMarket(LATE, "b3b-prime-lag-late-v1");
    await ready("ws-ihr-late", { derived: [INDICES, "b3b-prime-lag-late-v1"], use: "b3b-prime-lag-late-v1", book: INDEXED_BOOK });
    const item = await ratesItem("ws-ihr-late");
    expect(item.state, item.detail).toBe("warning");
    expect(item.detail).toContain(
      `An index history stops short of a month a lag reads: rfr-1m (history ${historyId}, read by prime-demo): history starts 2026-03, at or after the cut-off; 2 months filled flat; at 2026-03 the history is 4.35 percent`,
    );
    // No look-ahead (B3b follow-up item 2): the explanation never says a month before the cut-off reads the first value.
    expect(item.detail).toContain(
      ". A history that starts at or after the cut-off fills nothing before it (no look-ahead), so every month a lag reads before the cut-off reads the index's cut-off value on the unshocked curve. Acknowledge the warning to launch, or import a longer history on Market > Rate indices.",
    );
    expect(item.detail).not.toContain("read its first value");
  });

  it("a market with no readable calibration date points at the market, not at the history (B3b follow-up item 1)", async () => {
    const { historyId } = await historyMarket();
    const UNDATED = "b3b-prime-lag-undated-v1";
    if (!store.has("market", UNDATED)) {
      const { calibrationDate: _drop, ...rest } = store.getDocument<StoredMarket>("market", HIST_MARKET).doc;
      void _drop;
      store.putDocument("market", UNDATED, rest, { label: "history market without a calibration date (test)" });
    }
    await ready("ws-ihr-undated", { derived: [INDICES, UNDATED], use: UNDATED, book: INDEXED_BOOK });
    const item = await ratesItem("ws-ihr-undated");
    expect(item.state, item.detail).toBe("error");
    expect(item.detail).toContain(`which reads index history "${historyId}", but market "${UNDATED}" carries no readable calibrationDate to date the months before the cut-off`);
    expect(item.detail).not.toContain("Import the history again");
    expect(item.detail.endsWith(
      " The months before the cut-off are dated by the market's calibration date, so the history is not the fix: attach a base snapshot with a readable calibration date on Market > Yield curves and derive the market again on Market > Rate indices.",
    ), item.detail).toBe(true);
  });

  // A short history and a derived curve estimated on another platform default
  // version are one acknowledgeable Warning, the history's text first, then the curve's.
  it("joins the short-history warning and the derived-curve default warning in one detail", async () => {
    const { historyId } = await historyMarket(SHORT, "b3b-prime-lag-short-dc");
    const hist = store.getDocument<MarketSnapshot>("market", "b3b-prime-lag-short-dc").doc;
    const r = deriveMarketSnapshot(hist, [{ op: "set-index", id: "rfr-3m", label: "rfr-3m (test index)", tenorMonths: 3, basisBp: 0, spreadCurve: "sofr-ust" }], { baseId: "b3b-prime-lag-short-dc", id: "b4-short-dc" });
    store.putDocument("market", "b4-short-dc", r.snapshot, derivedMarketMeta(r));
    await ready("ws-ihr-dc", { derived: [INDICES, "b3b-prime-lag-short-dc", "b4-short-dc"], use: "b4-short-dc", book: INDEXED_BOOK });

    // A curve stored before the stamp existed, its source on platform-default: it reads as estimated on v1.
    const curve = { id: "sofr-ust", label: "SOFR over UST", base: "platform-default", spreads: [{ tenorMonths: 1, spreadBp: 5 }, { tenorMonths: 12, spreadBp: 10 }], source: { from: "platform-default", minus: "x" } };
    const docId = derivedCurveIdOf(curve);
    const meta = store.putDocument("derived-curves", docId, curve, { label: curve.label, workspaceId: "ws-ihr-dc" });
    const wsStore = new WorkspaceStore(t.storeRoot);
    const h = wsStore.head("ws-ihr-dc");
    wsStore.commit("ws-ihr-dc", h.revision, "tester", { kind: "set-block", block: "market", op: "add", ref: { collection: "derived-curves", id: docId }, derivedCurve: "edit" }, {
      ...h,
      blocks: { ...h.blocks, market: { ...h.blocks.market, derivedCurves: { curves: [{ lineageKey: "sofr-ust", current: { collection: "derived-curves", id: docId, contentHash: meta.contentHash, pinnedAt: "t" } }] } } },
    });

    const item = await ratesItem("ws-ihr-dc");
    expect(item.state, item.detail).toBe("warning");
    expect(item.detail.startsWith(`An index history stops short of a month a lag reads: rfr-1m (history ${historyId}, read by prime-demo): history ends 2025-12; 2 months filled flat`), item.detail).toBe(true);
    expect(item.detail.endsWith(
      ". Months after a history's last month read the index's cut-off value on the unshocked curve. Acknowledge the warning to launch, or import a longer history on Market > Rate indices." +
        ` Derived curve "sofr-ust" was estimated on platform default v1; the run's default is v2.` +
        " Nothing was changed: acknowledge the warning to launch on the saved spreads, or fill the curve again on Market > Derived curves and save it.",
    ), item.detail).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Review Focus 1: the roll-forward
// ---------------------------------------------------------------------------

describe("a roll-forward past a history's last month (Review Focus 1)", () => {
  it("re-applies without refusal, keeps the history id, and readiness warns with the gap at the new cut-off", async () => {
    const { historyId } = await historyMarket();
    const MAY = "market-public-2026-05-31-b3b";
    if (!store.has("market", MAY)) {
      store.putDocument("market", MAY, { ...store.getDocument<MarketSnapshot>("market", PUBLIC).doc, calibrationDate: "2026-05-31" }, { label: "public pack re-dated (test)" });
    }
    const src = await ready("ws-ih-roll", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });

    const r = await clone("ws-ih-roll", src.revision, { mode: "roll-forward", name: "May", cutoffDate: "2026-05-31", blocks: ["positions", "market", "assumptions", "run"] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const c = r.body.manifest;
    expect(c.blocks.market.carried.map((e) => [e.definitionKey, e.status])).toEqual([[INDICES, "awaiting"], [HIST_MARKET, "awaiting"]]);

    const set = await blocks(c.id, c.revision, { block: "market", op: "set", ref: { collection: "market", id: MAY } });
    expect(set.status).toBe(201);
    const re = await reapply(c.id, set.body.revision);
    expect(re.status, JSON.stringify(re.body)).toBe(200);
    expect(re.body.blocks.market.carried.map((e) => [e.definitionKey, e.status])).toEqual([[INDICES, "applied"], [HIST_MARKET, "applied"]]);
    const child = re.body.blocks.market.derived.find((d) => d.definitionKey === HIST_MARKET)!;
    const rfr1m = store.getDocument<StoredMarket>("market", child.id).doc.rateIndices.find((x) => x.id === "rfr-1m")!;
    expect(rfr1m.historyId).toBe(historyId);
    expect(store.getDocument<StoredMarket>("market", child.id).doc.calibrationDate).toBe("2026-05-31");

    // A roll-forward clears the book (plan v2 B2); the rates item checks only with a live book, so attach it again.
    const book = await blocks(c.id, re.body.revision, { block: "positions", op: "set", ref: { collection: "portfolios", id: INDEXED_BOOK } });
    expect(book.status).toBe(201);

    // Lag 2 at the May cut-off reads 2026-04 (after the history's last month: flat) and 2026-03 (covered).
    const item = await ratesItem(c.id);
    expect(item.state, item.detail).toBe("warning");
    expect(item.detail).toContain(`rfr-1m (history ${historyId}, read by prime-demo): history ends 2026-03; 1 month filled flat`);
    expect(item.detail).toContain("the history has no value at 2026-05");
  });
});

// ---------------------------------------------------------------------------
// The stale mirror
// ---------------------------------------------------------------------------

describe("the indexHistory: roles in the stale checks", () => {
  it("a validation is current while the bytes hash to the pin; Stale when they move in place or the document is gone", async () => {
    const { historyId } = await historyMarket();
    const role = `indexHistory:${historyId}`;
    await ready("ws-ihr-stale", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const v = await validate("ws-ihr-stale");
    expect(v.outcome).not.toBe("fail");
    const pinned = v.consumed[role]!.contentHash;
    expect(pinned).toBe(store.getMeta("index-histories", historyId).contentHash);

    const current = await setupsItem("ws-ihr-stale");
    expect(current.state, current.detail).not.toBe("stale");
    expect(current.detail).not.toContain("consumed pins the workspace no longer holds");

    // Overwritten in place: the meta is unchanged, the bytes are not; the arm re-hashes the bytes.
    const path = docPath(historyId);
    const original = store.getDocumentBytes("index-histories", historyId);
    const doc = store.getDocument<IndexHistory>("index-histories", historyId).doc;
    writeFileSync(path, JSON.stringify({ ...doc, label: "moved" }));
    try {
      const moved = await setupsItem("ws-ihr-stale");
      expect(moved.state).toBe("stale");
      const s = (moved.staleRoles ?? []).find((x) => x.role === role)!;
      expect(s).toEqual({ role, pinned, current: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(s.current).not.toBe(pinned);
    } finally {
      writeFileSync(path, original);
    }
    expect((await setupsItem("ws-ihr-stale")).state).not.toBe("stale");

    await withHistoryAway(historyId, async () => {
      const gone = await setupsItem("ws-ihr-stale");
      expect(gone.state).toBe("stale");
      expect((gone.staleRoles ?? []).find((x) => x.role === role)).toEqual({ role, pinned, current: null });
      // The rates item names the missing history with the import hint, not a derived-market hint.
      const rates = await ratesItem("ws-ihr-stale");
      expect(rates.state).toBe("error");
      expect(rates.detail).toContain(`which reads index history "${historyId}", and the run was not given that history`);
      expect(rates.detail.endsWith(" Import the history again on Market > Rate indices.")).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The launch, end to end
// ---------------------------------------------------------------------------

describe("a workspace launch on a history market, end to end", () => {
  it("validates current, launches, pins and attaches the history, carries one note, and the newest run is current", async () => {
    const { historyId } = await historyMarket();
    const role = `indexHistory:${historyId}`;
    await ready("ws-ihr-launch", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const v = await validate("ws-ihr-launch");
    expect(v.outcome).not.toBe("fail");
    const setups = await setupsItem("ws-ihr-launch");
    expect(setups.state, setups.detail).not.toBe("stale");

    const runId = await launchDone("ws-ihr-launch");
    const stored = store.readRunJson<StoredRunRequest>(runId, "request.json");
    expect(stored.request.indexHistories).toEqual([{ id: historyId, history: store.getDocument("index-histories", historyId).doc }]);
    expect(stored.workspace!.consumed[role as `indexHistory:${string}`]).toEqual(
      expect.objectContaining({ collection: "index-histories", id: historyId, contentHash: store.getMeta("index-histories", historyId).contentHash }),
    );

    const result = store.readRunJson<Result>(runId, "result.json");
    const notes = result.notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason.startsWith(`the run's lagged indices read these index histories before the cut-off: ${fullClause(historyId)}`)).toBe(true);
    expect(notes[0]!.reason).toMatch(/percent, a gap of -?[0-9.]+ bp\. A history is not shocked: every scenario and every path reads the same values\. The parent's own months read the curve; a lagged level index reads the history from its month 0, a beta index from month 1\.$/);
    // The note is the workspace compile's own plan tag.
    const tagged = compile("ws-ihr-launch").notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(tagged).toEqual([expect.objectContaining({ layer: "plan.rate-index.history", reason: notes[0]!.reason })]);

    expect(new WorkspaceStore(t.storeRoot).readRunAttachments("ws-ihr-launch").map((a) => a.runId)).toContain(runId);
    const newest = await newestItem("ws-ihr-launch");
    expect(newest.state, newest.detail).toBe("valid");
    expect(newest.detail).toBe(`The newest run ${runId} is done and every consumed pin is current.`);
  }, 600_000);

  it("with an active curve setup, the derived pin keeps the history and the role is pinned", async () => {
    const { historyId } = await historyMarket();
    const role = `indexHistory:${historyId}`;
    await ready("ws-ihr-setup", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const h = (await ws("ws-ihr-setup")).body;
    const market = store.getDocument<MarketSnapshot>("market", SEED_IDS.market).doc;
    const curveSetup: CurveSetupBlock = { ...setupFromSnapshot(monthExactSnapshot(market).snapshot, "log-linear-df"), id: "seed-log-linear-df", label: "Seed log-linear-df" };
    const saved = await api<{ id: string; revision: number }>(t.base, "POST", "/api/workspaces/ws-ihr-setup/curve-setups", { setup: curveSetup, expectedRevision: h.revision, by: "tester" });
    expect(saved.status).toBe(201);
    const act = await api(t.base, "POST", `/api/workspaces/ws-ihr-setup/curve-setups/${saved.body.id}/activate`, { expectedRevision: saved.body.revision, by: "tester" });
    expect(act.status).toBe(200);

    const row = compile("ws-ihr-setup");
    const pinnedId = row.planDocument.inputs.marketSnapshot;
    expect(pinnedId).not.toBe(HIST_MARKET);
    const pinned = store.getDocument<StoredMarket>("market", pinnedId).doc;
    expect(pinned.derivedFrom!.ops.map((o) => o.op)).toEqual(["set-curve-setup"]);
    expect(pinned.rateIndices.find((x) => x.id === "rfr-1m")!.historyId).toBe(historyId);
    expect(row.consumed[role as `indexHistory:${string}`]).toEqual(expect.objectContaining({ collection: "index-histories", id: historyId }));

    // Readiness prints the reading on the curve the launch runs on: the same clause as the compile's note.
    const rates = await ratesItem("ws-ihr-setup");
    expect(rates.state, rates.detail).toBe("valid");
    const clause = rates.detail.slice(rates.detail.indexOf("Index history read: ") + "Index history read: ".length, -1);
    const tag = row.notImplemented.find((n) => n.layer === "plan.rate-index.history")!;
    expect(tag.reason).toContain(clause);

    const v = await validate("ws-ihr-setup");
    expect(v.outcome).not.toBe("fail");
    expect((await setupsItem("ws-ihr-setup")).state).not.toBe("stale");
    const runId = await launchDone("ws-ihr-setup");
    const stored = store.readRunJson<StoredRunRequest>(runId, "request.json");
    expect(stored.request.indexHistories).toEqual([{ id: historyId, history: store.getDocument("index-histories", historyId).doc }]);
    expect(stored.workspace!.consumed.market!.id).toBe(pinnedId);
    expect(stored.workspace!.consumed[role as `indexHistory:${string}`]!.contentHash).toBe(store.getMeta("index-histories", historyId).contentHash);
    const result = store.readRunJson<Result>(runId, "result.json");
    expect(result.notImplemented.filter((n) => n.layer === "plan.rate-index.history")).toHaveLength(1);
    expect((await newestItem("ws-ihr-setup")).state).toBe("valid");
  }, 600_000);
});
