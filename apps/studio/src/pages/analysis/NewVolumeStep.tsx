// apps/studio/src/pages/analysis/NewVolumeStep.tsx
/**
 * Step 4, New volume. The plain question "What happens to maturing balances?" with no answer chosen for the user (its
 * answer starts the guided run setup); per family a target (run off, hold, grow to a balance by a month) with the
 * target balance path drawn before running; and the product each family's new volume is:
 * fixed or floating, how it repays, its term, the index it is priced off and its spread, with what it would pay today
 * and how it repays drawn beside it. Each product carries its family's behavior model where
 * it can, and the step shows which model in plain words with a small curve (CPR by month for a loan, the balance left by
 * month for a new deposit). Every drawn number is the server's preview (the engine's own rules); the step restates none
 * of them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getBalancePlan, getPortfolio, listBalancePlans, previewNewVolume, saveBalancePlan, setBlock, type GuidedNewVolumePreview } from "@alm/reader";
import type { BalancePlan, NewBusinessAmortization, NewBusinessRateType, PortfolioSpec } from "@alm/engine";
import { pct } from "@alm/reader";
import { LinePlot } from "../../charts/LinePlot";
import { monthTicks, type Point } from "../../charts/plotScale";
import { moneyTick, money } from "../../format/figures";
import { useKeptLoad as useLoad } from "../../useLoad";
import { errText } from "../../errText";
import { summarizeBook } from "../../guided/book";
import { answerOf, withBasis, withTemplates, type MaturingAnswer } from "../../guided/setup";
import {
  AMORTIZATION_LABEL, INDEX_TENORS, RATE_TYPE_LABEL, SWAP_TENORS,
  DEPOSIT_STAND_IN, DEPOSIT_STAND_IN_FULL, DEPOSIT_TERM_FULL, DEPOSIT_TERM_SHORT, DEPOSIT_TYPES, SWAP_PRICED_NOTE, behaviorWords, standInReason,
  draftPlanOf, newRow, planOf, productProblems, productRowsFor, productsDirty as rowsDirty, rowsFromPlan, templatesOf, volumeProblems, withRateType,
  type ProductRow, type TargetKind, type VolumeRow,
} from "../../guided/volume";
import { ActionLines, Details, byName, saveGuided, useAction, useUnsavedGuard, type StepContext } from "./common";

const ANSWERS: ReadonlyArray<{ kind: MaturingAnswer["kind"]; label: string; help: string }> = [
  { kind: "runoff", label: "They run off: no new volume", help: "Every balance follows its own maturities, amortization, prepayment and decay. The simplest view of the balance sheet you hold today." },
  { kind: "flat", label: "They are replaced to keep every balance flat", help: "Each family is topped back up to its opening balance with new volume of the product you set below." },
  { kind: "custom", label: "They follow my targets", help: "Set a target per family below: run off, hold, or grow to a balance by a month. The new volume is the product you set below." },
];

const KIND_LABEL: Record<TargetKind, string> = { runoff: "Run off", hold: "Hold the balance", grow: "Grow to" };

interface Loaded { book: PortfolioSpec; plan: BalancePlan | null; planIds: string[]; start: GuidedNewVolumePreview }

export function NewVolumeStep(props: { ctx: StepContext }) {
  const { ctx } = props;
  const bookId = ctx.head.blocks.positions.book?.id ?? null;
  const planId = ctx.guided?.nii.basis.kind === "custom" ? ctx.guided.nii.basis.balancePlanId : null;
  const load = useLoad(async (): Promise<Loaded> => {
    if (bookId === null) throw new Error("no book");
    const [book, plan, list, start] = await Promise.all([
      getPortfolio(bookId),
      planId === null ? Promise.resolve(null) : getBalancePlan(planId).catch(() => null),
      listBalancePlans().catch(() => []),
      previewNewVolume(ctx.ws, {}),
    ]);
    return { book: book as PortfolioSpec, plan, planIds: list.map((p) => p.id), start };
  }, [bookId, planId, ctx.head.revision]);
  if (bookId === null) return <section className="card"><p className="guided-warn">Load the balance sheet first: targets are set per family of your positions.</p></section>;
  if (load.state === "loading") return <div className="card muted">Reading the positions</div>;
  if (load.state === "error") return <div className="card" role="alert">{errText(load.error)}</div>;
  return <VolumeBody ctx={ctx} data={load.value} />;
}

/** The server's preview for the rows as they stand, refreshed shortly after each edit; the last good one stays drawn. */
function useLivePreview(ws: string, body: string, first: GuidedNewVolumePreview): { preview: GuidedNewVolumePreview; error: string | null; current: boolean } {
  const [preview, setPreview] = useState(first);
  const [error, setError] = useState<string | null>(null);
  // Fix round M3: the body the drawn preview answers, so Save waits for the preview of what is on screen.
  const [answered, setAnswered] = useState<string | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    const n = ++seq.current;
    const timer = window.setTimeout(() => {
      previewNewVolume(ws, JSON.parse(body) as Parameters<typeof previewNewVolume>[1]).then(
        (p) => { if (n === seq.current) { setPreview(p); setError(null); setAnswered(body); } },
        (e: unknown) => { if (n === seq.current) setError(errText(e)); },
      );
    }, 250);
    return () => window.clearTimeout(timer);
  }, [ws, body]);
  return { preview, error, current: answered === body && error === null };
}

function VolumeBody(props: { ctx: StepContext; data: Loaded }) {
  const { ctx, data } = props;
  const current = ctx.guided === null ? null : answerOf(ctx.guided.nii.basis);
  const [answer, setAnswer] = useState<MaturingAnswer["kind"] | null>(current?.kind ?? null);
  const base = useMemo(() => summarizeBook(data.book).families.filter((f) => f.positions > 0 && !f.offBalance && !f.heldAtBook && (f.side === "asset" || f.side === "liability")).map((f) => newRow(f.familyId, f.label, f.notional)), [data.book]);
  const [rows, setRows] = useState<VolumeRow[]>(() => rowsFromPlan(base, data.plan));
  const startProducts = useMemo(() => productRowsFor(data.start.families, ctx.guided, data.plan), [data.start, ctx.guided, data.plan]);
  const [products, setProducts] = useState<ProductRow[]>(startProducts);
  const act = useAction();
  const problems = volumeProblems(rows);
  const pProblems = productProblems(products);
  const anyTarget = rows.some((r) => r.kind !== "runoff");
  // Fix round M1: compare what the learner edits, not the rows' descriptive text, so a landed save reads as saved.
  const productsDirty = rowsDirty(products, startProducts);
  useUnsavedGuard(productsDirty);

  const previewBody = JSON.stringify({ templates: pProblems.length === 0 ? templatesOf(products) : [], plan: answer === "custom" ? draftPlanOf(data.book, rows, products) : null, months: 60 });
  const live = useLivePreview(ctx.ws, previewBody, data.start);
  const famPreview = (id: string) => live.preview.families.find((f) => f.familyId === id);

  // Fix round M3: the engine's own refusals, as the preview reports them for what is on screen, gate every save of the
  // products, so a product the run would refuse is never saved.
  const previewBlocks = live.preview.problems.length > 0 || !live.current;
  const templatesNow = () => {
    if (pProblems.length > 0) throw new Error(`Fix the products first: ${pProblems[0]}`);
    if (live.preview.problems.length > 0) throw new Error(`Fix the products first: ${live.preview.problems[0]}`);
    if (!live.current) throw new Error("The preview is still reading the products; save again in a moment.");
    return templatesOf(products);
  };
  const saveAnswer = () => act.run("Answer", async () => {
    if (answer === null) throw new Error("Choose one answer first.");
    if (answer === "custom") throw new Error("Save your targets below: that saves this answer too.");
    const a: MaturingAnswer = { kind: answer };
    // A new analysis starts with the products shown below (each family's own); an existing one keeps its products.
    const templates = ctx.guided === null ? templatesNow() : null;
    await saveGuided(ctx, (s) => (templates === null ? withBasis(s, a) : withTemplates(withBasis(s, a), templates)), a);
    ctx.refresh();
    return answer === "runoff" ? "Saved: maturing balances run off." : "Saved: every balance is kept flat with new volume of the products below.";
  });
  const saveTargets = () => act.run("Targets", async () => {
    const templates = templatesNow();
    let n = 1;
    const stem = `bp-guided-${ctx.ws.replace(/^ws-/, "")}`.slice(0, 58);
    while (data.planIds.includes(`${stem}-${n}`)) n++;
    const id = `${stem}-${n}`;
    const plan = planOf({ id, label: `Targets for ${data.book.label}`, asOf: data.book.asOf }, rows, products);
    await saveBalancePlan(plan);
    const head = await setBlock(ctx.ws, { expectedRevision: ctx.head.revision, by: byName(), block: "targets", op: "add", ref: { collection: "plans", id } });
    const a: MaturingAnswer = { kind: "custom", balancePlanId: id };
    await saveGuided({ ...ctx, head }, (s) => withTemplates(withBasis(s, a), templates), a);
    ctx.refresh();
    return `Saved the targets and the products as ${id}; the analysis follows them.`;
  });
  const saveProducts = () => act.run("Products", async () => {
    const templates = templatesNow();
    await saveGuided(ctx, (s) => withTemplates(s, templates));
    ctx.refresh();
    return "Saved the new-volume products.";
  });

  const shownProducts = answer === "custom" ? products.filter((p) => rows.find((r) => r.familyId === p.familyId)?.kind !== "runoff") : products;

  return (
    <>
      <section className="card" aria-label="Maturing balances">
        <fieldset className="guided-fieldset">
          <legend>What happens to maturing balances?</legend>
          {ANSWERS.map((a) => (
            <label key={a.kind} className="guided-option">
              <input type="radio" name="maturing" value={a.kind} checked={answer === a.kind} onChange={() => setAnswer(a.kind)} />
              <span className="guided-option-text"><span>{a.label}</span><span className="field-help">{a.help}</span></span>
            </label>
          ))}
        </fieldset>
        {current === null ? <p className="field-help">Nothing is chosen for you: your answer starts the analysis setup, with the products shown below.</p> : <p className="field-help">{`Saved answer: ${ANSWERS.find((x) => x.kind === current.kind)!.label}.`}</p>}
        {answer !== "custom" ? (
          <div className="guided-actions">
            <button type="button" className="btn btn-primary" disabled={act.busy || answer === null || answer === current?.kind || (answer === "flat" && (previewBlocks || (ctx.guided === null && pProblems.length > 0)))} onClick={saveAnswer}>Save the answer</button>
          </div>
        ) : null}
        <ActionLines busy={act.busy} error={act.error} done={act.done} />
      </section>
      {answer === "custom" ? (
        <section className="card table-card" aria-label="Targets">
          <div className="card-title">Targets by family</div>
          <p className="card-desc">A family on Run off gets no new volume. Hold keeps its opening balance; Grow reaches your balance by your month and keeps growing at that rate afterwards (the engine carries one steady rate per family).</p>
          <div className="table-wrap guided-tall">
            <table className="table guided-table">
              <thead><tr><th scope="col">Family</th><th scope="col" className="num">Opening balance</th><th scope="col">Target</th><th scope="col">Balance, $ million</th><th scope="col">By month</th></tr></thead>
              <tbody>
                {rows.map((r, i) => {
                  const set = (patch: Partial<VolumeRow>) => setRows(rows.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                  const g = r.kind === "grow" ? famPreview(r.familyId)?.target?.annualGrowthPct ?? null : null;
                  return (
                    <tr key={r.familyId}>
                      <td>{r.label}</td>
                      <td className="num">{money(r.opening)}</td>
                      <td>
                        <select className="guided-select" aria-label={`${r.label}: target`} value={r.kind} onChange={(e) => set({ kind: e.target.value as TargetKind })}>
                          {(["runoff", "hold", "grow"] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                        </select>
                        {g !== null ? <div className="field-help">{`${g.toFixed(1)}% a year`}</div> : null}
                      </td>
                      <td>{r.kind === "grow" ? <input className="input input-bal" aria-label={`${r.label}: target balance in millions`} value={r.balance} onChange={(e) => set({ balance: e.target.value })} /> : null}</td>
                      <td>{r.kind === "grow" ? <input className="input input-short" aria-label={`${r.label}: by month`} value={r.month} onChange={(e) => set({ month: e.target.value })} /> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {problems.length > 0 ? <ul className="guided-missing">{problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
          <TargetChart preview={live.preview} rows={rows} />
          <div className="guided-actions">
            <button type="button" className="btn btn-primary" disabled={act.busy || problems.length > 0 || pProblems.length > 0 || previewBlocks || !anyTarget} onClick={saveTargets}>Save the targets and products</button>
            {!anyTarget ? <span className="field-help">Give at least one family a Hold or Grow target, or choose Run off above.</span> : null}
          </div>
          <ActionLines busy={act.busy} error={act.error} done={act.done} />
        </section>
      ) : null}
      {answer === "flat" || answer === "custom" ? (
        <ProductsCard
          products={products}
          shown={shownProducts}
          setProducts={setProducts}
          preview={live.preview}
          previewError={live.error}
          problems={pProblems}
          blocked={previewBlocks}
          canSave={ctx.guided !== null && current?.kind === answer && answer !== "custom"}
          saving={act.busy}
          dirty={productsDirty}
          onSave={saveProducts}
        />
      ) : (
        <section className="card" aria-label="New volume products">
          <div className="card-title">What the new volume is</div>
          <p className="card-desc">{answer === "runoff" ? "Your maturing balances run off, so no new volume is made. Products apply when balances are replaced or follow targets." : "Choose an answer above: when balances are replaced or follow targets, you set here what the new volume is."}</p>
        </section>
      )}
    </>
  );
}

const TONES = ["accent", "second", "third", "fourth", "fifth", "sixth"] as const;

/** The repayment choices as the table shows them; the full words are the option's title and the card's text. */
const SHORT_AMORTIZATION: Record<NewBusinessAmortization, string> = { bullet: "Bullet", "level-pay": "Level payment", linear: "Equal principal", decay: "Decays" };

function TargetChart(props: { preview: GuidedNewVolumePreview; rows: VolumeRow[] }) {
  const series = props.preview.families
    .filter((f) => f.target !== undefined && props.rows.find((r) => r.familyId === f.familyId)?.kind !== "runoff")
    .slice(0, 6)
    .map((f, i) => ({ id: f.familyId, label: f.label, tone: TONES[i]!, points: f.target!.balance.map((v, t) => [t, v] as Point) }));
  if (series.length === 0) return <p className="field-help">The target balance of each Hold or Grow family is drawn here before you run, once every target reads. A Run off family follows its own run-off, which the run computes.</p>;
  return (
    <figure className="viz">
      <LinePlot series={series} xScale="linear" xTicks={monthTicks} xLabel={(m) => `Month ${m}`} yTick={moneyTick} format={money} unit="balance" yZero />
      <figcaption className="field-help">Target balance by month over five years, before any run: the path the engine aims each Hold or Grow family at.</figcaption>
    </figure>
  );
}

function ProductsCard(props: {
  products: ProductRow[];
  shown: ProductRow[];
  setProducts: (rows: ProductRow[]) => void;
  preview: GuidedNewVolumePreview;
  previewError: string | null;
  problems: string[];
  /** Fix round M3: the preview reports a refusal, or has not yet read what is on screen. */
  blocked: boolean;
  canSave: boolean;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
}) {
  const { products, shown, preview } = props;
  const set = (id: string, patch: Partial<ProductRow> | ((r: ProductRow) => ProductRow)) =>
    props.setProducts(products.map((r) => (r.familyId !== id ? r : typeof patch === "function" ? patch(r) : { ...r, ...patch })));
  const famOf = (id: string) => preview.families.find((f) => f.familyId === id);
  const drawn = shown
    .map((r) => ({ r, p: famOf(r.familyId)?.preview }))
    .filter((x): x is { r: ProductRow; p: NonNullable<typeof x.p> } => x.p !== undefined)
    .slice(0, 6)
    .map(({ r, p }, i) => ({ id: r.familyId, label: r.label, tone: TONES[i]!, points: [...p.months.map((m) => [m.month - 1, m.balance] as Point), [p.months.length, 0] as Point] }));
  return (
    <section className="card table-card" aria-label="New volume products">
      <div className="card-title">What the new volume is</div>
      <p className="card-desc">
        Each family's new volume is one product: a fixed rate locked when it is made, or a floating rate that resets on an index; repaid at maturity, by a
        level payment or in equal parts. A deposit family's new volume is a new deposit at the family's own rate. A product can carry the family's behavior
        model, aged from the month it is made: new loans prepay, new deposits decay and reprice. It earns or costs net interest income and is priced in FTP
        from the month it is made. Value and the gap ladders run the balance sheet you hold off unless you add new volume to them on the Simulation step.
      </p>
      {shown.length === 0 ? <p className="field-help">No family gets new volume with these targets: give a family Hold or Grow above.</p> : (
        <div className="table-wrap guided-tall">
          <table className="table guided-table">
            <thead>
              <tr>
                <th scope="col">Family</th><th scope="col">Rate</th><th scope="col">Repayment</th><th scope="col">Term, months</th>
                <th scope="col">Priced off</th><th scope="col">Spread, bp</th><th scope="col" className="num">Rate today</th><th scope="col">Behavior</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => {
                const fam = famOf(r.familyId);
                const p = fam?.preview;
                const depositFamily = DEPOSIT_TYPES.includes(fam?.instrumentType ?? "");
                const deposit = r.rateType === "deposit";
                // Fix round M3: a deposit product is offered only where the family's model is one it carries (or the row is on it).
                const reason = standInReason(fam);
                const rates: NewBusinessRateType[] = depositFamily && (reason === null || deposit) ? ["deposit", "fixed", "floating"] : ["fixed", "floating"];
                return (
                  <tr key={r.familyId}>
                    <td title={r.origin}>{r.label}{depositFamily && !deposit ? (reason !== null ? <div className="field-help">{reason}</div> : <div className="field-help" title={DEPOSIT_STAND_IN_FULL}>{DEPOSIT_STAND_IN}</div>) : null}</td>
                    <td>
                      <select className="guided-select" aria-label={`${r.label}: rate`} value={r.rateType} onChange={(e) => set(r.familyId, (x) => withRateType(x, e.target.value as NewBusinessRateType))}>
                        {rates.map((k) => <option key={k} value={k}>{RATE_TYPE_LABEL[k]}</option>)}
                      </select>
                    </td>
                    <td>
                      {deposit ? <span title={AMORTIZATION_LABEL.decay}>{SHORT_AMORTIZATION.decay}</span> : (
                        <select className="guided-select" aria-label={`${r.label}: repayment`} value={r.amortization} onChange={(e) => set(r.familyId, { amortization: e.target.value as NewBusinessAmortization })}>
                          {(["bullet", "level-pay", "linear"] as const).map((k) => <option key={k} value={k} title={AMORTIZATION_LABEL[k]}>{SHORT_AMORTIZATION[k]}</option>)}
                        </select>
                      )}
                    </td>
                    <td>
                      <input className="input input-short" aria-label={`${r.label}: term`} value={r.termMonths} onChange={(e) => set(r.familyId, { termMonths: e.target.value })} />
                      {/* Fix round L5: a deposit's term is a cut-off, not a life. */}
                      {deposit ? <div className="field-help" title={DEPOSIT_TERM_FULL}>{DEPOSIT_TERM_SHORT}</div> : null}
                    </td>
                    <td>
                      {deposit ? <span className="muted">Its own paid rate</span> : r.rateType === "fixed" ? (
                        <select className="guided-select" aria-label={`${r.label}: swap rate`} value={r.indexTenor} onChange={(e) => set(r.familyId, { indexTenor: e.target.value })}>
                          <option value="matched">Matched funding rate</option>
                          <option value="term">Swap, its own term</option>
                          {SWAP_TENORS.map((m) => <option key={m} value={String(m)}>{`Swap, ${m / 12} year${m === 12 ? "" : "s"}`}</option>)}
                        </select>
                      ) : (
                        <select className="guided-select" aria-label={`${r.label}: index`} value={r.indexTenor} onChange={(e) => set(r.familyId, { indexTenor: e.target.value })}>
                          {INDEX_TENORS.map((m) => <option key={m} value={String(m)}>{m === 1 ? "1-month rate, monthly reset" : `${m}-month rate, ${m}-month reset`}</option>)}
                        </select>
                      )}
                    </td>
                    <td>{deposit ? <span className="muted">0</span> : <input className="input input-short" aria-label={`${r.label}: spread`} value={r.spreadBp} onChange={(e) => set(r.familyId, { spreadBp: e.target.value })} />}</td>
                    <td className="num">{p === undefined ? "" : <>{pct(p.couponRate, 2)}<div className="field-help">{deposit ? "paid today" : p.transferRate !== undefined && p.margin !== undefined ? `transfer ${pct(p.transferRate, 2)}, margin ${Math.abs(p.margin * 1e4) < 0.05 ? "0.0" : (p.margin * 1e4).toFixed(1)} bp` : `index ${pct(p.indexRate, 2)}`}</div></>}</td>
                    <td className="guided-wrap">
                      {deposit ? null : (
                        <label className="guided-check">
                          <input type="checkbox" aria-label={`${r.label}: carries the family's model`} checked={r.behavior} onChange={(e) => set(r.familyId, { behavior: e.target.checked })} />
                          <span>Carries the family's model</span>
                        </label>
                      )}
                      <div className="field-help">{behaviorWords(r, p, fam?.model)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {shown.some((r) => r.rateType === "fixed" && r.indexTenor !== "matched") ? <p className="field-help">{SWAP_PRICED_NOTE}</p> : null}
      {props.problems.length > 0 ? <ul className="guided-missing">{props.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      {props.previewError !== null ? <p className="guided-warn" role="status">{`The preview could not be refreshed: ${props.previewError}`}</p> : null}
      {preview.problems.length > 0 ? <ul className="guided-missing">{preview.problems.map((p) => <li key={p}>{p}</li>)}</ul> : null}
      {drawn.length > 0 ? (
        <figure className="viz">
          <LinePlot series={drawn} xScale="linear" xTicks={monthTicks} xLabel={(m) => `Month ${m}`} yTick={(v) => v.toFixed(0)} format={(v) => v.toFixed(2)} unit="balance of 100 made today" yZero />
          <figcaption className="field-help">{`How each product repays: the balance left of 100 made today, by month, with its behavior where it carries one (rates read off the curve dated ${preview.calibrationDate}).`}</figcaption>
        </figure>
      ) : null}
      <BehaviorPreview shown={shown} preview={preview} />
      {props.canSave ? (
        <div className="guided-actions">
          <button type="button" className="btn btn-primary" disabled={props.saving || props.problems.length > 0 || props.blocked || !props.dirty} onClick={props.onSave}>Save the products</button>
          {props.dirty ? <span className="field-help">Not saved yet</span> : null}
        </div>
      ) : null}
      <Details>
        <p>Where each family's product started:</p>
        <ul className="guided-missing">{shown.map((r) => <li key={r.familyId}>{`${r.label}: ${r.origin}`}</li>)}</ul>
        <p>{`A fixed product's coupon is locked in the month it is made: its matched funding rate (the transfer rate of its own schedule, from that month's forwards and the liquidity premium) plus the spread, or a swap rate over a tenor you choose plus the spread. A floating product's coupon resets to the index read at its own months, plus the spread. Today's rule is a 60-month fixed bullet at the par swap rate: ${pct(preview.todayRule.couponRate, 2)} today.`}</p>
        <p>A product that carries the family's model runs the model a new position of the family runs: the saved model of the Behavior step where one binds the family, else the family's own position values, taken from its largest position. Each tranche starts at age 0 in the month it is made and reads the scenario's rates from that month. A prepayment model runs on a fixed-rate level-payment product; on any other shape the new volume is contractual and the row says so.</p>
        <p>Saved on the analysis setup as nii.templates; the engine sets each on the family's new-business rule.</p>
      </Details>
    </section>
  );
}

/**
 * What each new tranche carries (S2b-2 spec point 4): per family, the model in plain words, and two small curves read off
 * the server's preview of a tranche made today: CPR by month for loans that prepay, and the balance left of 100 by month
 * for new deposits.
 */
function BehaviorPreview(props: { shown: ProductRow[]; preview: GuidedNewVolumePreview }) {
  const rows = props.shown.map((r) => ({ r, f: props.preview.families.find((x) => x.familyId === r.familyId) })).filter((x) => x.f !== undefined && x.r.behavior);
  if (rows.length === 0) return null;
  // Fix round L2: a model is listed as carried only where the tranche runs it (the preview says applied).
  const carried = rows.filter((x) => x.f!.preview?.behavior?.applied === true);
  const plain = rows.filter((x) => x.f!.preview?.behavior?.applied !== true);
  const cpr = rows
    .filter((x) => x.f!.preview?.cprByMonth !== undefined)
    .slice(0, 6)
    .map((x, i) => ({ id: x.r.familyId, label: x.r.label, tone: TONES[i]!, points: x.f!.preview!.cprByMonth!.slice(0, 120).map((v, m) => [m + 1, v * 100] as Point) }));
  const dep = rows
    .filter((x) => x.r.rateType === "deposit" && x.f!.preview !== undefined)
    .slice(0, 6)
    .map((x, i) => ({ id: x.r.familyId, label: x.r.label, tone: TONES[i]!, points: x.f!.preview!.months.map((m) => [m.month - 1, m.balance] as Point) }));
  return (
    <section className="guided-subcard" aria-label="Behavior of new volume">
      <div className="card-title">The behavior each new tranche carries</div>
      <ul className="guided-missing">
        {carried.map(({ r, f }) => (
          <li key={r.familyId}>{`${r.label}: ${f!.model.label}${f!.model.source === "assumption-set" ? ` (your saved model, ${f!.model.modelVersions.join(", ")})` : " (the family's own position values)"}. ${f!.preview?.behavior?.note ?? ""}`}</li>
        ))}
        {plain.length > 0 ? <li>{`Contractual (no model, or a product that cannot carry it): ${plain.map((x) => x.r.label).join(", ")}.`}</li> : null}
      </ul>
      {cpr.length > 0 ? (
        <figure className="viz">
          <LinePlot series={cpr} xScale="linear" xTicks={monthTicks} xLabel={(m) => `Month ${m}`} yTick={(v) => `${v.toFixed(1)}%`} format={(v) => `${v.toFixed(2)}%`} unit="annual CPR" yZero />
          <figcaption className="field-help">{`Prepayment speed of a loan made today, by month of its life, first ten years (${cpr.map((s) => s.label).join(", ")}): the family's model from age 0, so the seasoning ramp starts at origination.`}</figcaption>
        </figure>
      ) : null}
      {dep.length > 0 ? (
        <figure className="viz">
          <LinePlot series={dep} xScale="linear" xTicks={monthTicks} xLabel={(m) => `Month ${m}`} yTick={(v) => v.toFixed(0)} format={(v) => v.toFixed(2)} unit="balance left of 100 new deposits" yZero />
          <figcaption className="field-help">Balance left of 100 of new deposits taken today, by month: the family's decay from age 0 on today's curve.</figcaption>
        </figure>
      ) : null}
    </section>
  );
}
