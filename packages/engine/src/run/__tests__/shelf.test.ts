/**
 * Spec Section 8.1. The shelf is a map with a three-part key and two refusals.
 * It holds artifacts, never numbers it computed, and it is the only mutable
 * state a walk carries.
 */
import { describe, expect, it } from "vitest";
import type { ArtifactScope } from "../../contracts/plan";
import { ArtifactConflictError, ArtifactMissingError } from "../executorErrors";
import { artifactKey, makeShelf } from "../shelf";

const RUN: ArtifactScope = { kind: "run" };
const S0: ArtifactScope = { kind: "scenario", scenarioId: "S0" };
const S100: ArtifactScope = { kind: "scenario", scenarioId: "S100" };
const AS0: ArtifactScope = { kind: "assumptionSet", assumptionSetId: "S0" };

describe("artifactKey", () => {
  it("separates the three parts so no two triples collide", () => {
    // Two honest producers of one type: the contractual pass and the balance
    // stage both produce Cashflow, one the static series and one the primary.
    expect(artifactKey("Cashflow", S0, "st-cashflow")).not.toBe(artifactKey("Cashflow", S0, "st-balance"));
    expect(artifactKey("Cashflow", S0, "st-cashflow")).not.toBe(artifactKey("Cashflow", S100, "st-cashflow"));
    // A scenario and an assumption set may share an id; the scope kind keeps them apart.
    expect(artifactKey("Position", S0, "st-x")).not.toBe(artifactKey("Position", AS0, "st-x"));
  });

  it("is stable for one triple", () => {
    expect(artifactKey("RatePath", S0, "st-term")).toBe(artifactKey("RatePath", S0, "st-term"));
  });
});

describe("the shelf", () => {
  it("puts and gets by the full triple", () => {
    const shelf = makeShelf();
    shelf.put("ZeroCurve", RUN, "st-curve", { nodes: 1 });
    expect(shelf.has("ZeroCurve", RUN, "st-curve")).toBe(true);
    expect(shelf.get<{ nodes: number }>("ZeroCurve", RUN, "st-curve").nodes).toBe(1);
  });

  it("keeps two producers of one type apart", () => {
    const shelf = makeShelf();
    shelf.put("Cashflow", S0, "st-cashflow", "static");
    shelf.put("Cashflow", S0, "st-balance", "primary");
    expect(shelf.get<string>("Cashflow", S0, "st-cashflow")).toBe("static");
    expect(shelf.get<string>("Cashflow", S0, "st-balance")).toBe("primary");
  });

  it("reports a miss as false rather than throwing", () => {
    expect(makeShelf().has("Cashflow", S0, "st-cashflow")).toBe(false);
  });

  it("throws ArtifactMissingError on a get with no entry, naming the triple", () => {
    const shelf = makeShelf();
    expect(() => shelf.get("Cashflow", S0, "st-cashflow")).toThrow(ArtifactMissingError);
    try {
      shelf.get("Cashflow", S0, "st-cashflow");
    } catch (err) {
      const e = err as ArtifactMissingError;
      expect(e.stageId).toBe("st-cashflow");
      expect(e.type).toBe("Cashflow");
      expect(e.role).toBe("producer");
      expect(e.message).toContain("scenario:S0");
    }
  });

  it("throws ArtifactConflictError on a second put of one key", () => {
    const shelf = makeShelf();
    shelf.put("Cashflow", S0, "st-cashflow", 1);
    // A different producer is a different key, so only the identical triple conflicts.
    expect(() => shelf.put("Cashflow", S0, "st-cashflow", 2)).toThrow(ArtifactConflictError);
    // The first value stands: a conflict refuses the write, it does not overwrite.
    expect(shelf.get<number>("Cashflow", S0, "st-cashflow")).toBe(1);
  });

  it("lists its entries in put order, without their values", () => {
    const shelf = makeShelf();
    shelf.put("ZeroCurve", RUN, "st-curve", "a");
    shelf.put("Cashflow", S0, "st-cashflow", "b");
    expect(shelf.entries().map((e) => `${e.type}@${e.producerStageId}`)).toEqual([
      "ZeroCurve@st-curve",
      "Cashflow@st-cashflow",
    ]);
    expect(Object.hasOwn(shelf.entries()[0]!, "value")).toBe(false);
  });

  it("stores undefined as a value that is present", () => {
    const shelf = makeShelf();
    shelf.put("FtpResult", RUN, "st-ftp", undefined);
    expect(shelf.has("FtpResult", RUN, "st-ftp")).toBe(true);
    expect(shelf.get("FtpResult", RUN, "st-ftp")).toBeUndefined();
  });
});
