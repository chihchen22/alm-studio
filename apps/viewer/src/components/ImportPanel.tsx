/**
 * Position-import panel. Two paths, matching the server:
 * JSON canonical (a full PortfolioSpec file, sent verbatim) and CSV assisted
 * (one row per position, against a stored COA by id). File text is read
 * client-side and posted unmodified — the server is the sole validator.
 *
 * A 201 renders the returned handle plus every warning; a 422 renders the
 * server's per-item errors VERBATIM, all of them, not first-failure. Nothing
 * here summarizes, truncates, or re-words a validation error.
 */
import { useState, type CSSProperties } from "react";
import {
  ApiError,
  importPortfolioCsv,
  importPortfolioJson,
  type ImportPortfolioResponse,
  type ItemError,
} from "@alm/reader";

type ImportState =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "ok"; response: ImportPortfolioResponse }
  | { status: "failed"; error: ApiError };

export function ImportPanel({ onImported }: { onImported?: (r: ImportPortfolioResponse) => void }) {
  const [mode, setMode] = useState<"json" | "csv">("json");
  const [file, setFile] = useState<File | null>(null);
  const [coaId, setCoaId] = useState("");
  const [label, setLabel] = useState("");
  const [portfolioId, setPortfolioId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [state, setState] = useState<ImportState>({ status: "idle" });

  // A CSV file cannot state the portfolio id, label, or as-of date, and the
  // platform never invents an as-of date — all four accompany the file.
  const canSubmit =
    state.status !== "sending" &&
    file !== null &&
    (mode === "json" ||
      (coaId.trim() !== "" && label.trim() !== "" && portfolioId.trim() !== "" && asOf.trim() !== ""));

  async function submit() {
    if (!file) return;
    setState({ status: "sending" });
    try {
      const text = await file.text();
      const response =
        mode === "json"
          ? await importPortfolioJson(text)
          : await importPortfolioCsv(text, coaId.trim(), label.trim(), portfolioId.trim(), asOf.trim());
      setState({ status: "ok", response });
      onImported?.(response);
    } catch (err) {
      if (err instanceof ApiError) setState({ status: "failed", error: err });
      else setState({ status: "failed", error: new ApiError(0, "network", String(err)) });
    }
  }

  return (
    <section className="panel">
      <h2>Import a portfolio</h2>
      <p className="desc">
        JSON is canonical (a full PortfolioSpec: the COA travels with the positions). CSV is the assisted path
        against a stored COA. Validation is server-side and total; errors render verbatim below.
      </p>

      <div className="controls">
        <button className={mode === "json" ? "active" : ""} onClick={() => setMode("json")}>
          JSON (PortfolioSpec)
        </button>
        <button className={mode === "csv" ? "active" : ""} onClick={() => setMode("csv")}>
          CSV + stored COA
        </button>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
        <input
          type="file"
          accept={mode === "json" ? ".json,application/json" : ".csv,text/csv"}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        {mode === "csv" ? (
          <>
            <label style={{ fontSize: 13 }}>
              <span className="zero" style={{ marginRight: 6 }}>coaId</span>
              <input
                type="text"
                value={coaId}
                onChange={(e) => setCoaId(e.target.value)}
                placeholder="stored COA id"
                style={fieldStyle}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              <span className="zero" style={{ marginRight: 6 }}>label</span>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="portfolio label"
                style={fieldStyle}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              <span className="zero" style={{ marginRight: 6 }}>portfolioId</span>
              <input
                type="text"
                value={portfolioId}
                onChange={(e) => setPortfolioId(e.target.value)}
                placeholder="new portfolio id"
                style={fieldStyle}
              />
            </label>
            <label style={{ fontSize: 13 }}>
              <span className="zero" style={{ marginRight: 6 }}>asOf</span>
              <input
                type="text"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
                placeholder="YYYY-MM-DD"
                style={fieldStyle}
              />
            </label>
          </>
        ) : null}
        <button className="active" style={buttonStyle} disabled={!canSubmit} onClick={() => void submit()}>
          {state.status === "sending" ? "Importing…" : "Import"}
        </button>
      </div>

      {state.status === "ok" ? <ImportOk response={state.response} /> : null}
      {state.status === "failed" ? <ImportFailed error={state.error} /> : null}
    </section>
  );
}

const fieldStyle: CSSProperties = {
  font: "inherit",
  padding: "3px 8px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
};

const buttonStyle: CSSProperties = {
  font: "inherit",
  padding: "5px 14px",
  borderRadius: 6,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "#fff",
  cursor: "pointer",
};

function ImportOk({ response }: { response: ImportPortfolioResponse }) {
  return (
    <div style={{ marginTop: 12 }}>
      <p className="emptynote">
        Imported <code>{response.id}</code>: {response.positionCount.toLocaleString("en-US")} positions, as of{" "}
        {response.asOf}.
      </p>
      {response.warnings.length > 0 ? (
        <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
          {response.warnings.map((w, i) => (
            <li key={i} style={{ color: "var(--warn-ink)", fontSize: 13 }}>
              {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Render a 422 (or any failure) verbatim: code, message, and every item error. */
function ImportFailed({ error }: { error: ApiError }) {
  const items = Array.isArray(error.detail) ? (error.detail as ItemError[]) : null;
  return (
    <div style={{ marginTop: 12 }}>
      <p className="error" style={{ padding: 0 }}>
        {error.status > 0 ? `${error.status} ` : ""}
        {error.code}: {error.message}
      </p>
      {items ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Column</th>
                <th>Position</th>
                <th style={{ textAlign: "left" }}>Error</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={i}>
                  <td className="num">{it.row ?? "—"}</td>
                  <td>{it.column ?? "—"}</td>
                  <td>{it.positionId ?? "—"}</td>
                  <td style={{ textAlign: "left", whiteSpace: "normal" }}>{it.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : error.detail !== undefined ? (
        <pre className="rationale">{JSON.stringify(error.detail, null, 2)}</pre>
      ) : null}
    </div>
  );
}
