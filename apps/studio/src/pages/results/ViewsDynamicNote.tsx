// apps/studio/src/pages/results/ViewsDynamicNote.tsx
/**
 * Views on a run with dynamic scenarios (spec v3.1 Section 5.4). A scenario that ran new business loses its
 * cell grain in the balance stage, so the pivot answers repricing, gapPrincipal and evePv and refuses the rest
 * (contracts/results.ts, THE DYNAMIC ASYMMETRY). The refusal text itself arrives from the pivot route; this note names
 * which scenarios of the run kept the grain, read from the envelope: a scenario with no `byCell` arm on a run that
 * declared views is dynamic.
 */
import type { RunResult } from "@alm/engine";

export function viewScenarioModes(result: RunResult): { dynamic: string[]; static: string[] } {
  const cf = result.cashflows as { cells?: unknown[]; byScenario?: Array<{ scenarioId: string; byCell?: unknown[] }> } | undefined;
  if (cf === undefined || cf.cells === undefined) return { dynamic: [], static: [] };
  const out = { dynamic: [] as string[], static: [] as string[] };
  for (const s of cf.byScenario ?? []) (s.byCell === undefined ? out.dynamic : out.static).push(s.scenarioId);
  return out;
}

export function DynamicViewsNote(props: { result: RunResult; scenarioId: string }) {
  const m = viewScenarioModes(props.result);
  if (m.dynamic.length === 0) return null;
  const onDynamic = m.dynamic.includes(props.scenarioId);
  return (
    <p className="card-desc" role="note">
      On a dynamic scenario the pivot answers repricing, gapPrincipal and evePv and refuses balance, principal, interest and nii: the balance stage replaces the contractual cash flows with the projection's own, which carries no cell index.
      {onDynamic ? ` ${props.scenarioId} is dynamic in this run, so a refused metric prints the engine's own reason below.` : ""}
      {" "}Static scenarios of this run: {m.static.length === 0 ? "none, every scenario ran new business" : m.static.join(", ")}.
    </p>
  );
}
