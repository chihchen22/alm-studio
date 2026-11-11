// apps/server/src/__tests__/curveDefaultMarker.test.ts
// Outside a run, a market with no curveSetup block
// builds its base curve through buildBaseCurveNamed, and every refusal of that build is a named 422,
// never a 500. A market marked `curveDefault: 1` previews the kernel bootstrap; a marker value other
// than 1 is refused by name. The prefix names what actually applies, the marker for a bad
// marker (even on a market that also carries a block), curve default version 1 for a marked market, the
// platform default for an unmarked one. The prefixes and the refusal sentence are restated by hand.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curveNodesOf } from "@alm/engine";
import { bootstrapZeroCurve, type MarketSnapshot } from "@alm/kernel";
import { HttpError } from "../http/errors";
import { buildBaseCurveNamed } from "../workspaces/curveSetupSlot";
import { api, bootTestPlatform, loadTestMarket, type TestPlatform } from "./harness";

/** The surface prefix of a refused build on an unmarked market with no block, restated. */
const PREFIX = "The platform default curve on this market: ";
/** The surface prefix of a refused build on a market marked curveDefault: 1 with no block, restated. */
const V1_PREFIX = "Curve default version 1 (the kernel bootstrap) on this market: ";
/** The surface prefix of a marker value the engine refuses, restated. */
const MARKER_PREFIX = "The curveDefault marker on this market: ";
/** The engine's refusal of a marker value other than 1, restated. */
const MARKER_TWO =
  "The market's curveDefault is 2; the only value it takes is 1, which selects curve default version 1 (the kernel bootstrap). Remove the field to build on the platform default.";

let t: TestPlatform;
let market: MarketSnapshot;
beforeAll(async () => {
  t = await bootTestPlatform();
  market = await loadTestMarket();
  const store = t.platform.context.store;
  store.putDocument("market", "mk-marker-one", { ...market, curveDefault: 1 }, { label: "marked v1" });
  store.putDocument("market", "mk-marker-two", { ...market, curveDefault: 2 }, { label: "marker 2" });
  store.putDocument("market", "mk-no-quotes", { ...market, curveQuotes: "none" }, { label: "unreadable quotes" });
  store.putDocument("market", "mk-marked-no-quotes", { ...market, curveDefault: 1, curveQuotes: "none" }, { label: "marked, unreadable quotes" });
});
afterAll(() => t.close());

type Reply = { base: { t: number[]; z: number[]; df: number[] }; error: { code: string; message: string } };
const preview = (marketSnapshot: string) =>
  api<Reply>(t.base, "POST", "/api/scenarios/preview", { marketSnapshot, rateSpec: { kind: "parallel", shockBp: 100 } });

describe("buildBaseCurveNamed with no curveSetup block", () => {
  it("a marked market builds the kernel bootstrap", () => {
    const curve = buildBaseCurveNamed({ ...market, curveDefault: 1 } as MarketSnapshot);
    const kernel = bootstrapZeroCurve(market);
    expect(curve.t).toEqual(kernel.t);
    expect(curve.z).toEqual(kernel.z);
  });

  it("wraps every throw of the build as a 422 whose prefix names what applies", () => {
    const setup = {
      id: "cs-test", label: "test", baseCurve: "UST", interpolation: "log-linear-df", dayCount: "ACT/365", compounding: "semi-annual",
      inputs: [{ instrument: "ois-swap", tenorMonths: 12, quoteType: "par-rate", value: 0.04 }],
    };
    const cases: Array<[MarketSnapshot, string]> = [
      [{ ...market, curveDefault: 2 } as MarketSnapshot, MARKER_PREFIX],
      // A bad marker on a market that also carries a valid block is the marker's fault, not the setup's.
      [{ ...market, curveDefault: 2, curveSetup: setup } as MarketSnapshot, MARKER_PREFIX],
      [{ ...market, curveDefault: 1, curveQuotes: "none" } as unknown as MarketSnapshot, V1_PREFIX],
      [{ ...market, curveQuotes: "none" } as unknown as MarketSnapshot, PREFIX],
      [{ ...market, curveDefault: 1, curveSetup: { ...setup, inputs: [] } } as MarketSnapshot, "The curve setup on this market: "],
    ];
    for (const [m, prefix] of cases) {
      let caught: unknown;
      try {
        buildBaseCurveNamed(m);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(HttpError);
      const e = caught as HttpError;
      expect(e.status).toBe(422);
      expect(e.code).toBe("validation");
      expect(e.message.startsWith(prefix), e.message).toBe(true);
      expect(e.message.length).toBeGreaterThan(prefix.length);
    }
    let caught: unknown;
    try {
      buildBaseCurveNamed({ ...market, curveDefault: 2 } as MarketSnapshot);
    } catch (err) {
      caught = err;
    }
    expect((caught as HttpError).message).toBe(`${MARKER_PREFIX}${MARKER_TWO}`);
  });
});

describe("POST /api/scenarios/preview on a market with no curveSetup block", () => {
  it("a marked market previews the kernel bootstrap", async () => {
    const r = await preview("mk-marker-one");
    expect(r.status).toBe(200);
    expect(r.body.base).toEqual(curveNodesOf(bootstrapZeroCurve(market)));
  });

  it("a marker value other than 1 is a 422 with the marker prefix and the engine's sentence, not a 500", async () => {
    const r = await preview("mk-marker-two");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message).toBe(`${MARKER_PREFIX}${MARKER_TWO}`);
  });

  it("a marked market the kernel cannot read is a 422 with the version 1 prefix, not a 500", async () => {
    const r = await preview("mk-marked-no-quotes");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message.startsWith(V1_PREFIX)).toBe(true);
  });

  it("a market the default build cannot read is a 422 with the named prefix, not a 500", async () => {
    const r = await preview("mk-no-quotes");
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation");
    expect(r.body.error.message.startsWith(PREFIX)).toBe(true);
  });
});
