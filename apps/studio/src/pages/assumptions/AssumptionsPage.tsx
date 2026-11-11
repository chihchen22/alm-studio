// apps/studio/src/pages/assumptions/AssumptionsPage.tsx
/**
 * Assumptions route (Studio S3b): build a BAU-plus-stress stack from stored
 * sets, read the resulting bindings, see the route's diff against the base and
 * store the flat stack as an ordinary set. The query carries the stack (base,
 * layers bottom to top, off), so a stack is a link. Nothing here computes a
 * number: the tables print stored fields and route replies as text.
 */
import { AssumptionReasons } from "./AssumptionReasons";
import { useRef, useState } from "react";
import type { AssumptionSet } from "@alm/engine";
import { listAssumptionSets, type AssumptionSetListItem, type WorkspaceManifest } from "@alm/reader";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { bindingRows, loadStack, saveStack, stackMappedGap, type SaveOutcome } from "../../assumptions/stackModel";
import { BindingsTable, DiffTable, LayerList, SaveBar, SetPicker, idList } from "./AssumptionsViews";
import { useBy } from "../../controls/ByName";
import { AttachedSets } from "./AttachedSets";
import { RoutingPolicyCard } from "./RoutingPolicyCard";

const DEFAULT_BASE = "demo-behavioral-v1";

/** The base: the query's when it names one, else demo-behavioral-v1 when listed, else the first listed set. */
export function defaultBaseId(sets: AssumptionSetListItem[], queried: string | undefined): string {
  if (queried !== undefined && queried !== "") return queried;
  return sets.some((s) => s.id === DEFAULT_BASE) ? DEFAULT_BASE : sets[0].id;
}

/** The last save, kept with the id it was for so it never shows against another stack. */
export type SavedNote = { forId: string; outcome: SaveOutcome } | null;

function StackEditor(props: {
  ws: string;
  sets: AssumptionSetListItem[];
  query: Record<string, string>;
  saved: SavedNote;
  busy: boolean;
  onSave(set: AssumptionSet): void;
}) {
  const baseId = defaultBaseId(props.sets, props.query.base);
  const layers = idList(props.query.layers);
  const off = idList(props.query.off);
  const active = layers.filter((id) => !off.includes(id));
  const load = useLoad(() => loadStack(baseId, active), [baseId, active.join(",")]);
  const stackProps = { ws: props.ws, sets: props.sets, baseId, layers, off, query: props.query };

  let body;
  if (load.state === "loading") {
    body = <div className="card muted">Reading the stack</div>;
  } else if (load.state === "error") {
    body = <div className="card" role="alert">{errText(load.error)}</div>;
  } else if (load.value.kind === "refused") {
    body = <div className="card" role="alert">{load.value.text}</div>;
  } else {
    const { flat, diff } = load.value;
    const outcome = props.saved !== null && props.saved.forId === flat.set.id ? props.saved.outcome : null;
    body = (
      <>
        <section className="card" aria-label="Resulting bindings">
          <div className="card-title">Resulting bindings</div>
          <BindingsTable rows={bindingRows(flat.rows, baseId)} />
          <p className="card-foot">Source: /api/assumption-sets/{"<id>"} for each set</p>
        </section>
        <section className="card" aria-label="Diff against the base">
          <div className="card-title">Diff against the base <span className="mono">{baseId}</span></div>
          <DiffTable diff={diff} baseId={baseId} layersOn={active.length} />
          {active.length > 0 ? <p className="card-foot">Source: POST /api/assumption-sets/diff</p> : null}
        </section>
        <section className="card" aria-label="Save stack">
          <SaveBar ws={props.ws} setId={flat.set.id} layersOn={active.length} busy={props.busy} block={stackMappedGap(flat.set)} outcome={outcome} query={props.query} onSave={() => props.onSave(flat.set)} />
        </section>
      </>
    );
  }

  return (
    <>
      <section className="card" aria-label="Stack">
        <div className="card-title">Stack</div>
        <SetPicker {...stackProps} />
        <LayerList {...stackProps} />
      </section>
      {body}
    </>
  );
}

/** The page below the set list: the empty store's reason, else the stack editor. */
export function AssumptionsBody(props: {
  ws: string;
  sets: AssumptionSetListItem[];
  query: Record<string, string>;
  saved: SavedNote;
  busy: boolean;
  onSave(set: AssumptionSet): void;
}) {
  if (props.sets.length === 0) {
    return (
      <div className="card unobs-panel">
        <span className="status status-unobs">Unobservable</span>
        <p className="unobs-text">No assumption set stored: run the seed.</p>
      </div>
    );
  }
  return <StackEditor {...props} />;
}

/**
 * The Assumption sets screen: the sets this workspace holds with the attach and default controls, the routing policy
 * card, then the stack editor over every stored set. `head` is the workspace head (null while it is not read); `onChanged` rereads it.
 * Reached with `focus=routing-policy` (Overview's Next step), the routing policy card scrolls into view once per visit: the
 * record lives here, because the card is remounted while the set list is read again after a stack is saved.
 */
export function AssumptionsPage(props: { ws: string; head?: WorkspaceManifest | null; onChanged?: () => void; query: Record<string, string> }) {
  const [refresh, setRefresh] = useState(0);
  const [saved, setSaved] = useState<SavedNote>(null);
  const [busy, setBusy] = useState(false);
  const list = useLoad(() => listAssumptionSets(), [refresh]);
  const byState = useBy();
  const arrived = useRef(false);

  if (list.state === "loading") return <div className="card muted">Reading the assumption sets</div>;
  if (list.state === "error") return <div className="card" role="alert">{errText(list.error)}</div>;

  const onSave = async (set: AssumptionSet) => {
    setBusy(true);
    const outcome = await saveStack(set);
    setBusy(false);
    setSaved({ forId: set.id, outcome });
    // A new set joins the list, so it can be picked as a base.
    if (outcome.kind === "saved") setRefresh((n) => n + 1);
  };
  return (
    <>
      {/* The reason a set reads Error, on the screen where sets are attached. */}
      <AssumptionReasons ws={props.ws} />
      {props.head === undefined || props.head === null ? null : (
        <>
          <AttachedSets head={props.head} stored={list.value.map((s) => ({ id: s.id, label: s.label }))} onChanged={props.onChanged ?? (() => {})} byState={byState} />
          <RoutingPolicyCard head={props.head} byState={byState} onChanged={props.onChanged ?? (() => {})} arrival={{ focus: props.query.focus, done: arrived }} />
        </>
      )}
      <AssumptionsBody ws={props.ws} sets={list.value} query={props.query} saved={saved} busy={busy} onSave={(s) => void onSave(s)} />
    </>
  );
}
