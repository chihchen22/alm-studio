// apps/server/src/__tests__/studioResultsAcceptance.test.tsx
/**
 * Studio S3a acceptance (spec 2026-09-25-studio-s3a-design.md Section 7).
 * Item 1: on the three seeded plans, every headline Studio paints equals the
 * stored field to the digit, and the viewer's panel for that field prints the
 * same string. The expected value is read by direct typed access and the path
 * is restated here; neither comes from Studio code. Item 3: validate, confirm,
 * submit, events to end done, results link; a refused plan shows the banner
 * and starts no run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunResult } from "@alm/engine";
import { classifyRunEvent, headlinesFor, type Headline, type RunPlanMeta } from "@alm/reader";
import { seedStore, SEED_IDS } from "../../scripts/seed-store";
import { repoRoot } from "../config";
import { FileStore } from "../store/store";
import { api, bootTestPlatform, waitFor, type TestPlatform } from "./harness";
import { EveTable } from "../../../viewer/src/components/EveTable";
import { NiiTable } from "../../../viewer/src/components/NiiTable";
import { overviewCells, overviewModel } from "../../../studio/src/results/overview";
import { confirmModel } from "../../../studio/src/run/confirm";
import { initialRunView, reduceRun } from "../../../studio/src/run/runState";
import { paint } from "../../../studio/src/plan/gatePaint";
import { loadConfirm, submitStoredPlan } from "../../../studio/src/pages/run/runActions";
import { ConfirmView, ProgressView, RefusalBanner } from "../../../studio/src/pages/run/RunViews";
import { loadResults, planIdText } from "../../../studio/src/pages/results/loadResults";

let t: TestPlatform;
beforeAll(async () => {
  t = await bootTestPlatform();
  await seedStore(new FileStore(t.storeRoot), repoRoot());
});
afterAll(() => t.close());

const TERMINAL = ["done", "error", "cancelled", "interrupted"];
const finished = (runId: string, ms: number) =>
  waitFor(() => api<{ state: string }>(t.base, "GET", `/api/runs/${runId}`).then((x) => x.body), (s) => TERMINAL.includes(s.state), ms);

// The three templates, restated rather than imported.
const EXPECTED_PATH: Record<Headline["metric"], (id: string) => string> = {
  eve: (id) => `eve.byScenario[scenarioId=${id}].eve`,
  nii12: (id) => `nii.byScenario[scenarioId=${id}].totalNet12`,
  nii24: (id) => `nii.byScenario[scenarioId=${id}].totalNet24`,
};

function storedValue(r: RunResult, h: Headline): number {
  if (h.metric === "eve") {
    const s = r.eve.byScenario.find((x) => x.scenarioId === h.scenarioId);
    if (s === undefined) throw new Error(`no eve scenario ${h.scenarioId}`);
    return s.eve;
  }
  const s = r.nii.byScenario.find((x) => x.scenarioId === h.scenarioId);
  if (s === undefined) throw new Error(`no nii scenario ${h.scenarioId}`);
  return h.metric === "nii12" ? s.totalNet12 : s.totalNet24;
}

const text = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
const headersOf = (table: string) => [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]!));
const cellsOf = (tr: string) => [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]!));

/** The text of the viewer table cell under `header` in the row whose first cell is `rowKey` (no scenario-label provider, so it is the id). */
function viewerCell(html: string, header: string, rowKey: string): string {
  const table = [...html.matchAll(/<table>([\s\S]*?)<\/table>/g)].map((m) => m[1]!).find((tb) => headersOf(tb).includes(header));
  if (table === undefined) throw new Error(`no viewer table with header ${header}`);
  const col = headersOf(table).indexOf(header);
  const row = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((m) => cellsOf(m[1]!)).find((cells) => cells[0] === rowKey);
  if (row === undefined) throw new Error(`no viewer row ${rowKey} under ${header}`);
  return row[col]!;
}

describe("headline parity on the three seeded plans", () => {
  it("every Studio headline equals its stored field and prints the viewer's string", async () => {
    const runs: Array<{ planId: string; runId: string; planHash: string }> = [];
    for (const planId of SEED_IDS.runPlans) {
      const plan = (await api(t.base, "GET", `/api/run-plans/${planId}`)).body;
      const v = await api<{ compile: { passed: boolean }; planHash?: string }>(t.base, "POST", "/api/plans/validate", { plan });
      expect(v.body.compile.passed).toBe(true);
      expect(typeof v.body.planHash).toBe("string");
      const r = await api<{ runId: string }>(t.base, "POST", "/api/plans/run", { plan, label: `parity ${planId}` });
      expect(r.status).toBe(202);
      runs.push({ planId, runId: r.body.runId, planHash: v.body.planHash as string });
    }
    for (const run of runs) {
      expect((await finished(run.runId, 400_000)).state).toBe("done");
      const result = (await api<RunResult>(t.base, "GET", `/api/runs/${run.runId}/result`)).body;
      expect(result.provenance.planId).toBe(run.planId);
      expect(planIdText({ detail: { state: "done" }, result, note: null })).toBe(run.planId);
      // The hash the confirm sheet shows is the hash the run carries.
      expect(result.provenance.planHash).toBe(run.planHash);

      const heads = headlinesFor(result);
      expect(heads.length).toBe(result.eve.byScenario.length + 2 * result.nii.byScenario.length);
      const cells = overviewCells(overviewModel(result));
      const eveHtml = renderToStaticMarkup(<EveTable eve={result.eve} />);
      const niiHtml = renderToStaticMarkup(<NiiTable nii={result.nii} familyLabel={(id) => id} selected={result.nii.byScenario[0]!.scenarioId} />);
      for (const h of heads) {
        expect(h.envelopePath).toBe(EXPECTED_PATH[h.metric](h.scenarioId));
        const cell = cells.find((c) => c.headline.id === h.id);
        if (cell === undefined) throw new Error(`Studio paints no cell for ${h.id} on ${run.planId}`);
        expect(cell.read.kind).toBe("value");
        if (cell.read.kind === "value") expect(cell.read.value).toBe(storedValue(result, h));
        const viewer = h.metric === "eve"
          ? viewerCell(eveHtml, "EVE", h.scenarioId)
          : viewerCell(niiHtml, h.metric === "nii12" ? "Net 12M" : "Net 24M", h.scenarioId);
        expect(cell.text).toBe(viewer);
      }
    }
  }, 900_000);
});

function sseEvents(body: string): unknown[] {
  return body
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter((l): l is string => l !== undefined)
    .map((l) => JSON.parse(l.slice(6)) as unknown);
}

describe("the run flow: validate, confirm, submit, events, results", () => {
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    // Studio's reader client calls relative /api paths; send them to the test platform.
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      realFetch(typeof input === "string" && input.startsWith("/") ? `${t.base}${input}` : input, init));
  });
  afterAll(() => vi.unstubAllGlobals());

  it("runs a stored plan to done and links its results", async () => {
    const plans = (await api<RunPlanMeta[]>(t.base, "GET", "/api/run-plans")).body;
    const data = await loadConfirm("plan-vanilla-book-v1", plans);
    expect(data.v.state).toBe("ok");
    const reply = data.v.state === "ok" ? data.v.reply : null;
    const model = confirmModel(data.plan, data.seeded, data.v);
    expect(model.runEnabled).toBe(true);
    expect(model.diff.kind).toBe("self");
    expect(model.planHashText).toBe(reply?.planHash);
    const sheet = renderToStaticMarkup(
      <ConfirmView model={model} v={data.v} gates={paint(data.plan.stages.map((s) => s.id), reply).gates} busy={false} outcome={null} closeHref="#/run" onRun={() => {}} />,
    );
    expect(sheet).toContain(model.planHashText);

    const outcome = await submitStoredPlan(data.plan);
    if (outcome.kind !== "submitted") throw new Error(`not submitted: ${JSON.stringify(outcome)}`);
    expect((await finished(outcome.runId, 300_000)).state).toBe("done");

    // A finished run's stream replays its log, sends end and closes.
    const res = await realFetch(`${t.base}/api/runs/${outcome.runId}/events`);
    const view = sseEvents(await res.text()).map(classifyRunEvent).reduce(reduceRun, initialRunView(outcome.runId));
    expect(view.state).toBe("done");
    expect(view.end).toBe("done");
    const card = renderToStaticMarkup(<ProgressView ws="ws-a" view={view} query={{}} cancelMsg={null} onCancel={() => {}} />);
    expect(card).toContain(`href="#/ws/ws-a/results/dashboard?result=${outcome.runId}"`);
    expect(card).not.toContain("Cancel");

    const results = await loadResults(outcome.runId);
    expect(results.result?.provenance.planId).toBe("plan-vanilla-book-v1");
  }, 360_000);

  it("a plan the server refuses shows the banner and starts no run", async () => {
    const base = (await api<Record<string, unknown>>(t.base, "GET", "/api/run-plans/plan-vanilla-book-v1")).body;
    const plan = { ...base, planId: "plan-vanilla-book-v1-nobase", scenarios: [{ id: "S100", label: "S100", rateSpec: { kind: "parallel", shockBp: 100 } }] };
    expect((await api(t.base, "POST", "/api/run-plans", { plan })).status).toBe(201);
    const plans = (await api<RunPlanMeta[]>(t.base, "GET", "/api/run-plans")).body;
    const data = await loadConfirm("plan-vanilla-book-v1-nobase", plans);
    const model = confirmModel(data.plan, data.seeded, data.v);
    // The gates pass; the one-base-scenario rule is checked when the run is submitted.
    expect(model.runEnabled).toBe(true);
    expect(model.diff.kind).toBe("same");

    const before = (await api<unknown[]>(t.base, "GET", "/api/runs")).body.length;
    const outcome = await submitStoredPlan(data.plan);
    expect(outcome).toMatchObject({ kind: "refused", status: 422, code: "plan_not_runnable" });
    const banner = renderToStaticMarkup(<RefusalBanner outcome={outcome} />);
    expect(banner).toContain("plan_not_runnable");
    expect(banner).toContain("exactly one base scenario");
    expect(banner).toContain("No run was started");
    expect((await api<unknown[]>(t.base, "GET", "/api/runs")).body.length).toBe(before);
  }, 60_000);
});
