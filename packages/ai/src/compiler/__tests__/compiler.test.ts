import { describe, it, expect } from "vitest";
import {
  bindAssumptions,
  resolveAssumptions,
  AssumptionValidationError,
  UnknownFamilyError,
} from "@alm/engine/src/scenario";
import { IncompatibleOverlayError } from "@alm/engine/src/scenario/resolveAssumptions";
import { createAssumptionCompiler } from "../compiler";
import {
  BASE,
  BETA_BUMP,
  FAMILIES,
  brokenAuthor,
  fakeAuthor,
  familyRebindAuthor,
  inputFor,
  prepayRebindAuthor,
} from "./fixtures";

const compiler = createAssumptionCompiler(fakeAuthor);

describe("createAssumptionCompiler.compile", () => {
  it("returns a compiled set that passes bindAssumptions and carries a stable hash", () => {
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    expect(out.assumptionSet.contentHash).toBeDefined();
    // Re-binding reproduces the same hash: the compiler bound it correctly.
    const rebound = bindAssumptions(out.assumptionSet);
    expect(rebound.contentHash).toBe(out.assumptionSet.contentHash);
  });

  it("diffs exactly the touched beta params with correct from/to", () => {
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    const beta = BASE.bindings.find(
      (b) => b.familyId === "MMA" && b.overlay.kind === "deposit-beta",
    );
    if (!beta || beta.overlay.kind !== "deposit-beta") throw new Error("no base beta");

    expect(out.diff.baseId).toBe("base");
    expect(out.diff.deltas).toEqual([
      {
        familyId: "MMA",
        overlayKind: "deposit-beta",
        path: "params.betaMax",
        from: beta.overlay.params.betaMax,
        to: beta.overlay.params.betaMax + BETA_BUMP,
      },
      {
        familyId: "MMA",
        overlayKind: "deposit-beta",
        path: "params.betaMin",
        from: beta.overlay.params.betaMin,
        to: beta.overlay.params.betaMin + BETA_BUMP,
      },
    ]);
  });

  it("leaves every binding the instruction did not touch byte-identical to base", () => {
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    for (let i = 0; i < BASE.bindings.length; i++) {
      const baseB = BASE.bindings[i];
      const candB = out.assumptionSet.bindings[i];
      const isTarget = baseB.familyId === "MMA" && baseB.overlay.kind === "deposit-beta";
      if (!isTarget) {
        expect(JSON.stringify(candB)).toBe(JSON.stringify(baseB));
      }
    }
  });

  it("compiles a prepayment instruction to halved CPR asymptotes", () => {
    const out = compiler.compile(inputFor("prepayments at half speed"));
    expect(out.diff.deltas.map((d) => `${d.familyId}:${d.path}`)).toEqual([
      "Mortgages:params.maxCpr",
      "Mortgages:params.minCpr",
    ]);
  });

  it("compiles a compound instruction touching two families", () => {
    const out = compiler.compile(
      inputFor("MMA betas 15 points higher and prepayments at half speed"),
    );
    const families = new Set(out.diff.deltas.map((d) => d.familyId));
    expect(families).toEqual(new Set(["MMA", "Mortgages"]));
  });

  it("writes a rationale that echoes the instruction and every diff line, computing no number", () => {
    const instruction = "MMA betas 15 points higher";
    const out = compiler.compile(inputFor(instruction));
    expect(out.rationale).toContain(instruction);
    for (const d of out.diff.deltas) {
      expect(out.rationale).toContain(d.path);
      expect(out.rationale).toContain(String(d.to));
    }
  });

  it("rejects a structurally invalid candidate rather than emitting a plausible set", () => {
    const bad = createAssumptionCompiler(brokenAuthor);
    expect(() => bad.compile(inputFor("MMA betas 15 points higher"))).toThrow(
      AssumptionValidationError,
    );
  });

  it("is deterministic: identical input yields identical output", () => {
    const a = compiler.compile(inputFor("MMA betas 15 points higher"));
    const b = compiler.compile(inputFor("MMA betas 15 points higher"));
    expect(a).toEqual(b);
  });
});

describe("createAssumptionCompiler.compile family gate", () => {
  it("rejects a binding that targets a family absent from the catalogue", () => {
    const bad = createAssumptionCompiler(familyRebindAuthor("ZZZ-UNKNOWN"));
    expect(() => bad.compile(inputFor("beta edit"))).toThrow(UnknownFamilyError);
  });

  it("names the bad family and the known catalogue in the error", () => {
    const bad = createAssumptionCompiler(familyRebindAuthor("MMB"));
    let message = "";
    try {
      bad.compile(inputFor("beta edit"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("MMB");
    for (const f of FAMILIES) expect(message).toContain(f.id);
  });

  it("matches families by exact case: a wrong-case family is rejected", () => {
    const bad = createAssumptionCompiler(familyRebindAuthor("mma"));
    expect(() => bad.compile(inputFor("beta edit"))).toThrow(UnknownFamilyError);
  });

  it("compiles a candidate whose bindings all target known families", () => {
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    expect(out.assumptionSet.contentHash).toBeDefined();
    expect(out.diff.deltas.length).toBeGreaterThan(0);
  });

  it("agrees with resolveAssumptions: a rejected candidate also fails at run time", () => {
    const author = familyRebindAuthor("MMB");
    const bad = createAssumptionCompiler(author);
    expect(() => bad.compile(inputFor("beta edit"))).toThrow(UnknownFamilyError);
    // The same candidate, bound and resolved as at run time, fails identically.
    const candidate = bindAssumptions(author(inputFor("beta edit")));
    expect(() => resolveAssumptions(candidate, FAMILIES)).toThrow(UnknownFamilyError);
  });

  it("agrees with resolveAssumptions: an accepted candidate raises no family error at run time", () => {
    // Isolate the family gate: resolveAssumptions may still reject on an unrelated
    // param domain, but a candidate the compiler accepts must never trip the
    // run-time UnknownFamilyError. That is the compile/run agreement being tested.
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    let err: unknown;
    try {
      resolveAssumptions(out.assumptionSet, FAMILIES);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(UnknownFamilyError);
  });
});

describe("createAssumptionCompiler.compile overlay-instrument compatibility gate (D5 mirror)", () => {
  it("rejects a deposit-beta overlay rebound to a fixed-loan family", () => {
    // familyRebindAuthor moves the MMA deposit-beta binding onto "CDs", a KNOWN
    // family whose instrument type is fixed-loan: it survives the family gate
    // and must die on the compatibility gate, at compile time.
    const bad = createAssumptionCompiler(familyRebindAuthor("CDs"));
    expect(() => bad.compile(inputFor("beta edit"))).toThrow(IncompatibleOverlayError);
  });

  it("names the family, the overlay kind, and the instrument type in the error", () => {
    const bad = createAssumptionCompiler(familyRebindAuthor("CDs"));
    let message = "";
    try {
      bad.compile(inputFor("beta edit"));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("CDs");
    expect(message).toContain("deposit-beta");
    expect(message).toContain("fixed-loan");
  });

  it("rejects a prepay overlay rebound to a fixed-loan family", () => {
    const author = prepayRebindAuthor("CDs");
    const bad = createAssumptionCompiler(author);
    try {
      bad.compile(inputFor("prepay edit"));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(IncompatibleOverlayError);
      const err = e as IncompatibleOverlayError;
      expect(err.familyId).toBe("CDs");
      expect(err.overlayKind).toBe("prepay");
      expect(err.instrumentType).toBe("fixed-loan");
    }
  });

  it("agrees with resolveAssumptions: a rejected candidate also fails at run time", () => {
    const author = familyRebindAuthor("CDs");
    const bad = createAssumptionCompiler(author);
    expect(() => bad.compile(inputFor("beta edit"))).toThrow(IncompatibleOverlayError);
    // The same candidate, bound and resolved as at run time, fails identically:
    // both gates call the one shared checkOverlayCompatibility over the one
    // shared table, so they cannot drift.
    const candidate = bindAssumptions(author(inputFor("beta edit")));
    expect(() => resolveAssumptions(candidate, FAMILIES)).toThrow(IncompatibleOverlayError);
  });

  it("agrees with resolveAssumptions: an accepted candidate raises no compatibility error at run time", () => {
    const out = compiler.compile(inputFor("MMA betas 15 points higher"));
    let err: unknown;
    try {
      resolveAssumptions(out.assumptionSet, FAMILIES);
    } catch (e) {
      err = e;
    }
    expect(err).not.toBeInstanceOf(IncompatibleOverlayError);
  });
});
