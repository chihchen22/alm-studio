/**
 * Controls (limits, read-only first build): GET /api/lenses lists the stored
 * lens definitions, ascending id, each with its stored fields and the store's
 * content hash. It is a read: there is no write route, a POST answers the
 * platform's no-route 404, and the call leaves every lens file and meta file
 * byte for byte as it found them.
 *
 * The lens documents are written straight through the store, as the seed
 * writes them, so this suite does not build the portfolios a full seed builds.
 * Expected ids, labels and constraint counts are restated from
 * docs/harness/lenses.json, not read from it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../config";
import { buildDemoLenses } from "../../scripts/seed-store";
import { api, bootTestPlatform, type TestPlatform } from "./harness";

let tp: TestPlatform;

beforeAll(async () => {
  tp = await bootTestPlatform();
  const store = tp.platform.context.store;
  for (const lens of buildDemoLenses(repoRoot())) {
    store.putDocument("lens", lens.id, lens, {
      label: lens.label,
      objective: lens.objective,
      constraintCount: lens.constraints.length,
      seeded: true,
    });
  }
}, 120_000);

afterAll(async () => {
  await tp.close();
});

/** Every file under the store's lens collection, name to bytes. */
function lensFiles(): Record<string, string> {
  const dir = tp.platform.context.store.paths.collectionDir("lens");
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f), "utf8");
  return out;
}

interface LensListItem {
  id: string;
  label: string;
  objective: string;
  constraints: Array<{ id: string; reader: string; op: string; limit: number; label?: string }>;
  contentHash: string;
}

describe("GET /api/lenses", () => {
  it("lists the six seeded lenses in ascending id with their constraint counts", async () => {
    const r = await api<LensListItem[]>(tp.base, "GET", "/api/lenses");
    expect(r.status).toBe(200);
    expect(r.body.map((l) => [l.id, l.constraints.length])).toEqual([
      ["balance-demo-v1", 1],
      ["capital-demo-v1", 1],
      ["liquidity-demo-v1", 2],
      ["rate-demo-v1", 2],
      ["strategy-demo-v1", 2],
      ["wal-gap-demo-v1", 2],
    ]);
    const rate = r.body.find((l) => l.id === "rate-demo-v1")!;
    expect(rate.label).toBe("Interest-rate risk (demonstration limits)");
    expect(rate.objective).toBe("rate");
    expect(rate.constraints.map((c) => [c.id, c.reader, c.op, c.limit])).toEqual([
      ["eve-15", "deltaEvePct", "atLeast", -0.15],
      ["nii-12", "deltaNiiPct", "atLeast", -0.1],
    ]);
    expect(rate.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rate.contentHash).toBe(tp.platform.context.store.getMeta("lens", "rate-demo-v1").contentHash);
  });

  it("is read-only: a POST is the no-route 404 and the store is unchanged after the calls", async () => {
    const before = lensFiles();
    expect(Object.keys(before)).toHaveLength(12);
    const post = await api<{ error: { message: string } }>(tp.base, "POST", "/api/lenses", {
      id: "x",
      label: "x",
      objective: "rate",
      constraints: [],
    });
    expect(post.status).toBe(404);
    expect(post.body.error.message).toContain("no route for POST /api/lenses");
    expect((await api(tp.base, "GET", "/api/lenses")).status).toBe(200);
    expect(lensFiles()).toEqual(before);
  });
});
