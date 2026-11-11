/**
 * One edge per value column (ALM Studio Polish 5 T2). In the Stack diff From and To columns and in each By kind set column every cell ends on the right
 * edge, under its right-aligned header: a figure as before (num), an absence word as before (num muted), and a text
 * leaf through a class that sets the edge and nothing else, so it keeps the mono face and the figure-face rule on
 * .num does not reach it. Studio tests have no layout engine, so this pins the markup and the rule; the drive
 * measures the edges at 1440 px. Markup and rule texts are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { byKindModel } from "../assumptions/byKindModel";
import { DiffTable } from "../pages/assumptions/AssumptionsViews";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");

describe("a text leaf in a value column", () => {
  it("ends on the right edge through a class that sets that and nothing else", () => {
    expect(CSS).toContain(".table td.right { text-align: right; }");
    expect(CSS.match(/\.right\b/g)).toEqual([".right"]);
    expect(APP_CSS).not.toMatch(/\.right\b/);
  });
  it("on the Stack diff: mono at the right edge beside a figure", () => {
    const html = renderToStaticMarkup(
      <DiffTable
        diff={{ kind: "ok", rows: [{ familyId: "mma", kind: "nmd-decay", selector: "whole family", path: "params.balanceSize", change: "changed", from: { kind: "text", text: "none" }, to: { kind: "figure", text: "1,000,000", exact: "1000000" } }] }}
        baseId="base"
        layersOn={1}
      />,
    );
    // A stored null on a changed row is a text leaf; an added row's From is an absence (Polish 5 Task 6 fix I1, diffFigures.test.tsx).
    expect(html).toContain('<td class="words">changed</td><td class="mono right">none</td><td class="num words" title="1000000">1,000,000</td></tr>');
  });
  it("on By kind: mono at the right edge beside a figure and an absence word", () => {
    const set = (id: string, params: unknown) =>
      ({ schemaVersion: "1.0.0", id, label: id, bindings: [{ familyId: "mma", overlay: { kind: "nmd-decay", params }, modelVersion: "kernel-nmd-decay-1" }] }) as unknown as AssumptionSet;
    const html = renderToStaticMarkup(
      <ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([set("a", { buckets: [{ label: "small", upper: 1000000 }] }), set("b", { buckets: [] })], ["nmd-decay"])} query={{}} />,
    );
    expect(html).toContain('<td class="mono">params.buckets[0].label</td><td class="mono right">small</td><td class="num muted words">Not stored</td></tr>');
    expect(html).toContain('<td class="mono">params.buckets[0].upper</td><td class="num words" title="1000000">1,000,000</td><td class="num muted words">Not stored</td></tr>');
  });
});
