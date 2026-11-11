// apps/studio/src/pages/run/SingleInstrumentPage.tsx
/**
 * Run > Single instrument (ALM Studio A+E Slice 1, Task E6; spec v3.1 Section 5.3). The stateful shell around
 * SingleInstrumentView: the positions of THIS workspace's book are read a page at a time (the type-ahead sends the
 * typed prefix to the server, which filters; the screen never holds the whole book), a setup's library scenarios are
 * read when the library arm is chosen, and one projection is requested on demand. The reply stays in this page's
 * state: no write is made and nothing is stored (ruling 15), so the screen works on a locked workspace.
 */
import { CURRENT_MODEL_CONVENTION } from "@alm/engine/src/corrections";
import { useCallback, useEffect, useRef, useState } from "react";
import { getRunSetup, listPositions, projectInstrument, type PositionsPage, type RunSetup, type WorkspaceManifest } from "@alm/reader";
import { pageErrText } from "../../errText";
import type { Query } from "../../router";
import { useLoad } from "../../useLoad";
import {
  defaultForm, drillRequest, libraryOffer, positionsRequest, type InstrumentForm, type LibraryState, type PositionFilter,
} from "../../rows/instrumentRows";
import { SingleInstrumentView, type PositionsState, type RunState } from "./SingleInstrumentView";
import "./singleInstrument.css";

/** How long the typed prefix rests before the server is asked, in ms. */
const TYPE_AHEAD_MS = 200;

function Loaded(props: { head: WorkspaceManifest; query: Query }) {
  const { head } = props;
  const bookId = head.blocks.positions.book?.id ?? null;
  const [form, setForm] = useState<InstrumentForm>(() => defaultForm(head, props.query));
  const [filter, setFilter] = useState<PositionFilter>({ q: "", offset: 0 });
  const [run, setRun] = useState<RunState>({ state: "idle" });
  const seq = useRef(0);

  // The type-ahead: the server filters by prefix, so only the settled text is sent.
  const typed = filter.q ?? "";
  const [sent, setSent] = useState(typed);
  useEffect(() => {
    const t = setTimeout(() => setSent(typed), TYPE_AHEAD_MS);
    return () => clearTimeout(t);
  }, [typed]);

  const page = useLoad<PositionsPage | null>(
    () => (bookId === null ? Promise.resolve(null) : listPositions(bookId, positionsRequest({ ...filter, q: sent }))),
    [bookId, sent, filter.familyId, filter.instrumentType, filter.coaNodeId, filter.offset],
  );
  let positions: PositionsState;
  if (bookId === null) positions = { state: "none" };
  else if (page.state === "loading") positions = { state: "loading" };
  else if (page.state === "error") positions = { state: "error", message: pageErrText(page.error) };
  else positions = page.value === null ? { state: "none" } : { state: "ok", page: page.value };

  const slot = head.blocks.run.setups.find((s) => s.setupLineageId === form.setupLineageId);
  const wantsLibrary = form.arm === "library";
  // The chosen setup is read on every arm, for its model convention as well as its scenarios.
  const setup = useLoad<RunSetup | null>(
    () => (slot === undefined ? Promise.resolve(null) : getRunSetup(slot.current.id)),
    [slot?.current.id],
  );
  let library: LibraryState;
  if (slot === undefined) library = { state: "none", reason: "This workspace holds no run setup, so there are no library scenarios to reproduce." };
  else if (!wantsLibrary) library = { state: "none", reason: "Choose the library arm to read the setup." };
  else if (setup.state === "loading") library = { state: "loading" };
  else if (setup.state === "error") library = { state: "none", reason: pageErrText(setup.error) };
  else library = setup.value === null ? { state: "loading" } : libraryOffer(setup.value.name, setup.value.scenarios);

  const project = useCallback(() => {
    const refs = library.state === "refs" ? library.refs : null;
    // The setup's convention, as its run walks the CD book (absent: made before the corrections, the original convention);
    // with no setup, the convention a new setup carries.
    const convention = slot === undefined ? CURRENT_MODEL_CONVENTION : setup.state === "ok" && setup.value !== null ? setup.value.modelConvention ?? "book" : null;
    if (convention === null) {
      setRun({ state: "error", message: "Reading the setup; try again in a moment." });
      return;
    }
    const r = drillRequest(form, bookId, refs, convention);
    if (!r.ok) {
      setRun({ state: "error", message: r.reason });
      return;
    }
    const n = ++seq.current;
    setRun({ state: "busy" });
    projectInstrument(r.body).then(
      (drill) => { if (n === seq.current) setRun({ state: "ok", drill, scenarioIndex: 0 }); },
      (e: unknown) => { if (n === seq.current) setRun({ state: "error", message: pageErrText(e) }); },
    );
  }, [form, bookId, library, slot, setup]);

  return (
    <SingleInstrumentView
      head={head}
      form={form}
      filter={filter}
      positions={positions}
      library={library}
      run={run}
      on={{
        form: (patch) => setForm((f) => ({ ...f, ...patch })),
        // A new filter starts at the first page; paging alone keeps the filter.
        filter: (patch) => setFilter((f) => ({ ...f, offset: 0, ...patch })),
        project,
        scenario: (i) => setRun((r) => (r.state === "ok" ? { ...r, scenarioIndex: i } : r)),
      }}
    />
  );
}

/** `head` is the open workspace's manifest; the address's `position` and `setup` name a starting pick. */
export function SingleInstrumentPage(props: { head: WorkspaceManifest | null; query: Query }) {
  const { head, query } = props;
  if (head === null) {
    return (
      <section className="card" aria-label="Single instrument run">
        <div className="card-title">Single instrument</div>
        <p className="card-desc">No workspace is open, so there is no book to pick a position from.</p>
      </section>
    );
  }
  return <Loaded key={head.id} head={head} query={query} />;
}
