/**
 * The validate reply as paint on the graph (Studio S2). Only structured fields
 * attribute a verdict to a stage: GateFailure.stageId, a refuse run-log entry's
 * ids.stageId, and the compiler's notImplemented layer (plan.stage.<id> or
 * plan.stage.<id>.unbound, written by packages/engine/src/plan/compile.ts).
 * Free-text detail is shown, never parsed. A failure or refusal that names no
 * stage goes to the banner; a notImplemented tag that names no stage on the
 * canvas (plan.balance-plan.unused, a scenario tag) goes to notes. A gate that
 * did not run is reported as not run, never as a pass: the server fills such a
 * gate with passed false, no failures and one "gate not run" line in checked,
 * so a gate ran only when it passed or reported a failure.
 */
import type { ValidateResponse } from "@alm/reader";

export type NodeStatus =
  | { kind: "refused"; code: string; message: string }
  | { kind: "not-implemented"; message: string }
  | { kind: "pass" }
  | { kind: "unchecked" };

export interface GateSummary {
  passed: boolean;
  ran: boolean;
  failures: number;
  checked: number;
}

export interface Paint {
  byStage: Record<string, NodeStatus>;
  /** Gate failures and compile refusals that name no stage on the canvas. */
  banner: Array<{ code: string; message: string }>;
  /** notImplemented tags whose layer names no stage on the canvas, verbatim; empty before any reply. */
  notes: Array<{ layer: string; reason: string }>;
  gates: { type: GateSummary; routing: GateSummary; compile: { passed: boolean; detail?: string; error?: string } } | null;
}

const LAYER = /^plan\.stage\.(.+?)(\.unbound)?$/;

export function stageOfLayer(layer: string): string | null {
  const m = LAYER.exec(layer);
  return m === null || m[1] === "" ? null : m[1]!;
}

type Report = ValidateResponse["type"];
const ran = (r: Report) => r.passed || r.failures.length > 0;
const summary = (r: Report): GateSummary => ({ passed: r.passed, ran: ran(r), failures: r.failures.length, checked: r.checked.length });

interface RefuseEntry { t: string; error?: string; ids?: Record<string, string> }

export function paint(stageIds: readonly string[], reply: ValidateResponse | null): Paint {
  const byStage: Record<string, NodeStatus> = {};
  for (const id of stageIds) byStage[id] = { kind: "unchecked" };
  if (reply === null) return { byStage, banner: [], notes: [], gates: null };

  const banner: Paint["banner"] = [];
  const notes: Paint["notes"] = [];
  const gatesRan = ran(reply.type) && ran(reply.routing);
  const refuse = (id: string, code: string, message: string) => {
    if (byStage[id]?.kind !== "refused") byStage[id] = { kind: "refused", code, message };
  };

  const gateFailures = [...reply.type.failures, ...reply.routing.failures];
  for (const f of gateFailures) {
    if (f.stageId !== null && f.stageId in byStage) refuse(f.stageId, f.rule, f.detail);
    else banner.push({ code: f.rule, message: f.detail });
  }
  let stageRefusal = false;
  for (const e of (reply.runLog ?? []) as RefuseEntry[]) {
    const id = e.t === "refuse" ? e.ids?.stageId : undefined;
    if (id !== undefined && id in byStage) {
      refuse(id, reply.compile.error ?? "refused", e.error ?? "");
      stageRefusal = true;
    }
  }
  // PlanRejected restates gate failures already painted or bannered; with none
  // (a profile that will not mount) its detail is the only reason, so show it.
  const restatesGates = reply.compile.error === "PlanRejected" && gateFailures.length > 0;
  if (!reply.compile.passed && !restatesGates && !stageRefusal) {
    banner.push({ code: reply.compile.error ?? "compile", message: reply.compile.detail ?? "" });
  }
  for (const n of reply.notImplemented ?? []) {
    const id = stageOfLayer(n.layer);
    if (id === null || !(id in byStage)) notes.push(n);
    else if (byStage[id]!.kind !== "refused") byStage[id] = { kind: "not-implemented", message: n.reason };
  }
  if (gatesRan) {
    for (const id of stageIds) if (byStage[id]!.kind === "unchecked") byStage[id] = { kind: "pass" };
  }
  return { byStage, banner, notes, gates: { type: summary(reply.type), routing: summary(reply.routing), compile: reply.compile } };
}
