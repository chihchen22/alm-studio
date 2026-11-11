// apps/studio/src/pages/plan/ViewsCard.tsx
/**
 * The plan's views, presentational: the views the plan declares
 * and a small form to add one. The validate gate above stays the judge of each
 * view; this card only offers the dimensions the engine's own shape check lets
 * the book's taxonomy group by.
 */
import { useState } from "react";
import { canAddView, groupByText, type ViewDimOption } from "../../plan/planViews";
import type { PlanDoc } from "../../plan/planGraph";

type ViewDef = NonNullable<PlanDoc["views"]>[number];

export interface ViewDraft {
  label: string;
  picks: string[];
}

export interface ViewsCardProps {
  views: ViewDef[];
  bookId: string;
  /** null while the taxonomy is unread or unreadable. */
  options: ViewDimOption[] | null;
  optionsError: string | null;
  note: string;
  draft: ViewDraft;
  nextId: string;
  onDraft(d: ViewDraft): void;
  onAdd(): void;
  onRemove(id: string): void;
  /** What the card says when nothing is declared; the plan composer's words by default (the setup editor names the setup). */
  emptyText?: string;
}

export function ViewsCard(props: ViewsCardProps) {
  const { views, bookId, options, optionsError, note, draft, nextId } = props;
  const available = (options ?? []).filter((o) => !draft.picks.includes(o.id));
  const [pending, setPending] = useState("");
  const chosen = available.some((o) => o.id === pending) ? pending : (available[0]?.id ?? "");
  const ready = canAddView(draft.label, draft.picks);
  return (
    <section className="card stack" aria-label="Views">
      <div className="card-title">Views</div>
      {views.length === 0 ? <p className="muted">{props.emptyText ?? "No view declared on this plan."}</p> : null}
      {views.map((v) => (
        <div key={v.id} className="plan-toolbar">
          <span>{v.label}</span>
          <span className="mono">{v.id}</span>
          <span className="muted">groups by <span className="mono">{groupByText(v.groupBy)}</span></span>
          <button type="button" className="btn" onClick={() => props.onRemove(v.id)}>Remove</button>
        </div>
      ))}
      <label className="field">
        <span className="field-label">Label</span>
        <input
          className="input"
          type="text"
          value={draft.label}
          onChange={(e) => props.onDraft({ ...draft, label: e.target.value })}
        />
      </label>
      {options === null ? (
        optionsError !== null ? (
          <p className="muted" role="alert">No dimension offered: book {bookId} could not be read. {optionsError}</p>
        ) : (
          <p className="muted">Reading the taxonomy of {bookId}</p>
        )
      ) : (
        <div className="plan-toolbar">
          <label className="field">
            <span className="field-label">Group by</span>
            <select aria-label="Group by" value={chosen} onChange={(e) => setPending(e.target.value)}>
              {available.map((o) => <option key={o.id} value={o.id}>{`${o.label} (${o.id})`}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            disabled={chosen === ""}
            onClick={() => { if (chosen !== "") props.onDraft({ ...draft, picks: [...draft.picks, chosen] }); }}
          >
            Add dimension
          </button>
        </div>
      )}
      {draft.picks.length > 0 ? (
        <div className="plan-toolbar">
          <span>Groups by: <span className="mono">{groupByText(draft.picks)}</span></span>
          <button type="button" className="btn" onClick={() => props.onDraft({ ...draft, picks: [] })}>Clear</button>
        </div>
      ) : null}
      <div>
        <button type="button" className="btn btn-primary" disabled={!ready} onClick={props.onAdd}>
          Add view <span className="mono">{nextId}</span>
        </button>
      </div>
      <div className="card-foot">
        <p>{note}</p>
        <p>
          Offered: the single-valued tags {bookId} declares, plus the derived productFamily and side, as the engine&apos;s view
          rules P1 and P2 allow. Whether every position carries the tag (P3) is the validate gate&apos;s answer above.
        </p>
        <p>
          The validate gate accepts or refuses each view. A run of the saved plan carries its views, and the Results Views tab
          groups the run by each one.
        </p>
        <p>Source: /api/portfolios/{bookId} taxonomy; /api/portfolios; /api/hierarchies.</p>
      </div>
    </section>
  );
}
