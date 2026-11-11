// apps/studio/src/__tests__/teachResultPicker.test.tsx
/**
 * Teaching build, slice A3: the result picker on a workspace whose setup slot is a registered record slot (registry.ts). A deterministic screen opens on the newest pinned-run run, not the newest run; stochastic rows say model,
 * paths and base scenario only; the pinned run is marked. Workspaces with no record slot keep the newest-run default
 * (resultPicker.test.tsx). The ids are synthetic.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkspaceRunRow } from "@alm/reader";
import { chooseResult, pickerRuns, rowText, stochasticText } from "../pages/results/resultChoice";
import { ResultPicker } from "../pages/results/ResultPicker";
import { registerRecordSlot } from "../registry";

const WS = "ws-record-demo-2026-03-31";
const ARM_OF_RECORD_SLOT = "setup-record-pinned-run";
registerRecordSlot({ slot: ARM_OF_RECORD_SLOT, title: "Launched from the pinned-run setup" });
/** The em-dash and the section sign, built from code points so this file never carries either. */
const BANNED = new RegExp(`[${String.fromCodePoint(0x2014)}${String.fromCodePoint(0xa7)}]`);

function row(runId: string, submittedAt: string, label: string | undefined, slot: string | undefined): WorkspaceRunRow {
  return {
    runId,
    attachedBy: slot === undefined ? "migration" : "launch",
    at: submittedAt,
    pins: slot === undefined ? "reconstructed" : "consumed",
    ...(slot === undefined ? {} : { setupLineageId: slot, launchNo: 1 }),
    status: {
      runId,
      state: "done",
      ...(label === undefined ? {} : { label }),
      submittedAt,
      platformRequestHash: "req",
      summary: { portfolioId: "example-book-v1", marketId: "market-public-2026-03-31", scenarioSlateId: "srp31-v1", scenarioCount: 11, workspaceId: WS },
    },
    basisLabel: "Runoff",
  };
}

// A store's order: the stochastic runs are newest, then the granular launches, the pinned run seventh.
const ROWS: WorkspaceRunRow[] = [
  row("run-aor-1", "2026-10-14T16:17:35Z", "pinned-run #1", ARM_OF_RECORD_SLOT),
  row("run-aor-2", "2026-10-17T04:53:37.760Z", "pinned-run #2", ARM_OF_RECORD_SLOT),
  row("run-beh-2", "2026-10-17T04:53:37.827Z", "behavioral #2", "setup-record-behavioral"),
  row("run-gaor-3", "2026-10-17T04:53:38.035Z", "granular-pinned-run #3", "setup-record-granular-pinned-run"),
  row("run-gbeh-3", "2026-10-17T04:53:38.169Z", "granular-behavioral #3", "setup-record-granular-behavioral"),
  row("run-mc-1", "2026-10-17T04:53:42Z", undefined, undefined),
  row("run-mc-2", "2026-10-26T13:06:53Z", undefined, undefined),
];
const MODES = { "run-mc-1": "stochastic", "run-mc-2": "stochastic" };
const SPECS = { "run-mc-1": { nPaths: 256 }, "run-mc-2": { nPaths: 64, model: "bgm-lmm-2f" as const } };

describe("the default on a workspace with an pinned-run setup", () => {
  const runs = pickerRuns(ROWS, MODES, null, SPECS);
  it("opens a deterministic screen on the newest pinned-run run, not the newest run", () => {
    expect(runs[0]!.runId).toBe("run-mc-2");
    expect(chooseResult(runs, undefined)).toMatchObject({ kind: "record", runId: "run-aor-2" });
  });
  it("keeps the explicit choice and the stochastic screen's own default", () => {
    expect(chooseResult(runs, "run-gbeh-3")).toMatchObject({ kind: "explicit", runId: "run-gbeh-3" });
    expect(chooseResult(runs, undefined, "stochastic")).toMatchObject({ kind: "newest", runId: "run-mc-2" });
  });
  it("marks only the pinned-run slot's runs, not the granular pinned run", () => {
    expect(runs.filter((r) => r.armOfRecord).map((r) => r.runId)).toEqual(["run-aor-2", "run-aor-1"]);
  });
});

describe("row text", () => {
  const runs = pickerRuns(ROWS, MODES, null, SPECS);
  const of = (id: string) => rowText(runs.find((r) => r.runId === id)!);
  it("a stochastic row names its model and paths and says base scenario only, never the slate's scenario count", () => {
    expect(of("run-mc-1")).toBe("run-mc-1 · 2026-10-17 · Stochastic, Hull-White, 256 paths, base scenario only · Runoff");
    expect(of("run-mc-2")).toBe("run-mc-2 · 2026-10-26 · Stochastic, BGM, 64 paths, base scenario only · Runoff");
    expect(of("run-mc-1")).not.toContain("11 scenarios");
  });
  it("a stochastic row whose options were not read still says what it is", () => {
    expect(stochasticText(null)).toBe("Stochastic, base scenario only");
    expect(rowText(pickerRuns(ROWS, MODES, null)[0]!)).toBe("run-mc-2 · 2026-10-26 · Stochastic, base scenario only · Runoff");
  });
  it("an pinned-run row ends with pinned run; other deterministic rows are unchanged", () => {
    expect(of("run-aor-2")).toBe("pinned-run #2 · 2026-10-17 · 11 scenarios · Runoff · pinned run");
    expect(of("run-beh-2")).toBe("behavioral #2 · 2026-10-17 · 11 scenarios · Runoff");
  });
});

describe("the picker control", () => {
  const runs = pickerRuns(ROWS, MODES, null, SPECS);
  const html = (explicit?: string) => renderToStaticMarkup(
    <ResultPicker ws={WS} screen="dashboard" query={explicit === undefined ? {} : { result: explicit }} runs={runs} choice={chooseResult(runs, explicit)} />,
  );
  it("says the pinned run is the default and why, and selects it", () => {
    const m = html();
    expect(m).toContain("Showing the pinned run by default, the newest run of its setup");
    expect(m).toContain('title="Launched from the pinned-run setup"');
    expect(m).toContain(`value="#/ws/${WS}/results/dashboard?result=run-aor-2" selected=""`);
    expect(m).toContain(">Pinned run<");
    expect(m).not.toMatch(BANNED);
  });
  it("offers the way back to the pinned run from an explicit choice", () => {
    const m = html("run-gbeh-3");
    expect(m).toContain("Showing the run chosen in the address");
    expect(m).toContain("Use the pinned run");
    expect(m).not.toContain("Use the newest run");
  });
});
