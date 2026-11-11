import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { coaRows, familyCell, leafNotionals, notionalCell } from "../balance/coaModel";
import { CoaView } from "../pages/balance/CoaPage";

const nodes = [
  { id: "liab", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 2 },
  { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 1 },
  { id: "coa-dda", label: "DDA", parentId: "liab", side: "liability", isLeaf: true, familyId: "dda", order: 1 },
  { id: "coa-loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: true, familyId: "loans", order: 2 },
  { id: "coa-cash", label: "Cash", parentId: "assets", side: "asset", isLeaf: true, familyId: "cash", order: 1 },
];

describe("coaRows", () => {
  it("walks the tree depth first in sibling order", () => {
    expect(coaRows(nodes).map((r) => [r.id, r.depth, r.familyId])).toEqual([
      ["assets", 0, null],
      ["coa-cash", 1, "cash"],
      ["coa-loans", 1, "loans"],
      ["liab", 0, null],
      ["coa-dda", 1, "dda"],
    ]);
  });
});

describe("leafNotionals", () => {
  it("keys served totals by leaf id, keeps a null total as null, drops the null-key remainder", () => {
    const m = leafNotionals([
      { key: "coa-loans", totalNotional: 2_000_000 },
      { key: "coa-cash", totalNotional: null },
      { key: null, totalNotional: 9_000_000 },
    ]);
    expect([...m.entries()]).toEqual([["coa-loans", 2_000_000], ["coa-cash", null]]);
    expect(m.has("coa-cash")).toBe(true);
  });
});

describe("notionalCell", () => {
  it("formats a served leaf notional in $MM", () => {
    expect(notionalCell(true, 12_345_678)).toEqual({ text: "$12.3M", muted: false });
  });
  it("prints Unobservable: notional null for a null served total, never a zero", () => {
    expect(notionalCell(true, null)).toEqual({ text: "Unobservable: notional null", muted: false });
  });
  it("prints Unobservable: no positions for a leaf the aggregate does not serve", () => {
    expect(notionalCell(true, undefined)).toEqual({ text: "Unobservable: no positions", muted: false });
  });
  it("prints a muted No roll-up served for a parent row, never blank", () => {
    expect(notionalCell(false, 5_000_000)).toEqual({ text: "No roll-up served", muted: true });
  });
});

describe("familyCell", () => {
  it("prints the family id on a leaf that has one", () => {
    expect(familyCell(true, "dda")).toEqual({ text: "dda", muted: false });
  });
  it("prints a muted No family on a leaf without one, never blank", () => {
    expect(familyCell(true, null)).toEqual({ text: "No family", muted: true });
  });
  it("prints a muted None: parent on a parent row, never blank: parents carry no family by design", () => {
    expect(familyCell(false, null)).toEqual({ text: "None: parent", muted: true });
  });
});

describe("CoaView", () => {
  const viewNodes = [...nodes, { id: "coa-other", label: "Other", parentId: "assets", side: "asset", isLeaf: true, order: 3 }];
  const html = renderToStaticMarkup(createElement(CoaView, {
    bookId: "book-a",
    rows: coaRows(viewNodes),
    notional: new Map<string, number | null>([["coa-cash", null], ["coa-loans", 2_000_000], ["coa-dda", 3_500_000]]),
  }));
  it("renders the null-total leaf's cell as Unobservable: notional null and never $0.0M", () => {
    expect(html).toContain('<td class="num">Unobservable: notional null</td>');
    expect(html).not.toContain("$0.0M");
  });
  it("renders an unserved leaf's cell as Unobservable: no positions", () => {
    expect(html).toContain('<td class="num">Unobservable: no positions</td>');
  });
  it("renders served leaves in $MM", () => {
    expect(html).toContain('<td class="num">$2.0M</td>');
    expect(html).toContain('<td class="num">$3.5M</td>');
  });
  it("renders parent notional cells as a muted No roll-up served, one per parent", () => {
    expect(html.split('<td class="num muted">No roll-up served</td>').length - 1).toBe(2);
  });
  it("opens each row on a row header that keeps the node's indent (Row header scope 2)", () => {
    expect(html).toContain('<tr><th scope="row" style="padding-left:calc(var(--sp-3) + 0 * var(--sp-5))">Assets <span class="mono muted">assets</span></th>');
    expect(html).toContain('<tr><th scope="row" style="padding-left:calc(var(--sp-3) + 1 * var(--sp-5))">Cash <span class="mono muted">coa-cash</span></th>');
    expect(html).not.toMatch(/<tr[^>]*><td/);
  });
  it("renders a muted No family on the leaf without a family", () => {
    expect(html).toContain('<td class="muted">No family</td>');
  });
});
