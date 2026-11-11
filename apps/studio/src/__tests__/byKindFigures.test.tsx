/**
 * By kind prints a stored leaf the way the Stack diff does (ALM Studio Polish 5 T1). One leaf view, in format/leaf.ts, serves
 * both pages: a JSON number is a figure (grouped in threes from 1000 up, the stored text as its title), any other
 * leaf is text (null as "none"), and a set with no leaf at the path gets an absence word. Every set cell is 12 px on
 * one line, as the family, selector and path cells beside it are. Expected values and markup are restated here.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { leafView } from "../format/leaf";
import { byKindModel } from "../assumptions/byKindModel";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const decay = (id: string, familyId: string, params: unknown) =>
  ({ schemaVersion: "1.0.0", id, label: id, bindings: [{ familyId, overlay: { kind: "nmd-decay", params }, modelVersion: "kernel-nmd-decay-1" }] }) as unknown as AssumptionSet;
const A = decay("a", "mma", { balanceSize: 1000000, buckets: [{ label: "small", upper: null }] });
const B = decay("b", "mma", { balanceSize: 2500000.5 });
const C = decay("c", "sav", { balanceSize: 0.25 });

describe("the shared leaf view", () => {
  it("makes a number a figure and any other leaf text", () => {
    expect(leafView(1000000)).toEqual({ kind: "figure", text: "1,000,000", exact: "1000000" });
    expect(leafView(0.25)).toEqual({ kind: "figure", text: "0.25", exact: "0.25" });
    expect(leafView("small")).toEqual({ kind: "text", text: "small" });
    expect(leafView(true)).toEqual({ kind: "text", text: "true" });
    expect(leafView(null)).toEqual({ kind: "text", text: "none" });
  });
});

describe("a By kind cell", () => {
  it("is a figure, a text leaf or an absence word; a stored null is a leaf, not an absence", () => {
    const m = byKindModel([A, B, C], ["nmd-decay"]);
    expect(m.rows.filter((r) => r.familyId === "mma").map((r) => [r.path, ...r.cells])).toEqual([
      ["params.balanceSize", { kind: "figure", text: "1,000,000", exact: "1000000" }, { kind: "figure", text: "2,500,000.5", exact: "2500000.5" }, { kind: "absent", text: "Not bound" }],
      ["params.buckets[0].label", { kind: "text", text: "small" }, { kind: "absent", text: "Not stored" }, { kind: "absent", text: "Not bound" }],
      ["params.buckets[0].upper", { kind: "text", text: "none" }, { kind: "absent", text: "Not stored" }, { kind: "absent", text: "Not bound" }],
    ]);
  });
  it("prints a figure as the Stack diff does, a text leaf in mono and an absence muted, every one 12 px", () => {
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([A, B, C], ["nmd-decay"])} query={{}} />);
    expect(html).toContain(
      '<td class="mono">params.balanceSize</td><td class="num words" title="1000000">1,000,000</td><td class="num words" title="2500000.5">2,500,000.5</td><td class="num muted words">Not bound</td></tr>',
    );
    expect(html).toContain('<td class="mono">params.buckets[0].upper</td><td class="mono right">none</td><td class="num muted words">Not stored</td><td class="num muted words">Not bound</td></tr>');
  });
  it("says that a number is grouped and its title holds the stored text", () => {
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([A], ["nmd-decay"])} query={{}} />);
    expect(html).toContain("Values print as stored, by stored path; a number from 1,000 up is grouped in threes, with the stored text in its title.");
  });
});
