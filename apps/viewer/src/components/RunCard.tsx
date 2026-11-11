/**
 * One run in the cockpit queue list. Renders the server's status record
 * verbatim: state chip, phase as received from the four-phase seam (never an
 * interpolated percent bar — design 3.4 forbids synthetic progress), queue
 * position, elapsed wall-clock, cancel, label edit, and a link to the results
 * route once the run is done. Elapsed time is clock presentation, not an
 * engine number: the server's elapsedMs is preferred; for a live running run
 * the display ticks from the server's startedAt stamp.
 */
import { useEffect, useState } from "react";
import { cancelRun, labelRun, type RunSummary } from "@alm/reader";
import { StatusChip } from "./StatusChip";

/** Milliseconds -> "m:ss" display. Time formatting, not arithmetic on results. */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

export function RunCard({ run, onChanged }: { run: RunSummary; onChanged?: () => void }) {
  const [editingLabel, setEditingLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Tick a live elapsed display only while the run is actually running.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.state !== "running") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [run.state]);

  const elapsedMs =
    run.elapsedMs ??
    (run.state === "running" && run.startedAt ? Math.max(0, now - Date.parse(run.startedAt)) : undefined);

  const cancellable = run.state === "queued" || run.state === "running";

  async function doCancel() {
    setBusy(true);
    setActionError(null);
    try {
      await cancelRun(run.runId);
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveLabel() {
    if (editingLabel === null) return;
    setBusy(true);
    setActionError(null);
    try {
      await labelRun(run.runId, editingLabel);
      setEditingLabel(null);
      onChanged?.();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: 8,
        padding: "10px 14px",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 16px",
        background: "var(--panel)",
      }}
    >
      <StatusChip state={run.state} />
      <code style={{ fontFamily: "var(--mono)", fontSize: 13 }}>{run.runId}</code>
      {run.mode === "stochastic" ? (
        <span
          className="zero"
          style={{ fontSize: 12, border: "1px solid var(--line-strong)", borderRadius: 999, padding: "1px 8px" }}
          title="Stochastic run: its result is a Monte Carlo distribution envelope with N and standard errors, not a deterministic EVE/NII."
        >
          stochastic
        </span>
      ) : null}

      {editingLabel !== null ? (
        <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
          <input
            type="text"
            value={editingLabel}
            onChange={(e) => setEditingLabel(e.target.value)}
            style={{
              font: "inherit",
              fontSize: 13,
              padding: "2px 6px",
              border: "1px solid var(--line-strong)",
              borderRadius: 6,
              background: "var(--panel)",
              color: "var(--ink)",
            }}
          />
          <button disabled={busy} onClick={() => void saveLabel()} style={miniButton}>
            save
          </button>
          <button disabled={busy} onClick={() => setEditingLabel(null)} style={miniButton}>
            cancel
          </button>
        </span>
      ) : (
        <span
          title="Edit label (platform metadata; the result envelope is never touched)"
          style={{ cursor: "pointer", fontSize: 13 }}
          onClick={() => setEditingLabel(run.label ?? "")}
        >
          {run.label ? run.label : <span className="zero">unlabeled — click to label</span>}
        </span>
      )}

      {run.state === "running" && run.phase ? (
        <span className="zero" style={{ fontSize: 12 }}>
          phase: <code style={{ fontFamily: "var(--mono)" }}>{run.phase}</code>
        </span>
      ) : null}
      {run.state === "queued" && run.queuePosition !== undefined ? (
        <span className="zero" style={{ fontSize: 12 }}>queue #{run.queuePosition}</span>
      ) : null}
      {elapsedMs !== undefined ? (
        <span className="zero" style={{ fontSize: 12 }}>elapsed {fmtElapsed(elapsedMs)}</span>
      ) : null}
      {run.error ? (
        <span className="neg" style={{ fontSize: 12 }}>
          {run.error.code ? `${run.error.code}: ` : ""}
          {run.error.message}
        </span>
      ) : null}

      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
        {run.state === "done" ? (
          <a href={`#/results/${encodeURIComponent(run.runId)}`} style={{ fontSize: 13, color: "var(--accent)" }}>
            results →
          </a>
        ) : null}
        {cancellable ? (
          <button disabled={busy} onClick={() => void doCancel()} style={miniButton}>
            cancel run
          </button>
        ) : null}
      </span>

      {actionError ? (
        <span className="neg" style={{ fontSize: 12, width: "100%" }}>
          {actionError}
        </span>
      ) : null}
    </div>
  );
}

const miniButton = {
  font: "inherit",
  fontSize: 12,
  padding: "2px 10px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;
