/**
 * The learn seed's rules on a fake reader. The happy path on a real platform is
 * apps/server/src/__tests__/s3fLearnSeed.test.ts; here, the cases a real store rarely shows: a launch that needs a note
 * confirmed is left for the learner and launches nothing, a blocked one is left with what it needs, a run still going
 * is waited for and not launched again, and a run that ends in error is said.
 */
import { describe, expect, it } from "vitest";
import type { ExampleBookRow, ExampleDemoRow, WorkspaceManifest, WorkspaceRunRow } from "@alm/reader";
import { seedLearnStore, type LearnApi } from "../guided/learnSeed";

const BANK: ExampleBookRow = { id: "mid-size-bank-v1", label: "Quillfield Bank", asOf: "2026-03-31", positionCount: 29, analysis: true };
const head = (slots: string[]): WorkspaceManifest =>
  ({ id: "ws-example-bank", name: "Example bank", status: "active", lock: null, createdAt: "2026-11-05T00:00:00.000Z", revision: 1,
    blocks: { positions: { book: { collection: "portfolios", id: BANK.id } }, assumptions: { sets: [] }, run: { setups: slots.map((s) => ({ setupLineageId: s, current: { collection: "run-setups", id: `rs-${s}` } })) } } }) as unknown as WorkspaceManifest;
const demo = (id: string): ExampleDemoRow => ({ id, title: id, lineageId: `demo-${id}`, setupId: `rs-${id}`, setIds: [], stored: true });
const row = (runId: string, slot: string, state: string): WorkspaceRunRow =>
  ({ runId, attachedBy: "launch", at: "2026-11-05T10:00:00.000Z", setupLineageId: slot, pins: "consumed", status: { runId, state, submittedAt: "2026-11-05T10:00:00.000Z" }, basisLabel: null }) as unknown as WorkspaceRunRow;

/** A fake reader over one Example bank workspace that already holds every slot. */
function fake(p: { demos: string[]; rows: WorkspaceRunRow[]; launchable: Record<string, { blocking: string[]; acknowledgeable: string[] }>; endStates?: Record<string, string> }) {
  const launched: string[] = [];
  const polls = new Map<string, number>();
  const ws = head(["setup-guided", ...p.demos.map((d) => `demo-${d}`)]);
  const api = {
    listExampleBooks: async () => [BANK],
    listExampleDemos: async () => p.demos.map(demo),
    listWorkspaces: async () => [ws],
    getWorkspace: async () => ws,
    listWorkspaceRuns: async () => p.rows,
    getReadiness: async () => ({ launchable: Object.fromEntries(Object.entries(p.launchable).map(([k, v]) => [k, { ok: v.blocking.length === 0, ...v }])) }),
    launchSetup: async (_ws: string, slot: string) => { launched.push(slot); return { runIds: [`run-${slot}`] }; },
    getRun: async (id: string) => {
      const n = (polls.get(id) ?? 0) + 1;
      polls.set(id, n);
      return { state: n < 2 ? "running" : (p.endStates?.[id] ?? "done") };
    },
    startWorkspace: async () => { throw new Error("the workspace exists; nothing is made"); },
    exploreExampleBank: async () => { throw new Error("the workspace exists; nothing is explored"); },
    openFeatureDemo: async () => { throw new Error("every slot exists; nothing is saved over"); },
  } as unknown as LearnApi;
  return { api, launched };
}

const none = { blocking: [], acknowledgeable: [] };

describe("the learn seed's rules", () => {
  it("leaves a launch that needs a note confirmed, and one that is blocked, and launches the rest", async () => {
    const f = fake({
      demos: ["seg", "regulatory", "six-shocks"],
      rows: [row("r-g", "setup-guided", "done")],
      launchable: { "setup-guided": none, "demo-seg": none, "demo-regulatory": { blocking: [], acknowledgeable: ["note-1"] }, "demo-six-shocks": { blocking: ["no market"], acknowledgeable: [] } },
    });
    const r = await seedLearnStore(() => undefined, f.api, async () => undefined);
    expect(f.launched).toEqual(["demo-seg"]);
    expect(r.kept).toEqual(["Example bank: the finished analysis"]);
    expect(r.launched).toEqual(["Example bank: seg"]);
    expect(r.left).toEqual([
      "Example bank: regulatory (a note waits for you on Run setups; read it, then press Launch)",
      "Example bank: six-shocks (Run setups says what it still needs: no market)",
    ]);
  });

  it("waits for a run still going instead of launching again, and says when a run ends in error", async () => {
    const f = fake({
      demos: ["seg", "regulatory"],
      rows: [row("r-g", "setup-guided", "done"), row("r-q", "demo-seg", "queued")],
      launchable: { "setup-guided": none, "demo-seg": none, "demo-regulatory": none },
      endStates: { "run-demo-regulatory": "error" },
    });
    const r = await seedLearnStore(() => undefined, f.api, async () => undefined);
    expect(f.launched).toEqual(["demo-regulatory"]);
    expect(r.left).toEqual(["Example bank: regulatory (its run did not finish: error; open it on Run setups and press Launch again)"]);
  });
});
