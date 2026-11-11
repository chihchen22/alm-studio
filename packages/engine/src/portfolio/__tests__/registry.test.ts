import { describe, it, expect, beforeEach } from "vitest";
import { loadPortfolio, getPortfolio, hasPortfolio, clearPortfolios } from "../registry";
import { fixedPosition, makePortfolio, AS_OF } from "./fixtures";

describe("portfolio registry", () => {
  beforeEach(() => clearPortfolios());

  it("registers a portfolio and returns a handle counting its positions", () => {
    const pf = makePortfolio([fixedPosition("a"), fixedPosition("b")], "PF1");
    const handle = loadPortfolio(pf);
    expect(handle).toEqual({ id: "PF1", positionCount: 2, asOf: AS_OF });
    expect(hasPortfolio("PF1")).toBe(true);
    expect(getPortfolio("PF1")).toBe(pf);
  });

  it("overwrites a prior portfolio registered under the same id", () => {
    loadPortfolio(makePortfolio([fixedPosition("a")], "PF1"));
    const handle = loadPortfolio(makePortfolio([fixedPosition("a"), fixedPosition("b"), fixedPosition("c")], "PF1"));
    expect(handle.positionCount).toBe(3);
    expect(getPortfolio("PF1").positions).toHaveLength(3);
  });

  it("throws on an unknown id rather than returning a plausible empty book", () => {
    expect(() => getPortfolio("nope")).toThrow(/no portfolio/i);
    expect(hasPortfolio("nope")).toBe(false);
  });
});
