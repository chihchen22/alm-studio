// apps/studio/src/pages/workspace/wsCommon.tsx
/**
 * What Workspace Home, New, Overview and Compare share: the stylesheet (imported here, once), the typed
 * "Your name" field, and the create and clone form. Every write goes through the reader with the typed `by`; the
 * clone body carries the source head's `expectedRevision`, so a head that moved since the page loaded is the
 * server's 409, printed verbatim. `studio.by` in localStorage is a convenience and is never verified.
 */
import "../../styles/workspaceScreens.css";
import { useState } from "react";
import { cloneWorkspace, createWorkspace, type BlockName, type WorkspaceManifest, type WorkspaceType } from "@alm/reader";
import { errText } from "../../errText";
import { hrefFor } from "../../router";
import {
  BLOCK_LABEL,
  BLOCK_ORDER,
  TYPE_ORDER,
  cloneBody,
  createBody,
  formProblems,
  isSupersede,
  withStart,
  type StartMode,
  type WorkspaceForm,
} from "../../rows/workspaceRows";
import { TYPE_LABEL } from "../../shell/WorkspaceSwitcher";

export const BY_KEY = "studio.by";

function readBy(): string {
  try {
    return window.localStorage.getItem(BY_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeBy(v: string): void {
  try {
    window.localStorage.setItem(BY_KEY, v);
  } catch {
    // Storage blocked: the name is typed again next time.
  }
}

/** The signer's typed name, remembered per browser. Empty where storage is blocked or there is no window. */
export function useBy(): [string, (v: string) => void] {
  const [by, setBy] = useState<string>(() => (typeof window === "undefined" ? "" : readBy()));
  return [by, (v: string) => { setBy(v); writeBy(v); }];
}

/** The one-line "Your name" field every write form carries. */
export function ByField(props: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">Your name</span>
      <input className="input input-text" type="text" value={props.value} maxLength={80} autoComplete="off" onChange={(e) => props.onChange(e.target.value)} />
      <span className="field-help">Typed, never verified: it is stamped on the history line.</span>
    </label>
  );
}

/** Go to a workspace's Overview. */
export function openOverview(id: string): void {
  window.location.hash = hrefFor({ ws: id, section: "workspace", screen: "overview" });
}

/** The label a workspace carries in a source picker. */
function sourceText(w: WorkspaceManifest): string {
  return `${w.name} (${TYPE_LABEL[w.type]}, cut-off ${w.cutoffDate})`;
}

const START_LABEL: Record<StartMode, string> = {
  blank: "Blank",
  copy: "Clone of a workspace",
  "roll-forward": "Roll forward a workspace",
};

/** The fields of the create and clone form. A fixed source (the Overview's clone dialog) hides the start choice and the source picker. */
export function WorkspaceFormFields(props: {
  form: WorkspaceForm;
  onChange: (f: WorkspaceForm) => void;
  workspaces: WorkspaceManifest[];
  fixedSource: WorkspaceManifest | null;
  today: Date;
  /** The newest market snapshot's date: the cut-off a blank start takes, on every switch back to blank. */
  blankCutoff?: string | null;
}) {
  const { form, onChange, fixedSource } = props;
  const source = fixedSource ?? props.workspaces.find((w) => w.id === form.sourceId) ?? null;
  const set = (patch: Partial<WorkspaceForm>) => onChange({ ...form, ...patch });
  const modes: StartMode[] = fixedSource === null ? ["blank", "copy", "roll-forward"] : ["copy", "roll-forward"];
  return (
    <div className="ws-form">
      <fieldset className="ws-start">
        <legend className="field-label">{fixedSource === null ? "Start from" : "Clone as"}</legend>
        {modes.map((m) => (
          <label className="ws-start-choice" key={m}>
            <input
              type="radio"
              name="ws-start"
              value={m}
              checked={form.start === m}
              disabled={m !== "blank" && fixedSource === null && props.workspaces.length === 0}
              onChange={() => onChange(withStart(form, m, m === "blank" ? null : fixedSource ?? props.workspaces.find((w) => w.id === form.sourceId) ?? props.workspaces[0] ?? null, props.today, props.blankCutoff ?? null))}
            />
            <span>{fixedSource !== null && m === "copy" ? "Copy" : fixedSource !== null ? "Roll forward" : START_LABEL[m]}</span>
          </label>
        ))}
      </fieldset>

      {fixedSource === null && form.start !== "blank" ? (
        <label className="field">
          <span className="field-label">Source workspace</span>
          <select
            className="input"
            aria-label="Source workspace"
            value={form.sourceId}
            onChange={(e) => {
              const next = props.workspaces.find((w) => w.id === e.target.value) ?? null;
              onChange(withStart({ ...form, sourceId: e.target.value }, form.start, next, props.today, props.blankCutoff ?? null));
            }}
          >
            <option value="">Choose a workspace</option>
            {props.workspaces.map((w) => <option key={w.id} value={w.id}>{sourceText(w)}</option>)}
          </select>
        </label>
      ) : null}

      <label className="field">
        <span className="field-label">Name</span>
        <input className="input input-text" type="text" value={form.name} maxLength={80} autoComplete="off" onChange={(e) => set({ name: e.target.value })} />
      </label>

      <label className="field">
        <span className="field-label">Type</span>
        <select className="input" aria-label="Type" value={form.type} onChange={(e) => set({ type: e.target.value as WorkspaceType })}>
          {TYPE_ORDER.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      </label>

      {form.start === "copy" && source !== null ? (
        <p className="field-help">Cut-off date stays {source.cutoffDate}: a copy keeps the source's reporting date.</p>
      ) : (
        <label className="field">
          <span className="field-label">Cut-off date</span>
          <input className="input input-text" type="date" value={form.cutoffDate} onChange={(e) => set({ cutoffDate: e.target.value })} />
          <span className="field-help">
            {form.start === "roll-forward" && source !== null
              ? `Must fall after ${source.cutoffDate}. It cannot be changed once the workspace exists.`
              : "The reporting date. It cannot be changed once the workspace exists."}
          </span>
        </label>
      )}

      {form.start === "blank" ? (
        <label className="field">
          <span className="field-label">Owner</span>
          <input className="input input-text" type="text" value={form.owner} maxLength={80} autoComplete="off" onChange={(e) => set({ owner: e.target.value })} />
        </label>
      ) : null}

      {form.start !== "blank" ? (
        <fieldset className="ws-blocks">
          <legend className="field-label">Carry these blocks</legend>
          {BLOCK_ORDER.map((b: BlockName) => (
            <label className="ws-block-choice" key={b}>
              <input type="checkbox" checked={form.blocks[b]} onChange={(e) => set({ blocks: { ...form.blocks, [b]: e.target.checked } })} />
              <span>{BLOCK_LABEL[b]}</span>
            </label>
          ))}
          {form.start === "roll-forward" ? (
            <p className="field-help">
              A roll-forward clears the position book and the base snapshot. Derived market definitions carry and are re-applied on the new snapshot;
              a macro definition carries a history pinned to the old as-of month and is refused on re-apply until a fresh history is derived.
              Targets are unticked: a balance plan is dated to the old as-of and is refused on the new book until it is re-authored.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {isSupersede(form, source) && source !== null ? (
        <p className="ws-notice" role="note">
          This clone is a correction of {source.name}. Creating it marks {source.id} superseded: that month keeps its approval record and stays readable, and
          no longer accepts a change or a launch.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The create and clone form as a card: fields, the typed name, a submit button off until the form is sendable, and
 * the server's refusal verbatim. On success it opens the new workspace's Overview.
 */
export function WorkspaceFormCard(props: {
  title: string;
  submitLabel: string;
  initial: WorkspaceForm;
  workspaces: WorkspaceManifest[];
  fixedSource: WorkspaceManifest | null;
  today: Date;
  onDone?: () => void;
  /** The newest market snapshot's date. */
  blankCutoff?: string | null;
}) {
  const [by, setBy] = useBy();
  const [form, setForm] = useState<WorkspaceForm>(props.initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withBy: WorkspaceForm = { ...form, by };
  const source = props.fixedSource ?? props.workspaces.find((w) => w.id === form.sourceId) ?? null;
  const problems = formProblems(withBy, source);

  function submit() {
    if (problems.length > 0 || busy) return;
    setBusy(true);
    setError(null);
    const run = withBy.start === "blank" || source === null
      ? createWorkspace(createBody(withBy)).then((m) => m.id)
      : cloneWorkspace(source.id, cloneBody(withBy, source)).then((r) => r.manifest.id);
    run.then(
      (id) => { props.onDone?.(); openOverview(id); },
      (e: unknown) => { setError(errText(e)); },
    ).finally(() => setBusy(false));
  }

  return (
    <section className="card" aria-label={props.title}>
      <div className="card-title">{props.title}</div>
      <WorkspaceFormFields form={form} onChange={setForm} workspaces={props.workspaces} fixedSource={props.fixedSource} today={props.today} blankCutoff={props.blankCutoff ?? null} />
      <ByField value={by} onChange={setBy} />
      <div role="group" aria-label="Submit" className="ws-actions">
        <button type="button" className="btn btn-primary" aria-disabled={problems.length > 0 || busy ? true : undefined} onClick={submit}>{props.submitLabel}</button>
      </div>
      {problems.length > 0 ? <p className="muted ws-problems">{problems.join(" ")}</p> : null}
      {error !== null ? <p className="card-desc" role="alert">{error}</p> : null}
    </section>
  );
}
