/**
 * The market derive routes (preview and save),
 * GET /api/market/:id, and the listing's derivedFromMarketId. Runs on a scratch
 * store seeded by the real seedStore() through the test-platform harness. Every
 * expected value is restated from the approved design, never read back from the
 * code under test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { seedStore } from "../../scripts/seed-store";
import { api, bootTestPlatform, warmCatalog, type TestPlatform } from "./harness";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

interface Err {
  error: { code: string; message: string; detail?: { problems?: Array<{ at: string; message: string }> } };
}
interface Node {
  tYears: number;
  spread: number;
}
interface Snap {
  tlpNodes: Node[];
  termFundingCurveQuotes: unknown[];
  rateIndices?: Array<{ id: string; label: string; tenorMonths: number; basis: number }>;
  derivedFrom?: { baseId: string; baseContentHash: string; ops: unknown[] };
}
interface Preview {
  id: string;
  label: string;
  snapshot: Snap;
  changes: unknown[];
  indexChanges: Array<{ id: string; from: unknown; to: { id: string; basis: number }; basisChangeBp: number | null }>;
  volChanges: Array<{
    expiryYears: number;
    quotes: number;
    quotesChanged: number;
    atmFrom: number | null;
    atmTo: number | null;
    atmChangeBp: number | null;
    ops: number[];
  }>;
  termFundingQuotesDropped: number;
}
interface SaveReply extends Preview {
  outcome: string;
}
interface ListRow {
  id: string;
  label?: string;
  derivedFromMarketId?: string;
}

const BASE = "market-public-2026-03-31";
const BASE_HASH = "900f07ce62af01db66c287a2a7dbb7c09fd35408866408ed2d565b561b9f3651";
const V1 = [0, 0.007, 0.007, 0.0075, 0.0075, 0.008, 0.0085, 0.0095, 0.0105, 0.0115, 0.014, 0.015];
const ADD50 = { op: "add", value: 50 };
const body = (extra: Record<string, unknown> = {}) => ({ baseId: BASE, ops: [ADD50], ...extra });
const rows = async () => (await api<ListRow[]>(t.base, "GET", "/api/market")).body;

describe("POST /api/market/derive/preview", () => {
  it("M1: answers 200 with the V1 spreads and 11 dropped quotes, and stores nothing", async () => {
    const before = await rows();
    const r = await api<Preview>(t.base, "POST", "/api/market/derive/preview", body());
    expect(r.status).toBe(200);
    expect(r.body.id).toBe("derived-mk-cc5f69059269");
    expect(r.body.snapshot.tlpNodes.map((n) => n.spread)).toEqual(V1);
    expect(r.body.termFundingQuotesDropped).toBe(11);
    expect(r.body.changes).toHaveLength(11);
    expect(await rows()).toEqual(before);
    expect(t.platform.context.store.has("market", "derived-mk-cc5f69059269")).toBe(false);
  });
});

describe("POST /api/market/derive", () => {
  it("M2: creates (201), lists the lineage on the derived row only, and serves the stored snapshot", async () => {
    const r = await api<SaveReply>(t.base, "POST", "/api/market/derive", body());
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe("created");
    expect(r.body.id).toBe("derived-mk-cc5f69059269");
    const list = await rows();
    const derived = list.find((x) => x.id === "derived-mk-cc5f69059269")!;
    expect(derived.derivedFromMarketId).toBe(BASE);
    const baseRow = list.find((x) => x.id === BASE)!;
    expect("derivedFromMarketId" in baseRow).toBe(false);
    const g = await api<Snap>(t.base, "GET", "/api/market/derived-mk-cc5f69059269");
    expect(g.status).toBe(200);
    expect(g.body.derivedFrom!.ops).toEqual([{ op: "add", value: 50 }]);
    expect(g.body.termFundingCurveQuotes).toEqual([]);
  });

  it("M2b: a saved derived market answers on the catalog market read and lineage at once, with no re-sync", async () => {
    await warmCatalog(t.base);
    const r = await api<SaveReply>(t.base, "POST", "/api/market/derive", body({ ops: [{ op: "add", value: 75 }] }));
    expect(r.status).toBe(201);
    const mkt = await api<{ id: string }>(t.base, "GET", `/api/catalog/markets/${r.body.id}`);
    expect(mkt.status).toBe(200);
    expect(mkt.body.id).toBe(r.body.id);
    expect((await api(t.base, "GET", `/api/catalog/lineage/market/${r.body.id}`)).status).toBe(200);
  });

  it("M3: the identical request, and the same ops under another label, return 200 unchanged", async () => {
    const a = await api<SaveReply>(t.base, "POST", "/api/market/derive", body());
    expect(a.status).toBe(200);
    expect(a.body.outcome).toBe("unchanged");
    const b = await api<SaveReply>(t.base, "POST", "/api/market/derive", body({ label: "other" }));
    expect(b.status).toBe(200);
    expect(b.body.outcome).toBe("unchanged");
  });

  it("M4: the same id with different content is 409", async () => {
    const a = await api<SaveReply>(t.base, "POST", "/api/market/derive", body({ id: "tlp-shock-test" }));
    expect(a.status).toBe(201);
    const b = await api<Err>(t.base, "POST", "/api/market/derive", {
      baseId: BASE,
      ops: [{ op: "add", value: 25 }],
      id: "tlp-shock-test",
    });
    expect(b.status).toBe(409);
    expect(b.body.error.message).toBe(
      'market "tlp-shock-test" already exists with different content (the store is append-only); save it under a new id',
    );
  });

  it("M5: refusals are 422 with every problem, an unknown key, a derived- id, and 404 for an unknown base", async () => {
    const two = await api<Err>(t.base, "POST", "/api/market/derive", {
      baseId: BASE,
      ops: [{ op: "set", value: 1 }, { op: "add", value: "x" }],
    });
    expect(two.status).toBe(422);
    expect(two.body.error.detail!.problems).toHaveLength(2);
    const foo = await api<Err>(t.base, "POST", "/api/market/derive", body({ foo: 1 }));
    expect(foo.status).toBe(422);
    expect(foo.body.error.message).toBe('unknown field "foo" in the request body; send { baseId, ops, id?, label? }');
    const pre = await api<Err>(t.base, "POST", "/api/market/derive", body({ id: "derived-x" }));
    expect(pre.status).toBe(422);
    const nf = await api<Err>(t.base, "POST", "/api/market/derive", { baseId: "no-such-market", ops: [ADD50] });
    expect(nf.status).toBe(404);
  });
});

describe("GET /api/market/:id", () => {
  it("M6: an unknown id is 404", async () => {
    const r = await api<Err>(t.base, "GET", "/api/market/no-such");
    expect(r.status).toBe(404);
  });

  it("M7: the base snapshot is served with its engine content hash", async () => {
    const r = await api<Snap>(t.base, "GET", `/api/market/${BASE}`);
    expect(r.status).toBe(200);
    expect(r.body.derivedFrom).toBeUndefined();
    expect(contentHash(r.body)).toBe(BASE_HASH);
  });
});

// --- Rate index ops through the same routes -------------
const SEED_OPS = [
  { op: "set-index", id: "rfr-1m", label: "One-month benchmark rate (demonstration index)", tenorMonths: 1, basisBp: 0 },
  { op: "set-index", id: "rfr-3m", label: "Three-month benchmark term rate (demonstration index)", tenorMonths: 3, basisBp: 0 },
  { op: "set-index", id: "prime-demo", label: "Prime-style rate, benchmark plus 300 bp (demonstration values)", tenorMonths: 1, basisBp: 300 },
];
const idxBody = (extra: Record<string, unknown> = {}) => ({ baseId: BASE, ops: SEED_OPS, ...extra });

describe("rate index ops on the derive routes (Piece 7a)", () => {
  it("I1: preview answers 200 with three index changes, no dropped quotes, sorted ids, and stores nothing", async () => {
    const before = await rows();
    const r = await api<Preview>(t.base, "POST", "/api/market/derive/preview", idxBody());
    expect(r.status, r.text).toBe(200);
    expect(r.body.indexChanges).toHaveLength(3);
    expect(r.body.termFundingQuotesDropped).toBe(0);
    expect(r.body.snapshot.rateIndices!.map((x) => x.id)).toEqual(["prime-demo", "rfr-1m", "rfr-3m"]);
    expect(r.body.snapshot.termFundingCurveQuotes).toHaveLength(11);
    expect(await rows()).toEqual(before);
  });

  it("I2: saves as idx-test-v1 (201), an identical re-save is 200 unchanged, the same id with basisBp 301 is 409", async () => {
    const a = await api<SaveReply>(t.base, "POST", "/api/market/derive", idxBody({ id: "idx-test-v1" }));
    expect(a.status, a.text).toBe(201);
    expect(a.body.outcome).toBe("created");
    expect(a.body.indexChanges).toHaveLength(3);
    const b = await api<SaveReply>(t.base, "POST", "/api/market/derive", idxBody({ id: "idx-test-v1" }));
    expect(b.status).toBe(200);
    expect(b.body.outcome).toBe("unchanged");
    const changed = SEED_OPS.map((o) => (o.id === "prime-demo" ? { ...o, basisBp: 301 } : o));
    const c = await api<Err>(t.base, "POST", "/api/market/derive", { baseId: BASE, ops: changed, id: "idx-test-v1" });
    expect(c.status).toBe(409);
    const g = await api<Snap>(t.base, "GET", "/api/market/idx-test-v1");
    expect(g.body.rateIndices!.find((x) => x.id === "prime-demo")!.basis).toBe(0.03);
  });

  it("I3: add-index-basis on an index the market does not carry is 422 naming it", async () => {
    const r = await api<Err>(t.base, "POST", "/api/market/derive", {
      baseId: BASE,
      ops: [{ op: "add-index-basis", indexId: "nope", value: 25 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems![0]!.message).toContain("nope");
  });

  it("I4: a TLP-only derive reports 11 dropped quotes and no index changes", async () => {
    const r = await api<Preview>(t.base, "POST", "/api/market/derive/preview", body());
    expect(r.status).toBe(200);
    expect(r.body.termFundingQuotesDropped).toBe(11);
    expect(r.body.indexChanges).toEqual([]);
  });

  it("I5: a TLP-only no-op keeps its 6c text", async () => {
    const r = await api<Err>(t.base, "POST", "/api/market/derive", { baseId: BASE, ops: [{ op: "add", value: 0 }] });
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems![0]!.message).toBe(
      'the ops change no TLP node; the derived market would carry what market "market-public-2026-03-31" carries',
    );
  });
});

// --- Short-rate volatility ops through the same routes ---
const VOL15 = [{ op: "scale-short-rate-vol", value: 1.5 }];
const VOL15_ID = "derived-mk-fdb4bee2e09a";
const VOL15_HASH = "f9737f2aae0c8b7d9c86dd3fbd49f280019cd47c6011c571bb206c3ff73e95f6";
const volBody = (extra: Record<string, unknown> = {}) => ({ baseId: BASE, ops: VOL15, ...extra });

describe("Piece 6d: volatility ops on the derive routes", () => {
  it("D1: a preview of scale 1.5 answers 200 with 15 volChanges rows and stores nothing", async () => {
    const before = await rows();
    const r = await api<Preview>(t.base, "POST", "/api/market/derive/preview", volBody());
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(VOL15_ID);
    expect(r.body.volChanges).toHaveLength(15);
    expect(r.body.volChanges[0]).toEqual({
      expiryYears: 1,
      quotes: 26,
      quotesChanged: 26,
      atmFrom: 0.006345,
      atmTo: 0.0095175,
      atmChangeBp: 31.725,
      ops: [0],
    });
    expect(r.body.changes).toEqual([]);
    expect(r.body.indexChanges).toEqual([]);
    expect(r.body.termFundingQuotesDropped).toBe(0);
    expect(await rows()).toEqual(before);
    expect(t.platform.context.store.has("market", VOL15_ID)).toBe(false);
  });

  it("D2: save is 201, the identical body is 200 unchanged, and a different value under the same id is 409", async () => {
    const a = await api<SaveReply>(t.base, "POST", "/api/market/derive", volBody());
    expect(a.status).toBe(201);
    expect(a.body.outcome).toBe("created");
    expect(a.body.id).toBe(VOL15_ID);
    expect(a.body.volChanges).toHaveLength(15);
    expect(t.platform.context.store.getMeta("market", VOL15_ID).contentHash).toBe(VOL15_HASH);
    const b = await api<SaveReply>(t.base, "POST", "/api/market/derive", volBody());
    expect(b.status).toBe(200);
    expect(b.body.outcome).toBe("unchanged");
    expect(b.body.volChanges).toHaveLength(15);
    const c1 = await api<SaveReply>(t.base, "POST", "/api/market/derive", volBody({ id: "vol-test-v1" }));
    expect(c1.status).toBe(201);
    const c2 = await api<Err>(t.base, "POST", "/api/market/derive", {
      baseId: BASE,
      ops: [{ op: "scale-short-rate-vol", value: 1.6 }],
      id: "vol-test-v1",
    });
    expect(c2.status).toBe(409);
  });

  it("D3: scale 5 is 422 with the engine's scale-range text", async () => {
    const r = await api<Err>(t.base, "POST", "/api/market/derive", {
      baseId: BASE,
      ops: [{ op: "scale-short-rate-vol", value: 5 }],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.detail!.problems![0]!.message).toBe(
      "ops[0]: a short-rate volatility scale factor must be from 0.25 to 4; got 5",
    );
  });

  it("D4: TLP and index replies now carry volChanges as an empty list", async () => {
    const tlp = await api<Preview>(t.base, "POST", "/api/market/derive/preview", body());
    expect(tlp.body.volChanges).toEqual([]);
    const idx = await api<Preview>(t.base, "POST", "/api/market/derive/preview", idxBody());
    expect(idx.body.volChanges).toEqual([]);
  });
});

describe("Piece 7b: macro series ops on the derive routes", () => {
  const flatOp = {
    op: "set-macro-series", id: "hpi-flat", label: "House prices flat (authored projection)", kind: "index", role: "projection",
    unit: "ratio to 2026-03", firstMonth: "2026-04", values: new Array(360).fill(1), source: { authored: true, note: "Synthetic." },
  };
  it("X1: a macro preview carries macroChanges; a TLP-only preview has no macroChanges key", async () => {
    const r = await api<Preview & { macroChanges?: unknown }>(t.base, "POST", "/api/market/derive/preview", { baseId: BASE, ops: [flatOp] });
    expect(r.status).toBe(200);
    expect(r.body.macroChanges).toEqual([{ id: "hpi-flat", change: "added", ops: [0] }]);
    const tlp = await api<Record<string, unknown>>(t.base, "POST", "/api/market/derive/preview", body());
    expect(Object.keys(tlp.body)).not.toContain("macroChanges");
  });
});
