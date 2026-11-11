// apps/studio/src/pages/plan/SwapMenu.tsx
/** The swap menu for one stage: same stage kind, each item marked Runs or Catalog only. */
import type { MenuItem } from "../../plan/componentMenu";

export function SwapMenu(props: { items: MenuItem[]; stageId: string; onPick(id: string): void; onClose(): void }) {
  return (
    <div className="card swap-menu" role="dialog" aria-label={`Swap the component of ${props.stageId}`}>
      <div className="swap-head">
        <span>Swap <span className="mono">{props.stageId}</span></span>
        <button type="button" className="btn" onClick={props.onClose}>Close</button>
      </div>
      <ul className="swap-list">
        {props.items.map((it) => (
          <li key={it.id}>
            <button type="button" className="swap-item" disabled={it.current} onClick={() => props.onPick(it.id)}>
              <span className="swap-label">{it.label}</span>
              <span className="mono muted">{it.id}</span>
              <span className={it.runs ? "chip chip-runs" : "chip chip-catalog"}>{it.runs ? "Runs" : "Catalog only"}</span>
              {it.current ? <span className="chip">Current</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
