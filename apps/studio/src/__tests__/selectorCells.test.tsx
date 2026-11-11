/**
 * Selector words print in the body font on the three tables that show a selector (ALM Studio Polish 3 T2): the Stack bindings table, the Stack diff
 * table and By kind. The cell is a words cell, so it keeps one line and the mono cells' 12 px size (Polish 3 T5
 * drive 4f). Family, kind, model version, source id, path, from and to stay mono: they are identifiers or
 * values. Rows and expected markup are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionSet } from "@alm/engine";
import { byKindModel } from "../assumptions/byKindModel";
import { BindingsTable, DiffTable } from "../pages/assumptions/AssumptionsViews";
import { ByKindView } from "../pages/assumptions/ByKindPage";

const CSS = readFileSync(new URL("../../design/components.css", import.meta.url), "utf8");

describe("a selector cell takes the body font, its neighbours stay mono", () => {
  it("the words cell keeps one line and the mono cells' size, in one rule with them (Polish 3 Task 5 drive 4f, Polish 4 T5)", () => {
    expect(CSS).toContain(".table td.mono, .table td.words { white-space: nowrap; font-size: var(--fs-1); }");
    expect(CSS).not.toContain(".table td.mono { white-space: nowrap; font-size: var(--fs-1); }");
  });
  it("on the Stack bindings table", () => {
    const html = renderToStaticMarkup(
      <BindingsTable rows={[{ familyId: "mma", kind: "nmd-decay", selector: "lcr-category: retail-other", modelVersion: "kernel-nmd-decay-1", sourceId: "demo-behavioral-v1-edit-5", fromLayer: false }]} />,
    );
    expect(html).toContain(
      '<th scope="row" class="mono">mma</th><td class="mono">nmd-decay</td><td class="words">lcr-category: retail-other</td><td class="mono">kernel-nmd-decay-1</td><td><span class="mono">demo-behavioral-v1-edit-5</span></td>',
    );
  });
  it("on the Stack diff table, where the path stays mono", () => {
    const html = renderToStaticMarkup(
      <DiffTable
        diff={{ kind: "ok", rows: [{ familyId: "mma", kind: "nmd-decay", selector: "lcr-category: retail-other", path: "params.buckets[0].label", change: "added", from: { kind: "absent", text: "Not stored" }, to: { kind: "text", text: "small" } }] }}
        baseId="demo-behavioral-v1"
        layersOn={1}
      />,
    );
    expect(html).toContain(
      '<th scope="row" class="mono">mma</th><td class="mono">nmd-decay</td><td class="words">lcr-category: retail-other</td><td class="mono">params.buckets[0].label</td><td class="words">added</td><td class="num muted words">Not stored</td><td class="mono right">small</td>',
    );
  });
  it("on By kind, where the path stays mono", () => {
    const set = {
      schemaVersion: "1.0.0", id: "demo-behavioral-v1-edit-5", label: "Edit 5",
      bindings: [{ familyId: "mma", overlay: { kind: "nmd-decay", params: { buckets: [{ label: "small" }] } }, modelVersion: "kernel-nmd-decay-1", selector: { "lcr-category": "retail-other" } }],
    } as unknown as AssumptionSet;
    const html = renderToStaticMarkup(<ByKindView ws="ws-a" kinds={["nmd-decay"]} model={byKindModel([set], ["nmd-decay"])} query={{}} />);
    expect(html).toContain('<tr><th scope="row" class="mono">mma</th><td class="words">lcr-category: retail-other</td><td class="mono">params.buckets[0].label</td><td class="mono right">small</td></tr>');
  });
});
