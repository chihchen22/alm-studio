// apps/studio/src/pages/run/SetupsPage.tsx
/**
 * Run > Run setups (spec v3.1 Section 5.2). The list of the workspace's setup slots on the left; the editor
 * for the chosen slot on the right, `#/ws/<ws>/run/setups/<setupLineageId>`. Saving writes a successor document
 * through POST /api/run-setups and moves the slot; Validate and Launch call the workspace routes through the reader.
 * The page reads its own head and readiness so it needs nothing from the frame; `env.refresh`, when the frame hands
 * it over, rereads the frame's chip after a write.
 */
import { StartHereSetupNote } from "../workspace/StartHere";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  launchSetup,
  listSetupValidations,
  saveRunSetup,
  validateSetup,
  type RunSetup,
  type SetupValidationEntry,
  type ValidateSetupReply,
  type WorkspaceManifest,
} from "@alm/reader";
import "../../styles/run-setups.css";
import { errText, pageErrText } from "../../errText";
import { hrefFor, type Query } from "../../router";
import { launchOutcomeText, lineageIdFor, marketInputChoices, newSetupDocument, setupListRows, setupTabOf, type SetupTab } from "../../rows/setupRows";
import { SetupEditor, type SetupEditorContext } from "../../run/SetupEditor";
import { ReadinessChip } from "../../shell/ReadinessChip";
import { useLoad } from "../../useLoad";
import { loadCoaNodes, loadSetupsPage, loadViewOptions, type SetupsPageData } from "./loadSetups";

const BY_KEY = "studio.recordedBy";

function readBy(): string {
  try {
    return window.localStorage.getItem(BY_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeBy(by: string): void {
  try {
    window.localStorage.setItem(BY_KEY, by);
  } catch {
    // Private mode or blocked storage: the name stays in memory for this page only.
  }
}

/** Why a workspace cannot be written, in words; null when it can. Mirrors the server's write refusal. */
export function readOnlyReason(head: WorkspaceManifest): string | null {
  if (head.status === "locked" || head.lock !== null) return "This workspace is locked by its sign-off. Clone it to change a setup or to launch.";
  if (head.status === "archived") return "This workspace is archived and read-only.";
  if (head.status === "superseded") return "This workspace was superseded and is read-only.";
  return null;
}

function StateRow(props: { row: ReturnType<typeof setupListRows>[number]; ws: string; selected: boolean; query: Query }) {
  const { row } = props;
  const href = hrefFor({ ws: props.ws, section: "run", screen: "setups", slot: row.lineageId, query: props.query.tab === undefined ? {} : { tab: props.query.tab } });
  const last = row.lastLaunched === null ? "never launched" : `last launched ${row.lastLaunched}`;
  return (
    <li className={props.selected ? "setups-item setups-item-on" : "setups-item"}>
      <a href={href} aria-current={props.selected ? "page" : undefined}>{row.name}</a>
      <div className="chip-row">
        <ReadinessChip state={row.state} />
        <span className="chip">{row.basisText}</span>
      </div>
      <span className="field-help">{`${row.launchCount} ${row.launchCount === 1 ? "launch" : "launches"}, ${last}`}</span>
    </li>
  );
}

function NewSetup(props: { disabled: boolean; busy: boolean; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="setups-new">
      <label className="field">
        <span className="field-label">New setup name</span>
        <input aria-label="New setup name" className="input" type="text" value={name} maxLength={60} disabled={props.disabled} onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="button" className="btn" disabled={props.disabled || props.busy || name.trim() === ""} onClick={() => { props.onCreate(name.trim()); setName(""); }}>New setup</button>
    </div>
  );
}

function Loaded(props: { ws: string; data: SetupsPageData; slot: string | undefined; query: Query; reload: () => void; refreshFrame: () => void }) {
  const { data, ws } = props;
  const [by, setBy] = useState(readBy);
  const [validations, setValidations] = useState<Record<string, ValidateSetupReply>>({});
  // The stored validations per slot, read from the server on mount and after a Validate; `error` is the server's message.
  const [histories, setHistories] = useState<Record<string, { entries: SetupValidationEntry[] | null; error: string | null }>>({});
  const [historyRev, setHistoryRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A launch answers beside its own button (Studio Part 2 D6), not in the header card.
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [runIds, setRunIds] = useState<string[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const bookId = data.head.blocks.positions.book?.id ?? null;
  const coa = useLoad(() => loadCoaNodes(bookId), [bookId]);
  const viewOpts = useLoad(() => loadViewOptions(bookId), [bookId]);
  const rows = setupListRows(data.setups.setups, data.runs, data.readiness);
  const chosenId = props.slot ?? props.query.setup ?? data.setups.setups[0]?.slot.setupLineageId;
  const chosen = data.setups.setups.find((s) => s.slot.setupLineageId === chosenId) ?? null;
  const tab: SetupTab = setupTabOf(props.query.tab);
  const locked = readOnlyReason(data.head);
  const chosenLineage = chosen?.slot.setupLineageId ?? null;
  const chosenDocId = chosen?.setup.id ?? null;
  // A launch answer belongs to the slot it was launched from, so it does not survive a switch to another slot.
  useEffect(() => { setLaunchMessage(null); setRunIds([]); }, [chosenLineage]);
  useEffect(() => {
    if (chosenLineage === null) return;
    let cancelled = false;
    listSetupValidations(ws, chosenLineage).then(
      (entries) => { if (!cancelled) setHistories((h) => ({ ...h, [chosenLineage]: { entries, error: null } })); },
      (e: unknown) => { if (!cancelled) setHistories((h) => ({ ...h, [chosenLineage]: { entries: null, error: errText(e) } })); },
    );
    return () => { cancelled = true; };
  }, [ws, chosenLineage, chosenDocId, historyRev]);

  const context: SetupEditorContext = {
    defaultSetId: data.head.blocks.assumptions.defaultSetId,
    setIds: data.head.blocks.assumptions.sets.map((r) => r.id),
    balancePlanIds: data.head.blocks.targets.balancePlans.map((r) => r.id),
    libraries: data.libraries,
    slates: data.slates,
    coaNodes: coa.state === "ok" ? coa.value : [],
    markets: marketInputChoices(data.head.blocks.market),
    viewOptions: viewOpts.state === "ok" ? viewOpts.value : viewOpts.state === "error" ? undefined : null,
    bookId,
  };

  const done = (text: string) => {
    if (!alive.current) return;
    setBusy(false);
    setMessage(text);
  };
  const launched = (text: string) => {
    if (!alive.current) return;
    setBusy(false);
    setLaunchMessage(text);
  };
  const changed = () => {
    props.reload();
    props.refreshFrame();
  };

  const guard = (fn: () => Promise<void>) => {
    if (by.trim() === "") {
      setMessage("Type who is recording this (typed, not verified) first.");
      return;
    }
    writeBy(by.trim());
    setBusy(true);
    setMessage(null);
    setLaunchMessage(null);
    void fn();
  };

  const save = (lineageId: string, draft: Omit<RunSetup, "id">) =>
    guard(async () => {
      try {
        const r = await saveRunSetup({ workspaceId: ws, setupLineageId: lineageId, expectedRevision: data.head.revision, by: by.trim(), setup: draft });
        // The stored document is new, so any earlier validation was of the old one.
        if (alive.current) setValidations((v) => { const { [lineageId]: _gone, ...rest } = v; void _gone; return rest; });
        done(`Saved as ${r.setup.id}. Validate it before launching.`);
        changed();
      } catch (e) {
        done(e instanceof ApiError && e.status === 409 ? `${errText(e)} Reload the page to read the workspace's current head.` : errText(e));
      }
    });

  const validate = (lineageId: string) =>
    guard(async () => {
      try {
        const r = await validateSetup(ws, lineageId, { by: by.trim() });
        if (alive.current) {
          setValidations((v) => ({ ...v, [lineageId]: r }));
          setHistoryRev((n) => n + 1);
        }
        done(r.outcome === "fail" ? "Validation failed; the report below names why." : `Validated. NII basis: ${r.basisLabel}.`);
        changed();
      } catch (e) {
        done(errText(e));
      }
    });

  const launch = (lineageId: string, acknowledge: string[], batch: boolean) =>
    guard(async () => {
      try {
        const reply = await launchSetup(ws, lineageId, { by: by.trim(), acknowledge, batch });
        if (alive.current) setRunIds(reply.runIds);
        launched(launchOutcomeText({ kind: "reply", reply }, data.readiness?.items ?? []));
        changed();
      } catch (e) {
        launched(launchOutcomeText({ kind: "error", error: e }, data.readiness?.items ?? []));
        changed();
      }
    });

  const create = (name: string) =>
    guard(async () => {
      const lineageId = lineageIdFor(name, data.head.blocks.run.setups.map((s) => s.setupLineageId));
      try {
        const r = await saveRunSetup({ workspaceId: ws, setupLineageId: lineageId, expectedRevision: data.head.revision, by: by.trim(), setup: newSetupDocument(name) });
        done(`Created ${name} as ${r.setup.id}. Validate it before launching.`);
        changed();
        window.location.hash = hrefFor({ ws, section: "run", screen: "setups", slot: lineageId });
      } catch (e) {
        done(errText(e));
      }
    });

  const slotReadiness =
    chosen !== null && data.readiness !== null && data.readiness.launchable[chosen.slot.setupLineageId] !== undefined
      ? { items: data.readiness.items, launchable: data.readiness.launchable[chosen.slot.setupLineageId]! }
      : null;

  return (
    <div className="setups-layout">
      <aside className="card setups-list" aria-label="Run setups">
        <div className="card-title">Run setups</div>
        {rows.length === 0 ? <p className="card-desc">This workspace holds no run setup. Create one below.</p> : null}
        <ul className="setups-items">
          {rows.map((r) => (
            <StateRow key={r.lineageId} row={r} ws={ws} selected={chosen?.slot.setupLineageId === r.lineageId} query={props.query} />
          ))}
        </ul>
        {data.setups.missing.map((m) => (
          <p key={m.setupLineageId} className="field-help field-error" role="alert">{`${m.setupLineageId}: ${m.problem}`}</p>
        ))}
        <NewSetup disabled={locked !== null} busy={busy} onCreate={create} />
      </aside>

      <div className="setups-editor">
        {/* Studio slice S3f fix round (H1): reached from a Start here item, the slot says what is next. */}
        <StartHereSetupNote ws={ws} query={props.query} slot={chosenLineage} setIds={chosen !== null && Array.isArray(chosen.setup.inputs.assumptionSetIds) ? chosen.setup.inputs.assumptionSetIds : []} runIds={runIds} named={by.trim() !== ""} />
        {props.slot !== undefined && chosen === null ? (
          <div className="card" role="alert">{`This workspace has no run setup "${props.slot}". Choose one from the list.`}</div>
        ) : null}
        {chosen !== null ? (
          <SetupEditor
            key={chosen.setup.id}
            setup={chosen.setup}
            context={context}
            tab={tab}
            onTab={(t) => { window.location.hash = hrefFor({ ws, section: "run", screen: "setups", slot: chosen.slot.setupLineageId, query: { tab: t } }); }}
            validation={validations[chosen.slot.setupLineageId] ?? null}
            history={histories[chosen.slot.setupLineageId]?.entries ?? null}
            historyError={histories[chosen.slot.setupLineageId]?.error ?? null}
            readiness={slotReadiness}
            by={by}
            onBy={setBy}
            readOnlyReason={locked}
            busy={busy}
            message={message}
            launchMessage={launchMessage}
            onSave={(draft) => save(chosen.slot.setupLineageId, draft)}
            onValidate={() => validate(chosen.slot.setupLineageId)}
            onLaunch={(ack, batch) => launch(chosen.slot.setupLineageId, ack, batch)}
          />
        ) : null}
        {chosen === null && message !== null ? <p className="setup-message" role="status">{message}</p> : null}
        {runIds.length > 0 ? (
          <p className="field-help">
            <a href={hrefFor({ ws, section: "run", screen: "queue", query: { run: runIds[0]! } })}>Follow the first queued run</a>
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function SetupsPage(props: { ws: string; head: WorkspaceManifest | null; slot?: string; query: Query; env?: { refresh: () => void } }) {
  const [rev, setRev] = useState(0);
  const reload = useCallback(() => setRev((n) => n + 1), []);
  const load = useLoad(() => loadSetupsPage(props.ws), [props.ws, rev]);
  // A reread after a write keeps the editor on screen: its draft and its validation are state of the mounted page.
  const last = useRef<SetupsPageData | null>(null);
  if (load.state === "ok") last.current = load.value;
  const data = load.state === "ok" ? load.value : last.current !== null && last.current.head.id === props.ws ? last.current : null;
  if (data === null) {
    if (load.state === "error") return <div className="card" role="alert">{pageErrText(load.error)}</div>;
    return <div className="card muted">Reading the run setups</div>;
  }
  return (
    <>
      {load.state === "error" ? <div className="card" role="alert">{pageErrText(load.error)}</div> : null}
      <Loaded
        ws={props.ws}
        data={data}
        slot={props.slot}
        query={props.query}
        reload={reload}
        refreshFrame={() => props.env?.refresh()}
      />
    </>
  );
}
