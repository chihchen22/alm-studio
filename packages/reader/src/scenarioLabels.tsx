/**
 * Scenario display labels, provided once from the bundle's scenario metadata so
 * every panel names a scenario the same way. Kept as context rather than a prop
 * threaded through six components: the label is ambient display vocabulary, not
 * an input any panel computes with.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { GeneratedFrom } from "./types";
import { formatScenarioLabel } from "./format";

type ScenarioMeta = GeneratedFrom["scenarios"][number];

/** No provider means no metadata, so the id is the honest thing to show. */
const ScenarioLabelContext = createContext<(id: string) => string>((id) => id);

export function ScenarioLabelProvider({
  scenarios,
  children,
}: {
  scenarios: ScenarioMeta[];
  children: ReactNode;
}) {
  const label = useMemo(() => {
    const map = new Map(scenarios.map((s) => [s.id, s]));
    return (id: string) => formatScenarioLabel(map.get(id), id);
  }, [scenarios]);
  return <ScenarioLabelContext.Provider value={label}>{children}</ScenarioLabelContext.Provider>;
}

/**
 * The scenario labeller. Degrades to identity when no provider is above it: a
 * read-only viewer should render the raw id, not blank the page.
 */
export function useScenarioLabel(): (id: string) => string {
  return useContext(ScenarioLabelContext);
}
