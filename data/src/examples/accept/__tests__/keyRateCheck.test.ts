/**
 * The capability check runs green on the vanilla book (its registration
 * in ./registry.ts is W3-V2's; this test keeps the check exercised in the
 * ordinary suite so the battery holds no assembly risk). Every line's measured
 * value is printed so the wave report can cite the numbers.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMarketSnapshot, type MarketSnapshot } from "@alm/kernel";
import { keyRateCheck } from "../keyRate";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../../../..");
const MARKET_PATH = resolve(REPO_ROOT, "packages/kernel/public/market_public.json");

let market: MarketSnapshot;
beforeAll(async () => {
  market = await loadMarketSnapshot(MARKET_PATH);
});

describe("accept/keyRate — vanilla anchors", () => {
  it("every line passes and the vanilla run emits no notImplemented tags", async () => {
    const res = await keyRateCheck.run({ repoRoot: REPO_ROOT, market });
    for (const line of res.lines) {
      // eslint-disable-next-line no-console
      console.log(`[accept keyRate] ${line.status.toUpperCase()} ${line.id} — ${line.detail}`);
    }
    expect(res.lines.length).toBeGreaterThanOrEqual(3);
    expect(res.lines.every((l) => l.status === "pass")).toBe(true);
    // The vanilla book has no regime-amplified positions and no seasoning, so
    // the opt-in run's register stays empty — nothing for stage 4 to expect.
    expect(res.observedNotImplemented).toEqual([]);
  }, 120_000);
});
