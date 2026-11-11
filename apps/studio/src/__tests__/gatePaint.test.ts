import type { ValidateResponse } from "@alm/reader";
import { describe, expect, it } from "vitest";
import { paint, stageOfLayer } from "../plan/gatePaint";
import {
  REPLY_MOUNT_REFUSED,
  REPLY_NOT_EXECUTABLE,
  REPLY_NOT_RUN,
  REPLY_PLAN_NOTE,
  REPLY_R1,
  REPLY_T1,
  REPLY_TAG,
  REPLY_UNLICENSED,
} from "./fixtures/plan";

type RefuseEntry = Extract<NonNullable<ValidateResponse["runLog"]>[number], { t: "refuse" }>;

const IDS = ["st-curve", "st-term", "st-decay", "st-beta", "st-cashflow", "st-ftp", "st-x"];

describe("stageOfLayer", () => {
  it("reads the compiler's two stage layers and nothing else", () => {
    expect(stageOfLayer("plan.stage.st-ftp")).toBe("st-ftp");
    expect(stageOfLayer("plan.stage.st-decay.unbound")).toBe("st-decay");
    expect(stageOfLayer("plan/license")).toBeNull();
    expect(stageOfLayer("plan.stage.")).toBeNull();
  });
});

describe("paint", () => {
  it("marks every stage unchecked before any reply", () => {
    const p = paint(IDS, null);
    expect(new Set(Object.values(p.byStage).map((s) => s.kind))).toEqual(new Set(["unchecked"]));
    expect(p.gates).toBeNull();
    expect(p.banner).toEqual([]);
    expect(p.notes).toEqual([]);
  });

  it("paints a tolerated stage not-implemented and the rest pass", () => {
    const p = paint(IDS, REPLY_TAG);
    expect(p.byStage["st-ftp"]).toEqual({ kind: "not-implemented", message: REPLY_TAG.notImplemented![0]!.reason });
    expect(p.byStage["st-curve"]).toEqual({ kind: "pass" });
    expect(p.banner).toEqual([]);
  });

  it("paints a T-rule on the stage it names and does not repeat PlanRejected in the banner", () => {
    const p = paint(IDS, REPLY_T1);
    expect(p.byStage["st-cashflow"]).toEqual({ kind: "refused", code: "T1", message: REPLY_T1.type.failures[0]!.detail });
    expect(p.banner).toEqual([]);
    expect(p.gates!.type).toEqual({ passed: false, ran: true, failures: 1, checked: 1 });
  });

  it("puts a plan-wide license refusal in the banner, with both gates not run and every stage unchecked", () => {
    const p = paint(IDS, REPLY_UNLICENSED);
    expect(p.banner).toEqual([{ code: "UnlicensedBindingError", message: REPLY_UNLICENSED.compile.detail }]);
    expect(p.gates!.type.ran).toBe(false);
    expect(p.gates!.routing.ran).toBe(false);
    expect(new Set(Object.values(p.byStage).map((s) => s.kind))).toEqual(new Set(["unchecked"]));
  });

  it("paints a refusal whose run-log entry names a stage on that stage, not in the banner", () => {
    const p = paint(IDS, REPLY_NOT_EXECUTABLE);
    expect(p.byStage["st-x"]).toEqual({ kind: "refused", code: "PlanNotExecutableError", message: (REPLY_NOT_EXECUTABLE.runLog![0] as RefuseEntry).error });
    expect(p.banner).toEqual([]);
  });

  it("paints an R-rule on its stage and a stage-less failure in the banner", () => {
    const p = paint(IDS, REPLY_R1);
    expect(p.byStage["st-decay"]).toEqual({ kind: "refused", code: "R1", message: REPLY_R1.routing.failures[0]!.detail });
    expect(p.banner).toEqual([{ code: "R4", message: REPLY_R1.routing.failures[1]!.detail }]);
  });

  it("when the gates never ran: stages stay unchecked, the refusal goes to the banner", () => {
    const p = paint(IDS, REPLY_NOT_RUN);
    expect(p.byStage["st-curve"]).toEqual({ kind: "unchecked" });
    expect(p.gates!.type.ran).toBe(false);
    expect(p.banner).toEqual([{ code: "UnknownDimensionError", message: REPLY_NOT_RUN.compile.detail }]);
  });

  it("never reads a not-run gate as a pass, though its checked list is not empty", () => {
    const p = paint(IDS, REPLY_NOT_RUN);
    expect(REPLY_NOT_RUN.type.checked.length).toBeGreaterThan(0);
    expect(p.gates!.routing.ran).toBe(false);
    expect(Object.values(p.byStage).some((s) => s.kind === "pass")).toBe(false);
  });

  it("shows a PlanRejected with no gate failures (a mount refusal) in the banner", () => {
    const p = paint(IDS, REPLY_MOUNT_REFUSED);
    expect(new Set(Object.values(p.byStage).map((s) => s.kind))).toEqual(new Set(["unchecked"]));
    expect(p.banner).toEqual([{ code: "PlanRejected", message: REPLY_MOUNT_REFUSED.compile.detail }]);
  });

  it("puts a notImplemented tag that names no stage in notes, not the banner", () => {
    const p = paint(IDS, REPLY_PLAN_NOTE);
    expect(p.notes).toEqual([REPLY_PLAN_NOTE.notImplemented![1]]);
    expect(p.banner).toEqual([]);
    expect(p.byStage["st-ftp"]).toEqual({ kind: "not-implemented", message: REPLY_PLAN_NOTE.notImplemented![0]!.reason });
  });

  it("keeps a stage-layer tag for a stage the canvas does not hold in notes", () => {
    const p = paint(["st-curve"], REPLY_TAG);
    expect(p.notes).toEqual(REPLY_TAG.notImplemented);
  });
});
