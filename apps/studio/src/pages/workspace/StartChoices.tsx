// apps/studio/src/pages/workspace/StartChoices.tsx
/**
 * The first screen's three choices: "Start a new analysis" (an empty
 * workspace on the newest market snapshot, dated at that snapshot so no date warning waits at launch), "Explore the example
 * bank" and any choice a pack registers (the optional extension folder adds one when it is present). A new analysis lands on step
 * 1 of the Analysis path. Core code names no pack choice: a pack's choice arrives through the registry.
 *
 * "Explore the example bank" opens the example bank that ships a finished analysis
 * (examples/mid-size-bank-v1.json): it sets the analysis up through the guided steps' own writes, runs it, and lands on
 * the Reports step with the results there. examples/example-book-v1.json stays as the small example.
 */
import { Fragment, useState } from "react";
import {
  archiveWorkspace, createWorkspace, listExampleBooks, listMarket, listWorkspaceRuns, setBlock, type ExampleBookRow, type WorkspaceManifest,
} from "@alm/reader";
import { ensureExample } from "../../guided/importBook";
import { archiveSentence, continueStep, finishExampleAnalysis, withArchiveOnFailure } from "../../guided/exampleAnalysis";
import { useLoad } from "../../useLoad";
import { useBy } from "../../controls/ByName";
import { errText } from "../../errText";
import { analysisHref } from "../../router";
import { registeredStartChoices } from "../../registry";
import { lastMonthEnd } from "../../rows/workspaceRows";
import { DEFAULT_BY, freeName, freeWorkspaceId, newestSnapshot } from "../../guided/start";

export const EXAMPLE_NAME = "Example bank";

/**
 * Create a test workspace on the newest snapshot, with the example book when asked (fix round 1, H1). Every read and
 * the example's import come first, so a failure there leaves nothing behind; the example is reused when the store
 * already holds it. A write that fails after the workspace exists archives that workspace (the store keeps every
 * document, so archiving is how it leaves the list) and says so. Returns the workspace id.
 */
export async function startWorkspace(name: string, by: string, workspaces: WorkspaceManifest[], example: ExampleBookRow | null): Promise<{ id: string; head: WorkspaceManifest; bookId: string | null; asOf: string }> {
  const markets = await listMarket();
  const snap = newestSnapshot(markets);
  const book = example === null ? null : await ensureExample(example);
  const cutoff = example?.asOf ?? snap?.calibrationDate ?? lastMonthEnd(new Date());
  const id = freeWorkspaceId(name, workspaces);
  let head = await createWorkspace({ id, name, type: "test", cutoffDate: cutoff, owner: by, by });
  try {
    if (snap !== null) head = await setBlock(id, { expectedRevision: head.revision, by, block: "market", op: "set", ref: { collection: "market", id: snap.id } });
    if (book !== null) head = await setBlock(id, { expectedRevision: head.revision, by, block: "positions", op: "set", ref: { collection: "portfolios", id: book.id } });
  } catch (e) {
    // S3f fix round (L1): the sentence says what happened to the workspace, archived or not.
    const archived = await archiveWorkspace(id, { expectedRevision: head.revision, by, note: "Archived by the start choice: setting it up failed." }).then(() => true, () => false);
    throw new Error(`${archiveSentence(name, archived)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { id, head, bookId: book?.id ?? null, asOf: cutoff };
}

/**
 * "Explore the example bank": a fresh workspace on the example that ships a finished analysis, set up and run
 * (finishExampleAnalysis). A platform with none opens the first example at step 1, as before. Returns the workspace
 * and the step to open. The start choice and the Start here card's step 1 both call this.
 */
export async function exploreExampleBank(workspaces: WorkspaceManifest[], who: string, say: (s: string) => void): Promise<{ id: string; step: "market" | "reports" | "run" }> {
  const books = await listExampleBooks();
  const bank = books.find((b) => b.analysis === true) ?? books[0];
  if (bank === undefined) throw new Error("The platform holds no example positions file.");
  const ws = await startWorkspace(freeName(EXAMPLE_NAME, workspaces), who, workspaces, bank);
  if (bank.analysis !== true || ws.bookId === null) return { id: ws.id, step: "market" };
  // Fix round M2: a failure past this point archives the workspace, as startWorkspace does for its own writes.
  const bookId = ws.bookId;
  const step = await withArchiveOnFailure({ id: ws.id, name: ws.head.name, by: who }, () => finishExampleAnalysis({ ws: ws.id, head: ws.head, bookId, asOf: ws.asOf, by: who, say }));
  return { id: ws.id, step };
}

export function StartChoices(props: { workspaces: WorkspaceManifest[] }) {
  const [by, setBy] = useBy();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const who = by.trim() === "" ? DEFAULT_BY : by.trim();
  const defaultName = freeName("My analysis", props.workspaces);
  const go = (label: string, fn: () => Promise<{ id: string; step: "market" | "reports" | "run" }>) => {
    setBusy(label);
    setError(null);
    fn().then(
      ({ id, step }) => { window.location.hash = analysisHref(id, step); },
      (e: unknown) => { setBusy(null); setError(errText(e)); },
    );
  };
  const onNew = () => go("Starting a new analysis", async () => ({ id: (await startWorkspace(name.trim() === "" ? defaultName : name.trim(), who, props.workspaces, null)).id, step: "market" }));
  const onExample = () => go("Opening the example bank", () => exploreExampleBank(props.workspaces, who, setBusy));
  const existingExample = props.workspaces.find((w) => w.name === EXAMPLE_NAME && w.status === "active") ?? null;
  // Fix round L9: "continue" opens Reports when the analysis has a finished run, else step 1.
  const existingRuns = useLoad(() => (existingExample === null ? Promise.resolve([]) : listWorkspaceRuns(existingExample.id)), [existingExample?.id ?? ""]);
  const continueTo = continueStep(existingRuns.state === "ok" ? existingRuns.value : []);
  return (
    <section className="card" aria-label="Start choices">
      <div className="card-title">Pick a starting point</div>
      <p className="card-desc">Pick one. Each opens the Analysis path: nine steps from the market to a report, each one saying what it still needs.</p>
      <div className="start-choices">
        <div className="start-choice">
          <div className="start-choice-title">Start a new analysis</div>
          <p className="card-desc">An empty workspace on the newest market snapshot, dated at that snapshot. Load your own balance sheet from a CSV or JSON template, then walk the steps.</p>
          <label className="field">
            <span className="field-label">Name</span>
            <input className="input" aria-label="Analysis name" value={name} placeholder={defaultName} onChange={(e) => setName(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={onNew}>Start a new analysis</button>
        </div>
        <div className="start-choice">
          <div className="start-choice-title">Explore the example bank</div>
          <p className="card-desc">Quillfield Bank, a synthetic bank of about $5 billion, its mix shaped like the published totals for US banks of $1 billion to $10 billion: deposits of every kind, loans, securities, borrowings, a swap and undrawn lines, in round illustrative numbers. Its analysis is set up and run for you, so the reports open with results; change any step and run it again.</p>
          <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={onExample}>{existingExample === null ? "Explore the example bank" : "Start a fresh example bank"}</button>
          {existingExample !== null ? <a className="btn btn-quiet btn-flush" href={analysisHref(existingExample.id, continueTo)}>{`Or continue ${existingExample.name}`}</a> : null}
        </div>
        {registeredStartChoices().map((c) => (
          <Fragment key={c.id}>
            <div className="start-choice">
              <div className="start-choice-title">{c.title}</div>
              <p className="card-desc">{c.description}</p>
              {c.render({ workspaces: props.workspaces })}
            </div>
          </Fragment>
        ))}
      </div>
      <div className="guided-row">
        <label className="field">
          <span className="field-label">Your name</span>
          <input className="input" aria-label="Your name" value={by} placeholder={DEFAULT_BY} onChange={(e) => setBy(e.target.value)} />
          <span className="field-help">Recorded with each change you make, never verified. Left empty, the start choices and Start here record their changes as {DEFAULT_BY}; Run setups asks for a name before it saves or launches.</span>
        </label>
      </div>
      {busy !== null ? <p className="guided-note" role="status">{busy}</p> : null}
      {error !== null ? <p className="guided-bad" role="alert">{error}</p> : null}
    </section>
  );
}
