// apps/studio/src/pages/assumptions/AssumptionsViews.tsx
/**
 * Assumptions page views (Studio S3b), props only: the base picker, the layer
 * list, the resulting bindings, the diff against the base and the save bar.
 * Nothing here fetches or computes a number; every cell is a stored field or a
 * route reply turned into text by the view model. Every stack control writes
 * the hash, so a stack is a link.
 */
import { isStackId, type AssumptionSetListItem } from "@alm/reader";
import { screenHref } from "../../pageLinks";
import type { BindingRowView, DeltaRowView, SaveOutcome } from "../../assumptions/stackModel";
import { LeafCell } from "../../format/LeafCell";

/** The page's own query keys; every other key passes through. */
const STACK_KEYS = ["base", "layers", "off"] as const;

function withoutStackKeys(query: Record<string, string>): Record<string, string> {
  const next = { ...query };
  for (const k of STACK_KEYS) delete next[k];
  return next;
}

/** Splits a comma list query value; an absent or empty value is no id. */
export function idList(value: string | undefined): string[] {
  return value === undefined ? [] : value.split(",").filter((s) => s !== "");
}

/** The Assumptions href for one stack. An off id not among the layers is dropped; empty lists are left out. */
export function stackHref(ws: string, query: Record<string, string>, baseId: string, layers: string[], off: string[]): string {
  const q: Record<string, string> = { ...withoutStackKeys(query), base: baseId };
  if (layers.length > 0) q.layers = layers.join(",");
  const offIn = off.filter((id) => layers.includes(id));
  if (offIn.length > 0) q.off = offIn.join(",");
  return screenHref({ ws, section: "assumptions", screen: "sets" }, q);
}

/** The scenario choice of Run setups with a saved set preselected (it reads query.set). */
export function scenariosHref(ws: string, query: Record<string, string>, setId: string): string {
  return screenHref({ ws, section: "run", screen: "setups" }, { ...withoutStackKeys(query), tab: "scenarios", set: setId });
}

const optionText = (s: AssumptionSetListItem): string => (s.label !== "" && s.label !== s.id ? `${s.id}: ${s.label}` : s.id);

interface StackProps {
  ws: string;
  sets: AssumptionSetListItem[];
  baseId: string;
  layers: string[];
  off: string[];
  query: Record<string, string>;
}

export function SetPicker(props: StackProps) {
  const choose = (id: string) => {
    window.location.hash = stackHref(props.ws, props.query, id, props.layers.filter((l) => l !== id), props.off);
  };
  return (
    <label className="field">
      <span className="field-label">Base set</span>
      <select value={props.baseId} onChange={(e) => choose(e.target.value)}>
        {props.sets.map((s) => <option key={s.id} value={s.id}>{optionText(s)}</option>)}
      </select>
    </label>
  );
}

function swap(list: string[], i: number, j: number): string[] {
  const next = [...list];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

/** A control that writes the hash when it can act, and a disabled button when it cannot. */
function HashControl(props: { href: string | null; label: string }) {
  return props.href === null
    ? <button type="button" className="btn btn-quiet" disabled>{props.label}</button>
    : <a className="btn btn-quiet" href={props.href}>{props.label}</a>;
}

/**
 * The layers, top of the stack first; the base sits under the last one. Up
 * moves a layer higher in the stack (it wins over the layers below it).
 */
export function LayerList(props: StackProps) {
  const { layers, off } = props;
  const href = (nextLayers: string[], nextOff: string[]) => stackHref(props.ws, props.query, props.baseId, nextLayers, nextOff);
  const stacks = props.sets.filter((s) => isStackId(s.id));
  const addable = props.sets.filter((s) => !isStackId(s.id) && s.id !== props.baseId && !layers.includes(s.id));
  const add = (id: string) => {
    if (id !== "") window.location.hash = href([...layers, id], off);
  };
  const order = layers.map((id, i) => ({ id, i })).reverse();
  return (
    <div className="stack">
      <div className="run-sub">Layers, top of the stack first</div>
      {layers.length === 0 ? (
        <p className="card-desc">No layer: the stack is the base alone.</p>
      ) : (
        <ol className="list">
          {order.map(({ id, i }) => {
            const isOff = off.includes(id);
            return (
              <li key={id}>
                <span className="mono">{id}</span>{" "}
                {isOff ? <span className="status status-unobs">Off</span> : <span className="status status-pass">On</span>}{" "}
                <HashControl label="Up" href={i < layers.length - 1 ? href(swap(layers, i, i + 1), off) : null} />
                <HashControl label="Down" href={i > 0 ? href(swap(layers, i, i - 1), off) : null} />
                <HashControl label={isOff ? "Turn on" : "Turn off"} href={href(layers, isOff ? off.filter((o) => o !== id) : [...off, id])} />
                <HashControl label="Remove" href={href(layers.filter((l) => l !== id), off.filter((o) => o !== id))} />
              </li>
            );
          })}
        </ol>
      )}
      <p className="card-desc">Base: <span className="mono">{props.baseId}</span></p>
      {addable.length === 0 ? (
        <p className="card-desc">Add layer: no other stored set to add.</p>
      ) : (
        <label className="field">
          <span className="field-label">Add layer</span>
          <select value="" onChange={(e) => add(e.target.value)}>
            <option value="">Pick a stored set</option>
            {addable.map((s) => <option key={s.id} value={s.id}>{optionText(s)}</option>)}
          </select>
        </label>
      )}
      {stacks.length > 0 ? (
        <p className="card-desc">
          Stored stacks can be a base, not a layer: {stacks.map((s, k) => <span key={s.id}>{k > 0 ? ", " : ""}<span className="mono">{s.id}</span></span>)}.
        </p>
      ) : null}
    </div>
  );
}

export function BindingsTable(props: { rows: BindingRowView[] }) {
  if (props.rows.length === 0) return <p className="card-desc">The stack binds nothing: the base and its layers hold no binding.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th scope="col">Family</th><th scope="col">Kind</th><th scope="col">Selector</th><th scope="col">Model version</th><th scope="col">Source set</th></tr>
        </thead>
        <tbody>
          {props.rows.map((r) => (
            <tr key={`${r.familyId}::${r.kind}::${r.selector}`}>
              <th scope="row" className="mono">{r.familyId}</th>
              <td className="mono">{r.kind}</td>
              {/* Selector words, not an identifier: the body font (Polish 3 T2). */}
              <td className="words">{r.selector}</td>
              <td className="mono">{r.modelVersion}</td>
              <td><span className="mono">{r.sourceId}</span>{r.fromLayer ? <> <span className="chip chip-edited">layer</span></> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export type DiffView = { kind: "ok"; rows: DeltaRowView[] } | { kind: "error"; text: string };

// A stored leaf's cell, LeafCell, lives beside the leaf formatter in format/LeafCell.tsx (Polish 6 T5).

export function DiffTable(props: { diff: DiffView; baseId: string; layersOn: number }) {
  if (props.layersOn === 0) return <p className="card-desc">No layer on: the stack is the base.</p>;
  const d = props.diff;
  if (d.kind === "error") return <p className="card-desc" role="alert">{d.text}</p>;
  if (d.rows.length === 0) {
    return <p className="card-desc">The route returned no delta: the stack binds what <span className="mono">{props.baseId}</span> binds.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr><th scope="col">Family</th><th scope="col">Kind</th><th scope="col">Selector</th><th scope="col">Path</th><th scope="col">Change</th><th scope="col" className="num">From</th><th scope="col" className="num">To</th></tr>
        </thead>
        <tbody>
          {d.rows.map((r, i) => (
            <tr key={i}>
              <th scope="row" className="mono">{r.familyId}</th>
              <td className="mono">{r.kind}</td>
              <td className="words">{r.selector}</td>
              <td className="mono">{r.path}</td>
              <td className="words">{r.change}</td>
              <LeafCell leaf={r.from} />
              <LeafCell leaf={r.to} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SaveNote(props: { ws: string; outcome: SaveOutcome | null; query: Record<string, string> }) {
  const o = props.outcome;
  if (o === null) return null;
  switch (o.kind) {
    case "saved":
      return <span>Saved as <span className="mono">{o.id}</span>. <a href={scenariosHref(props.ws, props.query, o.id)}>Use in scenarios</a></span>;
    case "already-saved":
      return <span><span className="mono">{o.id}</span> already saved. <a href={scenariosHref(props.ws, props.query, o.id)}>Use in scenarios</a></span>;
    case "conflict":
      return <span role="alert">Not saved: <span className="mono">{o.id}</span> is stored with different bindings. {o.text}</span>;
    case "refused":
      return <span role="alert">Not saved: {o.text}</span>;
  }
}

export function SaveBar(props: {
  ws: string;
  setId: string;
  layersOn: number;
  busy: boolean;
  /** Why Save is held off by the stack's own content (stackMappedGap), else null or absent. */
  block?: string | null;
  outcome: SaveOutcome | null;
  query: Record<string, string>;
  onSave(): void;
}) {
  const none = props.layersOn === 0;
  const block = props.block ?? null;
  const reasonId = "reason-save-stack";
  return (
    <div className="plan-toolbar">
      <button
        type="button"
        className="btn btn-primary"
        disabled={none || props.busy || block !== null}
        title={none ? "Add a layer to make a stack" : undefined}
        aria-describedby={block !== null ? reasonId : undefined}
        onClick={props.onSave}
      >
        {`Save stack ${props.setId}`}
      </button>
      {block !== null ? <span className="muted" id={reasonId} role="status">{block}</span> : null}
      <SaveNote ws={props.ws} outcome={props.outcome} query={props.query} />
    </div>
  );
}
