// packages/engine/src/run/__tests__/housingFlatIdentity.test.ts
/**
 * A2 at run level (C2, F8). Monitoring trigger (Section 13):
 * a kernel re-vendor; a failure is reported, never re-pinned without a recorded
 * hand check.
 *
 * The flat-path set (housing group on, mapped to hpi-flat) against the demo set
 * on the same market: every result block byte-identical; inputsHash and the run
 * log differ. The factory and the wrapper are counted, so a bypass that never
 * builds the wrapper cannot pass.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { MarketSnapshot } from "@alm/kernel";
import { housingSet, macroMarket, runOn } from "./macroFixtures";

const counts = { mortgageCalls: 0, wrappers: 0 };
vi.mock("../../runtime/instrumentFactory", async (orig) => {
  const m = await orig<typeof import("../../runtime/instrumentFactory")>();
  return { ...m, makeInstrument: (t: { type: string }, o?: unknown) => { if (t.type === "mortgage") counts.mortgageCalls++; return m.makeInstrument(t as never, o as never); } };
});
vi.mock("../../macro/housingMortgage", async (orig) => {
  const m = await orig<typeof import("../../macro/housingMortgage")>();
  class Counted extends m.HousingMortgage { constructor(...a: ConstructorParameters<typeof m.HousingMortgage>) { super(...a); counts.wrappers++; } }
  return { ...m, HousingMortgage: Counted };
});

let market: MarketSnapshot;
beforeAll(async () => { market = await macroMarket(); }, 120_000);
const blocks = (r: Record<string, unknown>) => { const { provenance: _p, ...rest } = r; return JSON.stringify(rest); };

describe("A2 flat-path identity at run level (monitoring trigger: kernel re-vendor)", () => {
  it("every result block is byte-identical; inputsHash and the run log differ; one wrapper per mortgage factory call", () => {
    const demo = runOn(market, housingSet("demo-behavioral-v1", null), { shards: 1 });
    expect(counts.wrappers).toBe(0);  // power: the unmapped run builds no wrapper
    counts.mortgageCalls = 0; counts.wrappers = 0;
    const flat = runOn(market, housingSet("housing-flat-demo-v1", "hpi-flat"), { shards: 1 });
    expect(blocks(flat as never)).toBe(blocks(demo as never));
    expect(flat.provenance.inputsHash).not.toBe(demo.provenance.inputsHash);
    expect(JSON.stringify(flat.provenance.runLog)).not.toBe(JSON.stringify(demo.provenance.runLog));
    console.info("A2 mortgage factory calls", counts.mortgageCalls, "wrappers", counts.wrappers);
    expect(counts.wrappers).toBe(counts.mortgageCalls);
    expect(counts.mortgageCalls).toBeGreaterThan(825);
    expect(blocks(runOn(market, housingSet("housing-flat-demo-v1", "hpi-flat"), { shards: 4 }) as never)).toBe(blocks(flat as never));
  }, 600_000);
});
