/**
 * Run-state chip. Pure presentation of the server's state string: the label is
 * the state verbatim (no euphemisms — "interrupted" renders as interrupted,
 * "error" as error), only the color varies. Reuses the existing .flag chip
 * shape from styles.css with per-state color overrides inline, since this
 * module does not own styles.css.
 */
import type { CSSProperties } from "react";
import type { RunState } from "@alm/reader";

const STATE_STYLES: Record<RunState, CSSProperties> = {
  queued: { background: "var(--head)", color: "var(--muted)" },
  running: { background: "var(--accent)", color: "#fff" },
  done: { background: "var(--pos)", color: "#fff" },
  error: { background: "var(--neg)", color: "#fff" },
  cancelled: { background: "var(--head)", color: "var(--ink)" },
  interrupted: { background: "var(--warn-bg)", color: "var(--warn-ink)" },
};

export function StatusChip({ state }: { state: RunState }) {
  const style = STATE_STYLES[state] ?? {};
  return (
    <span className="flag" style={style}>
      {state}
    </span>
  );
}
