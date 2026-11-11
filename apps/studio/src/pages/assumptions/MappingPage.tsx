// apps/studio/src/pages/assumptions/MappingPage.tsx
/**
 * Assumptions > Mapping: one grid, family and selector against the overlay kind, each cell the model version the set
 * binds there (spec v3.1 Section 3.1). Read-only over one attached set: the one the query names, else the workspace
 * default. Editing a binding is Edit a set, reached from Assumption sets.
 */
import { AssumptionReasons } from "./AssumptionReasons";
import type { WorkspaceManifest } from "@alm/reader";
import { getAssumptionSet } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { mappingGrid, type MappingGrid } from "../../assumptions/attachModel";
import { screenHref } from "../../pageLinks";

export function MappingView(props: { ws: string; setId: string | null; grid: MappingGrid | null; sets?: string[] }) {
  const { ws, setId, grid } = props;
  if (setId === null || grid === null) {
    return (
      <section className="card unobs-panel" aria-label="Mapping">
        <span className="status status-unobs">Not set</span>
        <p className="unobs-text">No assumption set is attached to this workspace, so there is nothing to map. Attach one on <a href={screenHref({ ws, section: "assumptions", screen: "sets" })}>Assumption sets</a>.</p>
      </section>
    );
  }
  return (
    <section className="card table-card" aria-label="Mapping">
      <div className="card-title">Mapping, <span className="mono">{setId}</span></div>
      {props.sets !== undefined && props.sets.length > 1 ? (
        <nav className="chip-row" aria-label="Set">
          {props.sets.map((id) => (
            <a key={id} className="pill" href={screenHref({ ws, section: "assumptions", screen: "mapping" }, { set: id })} aria-current={id === setId ? "true" : undefined}>{id}</a>
          ))}
        </nav>
      ) : null}
      {grid.rows.length === 0 ? <p className="card-desc">The set binds nothing: every family runs on its contractual terms.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th scope="col">Family</th><th scope="col">Selector</th>{grid.kinds.map((k) => <th scope="col" key={k} className="mono">{k}</th>)}</tr>
            </thead>
            <tbody>
              {grid.rows.map((r) => (
                <tr key={`${r.familyId}::${r.selector}`}>
                  <th scope="row" className="mono">{r.familyId}</th>
                  <td className="words">{r.selector}</td>
                  {r.cells.map((c, i) => (c === null ? <td key={i} className="muted">Not bound</td> : <td key={i} className="mono">{c}</td>))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-desc">
        A cell names the model version the set binds for that family and selector. A binding is changed in{" "}
        <a href={screenHref({ ws, section: "assumptions", screen: "sets" }, { set: setId })}>Edit a set</a>.
      </p>
      <p className="card-foot">Source: /api/assumption-sets/{setId} bindings[]</p>
    </section>
  );
}

export function MappingPage(props: { ws: string; head: WorkspaceManifest | null; query: Record<string, string> }) {
  const attached = props.head?.blocks.assumptions.sets.map((s) => s.id) ?? [];
  const named = props.query.set;
  const setId = named !== undefined && attached.includes(named) ? named : props.head?.blocks.assumptions.defaultSetId ?? attached[0] ?? null;
  const load = useLoad(async () => (setId === null ? null : mappingGrid(await getAssumptionSet(setId))), [setId]);
  // The reason a set reads Error sits on this screen too, above the mapping.
  const reasons = <AssumptionReasons ws={props.ws} />;
  if (setId === null) return <>{reasons}<MappingView ws={props.ws} setId={null} grid={null} /></>;
  if (load.state === "loading") return <div className="card muted">Reading {setId}</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <>{reasons}<MappingView ws={props.ws} setId={setId} grid={load.value} sets={attached} /></>;
}
