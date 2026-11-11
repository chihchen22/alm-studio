// apps/server/src/__tests__/studioS3bAcceptance.test.tsx
/**
 * Studio S3b acceptance (spec 2026-09-26-studio-s3b-design.md Section 8,
 * items 1 to 5) on a seeded test platform.
 *
 * Item 1: a stack of demo-behavioral-v1 plus liquidity-stress-demo-v1
 * flattens, diffs, saves and re-saves as already saved. Item 2: a library
 * scenario with the saved stack as its set is saved as a new plan id and
 * validated; it compiles clean (the stack binds mma nmd-decay and the seeded
 * st-decay selects dda and mma), the Studio paint equals the reply's own gate
 * fields, and the plan runs to done. A plan with the ramp scenario is refused
 * at compile. Item 3: two runs of the vanilla
 * plan compare cell for cell with compare.csv, and each delta is B - A
 * computed here. Item 4: the three S3b tables print no number the routes did
 * not return. Item 5: a result whose first scenario id holds "]." reads.
 *
 * Expected values are restated here (the diff fields, the gate summary, the
 * delta, the CSV encoding), never taken from the code they check.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AssumptionDiff, AssumptionSet, RunPlan, RunResult, ScenarioLibrary } from "@alm/engine";
import { flattenStack, getCompare, niiHorizonRows, niiMonthlyNet, type CompareReply, type FlatStack, type RunDetail, type ValidateResponse } from "@alm/reader";
import { seedStore } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { bindingRows, deltaRows, saveStack } from "../../../studio/src/assumptions/stackModel";
import { addLibraryScenario, setScenarioSet } from "../../../studio/src/scenarios/scenarioEdits";
import { nextEditId, withPlanId } from "../../../studio/src/plan/planEdits";
import { paint } from "../../../studio/src/plan/gatePaint";
import { BindingsTable, DiffTable } from "../../../studio/src/pages/assumptions/AssumptionsViews";
import { CompareTable } from "../../../studio/src/pages/compare/CompareViews";
import { overviewModel } from "../../../studio/src/results/overview";
import { OverviewTab } from "../../../studio/src/pages/results/OverviewTab";
import { NiiTab } from "../../../studio/src/pages/results/NiiTab";

let t: TestPlatform;
const realFetch = globalThis.fetch;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
  // Studio's reader client calls relative /api paths; send them to the test platform.
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
    realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  return t.close();
});

const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string, ms: number) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), ms);

const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
const rowsOf = (html: string) => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
// A body row's cells, its row header included (Row header scope 2: the compare, diff and bindings rows open on one).
const tdsOf = (tr: string) => [...tr.matchAll(/<(?:td|th scope="row")[^>]*>[\s\S]*?<\/t[dh]>/g)].map((m) => m[0]);

/** Number tokens: a minus counts only when no word character or dot sits before it ("decay-1" gives "1"). */
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi;
const numbersIn = (s: string): string[] => s.match(NUMBER) ?? [];

// State carried from one item to the next (vitest runs a file's tests in order).
let base: AssumptionSet;
let flat: FlatStack;
let diff: AssumptionDiff;
let stored: AssumptionSet & { contentHash?: unknown };
let compareNii: CompareReply;
let firstResult: RunResult;
let firstRunId: string;

describe("S3b acceptance", () => {
  it("item 1: the stack flattens, diffs against the base, saves, and re-saves as already saved", async () => {
    base = (await api<AssumptionSet>(t.base, "GET", "/api/assumption-sets/demo-behavioral-v1")).body;
    const layer = (await api<AssumptionSet>(t.base, "GET", "/api/assumption-sets/liquidity-stress-demo-v1")).body;
    flat = await flattenStack(base, [layer]);

    const d = await api<AssumptionDiff>(t.base, "POST", "/api/assumption-sets/diff", { baseId: base.id, candidate: flat.set });
    expect(d.status).toBe(200);
    diff = d.body;
    // Direct typed access to the route's deltas, not through deltaRows.
    expect(diff.deltas.some((x) => x.familyId === "mma" && x.overlayKind === "nmd-decay" && x.from === null)).toBe(true);
    expect(diff.deltas.some((x) => x.familyId === "dda" && x.overlayKind === "nmd-decay" && x.from !== null && x.to !== null)).toBe(true);

    expect(await saveStack(flat.set)).toEqual({ kind: "saved", id: flat.set.id });
    stored = (await api<AssumptionSet & { contentHash?: unknown }>(t.base, "GET", `/api/assumption-sets/${flat.set.id}`)).body;
    expect(typeof stored.contentHash).toBe("string");
    expect(stored.bindings).toEqual(flat.set.bindings);
    const listed = (await api<Array<{ id: string; contentHash: string }>>(t.base, "GET", "/api/assumption-sets")).body;
    expect(listed.find((s) => s.id === flat.set.id)?.contentHash).toBe(stored.contentHash);

    expect(await saveStack(flat.set)).toEqual({ kind: "already-saved", id: flat.set.id });
  }, 60_000);

  it("item 2: STEEP100 with the saved stack compiles clean (st-decay licenses mma nmd-decay), paints as the reply says and runs to done; the ramp plan is refused with ScenarioNotExecutableError", async () => {
    const seeded = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-synthetic-2500-v1")).body;
    const libraries = (await api<ScenarioLibrary[]>(t.base, "GET", "/api/plans/library")).body;
    const added = addLibraryScenario(seeded, "steepener-v1#STEEP100");
    expect(added.scenarios.length).toBe(seeded.scenarios.length + 1);
    const edited = setScenarioSet(added, added.scenarios.length - 1, flat.set.id, libraries);

    const planIds = (await api<Array<{ id: string }>>(t.base, "GET", "/api/run-plans")).body.map((p) => p.id);
    const saveId = nextEditId(seeded.planId, new Set(planIds));
    expect(saveId).toBe("plan-synthetic-2500-v1-edit-1");
    expect((await api(t.base, "POST", "/api/run-plans", { plan: withPlanId(edited, saveId) })).status).toBe(201);
    const plan = (await api<RunPlan>(t.base, "GET", `/api/run-plans/${saveId}`)).body;

    const v = await api<ValidateResponse>(t.base, "POST", "/api/plans/validate", { plan });
    expect(v.status).toBe(200);
    const reply = v.body;
    // The stack adds mma nmd-decay, and the seeded st-decay selects dda and mma,
    // so the binding has one licensee and the plan compiles clean.
    expect(reply.compile, JSON.stringify(reply.compile)).toEqual({ passed: true });
    expect(reply.type.failures).toEqual([]);
    expect(reply.routing.failures).toEqual([]);
    // The paint's gate summary, restated from the reply's own fields.
    const restated = (r: ValidateResponse["type"]) => ({
      passed: r.passed,
      ran: r.passed || r.failures.length > 0,
      failures: r.failures.length,
      checked: r.checked.length,
    });
    const painted = paint(plan.stages.map((s) => s.id), reply);
    expect(painted.gates).toEqual({ type: restated(reply.type), routing: restated(reply.routing), compile: reply.compile });
    const refusalCodes = (p: typeof painted) => [...p.banner.map((b) => b.code), ...Object.values(p.byStage).flatMap((s) => (s.kind === "refused" ? [s.code] : []))];
    expect(refusalCodes(painted)).toEqual([]);
    expect(painted.gates!.type.ran).toBe(true);
    expect(painted.gates!.routing.ran).toBe(true);

    // The saved stack runs end to end, and the stacked scenario is in the result.
    const run = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label: "s3b stacked steepener" });
    expect(run.status).toBe(202);
    expect((await finished(run.body.runId, 600_000)).state).toBe("done");
    const stacked = (await api<RunResult>(t.base, "GET", `/api/runs/${run.body.runId}/result`)).body;
    expect(stacked.nii.byScenario.map((s) => s.scenarioId)).toContain("STEEP100");

    const ramp = addLibraryScenario(seeded, "ramp-200-12m-v1#R200");
    const rv = await api<ValidateResponse>(t.base, "POST", "/api/plans/validate", { plan: ramp });
    expect(rv.status).toBe(200);
    expect(rv.body.compile.passed).toBe(false);
    expect(rv.body.compile.error).toBe("ScenarioNotExecutableError");
    const rampPaint = paint(ramp.stages.map((s) => s.id), rv.body);
    expect(rampPaint.gates!.compile).toEqual(rv.body.compile);
    expect(refusalCodes(rampPaint)).toContain("ScenarioNotExecutableError");
  }, 120_000);

  it("item 3: two vanilla runs compare cell for cell with compare.csv, each delta B - A", async () => {
    const seeded = (await api<RunPlan>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1")).body;
    const fewer: RunPlan = { ...seeded, planId: "plan-vanilla-book-v1-no-s-200", scenarios: seeded.scenarios.filter((s) => !("ref" in s && s.ref.endsWith("#S-200"))) };
    expect(fewer.scenarios.length).toBe(seeded.scenarios.length - 1);
    const a = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: seeded, label: "s3b compare A" });
    expect(a.status).toBe(202);
    const b = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan: fewer, label: "s3b compare B" });
    expect(b.status).toBe(202);
    expect((await finished(a.body.runId, 300_000)).state).toBe("done");
    expect((await finished(b.body.runId, 300_000)).state).toBe("done");
    firstRunId = a.body.runId;
    firstResult = (await api<RunResult>(t.base, "GET", `/api/runs/${a.body.runId}/result`)).body;

    // compare.csv's cell encoding, restated from compareJson.test.ts.
    const enc = (v: unknown) => (v === null || v === undefined ? "" : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    for (const table of ["nii", "eve", "repricing-gap", "liquidity-gap", "attribution", "cashflows"] as const) {
      const j = await getCompare(a.body.runId, b.body.runId, table);
      expect(j.table).toBe(table);
      expect(j.provenance.a.runId).toBe(a.body.runId);
      expect(j.provenance.b.runId).toBe(b.body.runId);
      const keys = j.columns.filter((c) => c.role === "key");
      const vals = j.columns.filter((c) => c.role !== "key");
      for (const r of j.rows) {
        for (const c of vals.filter((x) => x.role === "num")) {
          const va = r.a?.[c.name];
          const vb = r.b?.[c.name];
          const expected = typeof va === "number" && typeof vb === "number" ? vb - va : null;
          expect(r.delta[c.name], `${table} ${JSON.stringify(r.key)} ${c.name}`).toBe(expected);
        }
      }
      const csv = await realFetch(`${t.base}/api/compare.csv?runs=${a.body.runId},${b.body.runId}&table=${table}`).then((x) => x.text());
      const lines = csv.split("\r\n").filter((l) => l !== "" && !l.startsWith("#"));
      expect(lines.length - 1).toBe(j.rows.length);
      j.rows.forEach((r, i) => {
        const cells = [...keys.map((c) => enc(r.key[c.name])), ...vals.flatMap((c) => [enc(r.a?.[c.name]), enc(r.b?.[c.name]), ...(c.role === "num" ? [enc(r.delta[c.name])] : [])])];
        expect(cells.join(",")).toBe(lines[i + 1]);
      });
      if (table === "nii") compareNii = j;
    }
    // Run B drops S-200, so the nii table carries rows only run A has.
    expect(compareNii.rows.some((r) => r.a !== null && r.b === null)).toBe(true);
  }, 700_000);

  it("item 4: the compare, diff and bindings tables print no number the routes did not return", () => {
    // Compare: a row side B lacks prints its reason in B's cells and no digit.
    const reply: CompareReply = { ...compareNii, rows: compareNii.rows.filter((r) => r.a !== null && r.b === null) };
    expect(reply.rows.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(<CompareTable reply={reply} />);
    const keys = reply.columns.filter((c) => c.role === "key");
    const vals = reply.columns.filter((c) => c.role !== "key");
    const bodyRows = rowsOf(html).slice(1);
    expect(bodyRows.length).toBe(reply.rows.length);
    for (const tr of bodyRows) {
      const tds = tdsOf(tr);
      let at = keys.length;
      for (const c of vals) {
        const bCell = tds[at + 1]!;
        expect(text(bCell)).toBe("not in run B");
        expect(/\d/.test(bCell), bCell).toBe(false);
        if (c.role === "num") {
          expect(text(tds[at + 2]!)).toBe("none");
          expect(/\d/.test(tds[at + 2]!)).toBe(false);
        }
        at += c.role === "num" ? 3 : 2;
      }
      expect(at).toBe(tds.length);
    }

    // Diff and bindings: every number token in a cell is a number token of the stored set or the diff JSON.
    const known = new Set(numbersIn(JSON.stringify(stored)).concat(numbersIn(JSON.stringify(diff))));
    const diffHtml = renderToStaticMarkup(<DiffTable diff={{ kind: "ok", rows: deltaRows(diff, base, flat.set) }} baseId={base.id} layersOn={1} />);
    const bindHtml = renderToStaticMarkup(<BindingsTable rows={bindingRows(flat.rows, base.id)} />);
    expect(rowsOf(diffHtml).length - 1).toBe(diff.deltas.length);
    expect(rowsOf(bindHtml).length - 1).toBe(stored.bindings.length);
    let seen = 0;
    // The titled-cell branch counts its own cells, so it cannot pass on a diff that prints no figure (Polish 5 T5),
    // and counts them on the diff table only, so a titled bindings cell cannot stand in for one (Polish 6 T5).
    let titled = 0;
    for (const markup of [diffHtml, bindHtml]) {
      for (const tr of rowsOf(markup)) {
        for (const td of tdsOf(tr)) {
          // A diff figure cell prints its number grouped (Polish 4 T4) and holds the stored text in its title: the
          // printed text is the title with grouping commas only, and the title's number is the one checked.
          const title = /^<t[dh][^>]*\btitle="([^"]*)"/.exec(td)?.[1];
          if (title !== undefined) {
            if (markup === diffHtml) titled += 1;
            expect(text(td).replace(/,/g, ""), td).toBe(title);
          }
          for (const n of numbersIn(title ?? text(td))) {
            seen += 1;
            expect(known.has(n), `${n} in ${text(td)}`).toBe(true);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(titled).toBeGreaterThan(0);
  });

  it("item 5: a result whose first scenario id is S].0 reads on the Overview model and the NII rows", async () => {
    const r = structuredClone(firstResult);
    const from = r.eve.byScenario[0]!.scenarioId;
    const id = "S].0";
    // Rename the scenario wherever the envelope keys it.
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      for (const k of Object.keys(o)) {
        if (k === "scenarioId" && o[k] === from) o[k] = id;
        else if (k === "scenarioIds" && Array.isArray(o[k])) o[k] = (o[k] as unknown[]).map((s) => (s === from ? id : s));
        else walk(o[k]);
      }
    };
    walk(r);
    const eve = r.eve.byScenario.find((s) => s.scenarioId === id);
    const nii = r.nii.byScenario.find((s) => s.scenarioId === id);
    if (eve === undefined || nii === undefined) throw new Error(`the renamed scenario ${id} is missing from eve or nii`);

    const row = overviewModel(r).rows.find((x) => x.scenarioId === id);
    if (row === undefined) throw new Error(`the Overview model has no row ${id}`);
    const expected = { eve: eve.eve, nii12: nii.totalNet12, nii24: nii.totalNet24 };
    for (const k of ["eve", "nii12", "nii24"] as const) {
      expect(row[k].read, `${k} ${row[k].headline.envelopePath}`).toEqual({ kind: "value", value: expected[k] });
    }

    const niiRow = niiHorizonRows(r).rows.find((x) => x.scenarioId === id);
    if (niiRow === undefined) throw new Error(`the NII rows have no row ${id}`);
    expect(niiRow.cells.length).toBe(r.nii.horizonsMonths.length);
    for (const c of niiRow.cells) {
      const stored = c.horizonMonths === 12 ? nii.totalNet12 : c.horizonMonths === 24 ? nii.totalNet24 : nii.totalNetByHorizon?.[c.horizonMonths];
      expect(c.read, c.envelopePath).toEqual({ kind: "value", value: stored });
    }
    expect(niiMonthlyNet(r, id)).toEqual({ kind: "series", values: nii.netMonthly });

    // Both tabs render the renamed scenario without throwing and without a "not in this run" cell for it.
    const detail = (await api<RunDetail>(t.base, "GET", `/api/runs/${firstRunId}`)).body;
    const props = { runId: firstRunId, detail, result: r, query: { scenario: id }, scenarioLabel: (s: string) => s };
    const overview = renderToStaticMarkup(<OverviewTab ws="ws-a" {...props} />);
    expect(overview).toContain(`title="eve.byScenario[scenarioId=${id}].eve"`);
    const niiHtml = renderToStaticMarkup(<NiiTab ws="ws-a" {...props} />);
    expect(niiHtml).toContain(`title="nii.byScenario[scenarioId=${id}].totalNet12"`);
    expect(niiHtml).toContain(`nii.byScenario[scenarioId=${id}].netMonthly`);
  }, 30_000);
});
