/**
 * A labeled numeric input for one behavioral parameter. Editing an INPUT is
 * the one place the UI legitimately produces a number; the field performs no
 * arithmetic on it (no scaling, no clamping, no rounding — the server-side
 * bindAssumptions is the validator, and a client-side "helpful" clamp would
 * hide a refusal the engine should make).
 *
 * The raw text is kept in local state so intermediate keystrokes ("0.", "-",
 * "1e-") do not destroy the entry; onChange fires only when the text parses to
 * a finite number. A non-numeric entry flags the field and propagates nothing.
 */
import { useEffect, useState } from "react";

export function ParamField({
  label,
  value,
  onChange,
  hint,
}: {
  /** Display label, usually the parameter's dotted path (e.g. "params.betaMax"). */
  label: string;
  value: number;
  onChange: (next: number) => void;
  /** Optional muted annotation rendered after the input. */
  hint?: string;
}) {
  const [text, setText] = useState<string>(String(value));
  const [bad, setBad] = useState(false);

  // Re-sync when the upstream value changes identity (e.g. a different set was loaded).
  useEffect(() => {
    setText(String(value));
    setBad(false);
  }, [value]);

  function handle(next: string) {
    setText(next);
    const parsed = Number(next);
    if (next.trim() !== "" && Number.isFinite(parsed)) {
      setBad(false);
      onChange(parsed);
    } else {
      setBad(true);
    }
  }

  return (
    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
      <span style={{ fontFamily: "var(--mono)", color: "var(--muted)", minWidth: 180 }}>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => handle(e.target.value)}
        style={{
          font: "inherit",
          fontFamily: "var(--mono)",
          width: 130,
          padding: "3px 8px",
          border: `1px solid ${bad ? "var(--neg)" : "var(--line-strong)"}`,
          borderRadius: 6,
          background: "var(--panel)",
          color: "var(--ink)",
        }}
      />
      {bad ? <span className="neg" style={{ fontSize: 12 }}>not a number</span> : null}
      {hint ? <span className="zero" style={{ fontSize: 12 }}>{hint}</span> : null}
    </label>
  );
}
