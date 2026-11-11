// apps/studio/src/pages/workspace/StartHere.tsx
/**
 * The Start here card at the top of Home: a numbered learning path on Quillfield Bank,
 * then "More demos", every demo once (the list is guided/startHere.ts, held by a test). Each step has a number, a
 * title, one plain line on what you learn and an Open button:
 *
 *  - step 1 opens the bank's finished analysis: with no workspace on the bank yet it does what "Explore the example
 *    bank" does; with one, it opens that workspace's Reports step (or step 1 when no run is done);
 *  - a demo whose setup slot has a done run opens on that run's Results screen, with a line on what to change and run
 *    again (StartHereNote);
 *  - a demo with no done run yet opens on Run setups, as the demo cards did, and the step says to press Launch; the
 *    deposit desk's first Open makes its workspace, and a bank demo waits for step 1.
 *
 * The learn kit (`npm run learn`) runs every demo at seed time, so there every Open lands on a result.
 */
import { useRef, useState } from "react";
import { listExampleBooks, listExampleDemos, listWorkspaceRuns, type ExampleBookRow, type ExampleDemoRow, type WorkspaceManifest, type WorkspaceRunRow } from "@alm/reader";
import { demoWorkspace, openFeatureDemo, openOnSection, sectionFor } from "../../guided/featureDemos";
import { cardFor } from "../../guided/startHereCards";
import { aboutSlots, aboutText, BANK_ID, DESK_ID, MORE_DEMOS, resultHref, START_HERE_PATH, startHereItem, stepRows, slotOf, readMoreLine, guideHref, type StepRow } from "../../guided/startHere";
import { demoSetupHref, editItemOf, editSetHref, putCopyInDemo } from "../../guided/startHereEdit";
import { DEFAULT_BY, freeName } from "../../guided/start";
import { useBy } from "../../controls/ByName";
import { errText } from "../../errText";
import { analysisHref, homeHref } from "../../router";
import { useLoad } from "../../useLoad";
import { exploreExampleBank, startWorkspace } from "./StartChoices";

/** One step or demo: number (path only), title, learn line, what Open does, and Open. */
function StepItem(props: { row: StepRow; n: number | null; busy: string | null; onOpen: (row: StepRow) => void }) {
  const { row } = props;
  const card = row.demo === null ? undefined : cardFor(row.item.id);
  // With both slots set the box shows its own copy and the guide page instead of the card.
  const slots = aboutSlots(row.item);
  // A set guide base links the guide page; a null base leaves it plain text.
  const href = slots === null ? null : guideHref(slots.guide);
  const open = row.action.kind === "link"
    ? <a className="btn btn-primary" href={row.action.href}>Open</a>
    : <button type="button" className="btn btn-primary" disabled={row.action.kind === "off" || props.busy !== null} onClick={() => props.onOpen(row)}>{props.busy === row.item.id ? "Opening" : "Open"}</button>;
  return (
    <li className="start-here-step" aria-label={props.n === null ? row.item.title : `Step ${props.n}: ${row.item.title}`}>
      {props.n !== null ? <span className="start-here-num" aria-hidden="true">{props.n}</span> : null}
      <div className="start-here-body">
        <div className="start-here-title">{row.item.title}</div>
        <p className="card-desc">{row.item.learn}</p>
        {row.note !== null ? <p className="field-help">{row.note}</p> : null}
        {slots !== null ? (
          <details className="demo-card-details">
            <summary>More about this demo</summary>
            <ul className="demo-card-facts">
              <li>{slots.short}</li>
              {href === null ? <li>{readMoreLine(slots.guide)}</li> : <li>Read more: <a href={href} target="_blank" rel="noreferrer">{slots.guide}</a></li>}
            </ul>
          </details>
        ) : card !== undefined ? (
          <details className="demo-card-details">
            <summary>More about this demo</summary>
            <ul className="demo-card-facts">
              <li>{aboutText(card.text)}</li>
              {card.notes.map((n) => <li key={n}>{n}</li>)}
            </ul>
          </details>
        ) : null}
      </div>
      <div className="start-here-open">{open}</div>
    </li>
  );
}

/** Props only: the rows, what is busy, and what Open does. */
export function StartHereView(props: { path: StepRow[]; more: StepRow[]; busy: string | null; error: string | null; status: string | null; onOpen: (row: StepRow) => void }) {
  return (
    <section className="card" aria-label="Start here">
      <div className="card-title">Start here</div>
      <p className="card-desc">A short path through Quillfield Bank, a synthetic bank of about $5 billion. Open a step to see its result, change one thing, and run it again.</p>
      <ol className="start-here-path">
        {props.path.map((r, i) => <StepItem key={r.item.id} row={r} n={i + 1} busy={props.busy} onOpen={props.onOpen} />)}
      </ol>
      <div className="start-here-more-title">More demos</div>
      <ul className="start-here-path start-here-more">
        {props.more.map((r) => <StepItem key={r.item.id} row={r} n={null} busy={props.busy} onOpen={props.onOpen} />)}
      </ul>
      {props.status !== null ? <p className="guided-note" role="status">{props.status}</p> : null}
      {props.error !== null ? <p className="guided-bad" role="alert">{props.error}</p> : null}
    </section>
  );
}

interface Loaded {
  books: ExampleBookRow[];
  demos: Map<string, ExampleDemoRow>;
}

/** The example books and every demo the server lists, by id. */
async function loadDemos(): Promise<Loaded> {
  const books = await listExampleBooks();
  const demos = new Map<string, ExampleDemoRow>();
  for (const b of books) for (const d of await listExampleDemos(b.id)) demos.set(d.id, d);
  return { books, demos };
}

/** The runs of the bank's and the desk's workspaces, by workspace id. */
async function loadRuns(ids: string[]): Promise<Map<string, WorkspaceRunRow[]>> {
  const out = new Map<string, WorkspaceRunRow[]>();
  for (const id of ids) out.set(id, await listWorkspaceRuns(id).catch(() => []));
  return out;
}

/** The route-facing card: reads the demos and the two workspaces' runs, and opens a step. */
export function StartHere(props: { workspaces: WorkspaceManifest[] }) {
  const [by] = useBy();
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // S3c fix round (L7): the desk workspace a first Open made, kept for a retry when the open after it failed.
  const made = useRef<string | null>(null);
  const demos = useLoad(loadDemos, []);
  const mine = [BANK_ID, DESK_ID].map((b) => demoWorkspace(props.workspaces, b)).filter((w): w is WorkspaceManifest => w !== null);
  // Read again when either workspace moves (a launch attaches a run and moves its revision).
  const runs = useLoad(() => loadRuns(mine.map((w) => w.id)), [mine.map((w) => `${w.id}@${w.revision}`).join(",")]);
  const input = {
    workspaces: props.workspaces,
    demos: demos.state === "ok" ? demos.value.demos : null,
    runs: runs.state === "ok" ? runs.value : new Map<string, WorkspaceRunRow[]>(),
  };
  const who = by.trim() === "" ? DEFAULT_BY : by.trim();
  const go = (id: string, fn: () => Promise<string>) => {
    setBusy(id);
    setError(null);
    fn().then(
      (href) => { window.location.hash = href; },
      (e: unknown) => { setBusy(null); setStatus(null); setError(errText(e)); },
    );
  };
  const onOpen = (row: StepRow) => {
    if (row.item.id === "explore") {
      go("explore", async () => {
        const r = await exploreExampleBank(props.workspaces, who, setStatus);
        return analysisHref(r.id, r.step);
      });
      return;
    }
    const demo = row.demo;
    if (demo === null || demos.state !== "ok") return;
    const book = demos.value.books.find((b) => b.id === row.item.bookId) ?? null;
    const ws = demoWorkspace(props.workspaces, row.item.bookId);
    const section = sectionFor(row.item.bookId);
    if (ws === null && (section.makesWorkspace === null || book === null)) return;
    go(row.item.id, () => openOnSection({
      workspaceId: ws?.id ?? null,
      made,
      create: async () => (await startWorkspace(freeName(section.makesWorkspace!, props.workspaces), who, props.workspaces, book)).id,
      // S3f fix round (H1): Run setups opens with the item in the address, so it says what to do next.
      open: async (w) => { await openFeatureDemo({ ws: w, demo, by: who }); return demoSetupHref(w, row.item); },
    }));
  };
  return (
    <StartHereView
      path={stepRows({ ...input, items: START_HERE_PATH })}
      more={stepRows({ ...input, items: MORE_DEMOS })}
      busy={busy}
      error={error}
      status={busy !== null ? status : null}
      onOpen={onOpen}
    />
  );
}

/**
 * The line a Start here result shows above its Results screen (`?demo=<id>`): which demo it is, what to change and run
 * again, with links to its setup on Run setups and back to Start here. Nothing for an id the list does not hold, and
 * nothing above a run of another slot.
 */
export function StartHereNote(props: { ws: string; demoId: string | undefined; runSlot: string | null }) {
  const item = props.demoId === undefined ? undefined : startHereItem(props.demoId);
  if (item === undefined || item.id === "explore") return null;
  // S3f fix round (M2): only above a run of the demo's own slot; another run picked in the picker shows no note.
  if (props.runSlot !== slotOf(item.id)) return null;
  return (
    <section className="card start-here-note" aria-label="Start here">
      <p className="card-desc"><strong>{item.title}.</strong> Try this: {item.change}</p>
      <div className="ws-actions">
        {item.edit !== undefined ? <a className="btn btn-primary" href={editSetHref(props.ws, item as typeof item & { edit: { setId: string } })}>Open the assumption set</a> : null}
        <a className="btn" href={demoSetupHref(props.ws, item)}>Open its setup on Run setups</a>
        <a className="btn btn-quiet" href={homeHref()}>Back to Start here</a>
      </div>
    </section>
  );
}

/**
 * S3f fix round (H1): the set editor reached from a Start here item (`?demo=<id>`). On the item's own set it says what
 * to change and that Save stores a copy; on a copy it offers "Use this copy", which attaches the copy and puts it in the
 * demo's setup (guided/startHereEdit.ts), then opens Run setups ready to launch.
 */
export function StartHereSetBanner(props: { ws: string; query: Record<string, string>; shownSetId: string | null }) {
  const item = editItemOf(props.query);
  const [by] = useBy();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (item === null) return null;
  const onCopy = props.shownSetId !== null && props.shownSetId !== item.edit.setId;
  const use = () => {
    if (props.shownSetId === null) return;
    setBusy(true);
    setError(null);
    putCopyInDemo({ ws: props.ws, item, copyId: props.shownSetId, by: by.trim() === "" ? DEFAULT_BY : by.trim() }).then(
      (href) => { window.location.hash = href; },
      (e: unknown) => { setBusy(false); setError(errText(e)); },
    );
  };
  return (
    <section className="card start-here-note" aria-label="Start here">
      <p className="card-desc"><strong>{item.title}.</strong> {item.change}</p>
      {onCopy ? (
        <>
          <p className="card-desc">{`You are on your copy, ${props.shownSetId}. Use this copy puts it in the demo's setup and opens Run setups, where you press Launch.`}</p>
          <div className="ws-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={use}>{busy ? "Working" : "Use this copy"}</button>
            <a className="btn btn-quiet" href={homeHref()}>Back to Start here</a>
          </div>
        </>
      ) : (
        <p className="field-help">Make the change below, then press Save: it stores your copy under a new id, and this card then offers Use this copy.</p>
      )}
      {error !== null ? <p className="guided-bad" role="alert">{error}</p> : null}
    </section>
  );
}

/**
 * S3f fix round (H1): Run setups reached from a Start here item (`?demo=<id>`), on the demo's own slot: which sets the
 * setup runs on, that Launch is next, and, once launched, a link to the new result.
 */
export function StartHereSetupNote(props: { ws: string; query: Record<string, string>; slot: string | null; setIds: readonly string[]; runIds: readonly string[]; named: boolean }) {
  const item = props.query.demo === undefined ? undefined : startHereItem(props.query.demo);
  if (item === undefined || item.id === "explore" || props.slot !== slotOf(item.id)) return null;
  const runId = props.runIds[0];
  const name = props.named ? "" : "Type your name in Recorded by, then ";
  const onCopy = item.edit !== undefined && props.setIds.length > 0 && !props.setIds.includes(item.edit.setId);
  const next = onCopy
    ? `This setup now runs on your copy, ${props.setIds.join(", ")}. ${name}${name === "" ? "Press" : "press"} Launch.`
    : `This setup runs on ${props.setIds.join(", ")}. ${name}${name === "" ? "Press" : "press"} Launch to see its result. ${item.edit !== undefined ? "To try the change, use the assumption set: the note on the result says how." : "To try the change, make it here and press Save as a new version before you launch."}`;
  return (
    <section className="card start-here-note" aria-label="Start here">
      <p className="card-desc">
        <strong>{item.title}.</strong>{" "}
        {runId === undefined ? next : "Launched. When the run is done, open its result:"}
      </p>
      <div className="ws-actions">
        {runId !== undefined ? <a className="btn btn-primary" href={resultHref(props.ws, item, runId)}>See the new result</a> : null}
        <a className="btn btn-quiet" href={homeHref()}>Back to Start here</a>
      </div>
    </section>
  );
}
