// apps/studio/src/pages/assumptions/ByKindPage.tsx
/** One behavioral kind across every stored set, read-only. Each set's column links to Edit a set. */
import type { AssumptionSet } from "@alm/engine";
import { getAssumptionSet, getPluginCatalog, listAssumptionSets, type WorkspaceManifest } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { useMemo, useRef, type CSSProperties } from "react";
import { byKindModel, identityWidths, IDENTITY_LABELS, KIND_OF_LAYER, type ByKindLayer, type ByKindModel } from "../../assumptions/byKindModel";
import { HarnessFrame } from "../../harness/HarnessFrame";
import { behavioralInstances, behavioralMethods, type CatalogLike } from "../../harness/instances";
import { overlayKindOf } from "@alm/engine/src/contracts/assumptions";
import { screenHref } from "../../pageLinks";
import type { ScreenId } from "../../router";
import { editHref, macroMappingLines } from "../../assumptions/setEditModel";
import { MacroMappingRow } from "./EditSetPage";
import { LeafCell } from "../../format/LeafCell";
// The box ends on a whole row through the fit By kind shares with the Govern inventory (Polish 7 T3, Polish 8 T2).
import { useWholeRows } from "../../layout/wholeRows";

export function ByKindView(props: { ws: string; kinds: string[]; model: ByKindModel; query: Record<string, string> }) {
  const { model } = props;
  const wrap = useRef<HTMLDivElement>(null);
  useWholeRows(wrap, model);
  if (model.columns.length === 0) {
    return <section className="card unobs-panel"><span className="status status-unobs">Unobservable</span><p className="unobs-text">No stored set binds {props.kinds.join(" or ")}.</p></section>;
  }
  // The identity widths this page's own text needs (Task 6 fix I2); app.css falls back to 240, 168 and 232 px.
  const w = identityWidths(model.rows);
  const widths = { "--w1": `${w.w1}px`, "--w2": `${w.w2}px`, "--w3": `${w.w3}px` } as CSSProperties;
  return (
    <section className="card table-card" aria-label="Parameters by set">
      <div className="card-title">Stored parameters, {props.kinds.join(" and ")}</div>
      <p className="card-desc">One column per stored set that binds this kind. Values print as stored, by stored path; a number from 1,000 up is grouped in threes, with the stored text in its title. Edit opens the set in Edit a set, which labels each field with its unit and bounds.</p>
      <div className="table-wrap" ref={wrap}>
        {/* by-kind: the identity columns stay in view at this page's widths and a set header wraps (app.css, Polish 6 T2). */}
        <table className="table by-kind" style={widths}>
          <thead><tr>{IDENTITY_LABELS.map((l) => <th scope="col" key={l}>{l}</th>)}{model.columns.map((c) => (
            <th scope="col" key={c.id} className="num" title={c.label}>{c.id} <a href={editHref(props.ws, props.query, c.id)} aria-label={`Edit ${c.id}`}>Edit</a></th>
          ))}</tr></thead>
          <tbody>
            {model.rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" className="mono">{r.familyId}</th>
                {/* Selector words, not an identifier: the body font (Polish 3 T2). */}
                <td className="words">{r.selector}</td>
                <td className="mono">{r.path}</td>
                {/* A stored leaf prints as on the Stack diff; an absence word is muted, in the body face (Polish 5 T1), through the same cell (Task 6 fix I1). Every set cell is 12 px on one line. */}
                {r.cells.map((c, i) => <LeafCell key={i} leaf={c} />)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The row count, as text: the box ends on a whole row, so this line says how many rows it holds; the bar allows no fade or shadow as the cue (Polish 7 Task 4 I3, ruling 2026-09-29). */}
      <p className="table-foot">{model.rows.length} {model.rows.length === 1 ? "row" : "rows"}</p>
      <p className="card-foot">Source: /api/assumption-sets and /api/assumption-sets/:id bindings[].overlay</p>
    </section>
  );
}

/**
 * Beside the housing.* leaves the table already walks, each mapped set's Macro mapping row. Prepayment
 * only, the one kind a macro series feeds; props only.
 */
export function ByKindMapping(props: { kinds: string[]; sets: ReadonlyArray<Pick<AssumptionSet, "id" | "macroBindings">> }) {
  if (!props.kinds.includes("prepay")) return null;
  return <>{props.sets.filter((s) => macroMappingLines(s.macroBindings).length > 0).map((s) => <MacroMappingRow key={s.id} setId={s.id} lines={macroMappingLines(s.macroBindings)} />)}</>;
}

/** The screen each by-kind layer sits on, for the frame's instance links. */
const SCREEN_OF_LAYER: Record<ByKindLayer, ScreenId> = {
  "data/assumptions/prepay": "prepay",
  "data/assumptions/decay": "decay",
  "data/assumptions/deposit-repricing": "deposit-repricing",
  "data/assumptions/renewal-draws": "renewals-draws",
  "data/assumptions/loan-repricing": "loan-client-rate",
};

const NO_CATALOG: CatalogLike = { components: [], mounted: [] };

/** The harness frame of the workspace default set, over the kinds of this page: one instance per binding. */
function BehavioralFrame(props: { ws: string; layer: ByKindLayer; kinds: string[]; sets: AssumptionSet[]; head: WorkspaceManifest; query: Record<string, string> }) {
  const catalog = useLoad(() => getPluginCatalog().catch(() => NO_CATALOG), []);
  const setId = props.head.blocks.assumptions.defaultSetId;
  const set = props.sets.find((s) => s.id === setId);
  if (set === undefined) return null;
  const mine = { id: set.id, bindings: set.bindings.filter((b) => props.kinds.includes(overlayKindOf(b.overlay))) };
  const setups = props.head.blocks.run.setups.map((s) => s.setupLineageId);
  return (
    <HarnessFrame
      module="behavioral"
      instances={behavioralInstances(mine, { setups })}
      methods={behavioralMethods(catalog.state === "ok" ? catalog.value : NO_CATALOG)}
      selected={props.query.instance ?? null}
      hrefOf={(id) => screenHref({ ws: props.ws, section: "assumptions", screen: SCREEN_OF_LAYER[props.layer] }, { ...props.query, instance: id })}
    />
  );
}

export function ByKindPage(props: { ws: string; head?: WorkspaceManifest | null; layer: ByKindLayer; query: Record<string, string> }) {
  const kinds = KIND_OF_LAYER[props.layer];
  const load = useLoad(async () => {
    const list = await listAssumptionSets();
    return Promise.all(list.map((s) => getAssumptionSet(s.id)));
  }, []);
  // Built once per loaded sets and kinds, so the box's fit runs again only when the model changes (Polish 8 T3).
  const sets = load.state === "ok" ? load.value : null;
  const model = useMemo(() => (sets === null ? null : byKindModel(sets, kinds)), [sets, kinds]);
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  if (model === null) return <div className="card muted">Reading the assumption sets</div>;
  // A set that maps a macro series adds its Macro mapping row under the table, on the prepayment layer.
  const head = props.head ?? null;
  const frame = head === null ? null : <BehavioralFrame ws={props.ws} layer={props.layer} kinds={kinds} sets={sets ?? []} head={head} query={props.query} />;
  if (!kinds.includes("prepay") || !(sets ?? []).some((s) => s.macroBindings !== undefined)) {
    return (
      <>
        <ByKindView ws={props.ws} kinds={kinds} model={model} query={props.query} />
        {frame}
      </>
    );
  }
  return (
    <>
      <ByKindView ws={props.ws} kinds={kinds} model={model} query={props.query} />
      <ByKindMapping kinds={kinds} sets={sets ?? []} />
      {frame}
    </>
  );
}
