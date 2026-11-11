/**
 * Stack diff numbers read as numbers (ALM Studio Polish 4 T4). A From or To leaf that is a JSON number is
 * a figure: its integer part is grouped in threes when its size is 1000 or more, an exponent form prints as String()
 * does, and the cell is right-aligned in the theme's figure face with the exact stored text as its title. A string,
 * boolean or null leaf prints as before, in mono. All seven cells of a diff row are 12 px. The From and To headers
 * are right-aligned over their figures (Task 5 fix I2). A side whose binding stores no leaf at the delta's path (the
 * base on an added row, the candidate on a removed row, a side of a changed row the other side lengthens or
 * shortens) is an absence, not a stored null: it prints Not stored, By kind's word for the same fact, in By kind's
 * absence cell, the body face and the muted ink (Polish 5 Task 6 fix I1, Polish 6 T1). A stored null stays the mono
 * text leaf none. Expected texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionDiff, AssumptionSet } from "@alm/engine";
import { deltaRows } from "../assumptions/stackModel";
import { groupedText, NOT_STORED } from "../format/leaf";
import { DiffTable } from "../pages/assumptions/AssumptionsViews";

const LEAF = readFileSync(new URL("../format/leaf.ts", import.meta.url), "utf8");
const BY_KIND = readFileSync(new URL("../assumptions/byKindModel.ts", import.meta.url), "utf8");
const STACK = readFileSync(new URL("../assumptions/stackModel.ts", import.meta.url), "utf8");

describe("groupedText", () => {
  it("groups the integer part of a number of size 1000 or more, every digit kept", () => {
    expect(groupedText(10000000)).toBe("10,000,000");
    expect(groupedText(1000000)).toBe("1,000,000");
    expect(groupedText(1000)).toBe("1,000");
    expect(groupedText(-2500000.5)).toBe("-2,500,000.5");
    expect(groupedText(1234.5678)).toBe("1,234.5678");
  });
  it("prints a number below 1000 in size, or in exponent form, as String() does", () => {
    expect(groupedText(999)).toBe("999");
    expect(groupedText(-999.99)).toBe("-999.99");
    expect(groupedText(0.25)).toBe("0.25");
    expect(groupedText(0)).toBe("0");
    expect(groupedText(1e21)).toBe("1e+21");
    expect(groupedText(-2.5e22)).toBe("-2.5e+22");
    expect(groupedText(5e-7)).toBe("5e-7");
  });
});

describe("the Stack diff row", () => {
  // Each side stores every leaf its deltas name: a side's presence is read from its binding (Polish 6 T1).
  const set = (id: string, upper: number | null, label: string, open: boolean | null) =>
    ({
      schemaVersion: "1.0.0", id, label: id,
      bindings: [{ familyId: "dda", overlay: { kind: "nmd-decay", params: { buckets: [{ label, upper, open }] } }, modelVersion: "kernel-nmd-decay-1" }],
    }) as unknown as AssumptionSet;
  it("makes a number leaf a figure and any other leaf text", () => {
    const diff: AssumptionDiff = {
      baseId: "base",
      deltas: [
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.0.upper", from: 10000000, to: 1000000 },
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.0.label", from: "small", to: "large" },
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.0.open", from: null, to: true },
      ],
    };
    expect(deltaRows(diff, set("base", 10000000, "small", null), set("cand", 1000000, "large", true)).map((r) => [r.from, r.to])).toEqual([
      [{ kind: "figure", text: "10,000,000", exact: "10000000" }, { kind: "figure", text: "1,000,000", exact: "1000000" }],
      [{ kind: "text", text: "small" }, { kind: "text", text: "large" }],
      [{ kind: "text", text: "none" }, { kind: "text", text: "true" }],
    ]);
  });
  it("prints a figure right-aligned with its exact text as the title, text in mono, the change as a 12 px words cell", () => {
    const html = renderToStaticMarkup(
      <DiffTable
        diff={{
          kind: "ok",
          rows: [
            { familyId: "dda", kind: "nmd-decay", selector: "whole family", path: "params.buckets[0].upper", change: "changed", from: { kind: "figure", text: "10,000,000", exact: "10000000" }, to: { kind: "figure", text: "0.5", exact: "0.5" } },
            { familyId: "dda", kind: "nmd-decay", selector: "whole family", path: "params.buckets[0].label", change: "added", from: { kind: "absent", text: "Not stored" }, to: { kind: "text", text: "small" } },
          ],
        }}
        baseId="base"
        layersOn={1}
      />,
    );
    expect(html).toContain(
      '<td class="mono">params.buckets[0].upper</td><td class="words">changed</td><td class="num words" title="10000000">10,000,000</td><td class="num words" title="0.5">0.5</td></tr>',
    );
    expect(html).toContain('<td class="mono">params.buckets[0].label</td><td class="words">added</td><td class="num muted words">Not stored</td><td class="mono right">small</td></tr>');
  });
  it("prints a side the binding does not hold as the muted absence Not stored, and a stored null as a mono text leaf (Polish 5 Task 6 fix I1, Polish 6 T1)", () => {
    const bind = (familyId: string, v: number | null) => ({ familyId, overlay: { kind: "nmd-decay", params: { v } }, modelVersion: "kernel-nmd-decay-1" });
    const base = { schemaVersion: "1.0.0", id: "base", label: "base", bindings: [bind("dda", null), bind("mma", 2)] } as unknown as AssumptionSet;
    const cand = { schemaVersion: "1.0.0", id: "cand", label: "cand", bindings: [bind("dda", 1500), bind("sav", 3)] } as unknown as AssumptionSet;
    const diff: AssumptionDiff = {
      baseId: "base",
      deltas: [
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.v", from: null, to: 1500 },
        { familyId: "sav", overlayKind: "nmd-decay", path: "params.v", from: null, to: 3 },
        { familyId: "mma", overlayKind: "nmd-decay", path: "params.v", from: 2, to: null },
      ],
    };
    const rows = deltaRows(diff, base, cand);
    expect(rows.map((r) => [r.change, r.from, r.to])).toEqual([
      ["changed", { kind: "text", text: "none" }, { kind: "figure", text: "1,500", exact: "1500" }],
      ["added", { kind: "absent", text: "Not stored" }, { kind: "figure", text: "3", exact: "3" }],
      ["removed", { kind: "figure", text: "2", exact: "2" }, { kind: "absent", text: "Not stored" }],
    ]);
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows }} baseId="base" layersOn={1} />);
    expect(html).toContain('<th scope="row" class="mono">dda</th><td class="mono">nmd-decay</td><td class="words">whole family</td><td class="mono">params.v</td><td class="words">changed</td><td class="mono right">none</td><td class="num words" title="1500">1,500</td></tr>');
    expect(html).toContain('<th scope="row" class="mono">sav</th><td class="mono">nmd-decay</td><td class="words">whole family</td><td class="mono">params.v</td><td class="words">added</td><td class="num muted words">Not stored</td><td class="num words" title="3">3</td></tr>');
    expect(html).toContain('<th scope="row" class="mono">mma</th><td class="mono">nmd-decay</td><td class="words">whole family</td><td class="mono">params.v</td><td class="words">removed</td><td class="num words" title="2">2</td><td class="num muted words">Not stored</td></tr>');
  });
  it("prints Not stored for a leaf the base binding does not store when the candidate lengthens its bucket list; a stored null stays none (Polish 6 T1)", () => {
    const bind = (buckets: Array<{ label: string; upper: number | null }>) => ({ familyId: "dda", overlay: { kind: "nmd-decay", params: { buckets } }, modelVersion: "kernel-nmd-decay-1" });
    const base = { schemaVersion: "1.0.0", id: "base", label: "base", bindings: [bind([{ label: "small", upper: 1000000 }])] } as unknown as AssumptionSet;
    const cand = { schemaVersion: "1.0.0", id: "cand", label: "cand", bindings: [bind([{ label: "small", upper: 1000000 }, { label: "large", upper: null }])] } as unknown as AssumptionSet;
    // What the engine's diffBinding returns for this pair (packages/ai/src/compiler/diff.ts): both sides hold the
    // binding, so the change is changed, and a path only the candidate stores has from null.
    const diff: AssumptionDiff = {
      baseId: "base",
      deltas: [
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.1.label", from: null, to: "large" },
        { familyId: "dda", overlayKind: "nmd-decay", path: "params.buckets.1.upper", from: null, to: null },
      ],
    };
    const rows = deltaRows(diff, base, cand);
    expect(rows.map((r) => [r.path, r.change, r.from, r.to])).toEqual([
      ["params.buckets[1].label", "changed", { kind: "absent", text: "Not stored" }, { kind: "text", text: "large" }],
      ["params.buckets[1].upper", "changed", { kind: "absent", text: "Not stored" }, { kind: "text", text: "none" }],
    ]);
    const html = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows }} baseId="base" layersOn={1} />);
    expect(html).toContain('<td class="mono">params.buckets[1].upper</td><td class="words">changed</td><td class="num muted words">Not stored</td><td class="mono right">none</td></tr>');
  });
  it("says Not stored through one constant in format/leaf.ts, which By kind and the Stack diff both import (Polish 6 T1)", () => {
    expect(NOT_STORED).toBe("Not stored");
    expect(LEAF).toContain('export const NOT_STORED = "Not stored";');
    expect(BY_KIND).not.toContain('"Not stored"');
    expect(BY_KIND).toMatch(/import \{[^}]*\bNOT_STORED\b[^}]*\} from "\.\.\/format\/leaf";/);
    expect(STACK).toMatch(/import \{[^}]*\bNOT_STORED\b[^}]*\} from "\.\.\/format\/leaf";/);
    expect(STACK).not.toContain("NOT_HELD");
  });
  it("right-aligns the From and To headers over their figures; the other headers stay as they were (Task 5 fix I2)", () => {
    const html = renderToStaticMarkup(
      <DiffTable
        diff={{ kind: "ok", rows: [{ familyId: "dda", kind: "nmd-decay", selector: "whole family", path: "params.x", change: "changed", from: { kind: "figure", text: "2", exact: "2" }, to: { kind: "figure", text: "5", exact: "5" } }] }}
        baseId="base"
        layersOn={1}
      />,
    );
    expect(html).toContain('<thead><tr><th scope="col">Family</th><th scope="col">Kind</th><th scope="col">Selector</th><th scope="col">Path</th><th scope="col">Change</th><th scope="col" class="num">From</th><th scope="col" class="num">To</th></tr></thead>');
  });
});
