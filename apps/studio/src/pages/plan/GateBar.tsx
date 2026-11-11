// apps/studio/src/pages/plan/GateBar.tsx
/**
 * The gate bar (Studio S2, moved out of PlanPage for S3a so the Run page's
 * confirm sheet reuses it without loading the canvas). Failures and check
 * lines are different units (a failure is one per stage and rule, a check line
 * one per rule the gate walked), so they print apart, never as a ratio. A gate
 * that did not run shows no counts.
 */
import type { Paint } from "../../plan/gatePaint";
import type { ValidateState } from "./useValidate";

const countText = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;

export function GateBar(props: { v: ValidateState; gates: Paint["gates"] }) {
  const { v, gates } = props;
  if (v.state === "idle" || v.state === "checking") return <div className="gate-bar"><span className="status status-stale">… Checking</span></div>;
  if (v.state === "unavailable") return <div className="gate-bar" role="alert"><span className="status status-unobs">○ Validation unavailable</span> {v.message}</div>;
  if (v.state === "shape") return <div className="gate-bar" role="alert"><span className="status status-breach">✕ Malformed plan</span> {v.message}</div>;
  const g = gates!;
  const cell = (name: string, s: { passed: boolean; ran: boolean; failures: number; checked: number }) =>
    !s.ran
      ? <span className="status status-unobs">○ {name}: not run</span>
      : <span className={s.passed ? "status status-pass" : "status status-breach"}>{s.passed ? "✓" : "✕"} {name}: {countText(s.failures, "failure")}, {countText(s.checked, "check line")}</span>;
  return (
    <div className="gate-bar">
      {cell("Type gate", g.type)}
      {cell("Routing gate", g.routing)}
      <span className={g.compile.passed ? "status status-pass" : "status status-breach"}>{g.compile.passed ? "✓ Compile" : `✕ Compile: ${g.compile.error ?? "refused"}`}</span>
    </div>
  );
}
