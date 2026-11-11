// apps/studio/src/__tests__/resultsE7.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "@alm/engine";
import { signedMM, usd } from "@alm/reader";
import { NiiMonthlyView } from "../pages/results/NiiMonthlyCard";
import { derivedYield, detailCsv, familiesUnder, monthlyDetail, nodeIncome, NEXT_SENTENCE, type Coa } from "../pages/results/monthlyDetail";
import { FtpTab } from "../pages/results/FtpTab";
import { DynamicViewsNote, viewScenarioModes } from "../pages/results/ViewsDynamicNote";
import { DashboardView } from "../pages/dashboard/DashboardPage";
import { ResultMeta } from "../pages/results/GridAsOf";
import { ResultsLayerBody } from "../pages/results/ResultsPage";
import { DETAIL, RESULT, freshResult } from "./fixtures/results";

const FLAT = "Flat (simple top-up)";
const props = (result = RESULT, basisLabel: string | null = FLAT) => ({
  ws: "ws-a", runId: "run-fixture", detail: DETAIL, result, query: {}, scenarioLabel: (id: string) => id, basisLabel,
});

describe("FTP residual line", () => {
  it("prints the stored newBusinessNet12 with the sentence that names what it is", () => {
    const r = freshResult();
    const b = r.ftp!.nimBridge;
    b.newBusinessNet12 = b.niiNet12 - b.bridgeNet12;
    const html = renderToStaticMarkup(<FtpTab {...props(r)} />);
    expect(html).toContain("New business net 12m");
    expect(html).toContain(signedMM(b.newBusinessNet12));
    expect(html).toContain("the part of 12-month NII the FTP margins do not explain");
  });
  it("prints no residual line when the bridge stores none", () => {
    const html = renderToStaticMarkup(<FtpTab {...props()} />);
    expect(html).not.toContain("New business net");
    expect(html).not.toContain("the part of 12-month NII the FTP margins do not explain");
  });
  it("labels the NII net figure with the basis", () => {
    expect(renderToStaticMarkup(<FtpTab {...props()} />)).toContain("Basis: Flat (simple top-up)");
  });
});

describe("Views on dynamic scenarios", () => {
  const withViews = () => {
    const r = freshResult();
    (r.cashflows as { cells?: unknown[] }).cells = [];
    r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!.byCell = [];
    r.cashflows.byScenario.find((s) => s.scenarioId === "S100")!.byCell = [];
    return r;
  };
  it("splits the scenarios by whether they kept the cell grain", () => {
    expect(viewScenarioModes(withViews())).toEqual({ dynamic: ["S-100", "S200", "S-200"], static: ["S0", "S100"] });
  });
  it("is silent when no cell dictionary says views were declared", () => {
    expect(viewScenarioModes(freshResult())).toEqual({ dynamic: [], static: [] });
  });
  it("states the refusal on a dynamic scenario and names the static scenarios", () => {
    const html = renderToStaticMarkup(<DynamicViewsNote result={withViews()} scenarioId="S200" />);
    expect(html).toContain("On a dynamic scenario the pivot answers repricing, gapPrincipal and evePv and refuses balance, principal, interest and nii");
    expect(html).toContain("Static scenarios of this run: S0, S100");
  });
  it("says none are static when every scenario is dynamic", () => {
    const r = freshResult();
    (r.cashflows as { cells?: unknown[] }).cells = [];
    expect(renderToStaticMarkup(<DynamicViewsNote result={r} scenarioId="S0" />)).toContain("Static scenarios of this run: none, every scenario ran new business");
  });
});

describe("Dashboard tiles carry the window and the basis label", () => {
  const model = {
    cards: [{ key: "nii12", label: "NII, 12 months", value: "$20.0M", sub: "Lowest −$12.1M · -200bp", field: "nii.byScenario[scenarioId=S0].totalNet12", tone: null, absent: false }],
    rows: [{ scenarioId: "S0", label: "Base", eve: "$574.3M", deltaEve: "$0.0M", deltaTone: null, nii12: "$20.0M", nii24: "$36.8M", newBusiness: false }],
    newBusinessNote: null,
  };
  it("prints the label under the NII tile and above the by-scenario NII columns", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={{ state: "loading" }} basisLabel={FLAT} />);
    expect(html).toContain("12 months, Flat (simple top-up)");
    expect(html).toContain("NII 12M and 24M: Flat (simple top-up)");
  });
  it("is unchanged when no label is given", () => {
    const html = renderToStaticMarkup(<DashboardView runId="r1" model={model as never} limitUse={{ state: "loading" }} />);
    expect(html).not.toContain("Flat (simple top-up)");
  });
});

describe("the result meta line", () => {
  it("prints Grid as of, the clash badge and the basis label together", () => {
    const html = renderToStaticMarkup(<ResultMeta gridAsOf="2026-03-31" cutoff="2026-04-30" basisLabel={FLAT} />);
    expect(html).toContain("Grid as of 2026-03-31");
    expect(html).toContain("workspace cut-off 2026-04-30");
    expect(html).toContain("Basis: Flat (simple top-up)");
  });
  it("is printed under the run strip of every Results screen body that is framed", () => {
    const html = renderToStaticMarkup(
      <ResultsLayerBody ws="ws-a" tab="nii" runId="run-fixture" data={{ detail: DETAIL, result: RESULT, note: null }} query={{}} meta={{ cutoff: "2026-04-30", basisLabel: FLAT }} />,
    );
    expect(html).toContain("Grid as of 2026-03-31");
    expect(html).toContain("workspace cut-off 2026-04-30");
    expect(html).toContain("NII, 60 months, Flat (simple top-up)");
  });
  it("leaves a body without meta exactly as before", () => {
    const html = renderToStaticMarkup(
      <ResultsLayerBody ws="ws-a" tab="nii" runId="run-fixture" data={{ detail: DETAIL, result: RESULT, note: null }} query={{}} />,
    );
    expect(html).not.toContain("Grid as of");
  });
});

describe("the monthly detail on the NII card (slice three, decisions 124 to 126)", () => {
  const COA = {
    nodes: [
      { id: "coa-assets", label: "Assets", parentId: null, side: "asset", isLeaf: false, order: 0 },
      { id: "coa-cash", label: "Cash", parentId: "coa-assets", side: "asset", isLeaf: true, familyId: "cash", order: 0 },
      { id: "coa-investments", label: "Investments", parentId: "coa-assets", side: "asset", isLeaf: true, familyId: "investments", order: 1 },
      { id: "coa-liab-equity", label: "Liabilities", parentId: null, side: "liability", isLeaf: false, order: 1 },
      { id: "coa-dda", label: "DDA", parentId: "coa-liab-equity", side: "liability", isLeaf: true, familyId: "dda", order: 0 },
    ],
    families: [
      { id: "cash", label: "Cash", side: "asset", instrumentType: "fixed-loan", coaNodeId: "coa-cash" },
      { id: "investments", label: "Investments", side: "asset", instrumentType: "fixed-loan", coaNodeId: "coa-investments" },
      { id: "dda", label: "DDA", side: "liability", instrumentType: "nmd", coaNodeId: "coa-dda" },
    ],
  } as unknown as Coa;
  const S0 = (r: RunResult) => r.cashflows.byScenario.find((s) => s.scenarioId === "S0")!;
  const fam = (r: RunResult, id: string) => S0(r).byFamily.find((f) => f.familyId === id)!.series;
  const col = (d: { cols: { id: string }[] }, id: string) => d.cols.find((c) => c.id === id) as { values: (number | null)[]; note?: string } | undefined;
  const detail = (r: RunResult, pick: { kind: "family" | "node"; id: string }, coa: Coa | null = COA) =>
    monthlyDetail({ result: r, scenarioId: "S0", label: "Base", pick, coa });
  const withOriginations = () => {
    const r = freshResult();
    const n = r.cashflows.grid.horizonMonths;
    r.nii.byScenario.find((s) => s.scenarioId === "S0")!.newBusiness = [
      { familyId: "cash", originations: Array.from({ length: n }, (_, k) => k) },
      { familyId: "investments", originations: Array.from({ length: n }, (_, k) => 2 * k) },
    ];
    return r;
  };

  it("works out yield as interest times 12 over start-of-bucket balance, blank where the balance is zero", () => {
    expect(derivedYield([100, 50, 7], [12_000, 0, 840])).toEqual([0.1, null, 0.1]);
    const r = freshResult();
    const d = detail(r, { kind: "family", id: "cash" });
    const s = fam(r, "cash");
    const y = col(d, "yield")!;
    expect(y.note).toBe("worked out here");
    expect(y.values[0]).toBe((s.interest[0]! * 12) / s.balance[0]!);
    s.balance.forEach((b, k) => expect(y.values[k]).toBe(b === 0 ? null : (s.interest[k]! * 12) / b));
  });
  it("reads a family's balance, principal and interest as stored", () => {
    const r = freshResult();
    const d = detail(r, { kind: "family", id: "investments" });
    const s = fam(r, "investments");
    expect(col(d, "balance")!.values).toBe(s.balance);
    expect(col(d, "principal")!.values).toBe(s.principal);
    expect(col(d, "interest")!.values).toBe(s.interest);
  });
  it("reads a node's balance, principal and interest as stored on the node, not summed", () => {
    const r = freshResult();
    const node = S0(r).byCoaNode.find((n) => n.coaNodeId === "coa-assets")!.series;
    const d = detail(r, { kind: "node", id: "coa-assets" });
    expect(col(d, "balance")!.values).toBe(node.balance);
    expect(col(d, "principal")!.values).toBe(node.principal);
    expect(col(d, "interest")!.values).toBe(node.interest);
    expect(col(d, "yield")!.values[0]).toBe((node.interest[0]! * 12) / node.balance[0]!);
  });
  it("sums a summation node's net interest from the family rows", () => {
    const row = (id: string, v: number) => ({ familyId: id, side: "asset" as const, income: [v, v], expense: [0, 1], net: [v, v - 1] });
    const s = { scenarioId: "S0", income: [], expense: [], net: [], byFamily: [row("cash", 3), row("investments", 5), row("dda", 100)] };
    expect(familiesUnder(COA, "coa-assets")).toEqual(["cash", "investments"]);
    expect(nodeIncome(s, familiesUnder(COA, "coa-assets"))).toEqual({ income: [8, 8], expense: [0, 2], net: [8, 6] });
    expect(nodeIncome(s, [])).toBeNull();
  });
  it("reads a family's originations as stored and sums a node's from the family rows", () => {
    const r = withOriginations();
    expect(col(detail(r, { kind: "family", id: "investments" }), "originations")).toEqual({ id: "originations", label: "Originations", values: r.nii.byScenario[0]!.newBusiness![1]!.originations });
    const o = col(detail(r, { kind: "node", id: "coa-assets" }), "originations")!;
    expect(o.note).toBe("summed here from the family rows");
    expect(o.values.slice(0, 4)).toEqual([0, 3, 6, 9]);
  });
  it("says originations are not present on a static scenario, and not for a family the sweep holds no target for", () => {
    const r = withOriginations();
    expect(monthlyDetail({ result: r, scenarioId: "S100", label: "Up 100", pick: { kind: "family", id: "cash" }, coa: COA }).notes)
      .toContain("Originations are not present on Up 100: a static scenario writes none.");
    const d = detail(r, { kind: "family", id: "dda" });
    expect(col(d, "originations")).toBeUndefined();
    expect(d.notes).toContain("Originations are not present for dda on Base: the reinvestment sweep holds no target for it.");
    expect(detail(freshResult(), { kind: "family", id: "cash" }).notes).toContain("Originations are not present on this envelope: no scenario of the run wrote new business.");
  });
  it("says per-cell series are not present on a dynamic scenario of a run that declared views", () => {
    const r = withOriginations();
    (r.cashflows as { cells?: unknown[] }).cells = [];
    expect(detail(r, { kind: "family", id: "cash" }).notes).toContain("Per-cell series are not present on Base: a dynamic scenario carries no cell index, so this card reads family and node rows only.");
    S0(r).byCell = [];
    expect(detail(r, { kind: "family", id: "cash" }).notes.join(" ")).not.toContain("Per-cell");
  });
  it("leaves yield blank for derivative and commitment families and for a node holding both sides", () => {
    const coa = structuredClone(COA) as unknown as { families: { side: string; instrumentType: string }[] };
    coa.families[0]!.side = "derivative";
    coa.families[1]!.instrumentType = "commitment";
    const r = freshResult();
    const swap = detail(r, { kind: "family", id: "cash" }, coa as unknown as Coa);
    expect(col(swap, "yield")).toBeUndefined();
    expect(swap.notes).toContain("Yield is not worked out for cash: net settlement over a notional is not a yield.");
    expect(detail(r, { kind: "family", id: "investments" }, coa as unknown as Coa).notes).toContain("Yield is not worked out for investments: undrawn face is not a balance.");
    const both = { ...COA, nodes: [...COA.nodes, { id: "coa-root", label: "All", parentId: null, side: "asset", isLeaf: false, order: 2 }].map((n) => (n.parentId === null && n.id !== "coa-root" ? { ...n, parentId: "coa-root" } : n)) } as unknown as Coa;
    expect(familiesUnder(both, "coa-root")).toEqual(["cash", "investments", "dda"]);
    const r2 = freshResult();
    S0(r2).byCoaNode.push({ coaNodeId: "coa-root", series: fam(r2, "cash") });
    expect(detail(r2, { kind: "node", id: "coa-root" }, both).notes).toContain("Yield is not worked out for coa-root: it holds asset and liability families.");
  });
  it("says what is missing when the chart of accounts or the stored row is not at hand", () => {
    const d = detail(freshResult(), { kind: "node", id: "coa-assets" }, null);
    expect(col(d, "balance")).toBeDefined();
    expect(col(d, "yield")).toBeUndefined();
    expect(d.notes).toContain("The chart of accounts is not at hand, so yield and a node's summed rows are not shown.");
    expect(detail(freshResult(), { kind: "family", id: "nope" }).notes).toContain("Balance, principal and interest are not present for nope on Base.");
  });
  it("exports every shown series to the grid horizon as CSV, blank where a value is not worked out", () => {
    const csv = detailCsv([{ id: "balance", label: "Balance", values: [10, 0, 5] }, { id: "yield", label: "Yield", values: [0.1, null, 0.2], note: "worked out here" }]);
    expect(csv).toBe('"Month","Balance","Yield (worked out here)"\n1,10,0.1\n2,0,\n3,5,0.2\n');
    const r = freshResult();
    const lines = detailCsv(detail(r, { kind: "family", id: "cash" }).cols).trimEnd().split("\n");
    expect(lines).toHaveLength(r.cashflows.grid.horizonMonths + 1);
  });
  it("renders the node picker, the summed label, the CSV button and the next sentence on the card, from the reply's chart", () => {
    const r = withOriginations();
    const row = (id: string) => ({ familyId: id, side: "asset" as const, income: [1, 2], expense: [0, 0], net: [1, 2] });
    const bare = { kind: "monthly" as const, horizonMonths: 2, byScenario: [{ scenarioId: "S0", income: [9, 9], expense: [0, 0], net: [9, 9], byFamily: [row("cash"), row("investments")] }] };
    const reply = { ...bare, coa: COA };
    const html = renderToStaticMarkup(
      <NiiMonthlyView reply={reply} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={2} family={null} node="coa-assets" basisLabel={FLAT} query={{}} stored={null} result={r} />,
    );
    expect(html).toContain('aria-label="Account node"');
    expect(html).toContain('<option value="coa-assets" selected="">Assets, coa-assets</option>');
    expect(html).toContain("Income, expense, net interest and originations for coa-assets are summed here from the family rows");
    expect(html).toContain("Download CSV");
    expect(html).toContain(NEXT_SENTENCE);
    expect(html).toContain("worked out here");
    expect(html).toContain(usd(4));
    const total = renderToStaticMarkup(
      <NiiMonthlyView reply={reply} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={2} family={null} basisLabel={FLAT} query={{}} stored={null} result={r} />,
    );
    expect(total).toContain("Pick a family or an account node for balance, principal, interest, yield and originations.");
    // A reply without the chart (a server before slice three) still reads the family's stored rows and says what it cannot.
    const old = renderToStaticMarkup(
      <NiiMonthlyView reply={bare} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={2} family="cash" basisLabel={FLAT} query={{}} stored={null} result={r} />,
    );
    expect(old).toContain("The chart of accounts is not at hand, so yield and a node&#x27;s summed rows are not shown.");
    expect(old).toContain("Balance, start of month");
  });
  it("offers no account node when the reply carries no chart of accounts, and keeps the family chips", () => {
    const r = withOriginations();
    const row = (id: string) => ({ familyId: id, side: "asset" as const, income: [1, 2], expense: [0, 0], net: [1, 2] });
    const bare = { kind: "monthly" as const, horizonMonths: 2, byScenario: [{ scenarioId: "S0", income: [9, 9], expense: [0, 0], net: [9, 9], byFamily: [row("cash"), row("investments")] }] };
    expect(S0(r).byCoaNode.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(
      <NiiMonthlyView reply={bare} runId="run-fixture" scenarioId="S0" scenarioLabel={(id) => id} window={2} family={null} basisLabel={FLAT} query={{}} stored={null} result={r} />,
    );
    expect(html).not.toContain('aria-label="Account node"');
    expect(html).not.toContain("<option");
    expect(html).toContain("All families</button>");
    expect(html).toContain(">cash</button>");
    expect(html).toContain(">investments</button>");
  });
});
