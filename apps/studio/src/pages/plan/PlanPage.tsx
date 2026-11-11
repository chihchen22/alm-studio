// apps/studio/src/pages/plan/PlanPage.tsx
/**
 * The compiled chain of a stored plan, read-only. The model chain canvas retired as an editor:
 * the run setup is the editor (Run > Run setups). This page keeps what other screens still import from it (the gate
 * bar, the plan option text, the stored-plan Run button rule) and renders the stored plan's stages through the same
 * read-only panel the setup summary strip uses. It carries no edit, swap, wire, view or save control, and the page
 * is not on a route of its own: the run setup editor's summary strip mounts `CompiledChainPanel`, and nothing mounts this page.
 */
import { getRunPlan, type RunPlanMeta } from "@alm/reader";
import { useLoad } from "../../useLoad";
import { editsText } from "../../plan/planEdits";
import { CompiledChainPanel } from "../../run/CompiledChainPanel";
import { defaultPlanId, loadPlanPage } from "./loadPlan";
import { GateBar } from "./GateBar";
import { pageErrText } from "../../errText";
import { MACRO_PATH_NOTE } from "../../market/macroModel";

export { GateBar, editsText };

/**
 * A plan selector option: the id first, then "(seeded)" where it applies, then the stored label when it differs from
 * the id, so saved plans that share a label are told apart.
 */
export function planOptionText(p: RunPlanMeta): string {
  const label = p.label !== undefined && p.label !== "" && p.label !== p.id ? ` · ${p.label}` : "";
  return `${p.id}${p.seeded ? " (seeded)" : ""}${label}`;
}

/** The Run button rule for a stored plan: a run always runs a stored plan, so it waits while the page holds edits. */
export function runButton(edits: number): { disabled: boolean; title: string } {
  return edits > 0 ? { disabled: true, title: "Save as first" } : { disabled: false, title: "Run this stored plan" };
}

function StoredPlanChain(props: { planId: string }) {
  const load = useLoad(() => getRunPlan(props.planId), [props.planId]);
  if (load.state === "loading") return <div className="card muted">{`Reading plan ${props.planId}`}</div>;
  if (load.state === "error") return <div className="card" role="alert">{pageErrText(load.error)}</div>;
  return (
    <>
      <p className="card-desc muted">{MACRO_PATH_NOTE}</p>
      <CompiledChainPanel stages={load.value.stages} gates={null} />
    </>
  );
}

export function PlanPage(props: { ws: string; bookId: string | null; query: Record<string, string> }) {
  const load = useLoad(() => loadPlanPage(), []);
  if (load.state === "loading") return <div className="card muted">Reading the plan store</div>;
  if (load.state === "error") return <div className="card" role="alert">{pageErrText(load.error)}</div>;
  const id = defaultPlanId(load.value.plans, props.bookId, props.query.plan);
  if (id === null) {
    return (
      <div className="card unobs-panel">
        <span className="status status-unobs">Unobservable</span>
        <p className="unobs-text">No run plan stored: /api/run-plans returned none. Run the seed to store the demo plans.</p>
      </div>
    );
  }
  return <StoredPlanChain planId={id} />;
}
