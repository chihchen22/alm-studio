// apps/studio/src/pages/analysis/BehaviorStep.tsx
/**
 * Step 3, Behavior (S2a spec point 5). Starts from the user's families: per family its instrument type, the model that
 * applies now (from the saved set, from the book's own values, or none), a "choose a model" control offering only the
 * models valid for that instrument, the published illustrative default badged "default, not fitted", and a curve
 * preview (CPR by incentive, the share of balance left by month, beta by rate). Saving writes the assumption set behind
 * the scenes and makes it the workspace default. The effective model shows per family and per position; a binding on a
 * part of a family (a tag selector) is shown, and a default may be narrowed to one tag. When the saved models do not
 * fit the book, the reason is on this screen.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createAssumptionSet, getAssumptionSet, getPortfolio, listAssumptionSets, listGuidedBehaviorModels, previewGuidedBehavior, setBlock,
  type GuidedBehaviorPreview,
} from "@alm/reader";
import type { AssumptionSet, BehavioralOverlay, PortfolioSpec } from "@alm/engine";
import { LinePlot } from "../../charts/LinePlot";
import { linearTicks } from "./charts";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { selectorText } from "../../assumptions/selectorText";
import {
  choiceKey, familyRows, guidedSetsToDetach, inlineOverlay, isIllustrativeVersion, nextGuidedSetId, noRoleSentence, publishedBadge, ROLE_LABEL, setFromChoices,
  type FamilyRow, type PublishedModel, type RoleChoice, type RoleRow,
} from "../../guided/behavior";
import { INSTRUMENT_LABEL } from "./BalanceStep";
import { ActionLines, byName, Details, useAction, useUnsavedGuard, type StepContext } from "./common";

interface Loaded { book: PortfolioSpec; set: AssumptionSet | null; models: PublishedModel[]; takenIds: string[] }

async function loadBehavior(bookId: string, setId: string | null): Promise<Loaded> {
  const [book, set, models, list] = await Promise.all([
    getPortfolio(bookId),
    setId === null ? Promise.resolve(null) : getAssumptionSet(setId).catch(() => null),
    listGuidedBehaviorModels(),
    listAssumptionSets().catch(() => []),
  ]);
  return { book: book as PortfolioSpec, set, models: models as PublishedModel[], takenIds: list.map((s) => s.id) };
}

const CHOICE_LABEL: Record<RoleChoice["kind"], string> = { set: "Keep the saved model", book: "Use each position's own values", default: "Published default" };

export function BehaviorStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const bookId = ctx.head.blocks.positions.book?.id ?? null;
  const setId = ctx.head.blocks.assumptions.defaultSetId;
  const load = useLoad(() => (bookId === null ? Promise.reject(new Error("no book")) : loadBehavior(bookId, setId)), [bookId, setId, ctx.head.revision]);
  if (bookId === null) return <section className="card"><p className="guided-warn">Load the balance sheet first: the models are chosen per family of your positions.</p></section>;
  if (load.state === "loading") return <div className="card muted">Reading your families and the published defaults</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <BehaviorBody ctx={ctx} data={load.value} />;
}

function ReasonCard(props: { ctx: StepContext }) {
  const items = (props.ctx.readiness?.items ?? []).filter((i) => i.section === "assumptions" && (i.state === "error" || i.state === "warning"));
  if (items.length === 0) return null;
  return (
    <section className="card" aria-label="Why the saved models need attention">
      <div className="card-title">Why the saved models need attention</div>
      <ul className="guided-missing">{items.map((i) => <li key={i.item}>{`${i.item}: ${i.detail}`}</li>)}</ul>
      <p className="field-help">Saving your choices below writes a new set from this balance sheet's own families, which clears a model mapped to a family the balance sheet does not hold.</p>
    </section>
  );
}

function BehaviorBody(props: { ctx: StepContext; data: Loaded }) {
  const { ctx, data } = props;
  const rows = useMemo(() => familyRows(data.book, data.set, data.models), [data]);
  const [choices, setChoices] = useState<Record<string, RoleChoice>>({});
  const act = useAction();
  const [curve, setCurve] = useState<{ title: string; p: GuidedBehaviorPreview } | { title: string; error: string } | null>(null);
  const [saved, setSaved] = useState(0);
  const curveRef = useRef<HTMLElement | null>(null);
  // The preview card sits below the table: bring it into view and give it focus, so the click visibly does something (L3).
  useEffect(() => {
    if (curve === null || curveRef.current === null) return;
    curveRef.current.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
    curveRef.current.focus({ preventScroll: true });
  }, [curve]);
  const dirty = Object.keys(choices).length > 0 && saved === 0;
  useUnsavedGuard(dirty);
  const withRoles = rows.filter((f) => f.roles.length > 0);
  const onSave = () => act.run("Save", async () => {
    const id = nextGuidedSetId(ctx.ws, data.takenIds);
    const n = id.slice(id.lastIndexOf("-") + 1);
    const set = setFromChoices({ id, label: `Behavior models ${n}, ${ctx.head.name}` }, rows, data.set, choices);
    await createAssumptionSet(set);
    let head = await setBlock(ctx.ws, { expectedRevision: ctx.head.revision, by: byName(), block: "assumptions", op: "add", ref: { collection: "assumption-sets", id } });
    if (head.blocks.assumptions.defaultSetId !== id) {
      head = await setBlock(ctx.ws, { expectedRevision: head.revision, by: byName(), block: "assumptions", op: "set-default", ref: { collection: "assumption-sets", id } });
    }
    // The earlier guided sets of this workspace leave its block (L6); the store keeps them, as it keeps every document.
    for (const old of guidedSetsToDetach(ctx.ws, head.blocks.assumptions.sets.map((s) => s.id), id)) {
      head = await setBlock(ctx.ws, { expectedRevision: head.revision, by: byName(), block: "assumptions", op: "remove", ref: { collection: "assumption-sets", id: old } });
    }
    setSaved((k) => k + 1);
    setChoices({});
    ctx.refresh();
    return `Saved the models as ${id} (${set.bindings.length} ${set.bindings.length === 1 ? "binding" : "bindings"}) and made it the workspace default.`;
  });
  return (
    <>
      <ReasonCard ctx={ctx} />
      <section className="card table-card" aria-label="Families and their models">
        <div className="card-title">Your families and the model each one runs on</div>
        <p className="card-desc">
          {data.set === null ? "No behavior models are saved yet. " : `Saved models: ${data.set.label}. `}
          Every choice below is valid for the family's instrument. The published defaults are illustrative values from the engine's documentation, not fitted to your book; the deposit beta default is an illustrative textbook default, round values not fitted to any data. A saved model badged illustrative holds round illustrative values.
        </p>
        <div className="table-wrap guided-tall">
          <table className="table guided-table">
            <thead>
              <tr><th scope="col">Family</th><th scope="col">Behavior</th><th scope="col">Runs on now</th><th scope="col">Choose a model</th><th scope="col">Curve</th></tr>
            </thead>
            <tbody>
              {rows.map((f) => (f.roles.length === 0 ? (
                <tr key={f.familyId}>
                  <td><FamilyCell f={f} /></td>
                  <td className="muted guided-wrap" colSpan={4}>{noRoleSentence(f.instrumentType)}{f.otherBindings.length > 0 ? ` Saved: ${f.otherBindings.map((b) => `${b.overlay.kind === "registered" ? b.overlay.registeredKind : b.overlay.kind} (${b.modelVersion})`).join(", ")}.` : ""}</td>
                </tr>
              ) : f.roles.map((r, i) => (
                <RoleLine key={`${f.familyId}-${r.role}`} family={f} role={r} first={i === 0} choice={choices[choiceKey(f.familyId, r.role)] ?? { kind: r.initial }}
                  onChoice={(c) => setChoices({ ...choices, [choiceKey(f.familyId, r.role)]: c })} book={data.book} onCurve={setCurve} />
              ))))}
            </tbody>
          </table>
        </div>
        <div className="guided-actions">
          <button type="button" className="btn btn-primary" disabled={act.busy || withRoles.length === 0 && data.set !== null} onClick={onSave}>Use these models</button>
          <span className="field-help">Saves one assumption set from these choices and makes it the workspace default. Models on families your balance sheet does not hold are left out.</span>
        </div>
        {Object.keys(choices).length > 0 ? <p><span className="guided-badge" role="status">Not saved yet</span></p> : null}
        <ActionLines busy={act.busy} busyText="Saving the models" error={act.error} done={act.done} />
      </section>
      {curve !== null ? (
        <section className="card" aria-label="Curve preview" ref={(el) => { curveRef.current = el; }} tabIndex={-1}>
          <div className="card-title">{curve.title}</div>
          {"error" in curve ? <p className="guided-bad" role="alert">{curve.error}</p> : <MiniCurve p={curve.p} />}
        </section>
      ) : null}
      <PerPosition rows={rows} />
    </>
  );
}

function FamilyCell(props: { f: FamilyRow }) {
  return (
    <div className="guided-cell-stack">
      <span>{props.f.label}</span>
      <span className="field-help">{INSTRUMENT_LABEL[props.f.instrumentType] ?? props.f.instrumentType}</span>
    </div>
  );
}

function overlayFor(r: RoleRow, choice: RoleChoice, book: PortfolioSpec, familyId: string): BehavioralOverlay | null {
  if (choice.kind === "default") return r.published?.overlay ?? null;
  if (choice.kind === "set") return r.positions.find((p) => p.effective.source === "set")?.effective.overlay ?? null;
  const p = book.positions.find((x) => x.familyId === familyId);
  return p === undefined ? null : inlineOverlay(p, r.role);
}

type CurveShown = { title: string; p: GuidedBehaviorPreview } | { title: string; error: string };

function RoleLine(props: { family: FamilyRow; role: RoleRow; first: boolean; choice: RoleChoice; onChoice: (c: RoleChoice) => void; book: PortfolioSpec; onCurve: (c: CurveShown) => void }) {
  const { family: f, role: r, choice } = props;
  const anyDefault = r.positions.some((p) => p.effective.isDefault);
  const tagPairs = Object.entries(f.tags).flatMap(([d, vs]) => vs.map((v) => ({ dimension: d, value: v })));
  const onCurve = () => {
    const title = `${f.label}, ${ROLE_LABEL[r.role].toLowerCase()}: ${CHOICE_LABEL[choice.kind].toLowerCase()}`;
    const o = overlayFor(r, choice, props.book, f.familyId);
    if (o === null) { props.onCurve({ title, error: "There are no values to draw for this choice." }); return; }
    previewGuidedBehavior(o).then((p) => props.onCurve({ title, p }), (e: unknown) => props.onCurve({ title, error: errText(e) }));
  };
  return (
    <tr>
      <td>{props.first ? <FamilyCell f={f} /> : null}</td>
      <td>{ROLE_LABEL[r.role]}</td>
      <td className="guided-wrap">
        <div className="guided-cell-stack">
          <span>{r.summary}</span>
          {anyDefault ? <span><span className="guided-badge">{publishedBadge(r.published)}</span></span> : null}
          {r.positions.some((p) => p.effective.source === "set" && isIllustrativeVersion(p.effective.modelVersion)) ? <span><span className="guided-badge">illustrative</span></span> : null}
        </div>
      </td>
      <td>
        <div className="guided-cell-stack">
          <select className="guided-select" aria-label={`${f.label}, ${ROLE_LABEL[r.role]}: choose a model`} value={choice.kind}
            onChange={(e) => props.onChoice({ kind: e.target.value as RoleChoice["kind"] })}>
            {r.options.map((o) => <option key={o} value={o}>{CHOICE_LABEL[o]}</option>)}
          </select>
          {choice.kind === "default" ? <span><span className="guided-badge">{publishedBadge(r.published)}</span></span> : null}
          {choice.kind === "default" && tagPairs.length > 0 ? (
            <select className="guided-select" aria-label={`${f.label}: apply the default to`} value={choice.tag === undefined ? "" : `${choice.tag.dimension}=${choice.tag.value}`}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "") props.onChoice({ kind: "default" });
                else { const [dimension, value] = v.split("="); props.onChoice({ kind: "default", tag: { dimension: dimension!, value: value! } }); }
              }}>
              <option value="">The whole family</option>
              {tagPairs.map((t) => <option key={`${t.dimension}=${t.value}`} value={`${t.dimension}=${t.value}`}>{`Only positions tagged ${t.dimension} ${t.value}`}</option>)}
            </select>
          ) : null}
          {choice.kind === "default" && r.published !== null ? <span className="field-help">{r.published.source}</span> : null}
        </div>
      </td>
      <td>
        <button type="button" className="btn btn-quiet" onClick={onCurve}>Show the curve</button>
      </td>
    </tr>
  );
}

function MiniCurve(props: { p: GuidedBehaviorPreview }) {
  const { p } = props;
  const pct = p.yUnit === "percent";
  const xl = (x: number): string => (p.xUnit === "bp" ? `${x} bp` : p.xUnit === "month" ? `Month ${x}` : `${x}%`);
  return (
    <figure className="viz">
      <LinePlot series={[{ id: "c", label: p.yLabel, tone: "accent", points: p.points }]} xScale="linear" xTicks={linearTicks} xLabel={xl}
        yTick={(v) => (pct ? `${v.toFixed(0)}%` : v.toFixed(2))} format={(v) => (pct ? `${v.toFixed(2)}%` : v.toFixed(4))} unit={p.yLabel} height={240} legend={false} />
      <figcaption className="field-help">{`${p.xLabel}. ${p.note}`}</figcaption>
    </figure>
  );
}

function PerPosition(props: { rows: FamilyRow[] }) {
  const lines = props.rows.flatMap((f) => f.roles.flatMap((r) => r.positions.map((p) => ({ f, r, p }))));
  if (lines.length === 0) return null;
  const shown = lines.slice(0, 300);
  return (
    <section className="card table-card" aria-label="Model per position">
      <details>
        <summary className="card-title">The model each position runs on now ({lines.length})</summary>
        <div className="table-wrap guided-tall">
          <table className="table">
            <thead><tr><th scope="col">Position</th><th scope="col">Family</th><th scope="col">Behavior</th><th scope="col">From</th><th scope="col">Applies to</th></tr></thead>
            <tbody>
              {shown.map(({ f, r, p }) => (
                <tr key={`${p.id}-${r.role}`}>
                  <td><div className="guided-cell-stack"><span>{p.label}</span><span className="mono muted">{p.id}</span></div></td>
                  <td>{f.label}</td>
                  <td>{ROLE_LABEL[r.role]}</td>
                  <td>
                    {p.effective.source === "set" ? `Saved set, ${p.effective.modelVersion}` : p.effective.source === "book" ? "Its own position values" : "No model"}
                    {p.effective.isDefault ? <> <span className="guided-badge">{publishedBadge(r.published)}</span></> : null}
                    {p.effective.source === "set" && isIllustrativeVersion(p.effective.modelVersion) ? <> <span className="guided-badge">illustrative</span></> : null}
                  </td>
                  <td>{p.effective.source === "set" ? selectorText(p.effective.selector ?? undefined) : "the position"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {lines.length > shown.length ? <p className="table-foot">{`Showing the first ${shown.length} of ${lines.length}.`}</p> : null}
      </details>
      <Details><p>A saved binding with a selector applies to the positions whose tags match it; the rest of the family runs on its own position values.</p></Details>
    </section>
  );
}
