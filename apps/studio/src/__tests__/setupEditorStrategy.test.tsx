// apps/studio/src/__tests__/setupEditorStrategy.test.tsx
// The Strategy half: the node-target row of Balance Sheet > Strategy and targets (contract 25).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BalancePlan } from "@alm/engine";
import { TargetsView } from "../pages/balance/TargetsPage";
import { coaRows, type CoaNodeLike } from "../balance/coaModel";
import { checkNodeRows, checkRows, emptyNodeRow, familyRows, nodeRowsOf, toBalancePlan, type NodeTargetRow } from "../balance/targetsModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

/** A small chart: two asset leaves under Loans, one liability leaf. */
const COA: CoaNodeLike[] = [
  { id: "assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
  { id: "loans", label: "Loans", parentId: "assets", side: "asset", isLeaf: false, order: 0 },
  { id: "loans-fixed", label: "Fixed-rate loans", parentId: "loans", side: "asset", isLeaf: true, familyId: "fixed-loans", order: 0 },
  { id: "loans-float", label: "Floating-rate loans", parentId: "loans", side: "asset", isLeaf: true, familyId: "floating-loans", order: 1 },
  { id: "liabs", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
  { id: "dep-retail", label: "Retail deposits", parentId: "liabs", side: "liability", isLeaf: true, familyId: "dda", order: 0 },
];

const base = {
  bookId: "vanilla-book-v1",
  asOf: "2026-03-31",
  plans: [{ id: "bp-a", contentHash: "h", label: "A", asOf: "2026-03-31" }],
  selected: null as string | null,
  rows: familyRows([{ key: "fixed-loans", totalNotional: 650_000_000 }, { key: "floating-loans", totalNotional: 200_000_000 }, { key: "dda", totalNotional: 900_000_000 }], null),
  label: "",
  saveId: "bp-vanilla-book-v1-edit-1",
  problems: [] as string[],
  saveMsg: null as string | null,
  busy: null as string | null,
  loadError: null as string | null,
  onPick() {}, onRow() {}, onLabel() {}, onSave() {},
};

const node = (patch: Partial<NodeTargetRow> = {}): NodeTargetRow => ({ ...emptyNodeRow(), coaNodeId: "loans", balance: "900000000", month: "24", spreadBp: "150", termMonths: "60", ...patch });

describe("Strategy and targets: the node-target row", () => {
  it("lists the chart nodes by label in a select, with path fields, pricing and the allocation across templates", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} coaNodes={coaRows(COA)} nodeRows={[node()]} onNodeRow={() => {}} onAddNode={() => {}} onRemoveNode={() => {}} />);
    const select = html.match(/<select[^>]*aria-label="COA node of node target 1"[\s\S]*?<\/select>/)![0];
    for (const label of ["Assets", "Loans", "Fixed-rate loans", "Floating-rate loans", "Liabilities", "Retail deposits"]) expect(select, label).toContain(label);
    expect(select).toContain('<option value="loans" selected="">');
    for (const field of ["Balance, USD, node target 1", "By month, node target 1", "Spread, bp, node target 1", "Term, months, node target 1"]) expect(html, field).toContain(`aria-label="${field}"`);
    const t = text(html);
    expect(t).toContain("Node targets");
    expect(t).toMatch(/Allocation across templates[^.]*60-month fixed bullet/);
    expect(t).toContain("Add a node target");
  });

  it("says in words that a node target allocates to the leaf families in the opening mix, and that several templates wait for a later release", () => {
    const t = text(renderToStaticMarkup(<TargetsView {...base} coaNodes={coaRows(COA)} nodeRows={[]} onNodeRow={() => {}} onAddNode={() => {}} onRemoveNode={() => {}} />));
    expect(t).toContain("pro rata on opening balance");
    expect(t).toMatch(/several templates[^.]*a later release/);
  });

  it("the saved plan body carries nodeTargets with the chosen coaNodeId, path and pricing, beside the family targets", () => {
    const rows = base.rows.map((r) => (r.familyId === "dda" ? { ...r, kind: "flat" as const, spreadBp: "0", termMonths: "12" } : r));
    const plan = toBalancePlan({ id: "bp-x", label: "X", asOf: "2026-03-31" }, rows, [node()]);
    expect(plan.nodeTargets).toEqual([{ coaNodeId: "loans", path: [{ month: 24, balance: 900_000_000 }], newBusinessPricing: { spreadOverIndexBp: 150, termMonths: 60 } }]);
    expect(plan.targets.map((t) => t.familyId)).toEqual(["dda"]);
  });

  it("a plan with no node row has no nodeTargets key, so its hash is the one it had", () => {
    const plan = toBalancePlan({ id: "bp-x", label: "X", asOf: "2026-03-31" }, base.rows.map((r) => ({ ...r, kind: "flat" as const, spreadBp: "0", termMonths: "12" })), []);
    expect(Object.keys(plan)).not.toContain("nodeTargets");
  });

  it("opens a stored plan's node targets as rows, a multi-knot path kept verbatim", () => {
    const stored = {
      schemaVersion: "1.0.0", id: "bp-n", label: "N", asOf: "2026-03-31", unlistedFamilies: "runoff", targets: [],
      nodeTargets: [
        { coaNodeId: "loans", path: [{ month: 12, balance: 800 }], newBusinessPricing: { spreadOverIndexBp: 100, termMonths: 36 } },
        { coaNodeId: "dep-retail", path: [{ month: 6, balance: 850 }, { month: 24, balance: 700 }], newBusinessPricing: { spreadOverIndexBp: 0, termMonths: 12 } },
      ],
    } as BalancePlan;
    const rows = nodeRowsOf(stored);
    expect(rows.map((r) => [r.coaNodeId, r.balance, r.month, r.spreadBp, r.termMonths])).toEqual([["loans", "800", "12", "100", "36"], ["dep-retail", "", "", "0", "12"]]);
    expect(rows[1]!.storedPath).toEqual([{ month: 6, balance: 850 }, { month: 24, balance: 700 }]);
    expect(toBalancePlan({ id: "bp-n", label: "N", asOf: "2026-03-31" }, base.rows, rows).nodeTargets).toEqual(stored.nodeTargets);
    expect(nodeRowsOf(null)).toEqual([]);
  });

  it("checks the node rows before a save: a node picked, once, a positive balance, a whole month, a number of basis points, a whole term", () => {
    const rows = base.rows;
    expect(checkNodeRows([node()], COA, rows)).toEqual([]);
    expect(checkNodeRows([node({ coaNodeId: "" })], COA, rows)).toEqual(["Node target 1: pick a chart of accounts node."]);
    expect(checkNodeRows([node(), node()], COA, rows)).toContain("Node target 2: loans already has a node target.");
    expect(checkNodeRows([node({ balance: "0" })], COA, rows)).toContain("Node target 1: the balance must be a number above zero.");
    expect(checkNodeRows([node({ month: "0" })], COA, rows)).toContain("Node target 1: the month must be a whole number of 1 or more.");
    expect(checkNodeRows([node({ spreadBp: "" })], COA, rows)).toContain("Node target 1: the spread must be a number of basis points.");
    expect(checkNodeRows([node({ termMonths: "1.5" })], COA, rows)).toContain("Node target 1: the term must be a whole number of months, 1 or more.");
  });

  it("refuses a node target over a family that also has a family target, the engine's own refusal said before the save", () => {
    const rows = base.rows.map((r) => (r.familyId === "fixed-loans" ? { ...r, kind: "flat" as const, spreadBp: "0", termMonths: "60" } : r));
    expect(checkNodeRows([node()], COA, rows)).toEqual(["Node target 1: Loans holds fixed-loans, which also has a family target; set it to Run off or drop the node target."]);
    // A node with no leaf family under it is the engine's other refusal.
    expect(checkNodeRows([node({ coaNodeId: "assets" }), node({ coaNodeId: "liabs" })], [...COA.filter((n) => n.id !== "dep-retail")], base.rows)).toContain("Node target 2: Liabilities holds no family, so there is nothing to allocate to.");
  });

  it("a node target alone is enough to save: every family may run off", () => {
    expect(checkRows(base.rows)).toEqual(["Every family runs off: set at least one target before saving."]);
    expect(checkRows(base.rows, true)).toEqual([]);
  });
});
