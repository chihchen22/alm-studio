// apps/server/src/__tests__/indexHistoryLaunch.test.ts
// Index histories at the server's run entries. The derive
// refuses an ih- id the store does not hold; a workspace launch pins each history a lagged formula reads as a consumed
// role `indexHistory:<id>` and attaches the documents to the run request; a market without history launches as
// before; moved bytes are a 409 and a missing document a 422 (a failed validation); a plain submission, the plan
// route and the drill pass the histories too, the drill tolerating a missing history its position does not read.
// Helpers are copied from indexKindsServer.test.ts. Every expected value and sentence is restated by hand; none is
// read back from the code under test.
import { renameSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IndexHistory, NotImplemented, RunPlan } from "@alm/engine";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { submitRun } from "../http/routes/runs";
import type { Collection } from "../store/paths";
import { FileStore } from "../store/store";
import { compileSetupRow } from "../workspaces/setupCompile";
import { WorkspaceStore } from "../workspaces/workspaceStore";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import type { ConsumedPins, DocRef, RunSetup, WorkspaceManifest } from "../workspaces/types";
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
const INDEXED_PLAN = "plan-synthetic-2500-indexed-v1";
/** The readiness id a compile's standing warnings are acknowledged under (restated from setupEvents.test.ts). */
const WARNINGS = "run/setup-warnings";

const ws = (id: string) => api<WorkspaceManifest>(t.base, "GET", `/api/workspaces/${id}`);
const create = (body: object) => api<WorkspaceManifest>(t.base, "POST", "/api/workspaces", { name: "A", type: "test", cutoffDate: "2026-03-31", owner: "o", by: "tester", ...body });
const blocks = (id: string, rev: number, body: object) => api<WorkspaceManifest>(t.base, "POST", `/api/workspaces/${id}/blocks`, { expectedRevision: rev, by: "tester", ...body });
const derive = (body: object) => api<{ id: string; snapshot: { rateIndices: unknown[]; derivedFrom: { ops: unknown[] } } }>(t.base, "POST", "/api/market/derive", body);

interface Problem { at: string; message: string }
interface ErrBody { error: { code: string; message: string; detail?: { problems?: Problem[] } } }
type Note = { layer: string; reason: string };
type Result = Record<string, unknown> & { provenance: unknown; notImplemented: Note[] };
type StoredMarket = Record<string, unknown> & { rateIndices: Array<Record<string, unknown> & { id: string }>; derivedFrom?: { baseId: string; ops: unknown[] } };

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

/** Launch the workspace's first setup, wait for the run, and answer its id once it is done. */
async function launchDone(wsId: string): Promise<string> {
  const l = await api<{ runIds: string[] }>(t.base, "POST", `/api/workspaces/${wsId}/setups/${await slotOf(wsId)}/launch`, { by: "tester", acknowledge: [WARNINGS] });
  expect(l.status, l.text).toBe(200);
  const runId = l.body.runIds[0]!;
  const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 480_000);
  expect(done.body).toEqual(expect.objectContaining({ state: "done" }));
  return runId;
}

// ---------------------------------------------------------------------------
// The synthetic history and the market that reads it
// ---------------------------------------------------------------------------

const MONTHLY = "date,rate\n2025-10,4.10\n2025-11,4.15\n2025-12,4.20\n2026-01,4.25\n2026-02,4.30\n2026-03,4.35\n";
/** A second synthetic series (distinct content, so a distinct id), for the order test. */
const MONTHLY_B = "date,rate\n2025-10,4.40\n2025-11,4.45\n2025-12,4.50\n2026-01,4.55\n2026-02,4.60\n2026-03,4.65\n";
const importHistory = async (text: string, name = "synthetic-rfr-1m.csv") => {
  const res = await fetch(`${t.base}/api/index-histories/import?unit=percent`, { method: "POST", headers: { "content-type": "application/octet-stream", "X-Filename": name }, body: Buffer.from(text) });
  return (await res.json()) as { id: string; history: IndexHistory };
};
const PRIME_LAG = { op: "set-index", id: "prime-demo", label: "Prime-style rate, two months late (demonstration values)", kind: "formula", parent: "rfr-1m", coefficient: 1, lagMonths: 2, basisBp: 300 };
const HIST_MARKET = "b3b-prime-lag-v1";
async function historyMarket(): Promise<{ marketId: string; historyId: string }> {
  const { id } = await importHistory(MONTHLY);
  const r = await derive({ baseId: INDICES, ops: [{ op: "set-index-history", indexId: "rfr-1m", historyId: id }, PRIME_LAG], id: HIST_MARKET });
  expect([200, 201]).toContain(r.status);
  return { marketId: HIST_MARKET, historyId: id };
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

describe("the derive's store check", () => {
  /** Both ways out, restated by hand (fix round 1, IMPORTANT 1 and MINOR 2): the id hashes the whole document. */
  const REMEDY =
    "clear the history (Clear the history on Market > Rate indices, a set-index-history op with historyId null), " +
    "or import the history on Market > Rate indices; an import restores this id only from the same file under the same file name, unit and label";
  it("refuses a set-index-history op naming an id the store does not hold, and accepts the imported id", async () => {
    const preview = (historyId: string) =>
      api<ErrBody>(t.base, "POST", "/api/market/derive/preview", { baseId: INDICES, ops: [{ op: "set-index-history", indexId: "rfr-1m", historyId }] });
    const r = await preview("ih-0123456789abcdef");
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems).toContainEqual({
      at: "rateIndices",
      message: `rate index "rfr-1m" names index history "ih-0123456789abcdef", which is not in the store; ${REMEDY}`,
    });
    const { id } = await importHistory(MONTHLY);
    const ok = await preview(id);
    expect(ok.status, ok.text).toBe(200);
  });

  // B3b follow-up item 5, option B (ruling): an id carried from the base is still refused on every derive,
  // and the refusal says it came from the base and names the two ways out. No behavior change.
  it("an unknown id carried from the base market is refused with words that say so and name the fix", async () => {
    const { historyId } = await historyMarket();
    const preview = (ops: unknown[]) => api<ErrBody>(t.base, "POST", "/api/market/derive/preview", { baseId: HIST_MARKET, ops });
    await withHistoryAway(historyId, async () => {
      const r = await preview([{ op: "add-index-basis", indexId: "prime-demo", value: 25 }]);
      expect(r.status).toBe(422);
      expect(r.body.error.detail!.problems).toEqual([{
        at: "rateIndices",
        message:
          `rate index "rfr-1m" carries index history "${historyId}", which is not in the store; the id comes from the base market "${HIST_MARKET}", ` +
          `so every derive on it is refused until the index stops naming it: ${REMEDY}`,
      }]);
      // Clearing it in the same derive is accepted, as before.
      const cleared = await preview([{ op: "set-index-history", indexId: "rfr-1m", historyId: null }]);
      expect(cleared.status, cleared.text).toBe(200);
    });
  });

  // Fix round 1, IMPORTANT 1: the path the Studio sends. Studio derives from the chosen market's own base and replays
  // the chosen market's ops first (rateIndexModel.ts), as re-apply does, so the missing id arrives through a carried
  // set-index-history op; that refusal names both ways out too. Same 422, same id refused.
  it("an unknown id that arrives through a carried set-index-history op names both ways out", async () => {
    const { historyId } = await historyMarket();
    const carried = store.getDocument<StoredMarket>("market", HIST_MARKET).doc.derivedFrom!;
    expect(carried.baseId).toBe(INDICES);
    const preview = (ops: unknown[]) => api<ErrBody>(t.base, "POST", "/api/market/derive/preview", { baseId: carried.baseId, ops: [...carried.ops, ...ops] });
    await withHistoryAway(historyId, async () => {
      const r = await preview([{ op: "add-index-basis", indexId: "prime-demo", value: 25 }]);
      expect(r.status).toBe(422);
      expect(r.body.error.detail!.problems).toEqual([{ at: "rateIndices", message: `rate index "rfr-1m" names index history "${historyId}", which is not in the store; ${REMEDY}` }]);
      const cleared = await preview([{ op: "set-index-history", indexId: "rfr-1m", historyId: null }]);
      expect(cleared.status, cleared.text).toBe(200);
    });
  });
});

describe("a workspace launch pins and attaches the histories it reads", () => {
  // These two items prove the two halves the launch joins: the setup compile pins and attaches, and the run submission
  // reads under those pins. The route end to end (readiness Valid, launch, note, current run) is in
  // indexHistoryReadiness.test.ts, "a workspace launch on a history market, end to end".
  it("the setup compile pins indexHistory:<id>, attaches the document to the request and carries the history note", async () => {
    const { historyId } = await historyMarket();
    await ready("ws-ih-launch", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const row = compile("ws-ih-launch");
    expect(row.request.indexHistories).toEqual([{ id: historyId, history: store.getDocument("index-histories", historyId).doc }]);
    expect(row.consumed[`indexHistory:${historyId}`]).toEqual(
      expect.objectContaining({ collection: "index-histories", id: historyId, contentHash: store.getMeta("index-histories", historyId).contentHash }),
    );
    const notes = row.notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain(
      `rfr-1m (history ${historyId}, read by prime-demo): history covers every month a lag reads; at 2026-03 the history is 4.35 percent`,
    );
    // The validate route records the same role.
    const v = await api<{ consumed: Record<string, { collection: string; id: string }> }>(t.base, "POST", `/api/workspaces/ws-ih-launch/setups/${await slotOf("ws-ih-launch")}/validate`, { by: "tester" });
    expect(v.status).toBe(200);
    expect(v.body.consumed[`indexHistory:${historyId}`]).toEqual(expect.objectContaining({ collection: "index-histories", id: historyId }));
  });

  it("the run submission reads each history under its pin: attached on a match, 409 when the pin moved or is absent", async () => {
    const { historyId } = await historyMarket();
    const role: `indexHistory:${string}` = `indexHistory:${historyId}`;
    const ref = (collection: Collection, id: string): DocRef => ({ collection, id, contentHash: store.getMeta(collection, id).contentHash, pinnedAt: "2026-10-15T00:00:00.000Z" });
    const pins = {
      book: ref("portfolios", INDEXED_BOOK),
      market: ref("market", HIST_MARKET),
      slate: ref("scenario-slates", SEED_IDS.vanillaSlate),
      [`set:${SEED_IDS.vanillaAssumptions}`]: ref("assumption-sets", SEED_IDS.vanillaAssumptions),
      [role]: ref("index-histories", historyId),
    } as ConsumedPins;
    const plan = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${INDEXED_PLAN}`)).body;
    const tags = (await api<{ notImplemented: NotImplemented[] }>(t.base, "POST", "/api/plans/validate", { plan: { ...plan, inputs: { ...plan.inputs, marketSnapshot: HIST_MARKET } } })).body.notImplemented;
    const submit = (consumed: ConsumedPins) =>
      submitRun(t.platform.context, {
        portfolioId: INDEXED_BOOK,
        marketId: HIST_MARKET,
        scenarioSlateId: SEED_IDS.vanillaSlate,
        assumptionSetIds: [SEED_IDS.vanillaAssumptions],
        planTags: tags,
        workspace: { workspaceId: "ws-ih-direct", setupLineageId: "sl-direct", setupDocId: "rs-direct", launchNo: 1, consumed },
      }) as { status?: number; value: { runId: string } };

    const refusal = (consumed: ConsumedPins): { status: number; message: string } => {
      try {
        submit(consumed);
      } catch (err) {
        return { status: (err as { status: number }).status, message: (err as Error).message };
      }
      throw new Error("expected a refusal");
    };
    const { [role]: _dropped, ...withoutRole } = pins;
    void _dropped;
    const absent = refusal(withoutRole);
    expect(absent.status).toBe(409);
    expect(absent.message).toContain(`pin indexHistory:${historyId}: this workspace launch reads index-histories "${historyId}" but consumed no pin in that role`);
    const moved = refusal({ ...pins, [role]: { ...pins[role]!, contentHash: "0".repeat(64) } });
    expect(moved.status).toBe(409);
    expect(moved.message).toContain(`pin indexHistory:${historyId} "${historyId}" moved between the setup compile and submission`);

    const runId = submit(pins).value.runId;
    const stored = store.readRunJson<StoredRunRequest>(runId, "request.json");
    expect(stored.request.indexHistories).toEqual([{ id: historyId, history: store.getDocument("index-histories", historyId).doc }]);
    expect(stored.workspace!.consumed[`indexHistory:${historyId}`]).toEqual(pins[`indexHistory:${historyId}`]);
    const done = await waitFor(() => api<RunStatus>(t.base, "GET", `/api/runs/${runId}`), (s) => s.body.state === "done" || s.body.state === "error", 480_000);
    expect(done.body).toEqual(expect.objectContaining({ state: "done" }));
    const result = store.readRunJson<Result>(runId, "result.json");
    const notes = result.notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain(
      `rfr-1m (history ${historyId}, read by prime-demo): history covers every month a lag reads; at 2026-03 the history is 4.35 percent`,
    );
  }, 600_000);

  it("a market without history launches with no indexHistories key and no indexHistory: role", async () => {
    await ready("ws-ih-window", { derived: [INDICES], use: INDICES, book: INDEXED_BOOK });
    const runId = await launchDone("ws-ih-window");
    const stored = store.readRunJson<StoredRunRequest>(runId, "request.json");
    expect(Object.keys(stored.request)).not.toContain("indexHistories");
    expect(Object.keys(stored.workspace!.consumed).filter((k) => k.startsWith("indexHistory:"))).toEqual([]);
  }, 600_000);

  it("answers 409 on validate when the stored history's bytes no longer hash to its id", async () => {
    const { historyId } = await historyMarket();
    await ready("ws-ih-moved", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const path = docPath(historyId);
    const original = store.getDocumentBytes("index-histories", historyId);
    const doc = store.getDocument<IndexHistory>("index-histories", historyId).doc;
    writeFileSync(path, JSON.stringify({ ...doc, label: "moved" }));
    try {
      const v = await api<ErrBody>(t.base, "POST", `/api/workspaces/ws-ih-moved/setups/${await slotOf("ws-ih-moved")}/validate`, { by: "tester" });
      expect(v.status).toBe(409);
      expect(v.body.error.message.startsWith(`pin indexHistory "${historyId}" moved`)).toBe(true);
    } finally {
      writeFileSync(path, original);
    }
  });

  it("a missing history is a failed validation and a 422 launch with no run attached (B1)", async () => {
    const { historyId } = await historyMarket();
    await ready("ws-ih-missing", { derived: [INDICES, HIST_MARKET], use: HIST_MARKET, book: INDEXED_BOOK });
    const sentence = `The index history "${historyId}" is not in the store; import it again on Market > Rate indices.`;
    const slot = await slotOf("ws-ih-missing");
    await withHistoryAway(historyId, async () => {
      const v = await api<{ outcome: string; reports: { error?: { message: string } } }>(t.base, "POST", `/api/workspaces/ws-ih-missing/setups/${slot}/validate`, { by: "tester" });
      expect(v.status).toBe(200);
      expect(v.body.outcome).toBe("fail");
      expect(v.body.reports.error!.message).toContain(sentence);
      const l = await api<ErrBody>(t.base, "POST", `/api/workspaces/ws-ih-missing/setups/${slot}/launch`, { by: "tester", acknowledge: [WARNINGS] });
      expect(l.status).toBe(422);
      expect(l.body.error.message).toContain(sentence);
      expect(new WorkspaceStore(t.storeRoot).readRunAttachments("ws-ih-missing")).toEqual([]);
    });
  });
});

describe("the plan route and the drill pass the histories", () => {
  it("the stored indexed plan on the history market compiles with the history note", async () => {
    const { historyId } = await historyMarket();
    const stored = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${INDEXED_PLAN}`)).body;
    const plan = { ...stored, inputs: { ...stored.inputs, marketSnapshot: HIST_MARKET } };
    const v = await api<{ compile: { passed: boolean }; notImplemented: Note[] }>(t.base, "POST", "/api/plans/validate", { plan });
    expect(v.status, v.text).toBe(200);
    expect(v.body.compile.passed).toBe(true);
    const notes = v.body.notImplemented.filter((n) => n.layer === "plan.rate-index.history");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.reason).toContain(`rfr-1m (history ${historyId}, read by prime-demo)`);
  });

  it("the drill passes the stored histories; a missing one refuses only when the drilled position reads it", async () => {
    const { historyId } = await historyMarket();
    const drill = (marketId: string) =>
      api<ErrBody>(t.base, "POST", "/api/instrument/project", {
        instrument: { portfolioId: INDEXED_BOOK, positionId: "floating-loans-2" },
        marketId,
        scenarios: { parallelShockBp: 0 },
        horizonMonths: 12,
      });
    const ok = await drill(HIST_MARKET);
    expect(ok.status, ok.text).toBe(200);

    // rfr-3m names a history the store does not hold; floating-loans-2 reads prime-demo (lag on rfr-1m), not rfr-3m.
    const hist = store.getDocument<StoredMarket>("market", HIST_MARKET).doc;
    const unstored = { ...hist, rateIndices: hist.rateIndices.map((r) => (r.id === "rfr-3m" ? { ...r, historyId: "ih-0000000000000000" } : r)) };
    new FileStore(t.storeRoot).putDocument("market", "b3b-unstored-v1", unstored, { label: "test" });
    const tolerated = await drill("b3b-unstored-v1");
    expect(tolerated.status, tolerated.text).toBe(200);

    await withHistoryAway(historyId, async () => {
      const refused = await drill("b3b-unstored-v1");
      expect(refused.status).toBe(422);
      expect(refused.body.error.message).toContain("and the run was not given that history");
    });
  });
});

describe("a plain run submission attaches the histories, sorted by id", () => {
  const submit = (marketId: string) =>
    api<{ runId: string }>(t.base, "POST", "/api/runs", {
      portfolioId: INDEXED_BOOK,
      marketId,
      scenarioSlateId: SEED_IDS.vanillaSlate,
      assumptionSetIds: [SEED_IDS.vanillaAssumptions],
    });
  /** Read the stored request, then cancel the queued run: only the submission is under test. */
  const submitted = async (marketId: string): Promise<StoredRunRequest> => {
    const r = await submit(marketId);
    expect(r.status, r.text).toBe(202);
    const stored = store.readRunJson<StoredRunRequest>(r.body.runId, "request.json");
    await api(t.base, "POST", `/api/runs/${r.body.runId}/cancel`, {});
    return stored;
  };

  it("POST /api/runs on the history market carries the one history", async () => {
    const { historyId } = await historyMarket();
    const stored = await submitted(HIST_MARKET);
    expect(stored.request.indexHistories).toEqual([{ id: historyId, history: store.getDocument("index-histories", historyId).doc }]);
  });

  it("two markets naming the same two histories in opposite block order attach the same list, sorted and distinct", async () => {
    const a = (await importHistory(MONTHLY)).id;
    const b = (await importHistory(MONTHLY_B, "synthetic-rfr-b.csv")).id;
    expect(a).not.toBe(b);
    const [low, high] = a < b ? [a, b] : [b, a];
    // The derive writes the block sorted by id, so rfr-1m comes before x-1m. prime-demo lags on rfr-1m and rfr-3m lags
    // on x-1m, so both histories are read. The first market names high then low in block order; the second low then high.
    const ops = (onRfr1m: string, onX: string) => [
      { op: "set-index", id: "x-1m", label: "Second one-month benchmark (demonstration index)", tenorMonths: 1, basisBp: 0 },
      { op: "set-index-history", indexId: "rfr-1m", historyId: onRfr1m },
      { op: "set-index-history", indexId: "x-1m", historyId: onX },
      PRIME_LAG,
      { op: "set-index", id: "rfr-3m", label: "Three-month rate, one month late (demonstration values)", kind: "formula", parent: "x-1m", coefficient: 1, lagMonths: 1, basisBp: 0 },
    ];
    expect((await derive({ baseId: INDICES, ops: ops(high, low), id: "b3b-order-high-low-v1" })).status).toBe(201);
    expect((await derive({ baseId: INDICES, ops: ops(low, high), id: "b3b-order-low-high-v1" })).status).toBe(201);
    const named = (id: string) => store.getDocument<StoredMarket>("market", id).doc.rateIndices.filter((r) => r.historyId !== undefined).map((r) => r.historyId);
    expect(named("b3b-order-high-low-v1")).toEqual([high, low]);
    expect(named("b3b-order-low-high-v1")).toEqual([low, high]);

    const one = (await submitted("b3b-order-high-low-v1")).request.indexHistories!;
    const two = (await submitted("b3b-order-low-high-v1")).request.indexHistories!;
    expect(one.map((e) => e.id)).toEqual([low, high]);
    expect(two).toEqual(one);
    // inputsHash covers this list as serialized (assembleProvenance): equal bytes, so the history part hashes the same.
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));

    // Both parents naming the same history: the request lists it once.
    expect((await derive({ baseId: INDICES, ops: ops(low, low), id: "b3b-order-same-v1" })).status).toBe(201);
    expect(named("b3b-order-same-v1")).toEqual([low, low]);
    expect((await submitted("b3b-order-same-v1")).request.indexHistories!.map((e) => e.id)).toEqual([low]);
  });
});
