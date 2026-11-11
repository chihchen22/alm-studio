// apps/server/src/__tests__/workspaceHashes.test.ts
import { describe, expect, it } from "vitest";
import { blockHashes, manifestHashOf, signedHashOf, slugOf } from "../workspaces/hashes";
import type { WorkspaceBlocks, WorkspaceManifest } from "../workspaces/types";
import { InvalidIdError } from "../store/paths";

const ref = (collection: string, id: string, contentHash: string, pinnedAt = "2026-10-09T00:00:00.000Z") => ({ collection, id, contentHash, pinnedAt }) as never;
const empty = (): WorkspaceBlocks => ({
  market: { snapshot: null, derived: [], carried: [], carriedFrom: null },
  positions: { book: null, retagged: [], coa: null, taxonomy: null, hierarchies: [] },
  targets: { balancePlans: [], templates: [] },
  assumptions: { sets: [], defaultSetId: null, routingPolicy: null },
  scenarios: { slates: [] },
  run: { setups: [], lenses: [] },
});
const manifest = (blocks: WorkspaceBlocks): WorkspaceManifest => {
  const bh = blockHashes(blocks);
  const m = { schemaVersion: "1.0.0", id: "ws-a", name: "A", type: "test", status: "active", cutoffDate: "2026-03-31", owner: "o", createdAt: "t", updatedAt: "t", revision: 1, blocks, blockHashes: bh, signedHash: "", manifestHash: "", lineage: { mode: "blank", fromWorkspaceId: null, fromSignedHash: null, carried: [], supersededBy: null, pendingSupersede: false }, clashes: [], lock: null, note: "" } as unknown as WorkspaceManifest;
  m.signedHash = signedHashOf(m); m.manifestHash = manifestHashOf(m); return m;
};

// Pinned literals, each computed once by hand from the rule:
// sha256 over the canonical JSON string written out below, via `shasum -a 256`.
// sha256("[]"): the hash of a block with no entries.
const EMPTY_BLOCK = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
// sha256('[["assumption-sets","s1","h1"],["assumption-sets","s2","h2"],["default","s1"]]')
const ASSUMPTIONS_S1_S2_DEFAULT_S1 = "76fa5fb38b121f93fb54dedcf7826fe723bab6aee3473b077b45e7f4a469e98f";
// sha256('[["carried","k",null,"m","hm","awaiting",null]]')
const MARKET_ONE_AWAITING = "0101c1cacfa969cf3dc8eb80e9c138b3ab6e97fe90fbd919b660edaf03451ddc";
// sha256 of {"blockHashes":{<six blocks, each EMPTY_BLOCK, keys sorted>},"cutoffDate":"2026-03-31","id":"ws-a","type":"test"}
const SIGNED_EMPTY_WS_A = "45ad5585d60f642e7ee5f896675b62b9bdb99ce05cf6838ddcd826fedeb169f4";
// sha256 of the whole empty ws-a manifest, keys sorted, with updatedAt, revision and manifestHash removed
const MANIFEST_EMPTY_WS_A = "4d23197285c6bca7ab37de0f215039a7f0b571c001b2a3c01a4f536734305801";

describe("block hash tuples", () => {
  it("pinnedAt and attachment order never enter a block hash", () => {
    const a = empty(); a.assumptions.sets = [ref("assumption-sets", "s1", "h1", "t1"), ref("assumption-sets", "s2", "h2", "t1")];
    const b = empty(); b.assumptions.sets = [ref("assumption-sets", "s2", "h2", "t9"), ref("assumption-sets", "s1", "h1", "t9")];
    expect(blockHashes(a).assumptions).toBe(blockHashes(b).assumptions);
  });
  it("a content hash, the default set, a carried status and a slot document all move their block", () => {
    const a = empty(); a.assumptions.sets = [ref("assumption-sets", "s1", "h1")];
    const b = empty(); b.assumptions.sets = [ref("assumption-sets", "s1", "h2")];
    expect(blockHashes(a).assumptions).not.toBe(blockHashes(b).assumptions);
    const c = empty(); c.assumptions.sets = [ref("assumption-sets", "s1", "h1")]; c.assumptions.defaultSetId = "s1";
    expect(blockHashes(a).assumptions).not.toBe(blockHashes(c).assumptions);
    const d = empty(); d.market.carried = [{ definitionKey: "k", parentKey: null, source: ref("market", "m", "hm"), status: "awaiting", appliedId: null, refusal: null }];
    const e = empty(); e.market.carried = [{ definitionKey: "k", parentKey: null, source: ref("market", "m", "hm"), status: "applied", appliedId: "derived-mk-abc", refusal: null }];
    expect(blockHashes(d).market).not.toBe(blockHashes(e).market);
    const f = empty(); f.run.setups = [{ setupLineageId: "setup-1", current: ref("run-setups", "rs-1", "r1") }];
    const g = empty(); g.run.setups = [{ setupLineageId: "setup-1", current: ref("run-setups", "rs-2", "r2") }];
    expect(blockHashes(f).run).not.toBe(blockHashes(g).run);
    expect(blockHashes(f).market).toBe(blockHashes(g).market);
  });
  it("refusal text does not move the market hash", () => {
    const d = empty(); d.market.carried = [{ definitionKey: "k", parentKey: null, source: ref("market", "m", "hm"), status: "refused", appliedId: null, refusal: "one" }];
    const e = empty(); e.market.carried = [{ definitionKey: "k", parentKey: null, source: ref("market", "m", "hm"), status: "refused", appliedId: null, refusal: "two" }];
    expect(blockHashes(d).market).toBe(blockHashes(e).market);
  });
  it("matches the literals computed by hand from the tuple rule", () => {
    const z = blockHashes(empty());
    expect(z).toEqual({ market: EMPTY_BLOCK, positions: EMPTY_BLOCK, targets: EMPTY_BLOCK, assumptions: EMPTY_BLOCK, scenarios: EMPTY_BLOCK, run: EMPTY_BLOCK });
    const a = empty(); a.assumptions.sets = [ref("assumption-sets", "s2", "h2"), ref("assumption-sets", "s1", "h1")]; a.assumptions.defaultSetId = "s1";
    expect(blockHashes(a).assumptions).toBe(ASSUMPTIONS_S1_S2_DEFAULT_S1);
    const d = empty(); d.market.carried = [{ definitionKey: "k", parentKey: null, source: ref("market", "m", "hm"), status: "awaiting", appliedId: null, refusal: "ignored" }];
    d.market.carriedFrom = { workspaceId: "ws-old", at: "t" };
    expect(blockHashes(d).market).toBe(MARKET_ONE_AWAITING);
  });
});

describe("signedHash and manifestHash", () => {
  it("signedHash ignores name, note, status, lock, clashes, lineage, revision and updatedAt", () => {
    const m = manifest(empty());
    const moved = { ...m, name: "B", note: "n", status: "locked", lock: { lockedAt: "t", by: "x", approvalId: "ap-1", signedHash: m.signedHash }, revision: 9, updatedAt: "u", clashes: [{ block: "market", id: "m", documentAsOf: "2026-04-30", recordedAt: "t", outcome: "warned" }], lineage: { ...m.lineage, supersededBy: "ws-b" } } as WorkspaceManifest;
    expect(signedHashOf(moved)).toBe(m.signedHash);
  });
  it("signedHash moves with id, type, cutoffDate and any block hash", () => {
    const m = manifest(empty());
    expect(signedHashOf({ ...m, id: "ws-b" })).not.toBe(m.signedHash);
    expect(signedHashOf({ ...m, type: "production" })).not.toBe(m.signedHash);
    expect(signedHashOf({ ...m, cutoffDate: "2026-04-30" })).not.toBe(m.signedHash);
    const b = empty(); b.scenarios.slates = [ref("scenario-slates", "sl", "h")];
    expect(signedHashOf(manifest(b))).not.toBe(m.signedHash);
  });
  it("manifestHash excludes updatedAt, revision and itself, and moves with a note", () => {
    const m = manifest(empty());
    expect(manifestHashOf({ ...m, updatedAt: "u", revision: 7 })).toBe(m.manifestHash);
    expect(manifestHashOf({ ...m, note: "n" })).not.toBe(m.manifestHash);
  });
  it("signedHash and manifestHash match the literals computed by hand", () => {
    const m = manifest(empty());
    expect(m.signedHash).toBe(SIGNED_EMPTY_WS_A);
    expect(m.manifestHash).toBe(MANIFEST_EMPTY_WS_A);
  });
});

describe("slugOf", () => {
  it("lowercases, collapses runs, strips ends, truncates to 40", () => {
    expect(slugOf("Q2 Stress (draft)")).toBe("ws-q2-stress-draft");
    expect(slugOf("  --Hello__World--  ")).toBe("ws-hello-world");
    expect(slugOf("a".repeat(60))).toBe(`ws-${"a".repeat(40)}`);
  });
  it("refuses a name that yields nothing", () => {
    expect(() => slugOf("(((")).toThrow(InvalidIdError);
  });
});

// The saved curve setups slot on the market block. Literals by hand, as above:
// sha256('[["curve-active","cs-1"],["curve-setups","sofr","cs-1","h1"]]')
const MARKET_CURVE_SETUP_ACTIVE = "a123749e798adb012b71df3c6ead80a06ddbc117fbf936e649bee255b22c231f";
// sha256('[["curve-setups","sofr","cs-1","h1"]]')
const MARKET_CURVE_SETUP_SAVED = "fd826172a1798269d1278e975824f97c52b5b0fac6df2b2f3cc8287a008d46ea";

describe("curve setups on the market block (Piece B, step B1)", () => {
  const withSetups = (active?: string, pinnedAt?: string): WorkspaceBlocks => {
    const b = empty();
    b.market.curveSetups = { setups: [{ lineageKey: "sofr", current: ref("curve-setups", "cs-1", "h1", pinnedAt) }], ...(active !== undefined ? { active } : {}) };
    return b;
  };
  it("a workspace with no curve setups slot hashes exactly as before: the key is absent and every block is the empty literal", () => {
    const blocks = empty();
    expect("curveSetups" in blocks.market).toBe(false);
    expect(blockHashes(blocks).market).toBe(EMPTY_BLOCK);
    expect(manifest(blocks).signedHash).toBe(SIGNED_EMPTY_WS_A);
  });
  it("a saved setup and the active pointer each move the market hash, and only the market hash; pinnedAt never does", () => {
    const saved = blockHashes(withSetups());
    const active = blockHashes(withSetups("cs-1"));
    expect(saved.market).not.toBe(EMPTY_BLOCK);
    expect(active.market).not.toBe(saved.market);
    for (const b of ["positions", "targets", "assumptions", "scenarios", "run"] as const) {
      expect(saved[b]).toBe(EMPTY_BLOCK);
      expect(active[b]).toBe(EMPTY_BLOCK);
    }
    expect(blockHashes(withSetups("cs-1", "2030-01-01T00:00:00.000Z")).market).toBe(active.market);
    expect(signedHashOf(manifest(withSetups("cs-1")))).not.toBe(SIGNED_EMPTY_WS_A);
  });
  it("matches the literals computed by hand from the tuple rule", () => {
    expect(blockHashes(withSetups()).market).toBe(MARKET_CURVE_SETUP_SAVED);
    expect(blockHashes(withSetups("cs-1")).market).toBe(MARKET_CURVE_SETUP_ACTIVE);
  });
});

// Saved derived curves on the market block. Literals by hand, as above:
// sha256('[["derived-curves","sofr-ust","dc-1","h1"]]')
const MARKET_DERIVED_CURVE_SAVED = "6f3e6979c90429707f00da2a553c1437b5daed79e5a399842ecd2258378bd4e6";
// sha256('[["curve-active","cs-1"],["curve-setups","sofr","cs-1","h1"],["derived-curves","sofr-ust","dc-1","h1"]]')
const MARKET_SETUP_AND_DERIVED_CURVE = "21df796c1d64546ac2c3fc94797a6c8b3db5509a19aa386c58504bfdede2d7a9";

describe("derived curves on the market block (Piece B, step B2)", () => {
  const withCurve = (pinnedAt?: string): WorkspaceBlocks => {
    const b = empty();
    b.market.derivedCurves = { curves: [{ lineageKey: "sofr-ust", current: ref("derived-curves", "dc-1", "h1", pinnedAt) }] };
    return b;
  };
  it("a workspace with no derivedCurves key hashes exactly as before", () => {
    const blocks = empty();
    expect("derivedCurves" in blocks.market).toBe(false);
    expect(blockHashes(blocks).market).toBe(EMPTY_BLOCK);
    expect(manifest(blocks).signedHash).toBe(SIGNED_EMPTY_WS_A);
    expect(manifest(blocks).manifestHash).toBe(MANIFEST_EMPTY_WS_A);
  });
  it("a saved curve moves only the market hash, never on pinnedAt, and matches the literal computed by hand", () => {
    const saved = blockHashes(withCurve());
    expect(saved.market).toBe(MARKET_DERIVED_CURVE_SAVED);
    for (const b of ["positions", "targets", "assumptions", "scenarios", "run"] as const) expect(saved[b]).toBe(EMPTY_BLOCK);
    expect(blockHashes(withCurve("2030-01-01T00:00:00.000Z")).market).toBe(saved.market);
    const both = withCurve();
    both.market.curveSetups = { setups: [{ lineageKey: "sofr", current: ref("curve-setups", "cs-1", "h1") }], active: "cs-1" };
    expect(blockHashes(both).market).toBe(MARKET_SETUP_AND_DERIVED_CURVE);
  });
});
