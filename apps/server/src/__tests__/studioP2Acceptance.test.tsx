// apps/server/src/__tests__/studioP2Acceptance.test.tsx
/**
 * ALM Studio Piece 2 acceptance (spec 2026-09-26-alm-studio-p2-targets-design.md
 * Section 6, items 3 and 4) on a freshly seeded test platform. Item 3: the
 * served per-family opening balance of the vanilla book equals the book's own
 * positions summed here, and a Hold flat target built from it lowers to flat.
 * Item 4: a balance plan with one Hold flat and one Reach target, saved through
 * the route, bound to the plan's first scenario only, the balance stage added
 * with the Studio edit, run; the provenance names that scenario alone, the NII
 * block stores a shortfall for the Reach family, and the card prints it.
 * Expected values, field paths and formats are restated here, never imported
 * from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BalancePlan, RunPlan, RunResult } from "@alm/engine";
import { lowerBalancePlan } from "@alm/engine/src/plan/lowerBalancePlan";
// Accepted exception to "never import the expected value": contentHash is the
// engine's identity hash of a stored document, not the code under test here.
import { contentHash } from "@alm/engine/src/runtime/contentHash";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { familyRows, toBalancePlan, withKind } from "../../../studio/src/balance/targetsModel";
import { addBalanceStage, scenarioIdOf, setScenarioBalancePlan } from "../../../studio/src/scenarios/scenarioEdits";
import { shortfallRows } from "../../../studio/src/results/shortfallRows";
import { ShortfallCard } from "../../../studio/src/pages/results/NiiTab";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

const BOOK = "vanilla-book-v1";
const PLAN = "plan-vanilla-book-v1";
const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), 600_000);
const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rowsOf = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
// A body cell is a td or a row header, th scope="row" (Row header scope); a column header is not one.
const cellsOf = (tr: string) => [...tr.matchAll(/<(?:td|th scope="row")[^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) => text(m[1]!));

type Groups = { groups: Array<{ key: string | null; totalNotional: number | null }> };
const served = async () => (await api<Groups>(t.base, "GET", `/api/catalog/portfolios/${BOOK}/positions/aggregate?groupBy=family`)).body.groups;
const bookDoc = () => new FileStore(t.storeRoot).getDocument<{ asOf: string; positions: Array<{ familyId: string; terms: { notional: number } }> }>("portfolios", BOOK).doc;

describe("ALM Studio P2 acceptance", () => {
  it("item 3: the served opening balance per family equals the book's positions, and Hold flat lowers to flat", async () => {
    const doc = bookDoc();
    const mine = new Map<string, number>();
    for (const p of doc.positions) mine.set(p.familyId, (mine.get(p.familyId) ?? 0) + p.terms.notional);
    const groups = await served();
    expect(groups.map((g) => g.key).sort()).toEqual([...mine.keys()].sort());
    for (const g of groups) {
      expect(g.key).not.toBeNull();
      expect(Math.abs(g.totalNotional! - mine.get(g.key!)!)).toBeLessThanOrEqual(1e-6 * mine.get(g.key!)!);
    }
    const rows = familyRows(groups, null).map((r) => (r.familyId === "cash" ? { ...withKind(r, "flat"), spreadBp: "100", termMonths: "12" } : r));
    const bp = toBalancePlan({ id: "bp-p2-item3", label: "item 3", asOf: doc.asOf }, rows);
    expect(lowerBalancePlan(bp, mine, 360, doc.asOf)).toEqual([{ familyId: "cash", reinvest: "flat", spreadOverIndexBp: 100, termMonths: 12 }]);
  });

  it("item 4: one scenario bound, balance stage added, run; provenance, shortfall and card agree with the store", async () => {
    const doc = bookDoc();
    const rows = familyRows(await served(), null).map((r) => {
      if (r.familyId === "cash") return { ...withKind(r, "flat"), spreadBp: "100", termMonths: "12" };
      // A target of one dollar at month 12: level-pay loans of three to ten
      // years cannot run off that far that fast, and the engine never sells, so
      // the family must end above target and store a shortfall.
      if (r.familyId === "fixed-loans") return { ...withKind(r, "reach"), balance: "1", month: "12", spreadBp: "150", termMonths: "60" };
      return r;
    });
    const bp: BalancePlan = toBalancePlan({ id: "bp-p2-accept", label: "P2 acceptance", asOf: doc.asOf }, rows);
    expect((await api(t.base, "POST", "/api/balance-plans", { balancePlan: bp })).status).toBe(201);

    const stored = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${PLAN}`)).body;
    const first = scenarioIdOf(stored.scenarios[0]!);
    const staged = addBalanceStage(setScenarioBalancePlan({ ...stored, planId: "plan-vanilla-p2-accept" }, first, "bp-p2-accept"));
    if (staged.kind !== "ok") throw new Error(staged.text);
    const v = await api<{ compile: { passed: boolean; detail?: string } }>(t.base, "POST", "/api/plans/validate", { plan: staged.plan });
    expect(v.body.compile).toMatchObject({ passed: true });

    const run = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: staged.plan, label: "p2 acceptance" });
    expect(run.status).toBe(202);
    expect((await finished(run.body.runId)).state).toBe("done");
    const result = (await api<RunResult>(t.base, "GET", `/api/runs/${run.body.runId}/result`)).body;

    const storedBp = (await api<BalancePlan>(t.base, "GET", "/api/balance-plans/bp-p2-accept")).body;
    expect(result.provenance.scenarioBalancePlanHashes).toEqual({ [first]: contentHash(storedBp) });

    const byScenario = result.nii.byScenario;
    const mine = byScenario.find((s) => s.scenarioId === first)!;
    expect(mine.shortfalls?.map((f) => f.familyId)).toContain("fixed-loans");
    expect(byScenario.filter((s) => s.scenarioId !== first).every((s) => s.shortfalls === undefined)).toBe(true);

    const html = renderToStaticMarkup(<ShortfallCard runId={run.body.runId} rows={shortfallRows(result)} bound={true} scenarioLabel={(id) => id} />);
    const loans = mine.shortfalls!.find((f) => f.familyId === "fixed-loans")!;
    // Restated: the row prints scenario id, family, rule, then the three money
    // fields at nii.byScenario[scenarioId=first].shortfalls[familyId=fixed-loans]
    // .targetBalanceEnd, .achievedBalanceEnd, .balanceGapEnd in full USD, then
    // firstBucket and clampedBuckets as integers. Reach $1 by month 12 decays
    // geometrically to the horizon, so target and achieved at the end are both
    // near zero; that is expected.
    const expected = [
      first, "fixed-loans", loans.reinvest,
      U(loans.targetBalanceEnd), U(loans.achievedBalanceEnd), U(loans.balanceGapEnd),
      String(loans.firstBucket), String(loans.clampedBuckets),
    ];
    const cardRows = rowsOf(html).map(cellsOf).filter((c) => c.length > 0);
    const row = cardRows.find((c) => c[0] === first && c[1] === "fixed-loans");
    expect(row).toEqual(expected);
    expect(text(html)).toContain(expected.join(" "));
    console.log(`[p2 acceptance] shortfall row: ${JSON.stringify(loans)} printed ${JSON.stringify(row)}`);
  }, 700_000);
});

/**
 * Full USD, restated from the ruling: grouping commas, every digit kept
 * (no rounding), no sign when the printed magnitude is "0", a true minus
 * (U+2212) otherwise for a negative value.
 */
function U(v: number): string {
  const mag = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 20, useGrouping: true });
  return v < 0 && mag !== "0" ? `−${mag}` : mag;
}
