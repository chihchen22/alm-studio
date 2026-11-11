// apps/studio/src/pages/assumptions/AttachedSets.tsx
/**
 * Assumptions > Assumption sets: the sets this workspace holds, the attach control and the workspace default
 * (spec v3.1 Section 3.6 step 6). The default is the set a run setup that names the workspace default resolves to;
 * the control shows once two or more sets are attached.
 */
import { useRef, useState } from "react";
import { setBlock, type WorkspaceManifest } from "@alm/reader";
import { ByField, useBy } from "../../controls/ByName";
import { errText } from "../../errText";
import { attachBody, defaultBody } from "../../assumptions/attachModel";

export interface SetOption {
  id: string;
  label: string;
}

const optionText = (s: SetOption): string => (s.label !== "" && s.label !== s.id ? `${s.id}: ${s.label}` : s.id);

export function AttachedSetsView(props: {
  attached: SetOption[];
  defaultSetId: string | null;
  /** Stored sets the workspace does not hold yet: the attach choices. */
  stored: SetOption[];
  by: string;
  busy: boolean;
  note: string | null;
  onDefault(id: string): void;
  onAttach(id: string): void;
  onBy(v: string): void;
}) {
  const { attached, defaultSetId } = props;
  const off = props.busy;
  const attachable = props.stored.filter((s) => !attached.some((a) => a.id === s.id));
  const named = props.by.trim() !== "";
  const [pick, setPick] = useState("");
  return (
    <section className="card" aria-label="Sets of this workspace">
      <div className="card-title">Sets of this workspace</div>
      {attached.length === 0 ? (
        <>
          <p className="card-desc">No assumption set is attached to this workspace. Attach a set from the stored sets. The vanilla empty set is a valid contractual-only choice. The first set attached becomes the workspace default the Standard ALCO run setup runs on.</p>
        </>
      ) : attached.length === 1 ? (
        <>
          <ul className="list">
            <li><span className="mono">{attached[0]!.id}</span> <span className="status status-pass">Workspace default</span></li>
          </ul>
          <p className="card-desc">The first set attached becomes the workspace default. The default control appears once a second set is attached.</p>
        </>
      ) : (
        <fieldset className="stack" disabled={off}>
          <legend className="run-sub">Workspace default</legend>
          {attached.map((s) => (
            <label key={s.id} className="field">
              <span className="field-label">
                <input type="radio" name="workspace-default" value={s.id} checked={s.id === defaultSetId} onChange={() => props.onDefault(s.id)} />{" "}
                <span className="mono">{s.id}</span>{s.id === defaultSetId ? <> <span className="status status-pass">Workspace default</span></> : null}
              </span>
            </label>
          ))}
          <p className="card-desc">A run setup that names the workspace default resolves to this set when it is compiled, and records the set it resolved to. Changing the default moves the assumptions block, so a setup validated before the change reads Stale.</p>
        </fieldset>
      )}
      <div className="param-grid">
        <label className="field">
          <span className="field-label">Attach a set</span>
          <select aria-label="Stored set to attach" disabled={off || attachable.length === 0} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{attachable.length === 0 ? "No other stored set" : "Pick a stored set"}</option>
            {attachable.map((s) => <option key={s.id} value={s.id}>{optionText(s)}</option>)}
          </select>
        </label>
        <ByField value={props.by} onChange={props.onBy} disabled={off} />
      </div>
      <div className="sheet-actions">
        <button type="button" className="btn" aria-disabled={pick === "" || !named || off ? true : undefined} onClick={pick === "" || !named || off ? undefined : () => { props.onAttach(pick); setPick(""); }}>Attach</button>
        {props.busy ? <span className="muted" role="status">Saving</span> : null}
        {props.note !== null ? <span role="status">{props.note}</span> : null}
      </div>
      <p className="card-foot">Source: /api/workspaces/{"<id>"} blocks.assumptions.sets, defaultSetId</p>
    </section>
  );
}

/** The control with its calls: attach is an `add`, the radio is `set-default`; each at the head revision, then the head is read again. */
export function AttachedSets(props: { head: WorkspaceManifest; stored: SetOption[]; onChanged(): void; byState?: [string, (v: string) => void] }) {
  const { head } = props;
  const ownBy = useBy();
  const [by, setBy] = props.byState ?? ownBy;
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  const write = async (body: ReturnType<typeof attachBody>, done: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      await setBlock(head.id, body);
      setNote(done);
      props.onChanged();
    } catch (e) {
      setNote(errText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const label = (id: string): SetOption => props.stored.find((s) => s.id === id) ?? { id, label: id };
  return (
    <AttachedSetsView
      attached={head.blocks.assumptions.sets.map((s) => label(s.id))}
      defaultSetId={head.blocks.assumptions.defaultSetId}
      stored={props.stored}
      by={by} busy={busy} note={note} onBy={setBy}
      onAttach={(id) => void write(attachBody(head, id, by.trim()), `Attached ${id}`)}
      onDefault={(id) => void write(defaultBody(head, id, by.trim()), `${id} is the workspace default`)}
    />
  );
}
