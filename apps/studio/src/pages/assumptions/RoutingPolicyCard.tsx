// apps/studio/src/pages/assumptions/RoutingPolicyCard.tsx
/**
 * Assumptions > Routing policy: the policy this workspace holds and a control to attach another stored one. The
 * routing policy says which model handles each class of position; Validate refuses a setup while none is attached. A
 * workspace made before the create route pinned the seeded policy, or one whose policy the analyst wants to swap, uses
 * this card. The write is the same block route the sets card uses, at the head revision; the server's refusal is
 * printed in its own words.
 */
import { useEffect, useId, useRef, useState } from "react";
import { listRoutingPolicies, type WorkspaceManifest } from "@alm/reader";
import { ByField } from "../../controls/ByName";
import { attachWhy, optionText, useBlockWrite } from "../../controls/AttachStored";
import { errText } from "../../errText";
import { useLoad } from "../../useLoad";
import { policyBlock, routingPolicyBody } from "../../assumptions/attachModel";
import { focusOnArrival, prefersReducedMotion, type Arrival } from "../../assumptions/arrivalFocus";

export interface PolicyOption {
  id: string;
  label: string;
}

export function RoutingPolicyView(props: {
  /** The policy attached now, or null when none is. */
  current: PolicyOption | null;
  /** Stored policies: the attach choices (the attached one is left out). */
  stored: PolicyOption[];
  by: string;
  busy: boolean;
  note: string | null;
  /** Why the control is off (a locked, archived or superseded workspace); null when it can be used. */
  blocked: string | null;
  /** How the screen was reached: with `focus=routing-policy` the card scrolls into view and takes focus once. */
  arrival?: Arrival;
  onAttach(id: string): void;
  onBy(v: string): void;
}) {
  const { current } = props;
  const choices = props.stored.filter((p) => current === null || p.id !== current.id);
  const [pick, setPick] = useState("");
  const named = props.by.trim() !== "";
  const off = props.busy || props.blocked !== null;
  const blocked = pick === "" || !named || off;
  const hintId = useId();
  // The book and market controls' sentence, "Pick a stored ... first."; the field keeps its shorter label.
  const why = attachWhy({ selectLabel: "Attach a stored routing policy", pick, choices: choices.length, named, busy: off });
  const card = useRef<HTMLElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const select = useRef<HTMLSelectElement>(null);
  const { arrival } = props;
  useEffect(() => {
    if (arrival === undefined || card.current === null || heading.current === null || select.current === null) return;
    focusOnArrival(arrival, { card: card.current, select: select.current, heading: heading.current }, prefersReducedMotion());
  }, [arrival?.focus, arrival?.ready, arrival?.done]);
  return (
    <section className="card" aria-label="Routing policy" ref={card}>
      <div className="card-title" tabIndex={-1} ref={heading}>Routing policy</div>
      <p className="card-desc">The routing policy says which model handles each class of position.</p>
      {current === null ? (
        <p className="card-desc">None attached. Validate needs one.</p>
      ) : (
        <ul className="list">
          <li><span className="mono">{current.id}</span>{current.label !== "" && current.label !== current.id ? <> <span className="muted">{current.label}</span></> : null}</li>
        </ul>
      )}
      {props.blocked !== null ? <p className="field-help" role="status">{props.blocked}</p> : null}
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Attach a routing policy</span>
          <select ref={select} aria-label="Stored routing policy to attach" disabled={off || choices.length === 0} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{choices.length === 0 ? "No other stored policy" : "Pick a stored policy"}</option>
            {choices.map((p) => <option key={p.id} value={p.id}>{optionText(p)}</option>)}
          </select>
        </label>
        <ByField value={props.by} onChange={props.onBy} disabled={off} />
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-disabled={blocked ? true : undefined} aria-describedby={why !== null ? hintId : undefined} onClick={blocked ? undefined : () => { props.onAttach(pick); setPick(""); }}>Attach</button>
        {props.busy ? <span className="muted" role="status">Saving</span> : null}
        {why !== null ? <span className="muted" id={hintId}>{why}</span> : null}
        {props.note !== null ? <span role="status">{props.note}</span> : null}
      </div>
      <p className="card-foot">Source: /api/workspaces/{"<id>"} blocks.assumptions.routingPolicy, /api/routing-policies</p>
    </section>
  );
}

/**
 * The card with its calls: the stored policies are listed once per workspace; a pick is a `set` at the head revision,
 * then the head is read again. `arrival` is the page's: the card is ready for it once the stored policies are read.
 */
export function RoutingPolicyCard(props: { head: WorkspaceManifest; byState: [string, (v: string) => void]; onChanged(): void; arrival?: Omit<Arrival, "ready"> }) {
  const { head } = props;
  const [by, setBy] = props.byState;
  const w = useBlockWrite(head.id, props.onChanged);
  const load = useLoad(() => listRoutingPolicies(), [head.id]);
  const stored: PolicyOption[] = load.state === "ok" ? load.value.map((p) => ({ id: p.id, label: p.label ?? "" })) : [];
  const ref = head.blocks.assumptions.routingPolicy;
  const current: PolicyOption | null = ref === null ? null : (stored.find((p) => p.id === ref.id) ?? { id: ref.id, label: "" });
  const note = w.note !== null ? w.note : load.state === "error" ? errText(load.error) : null;
  return (
    <RoutingPolicyView
      current={current} stored={stored} by={by} busy={w.busy} note={note}
      blocked={policyBlock(head)} onBy={setBy}
      arrival={props.arrival === undefined ? undefined : { ...props.arrival, ready: load.state !== "loading" }}
      onAttach={(id) => void w.write(routingPolicyBody(head, id, by.trim()), `Attached ${id}`)}
    />
  );
}
