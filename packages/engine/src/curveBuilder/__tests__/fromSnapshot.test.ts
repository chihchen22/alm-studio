/**
 * defaultSetupFromSnapshot: the setup
 * the engine fills from a snapshot that carries no curveSetup. Par-rate rows,
 * CASH to cash and everything else to ois-swap, sub-month quotes dropped and
 * named, log-linear on discount factor, the convention from the snapshot. A
 * snapshot the default cannot represent is ok:false with a reason in words.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMarketSnapshot, type CurveQuote, type MarketSnapshot } from "@alm/kernel";
import { CURVE_DEFAULT_VERSION, type CurveDefaultStamp } from "../../contracts/curveSetup";
import { PLATFORM_DEFAULT_CURVE } from "../../contracts/derivedCurve";
import { buildCurveFromSetup } from "../buildCurve";
import { defaultSetupFromSnapshot } from "../fromSnapshot";
import { defaultSetupFromSnapshot as fromIndex } from "../index";

const load = (url: URL): MarketSnapshot => parseMarketSnapshot(JSON.parse(readFileSync(url, "utf8")));

const PUBLIC = load(new URL("../../../../kernel/public/market_public.json", import.meta.url));
const CONSTRUCTED = load(
  new URL("../../../../kernel/src/math/rates/__tests__/fixtures/market_constructed.json", import.meta.url),
);

const withQuotes = (snap: MarketSnapshot, curveQuotes: CurveQuote[]): MarketSnapshot => ({ ...snap, curveQuotes });
const quote = (term: string, tYears: number, rate: number, instrumentType: CurveQuote["instrumentType"] = "CMT_PAR"): CurveQuote => ({
  term,
  tYears,
  instrumentType,
  rate,
});

/** Month-exact semi-annual tenors that validate: months 1 to 11, then every 6 months from 12 to 360. */
const semiTenors = (): number[] => [...Array.from({ length: 11 }, (_, i) => i + 1), ...Array.from({ length: 59 }, (_, i) => 12 + 6 * i)];

const refusal = (r: ReturnType<typeof defaultSetupFromSnapshot>): string => {
  if (r.ok) throw new Error("expected ok:false");
  return r.reason;
};

describe("defaultSetupFromSnapshot on the public pack (semiannual_bond)", () => {
  const r = defaultSetupFromSnapshot(PUBLIC);

  it("fills a log-linear-df setup on the snapshot's convention, nothing dropped", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toEqual([]);
    expect(r.block.id).toBe(PLATFORM_DEFAULT_CURVE);
    expect(r.block.interpolation).toBe("log-linear-df");
    expect(r.block.dayCount).toBe("ACT/365");
    expect(r.block.compounding).toBe("semi-annual");
    expect(r.block.baseCurve).toBe("UST");
    expect(r.block.inputs.map((x) => x.tenorMonths)).toEqual([1, 3, 6, 12, 24, 36, 60, 84, 120, 240, 360]);
    expect(r.block.inputs.every((x) => x.quoteType === "par-rate" && x.instrument === "ois-swap")).toBe(true);
    expect(r.block.inputs.map((x) => x.value)).toEqual(PUBLIC.curveQuotes.map((q) => q.rate));
  });

  it("builds a curve whose first node is 1/12 on 360 month nodes, on semiannual_bond", () => {
    if (!r.ok) throw new Error("expected ok:true");
    const built = buildCurveFromSetup(r.block);
    expect(built.curve.t[0]).toBe(1 / 12);
    expect(built.curve.t).toHaveLength(360);
    expect(built.curve.convention).toBe("semiannual_bond");
  });

  it("is reachable from the curveBuilder index", () => {
    expect(fromIndex).toBe(defaultSetupFromSnapshot);
  });
});

describe("defaultSetupFromSnapshot on the constructed pack (annual_act360)", () => {
  const r = defaultSetupFromSnapshot(CONSTRUCTED);

  it("drops the 1D quote and names it", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.dropped).toEqual(["1D"]);
    // Literals, not read from the fixture, so the check does not confirm the fixture against itself.
    expect(r.block.inputs).toHaveLength(11);
    expect(r.block.inputs.map((x) => x.tenorMonths)).toEqual([1, 3, 6, 12, 24, 36, 48, 60, 120, 240, 360]);
    expect(r.block.inputs.map((x) => x.value)).toEqual([0.0375, 0.037, 0.0365, 0.036, 0.0355, 0.0355, 0.036, 0.0365, 0.039, 0.0415, 0.042]);
    for (const row of r.block.inputs) {
      expect(row.quoteType).toBe("par-rate");
      expect(row.instrument).toBe("ois-swap");
    }
    expect(r.block.dayCount).toBe("ACT/360");
    expect(r.block.compounding).toBe("annual");
    expect(r.block.baseCurve).toBe("SOFR");
    expect(r.block.interpolation).toBe("log-linear-df");
  });

  it("builds a curve whose first node is 1/12, on annual_act360", () => {
    if (!r.ok) throw new Error("expected ok:true");
    const built = buildCurveFromSetup(r.block);
    expect(built.curve.t[0]).toBe(1 / 12);
    expect(built.curve.convention).toBe("annual_act360");
  });

  it("maps a CASH quote to a cash row and every other quote to ois-swap", () => {
    const snap = withQuotes(CONSTRUCTED, [
      quote("3M", 0.25, 0.037, "CASH"),
      quote("6M", 0.5, 0.0365, "SWAP"),
      quote("1Y", 1, 0.036, "SWAP"),
    ]);
    const out = defaultSetupFromSnapshot(snap);
    if (!out.ok) throw new Error(out.reason);
    expect(out.block.inputs.map((x) => x.instrument)).toEqual(["cash", "ois-swap", "ois-swap"]);
  });

  it("snaps a quote within 1e-4 years of a whole month to that month", () => {
    const out = defaultSetupFromSnapshot(CONSTRUCTED);
    if (!out.ok) throw new Error(out.reason);
    // The 1M quote is stored as 0.083333 years.
    expect(CONSTRUCTED.curveQuotes[1].tYears).toBe(0.083333);
    expect(out.block.inputs[0].tenorMonths).toBe(1);
  });

  it("leaves the snapshot untouched", () => {
    const before = JSON.stringify(CONSTRUCTED);
    defaultSetupFromSnapshot(CONSTRUCTED);
    expect(JSON.stringify(CONSTRUCTED)).toBe(before);
  });
});

describe("defaultSetupFromSnapshot refusals (decision 70: the run falls back to v1)", () => {
  it("60 quotes is accepted", () => {
    const quotes = semiTenors().slice(0, 60).map((m) => quote(`${m}M`, m / 12, 0.04));
    const out = defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes));
    expect(out.ok).toBe(true);
  });

  it("60 usable quotes plus a 1D is accepted: the 1D does not count against the limit", () => {
    const quotes = [quote("1D", 1 / 360, 0.0375, "CASH"), ...semiTenors().slice(0, 60).map((m) => quote(`${m}M`, m / 12, 0.04))];
    const out = defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes));
    if (!out.ok) throw new Error(out.reason);
    expect(out.block.inputs).toHaveLength(60);
    expect(out.dropped).toEqual(["1D"]);
  });

  it("61 usable quotes is refused in words", () => {
    const quotes = semiTenors().slice(0, 61).map((m) => quote(`${m}M`, m / 12, 0.04));
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("the snapshot holds 61 curve quotes of one month or longer; the default curve takes at most 60");
  });

  it("61 usable quotes plus a 1D is still refused, counting the 61", () => {
    const quotes = [quote("1D", 1 / 360, 0.0375, "CASH"), ...semiTenors().slice(0, 61).map((m) => quote(`${m}M`, m / 12, 0.04))];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("the snapshot holds 61 curve quotes of one month or longer; the default curve takes at most 60");
  });

  it("a quote past 360 months is refused in words", () => {
    const quotes = [...PUBLIC.curveQuotes, quote("30Y1M", 361 / 12, 0.0488)];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("quote 30Y1M falls at 361 months; the default curve runs to 360 months");
  });

  it("a quote more than 1e-4 years off a whole month is refused in words", () => {
    const quotes = [...PUBLIC.curveQuotes.slice(0, 2), quote("4.5M", 0.375, 0.037, "BILL_BEY"), ...PUBLIC.curveQuotes.slice(2)];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("quote 4.5M at 0.375 years is not within 0.0001 years of a whole month");
  });

  it("a quote with no finite tenor is refused in words", () => {
    const quotes = [quote("XX", Number.NaN, 0.04), ...PUBLIC.curveQuotes];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("quote XX has no finite tenor in years");
  });

  it("two quotes on the same month are refused, named by their terms", () => {
    const quotes = [quote("1M", 1 / 12, 0.0374, "BILL_BEY"), quote("4W", 0.08334, 0.0375, "BILL_BEY"), ...PUBLIC.curveQuotes.slice(1)];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe("the default curve cannot take this snapshot: quote 4W repeats tenor 1 months");
  });

  it("a quote the setup validator refuses is named by its term, not a row number", () => {
    const quotes = PUBLIC.curveQuotes.map((q) => (q.term === "2Y" ? { ...q, rate: 3.79 } : q));
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe(
      "the default curve cannot take this snapshot: quote 2Y value 3.79 is above 1.0 in magnitude; a rate is a decimal, so 0.04 is 4 percent",
    );
  });

  it("a snapshot whose quotes are all under a month is refused in words", () => {
    const quotes = [quote("1D", 1 / 360, 0.0375, "CASH")];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(CONSTRUCTED, quotes)));
    expect(reason).toBe("the snapshot holds no curve quote of one month or longer (dropped: 1D)");
  });

  it("collects every quote refusal in one reason", () => {
    const quotes = [...PUBLIC.curveQuotes, quote("A", 0.375, 0.04), quote("B", 31, 0.04)];
    const reason = refusal(defaultSetupFromSnapshot(withQuotes(PUBLIC, quotes)));
    expect(reason).toBe(
      "quote A at 0.375 years is not within 0.0001 years of a whole month; quote B falls at 372 months; the default curve runs to 360 months",
    );
  });
});

describe("curve default contract", () => {
  it("the default version is 2 and both stamp kinds type-check", () => {
    expect(CURVE_DEFAULT_VERSION).toBe(2);
    const stamps: CurveDefaultStamp[] = [
      { kind: "default", version: 2 },
      { kind: "default", version: 1, reason: "the snapshot holds 61 curve quotes of one month or longer; the default curve takes at most 60" },
      { kind: "setup", id: "my-setup" },
    ];
    expect(stamps).toHaveLength(3);
  });
});
