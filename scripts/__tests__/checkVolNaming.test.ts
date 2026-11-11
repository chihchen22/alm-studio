/**
 * The volatility naming sweep: what it reads, what it joins, and its allowlist.
 * Sources below are inline fixtures; expected hits are restated by hand.
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no type declarations
import { isAllowlisted, scanJson, scanSource } from "../check-vol-naming.mjs";

type Hit = { line: number | string; match: string; text: string; enclosingClass: string | null };
const scan = (src: string, file = "x.ts"): Hit[] => scanSource(src, file) as Hit[];

describe("scanSource", () => {
  it("finds a phrase split across adjacent string literals joined by +", () => {
    const hits = scan('const m =\n  "the snapshot carries no ATM cap " +\n  "quotes; supply one";\n');
    expect(hits.map((h) => [h.line, h.match])).toEqual([[2, "cap quote"]]);
  });

  it("finds a phrase across a template line continuation", () => {
    expect(scan("const m = `the cap \\\nvol surface`;\n").map((h) => h.match)).toEqual(["cap vol"]);
  });

  it("matches case-insensitively and across whitespace runs, on every pattern arm", () => {
    const src = [
      'a("Cap  Normal Vol");',
      'b("a cap surface");',
      'c("Swaption quotes");',
      'd("swaption normal vols");',
      'e("the swaption grid");',
      'f("swaption ATM");',
    ].join("\n");
    expect(scan(src).map((h) => h.match.toLowerCase())).toEqual([
      "cap normal vol",
      "cap surface",
      "swaption quote",
      "swaption normal",
      "swaption grid",
      "swaption atm",
    ]);
  });

  it("does not read comments, identifiers or keys", () => {
    const src = [
      "// the ATM cap quotes of the snapshot",
      "/* swaption grid */",
      "const capVolSurface = snapshot.capQuotes;",
      'const o = { "cap quote": 1, swaptionATMQuotes: 2 };',
      'const v = o["cap quote"];',
      'const k = { kind: "cap" };',
      'import x from "./cap quote";',
    ].join("\n");
    expect(scan(src)).toEqual([]);
  });

  it("cuts the -- comments of an SQL statement string, and only of one", () => {
    const sql = "const DDL = `\nCREATE TABLE IF NOT EXISTS t (k TEXT);\n-- Market time series: cap vols, swaption vols\nCREATE TABLE IF NOT EXISTS cap_vol_points (x REAL);\n`;\n";
    expect(scan(sql)).toEqual([]);
    expect(scan('const m = "a -- note on the cap vols";').map((h) => h.match)).toEqual(["cap vol"]);
  });

  it("reads JSX text and JSX attribute strings in a .tsx file", () => {
    const src = 'export const A = () => <p title="Swaption grid">The ATM cap\n  vols, it\'s plain text</p>;\n';
    expect(scan(src, "A.tsx").map((h) => h.match)).toEqual(["Swaption grid", "cap vol"]);
  });

  it("joins JSX text across a string-literal expression child", () => {
    const src = 'export const A = () => <p>the ATM cap{" "}quotes and the swaption{` `}grid</p>;\n';
    expect(scan(src, "A.tsx").map((h) => h.match)).toEqual(["cap quote"]);
    expect(scan('export const B = () => <p>the swaption{" "}grid</p>;\n', "B.tsx").map((h) => h.match)).toEqual([
      "swaption grid",
    ]);
  });

  it("joins JSX text across a non-literal expression child and a JSX comment", () => {
    expect(scan("export const A = () => <p>the cap {n} quotes</p>;\n", "A.tsx").map((h) => h.match)).toEqual([
      "cap quote",
    ]);
    expect(scan("export const A = () => <p>cap{/* note */}\n  vols</p>;\n", "A.tsx").map((h) => h.match)).toEqual([
      "cap vol",
    ]);
    // A literal inside a non-literal expression child is still read on its own.
    expect(scan('export const A = () => <p>{ok ? "swaption quotes" : x}</p>;\n', "A.tsx").map((h) => h.match)).toEqual([
      "swaption quote",
    ]);
  });

  it("decodes the non-breaking space entities in JSX text and JSX attribute strings", () => {
    expect(scan("export const A = () => <p>cap&nbsp;vols</p>;\n", "A.tsx").map((h) => h.match)).toEqual(["cap vol"]);
    expect(scan("export const A = () => <p>cap&#160;vols</p>;\n", "A.tsx").map((h) => h.match)).toEqual(["cap vol"]);
    expect(scan("export const A = () => <p>Swaption&#xA0;grid</p>;\n", "A.tsx").map((h) => h.match)).toEqual([
      "Swaption grid",
    ]);
    expect(scan('export const A = () => <p title="cap&nbsp;quotes">x</p>;\n', "A.tsx").map((h) => h.match)).toEqual([
      "cap quote",
    ]);
  });

  it("an element child breaks the JSX text run, and words of record across an expression read clean", () => {
    expect(scan("export const A = () => <p>cap <b>x</b> vols</p>;\n", "A.tsx")).toEqual([]);
    expect(
      scan("export const A = () => <p>the short-rate {kind} volatility surface, at-the-money&nbsp;column</p>;\n", "A.tsx"),
    ).toEqual([]);
  });

  it("names the enclosing class, which the allowlist reads", () => {
    const src = 'export class StochasticCapVolsError extends Error {\n  constructor() {\n    super("no ATM cap " + "quotes; " + `x`);\n  }\n}\n';
    const hits = scan(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.enclosingClass).toBe("StochasticCapVolsError");
    expect(isAllowlisted("packages/engine/src/scenario/stochasticEnvironment.ts", hits[0])).toBe(true);
    expect(isAllowlisted("packages/engine/src/scenario/other.ts", hits[0])).toBe(false);
  });

  it("reads words of record as clean", () => {
    expect(
      scan('const m = "the at-the-money column of the short-rate volatility surface, and the long-yield volatility surface";'),
    ).toEqual([]);
  });
});

describe("scanJson", () => {
  it("reads string values, never keys", () => {
    const hits = scanJson(JSON.stringify({ "cap quote": "fine", plugins: [{ description: "reads the swaption grid" }] })) as Hit[];
    expect(hits.map((h) => [h.line, h.match])).toEqual([["$.plugins[0].description", "swaption grid"]]);
  });
});
