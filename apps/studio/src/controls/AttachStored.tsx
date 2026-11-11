/**
 * The attach control a first run needs on Market > Yield curves, Balance Sheet > Strategy and Run > Scenario library
 * (final review M1): pick a stored document, type a name, Attach. The write is the same block route Positions and
 * Assumptions use, at the head revision; the head and its readiness are read again after it. The server's refusal,
 * when it refuses, is printed in its own words.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { setBlock, type SetBlockBody, type WorkspaceManifest } from "@alm/reader";
import { ByField, useBy } from "./ByName";
import { errText } from "../errText";
import { useLoad, type LoadState } from "../useLoad";
import type { StoredOption } from "./attachBodies";

/** What re-reads the stored list: another workspace, or a new revision after an import or an attach elsewhere on the page. */
export function listDeps(head: WorkspaceManifest): unknown[] {
  return [head.id, head.revision];
}

/**
 * What the control draws for a load state. The list on screen stays while the next read is in flight, so a pick and
 * the card do not flash away after every write; the loading line is for the first read only.
 */
export function listToShow(load: LoadState<StoredOption[]>, last: StoredOption[] | null):
  | { kind: "loading" } | { kind: "error"; error: Error } | { kind: "list"; value: StoredOption[] } {
  if (load.state === "ok") return { kind: "list", value: load.value };
  if (load.state === "error") return { kind: "error", error: load.error };
  return last === null ? { kind: "loading" } : { kind: "list", value: last };
}

/**
 * Why the Attach button is off, in words; null when it can be pressed, while it is busy, and when there is nothing to
 * pick. "Attach a stored snapshot" names its kind and the hint reuses it: "Pick a stored snapshot first."
 */
export function attachWhy(s: { selectLabel: string; pick: string; choices: number; named: boolean; busy: boolean }): string | null {
  if (s.busy) return null;
  if (s.pick === "") return s.choices > 0 ? `${s.selectLabel.replace(/^Attach a /, "Pick a ")} first.` : null;
  return s.named ? null : "Type your name first.";
}

/**
 * One stored choice as an option line: the id alone when it has no label or the label repeats it; the label alone when
 * it already opens with the id and a bracket ("one-loan (2026-02-27, 1 position)"); otherwise "id: label". A label
 * that only shares the id's first letters ("m10 snapshot" under "m1") is a different label, so the id is kept.
 */
export function optionText(s: StoredOption): string {
  if (s.label === "" || s.label === s.id) return s.id;
  if (s.label.startsWith(`${s.id} (`)) return s.label;
  return `${s.id}: ${s.label}`;
}

export function AttachStoredView(props: {
  title: string;
  selectLabel: string;
  /** What the block holds now, in words. */
  current: ReactNode;
  foot: string;
  stored: StoredOption[];
  attachedIds: string[];
  by: string;
  busy: boolean;
  note: string | null;
  /** Why the control is off (a locked, archived or superseded workspace); absent or null when it can be used. */
  blocked?: string | null;
  onAttach(id: string): void;
  onBy(v: string): void;
}) {
  const [pick, setPick] = useState("");
  const blockedText = props.blocked ?? null;
  const off = props.busy || blockedText !== null;
  const choices = props.stored.filter((s) => !props.attachedIds.includes(s.id));
  const named = props.by.trim() !== "";
  const blocked = pick === "" || !named || off;
  const hintId = useId();
  const why = attachWhy({ selectLabel: props.selectLabel, pick, choices: choices.length, named, busy: off });
  return (
    <section className="card" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      <p className="card-desc">{props.current}</p>
      {blockedText !== null ? <p className="field-help" role="status">{blockedText}</p> : null}
      <div className="param-grid">
        <label className="field">
          <span className="field-label">{props.selectLabel}</span>
          <select aria-label={props.selectLabel} disabled={off || choices.length === 0} value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">{choices.length === 0 ? "No other stored choice" : "Pick a stored one"}</option>
            {choices.map((s) => <option key={s.id} value={s.id}>{optionText(s)}</option>)}
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
      <p className="card-foot">{props.foot}</p>
    </section>
  );
}

/** One block write at a time: busy while it is in flight, the outcome in words, then the head is read again. */
export function useBlockWrite(wsId: string, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const inFlight = useRef(false);
  const write = async (body: SetBlockBody, done: string) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNote(null);
    try {
      await setBlock(wsId, body);
      setNote(done);
      onChanged();
    } catch (e) {
      setNote(errText(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return { busy, note, setNote, write };
}

/**
 * The control with its reads: the stored choices are listed by `list`; a pick is written with `body`. `written` lets a
 * page share one write state (Strategy adds a saved plan through the same note).
 */
export function AttachStored(props: {
  head: WorkspaceManifest;
  title: string;
  selectLabel: string;
  current: ReactNode;
  foot: string;
  attachedIds: string[];
  loadingText: string;
  list: () => Promise<StoredOption[]>;
  body: (head: WorkspaceManifest, id: string, by: string) => SetBlockBody;
  done: (id: string) => string;
  onChanged: () => void;
  written?: ReturnType<typeof useBlockWrite>;
  byState?: [string, (v: string) => void];
  /** Why the workspace takes no write; absent or null when it does. */
  blocked?: string | null;
}) {
  const own = useBlockWrite(props.head.id, props.onChanged);
  const ownBy = useBy();
  const w = props.written ?? own;
  const [by, setBy] = props.byState ?? ownBy;
  const load = useLoad(props.list, listDeps(props.head));
  const last = useRef<StoredOption[] | null>(null);
  const shown = listToShow(load, last.current);
  if (shown.kind === "list") last.current = shown.value;
  if (shown.kind === "loading") return <div className="card muted">{props.loadingText}</div>;
  if (shown.kind === "error") return <div className="card" role="alert">{errText(shown.error)}</div>;
  return (
    <AttachStoredView
      title={props.title} selectLabel={props.selectLabel} current={props.current} foot={props.foot}
      stored={shown.value} attachedIds={props.attachedIds} by={by} busy={w.busy} note={w.note} blocked={props.blocked ?? null} onBy={setBy}
      onAttach={(id) => void w.write(props.body(props.head, id, by.trim()), props.done(id))}
    />
  );
}
