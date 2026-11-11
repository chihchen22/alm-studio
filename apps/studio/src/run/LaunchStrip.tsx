// apps/studio/src/run/LaunchStrip.tsx
/**
 * The Launch strip (spec v3.1 Section 3.5, "Launch gate"). It prints the readiness lists the server computed for
 * one setup: one chip per state present, worst first; the blocking items in words beside a disabled Launch button;
 * and a checkbox per acknowledgeable item (Stale or Warning), which the launch needs ticked. Nothing here decides
 * whether a setup may launch: the server's `launchable[slot]` does, and the launch route re-checks it.
 */
import { useState } from "react";
import type { ReadinessItem, ReadinessReport } from "@alm/reader";
import { acknowledgeLabel, blockingReasons, blockingText } from "../rows/setupRows";
import { READINESS_ESCALATION, ReadinessChip } from "../shell/ReadinessChip";

export type SlotLaunchable = ReadinessReport["launchable"][string];

export interface LaunchStripProps {
  /** The ReadinessItem rows of the setup being launched. */
  items: readonly ReadinessItem[];
  /** `ReadinessReport.launchable[slot]`: { ok, blocking, acknowledgeable }. */
  launchable: SlotLaunchable;
  /** Called with the acknowledged ids, and whether the launch is the whole batch. */
  onLaunch: (acknowledge: string[], batch: boolean) => void;
  /** How many batch rows the setup holds; the batch launch is offered only when there are some. */
  batchRows?: number;
  /** A reason the page switches Launch off (unsaved edits, no name typed, a locked workspace); null when none. */
  disabledReason?: string | null;
  busy?: boolean;
  /** The last launch's answer in words, printed beside the buttons; null or absent when there is none. */
  message?: string | null;
}

export function LaunchStrip(props: LaunchStripProps) {
  const { items, launchable } = props;
  const [ticked, setTicked] = useState<string[]>([]);
  const present = READINESS_ESCALATION.filter((s) => items.some((i) => i.state === s));
  const blocked = launchable.blocking.length > 0;
  const unacknowledged = launchable.acknowledgeable.filter((id) => !ticked.includes(id));
  const reason = props.disabledReason ?? null;
  const off = blocked || unacknowledged.length > 0 || reason !== null || props.busy === true;
  const toggle = (id: string, on: boolean) => setTicked((t) => (on ? [...t.filter((x) => x !== id), id] : t.filter((x) => x !== id)));
  const go = (batch: boolean) => props.onLaunch(launchable.acknowledgeable.filter((id) => ticked.includes(id)), batch);
  const batchRows = props.batchRows ?? 0;
  return (
    <section className="card launch-strip" aria-label="Launch">
      <div className="card-title">Launch</div>
      <div className="chip-row">
        {present.map((s) => (
          <ReadinessChip key={s} state={s} />
        ))}
      </div>
      {blocked ? <p className="launch-blocking" role="alert">{`Blocking: ${blockingText(launchable.blocking, items)}`}</p> : null}
      {blocked ? <ul className="launch-ack">{blockingReasons(launchable.blocking, items).map((r) => <li key={r}>{r}</li>)}</ul> : null}
      {launchable.acknowledgeable.length > 0 ? (
        <ul className="launch-ack">
          {launchable.acknowledgeable.map((id) => (
            <li key={id}>
              <label>
                <input
                  aria-label={`Acknowledge ${blockingText([id], items)}`}
                  type="checkbox"
                  checked={ticked.includes(id)}
                  onChange={(e) => toggle(id, e.target.checked)}
                />{" "}
                <span>{acknowledgeLabel(id, items)}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="launch-actions">
        <button type="button" className="btn btn-primary" disabled={off} onClick={() => go(false)}>Launch</button>
        {batchRows > 0 ? (
          <button type="button" className="btn" disabled={off} onClick={() => go(true)}>{`Launch batch (${batchRows} ${batchRows === 1 ? "row" : "rows"})`}</button>
        ) : null}
        {props.message !== undefined && props.message !== null ? <span className="launch-message" role="status">{props.message}</span> : null}
      </div>
      {reason !== null ? <p className="field-help">{reason}</p> : null}
      {off && !blocked && unacknowledged.length > 0 ? <p className="field-help">Tick each item above to launch on it.</p> : null}
    </section>
  );
}
