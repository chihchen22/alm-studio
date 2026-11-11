/**
 * Assumptions route: the stored assumption sets, a
 * per-binding numeric editor, a raw-JSON drawer for full fidelity, save-as
 * (the store is append-only: an edit lands under a NEW id and the server-side
 * bindAssumptions is the validator that fills contentHash), and a diff panel
 * against any stored base set.
 *
 * The editor is data-driven: numeric fields are enumerated from the overlay
 * object actually stored, not from a hand-copied parameter schema (a
 * transcribed schema is how silent drift starts). Editing an input is the one
 * place the UI produces numbers; nothing here computes a result.
 */
import { useCallback, useEffect, useState } from "react";
import type { AssumptionDiff, AssumptionSet } from "@alm/engine";
import {
  ApiError,
  createAssumptionSet,
  diffAssumptionSets,
  getAssumptionSet,
  listAssumptionSets,
  type AssumptionSetListItem,
} from "@alm/reader";
import { ParamField } from "../components/ParamField";
import { ShowBeforeRunDiff } from "../components/ShowBeforeRunDiff";

// --- Generic numeric-leaf traversal (input editing, not computation) ---------

interface NumericLeaf {
  path: string;
  value: number;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Enumerate numeric leaves of an overlay, skipping the discriminant. */
function numericLeaves(obj: Record<string, unknown>, prefix = ""): NumericLeaf[] {
  const out: NumericLeaf[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key === "kind") continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "number") out.push({ path, value });
    else if (isPlainObject(value)) out.push(...numericLeaves(value, path));
  }
  return out;
}

/** Immutable deep set of a dotted path inside a plain-object tree. */
function setLeaf<T>(obj: T, path: string, value: number): T {
  const keys = path.split(".");
  function rec(node: unknown, depth: number): unknown {
    if (!isPlainObject(node)) return node;
    const key = keys[depth];
    const child = depth === keys.length - 1 ? value : rec(node[key], depth + 1);
    return { ...node, [key]: child };
  }
  return rec(obj, 0) as T;
}

// --- Page --------------------------------------------------------------------

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; items: AssumptionSetListItem[] };

export function AssumptionsPage() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [working, setWorking] = useState<AssumptionSet | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setList({ status: "loading" });
    listAssumptionSets()
      .then((items) => setList({ status: "ready", items }))
      .catch((err: unknown) =>
        setList({ status: "error", message: err instanceof Error ? err.message : String(err) }),
      );
  }, []);

  useEffect(() => refresh(), [refresh]);

  function open(id: string) {
    setLoadError(null);
    getAssumptionSet(id)
      .then((set) => {
        setSourceId(id);
        setWorking(set);
      })
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }

  return (
    <>
      <section className="panel">
        <h2>Assumption sets</h2>
        <p className="desc">
          Stored sets with their engine-populated content hashes. The store is append-only: editing a set saves a
          new set under a new id; nothing is overwritten.
        </p>
        {list.status === "loading" ? <p className="zero">Loading…</p> : null}
        {list.status === "error" ? <p className="error" style={{ padding: 0 }}>{list.message}</p> : null}
        {list.status === "ready" ? (
          <div className="tablewrap">
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: "left" }}>Id</th>
                  <th style={{ textAlign: "left" }}>Label</th>
                  <th style={{ textAlign: "left" }}>Content hash</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontFamily: "var(--mono)" }}>{s.id}</td>
                    <td style={{ textAlign: "left" }}>{s.label}</td>
                    <td style={{ fontFamily: "var(--mono)", fontSize: 11, textAlign: "left" }}>
                      {s.contentHash.slice(0, 16)}…
                    </td>
                    <td>
                      <button style={miniButton} onClick={() => open(s.id)}>
                        open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {loadError ? <p className="error" style={{ padding: 0 }}>{loadError}</p> : null}
      </section>

      {working && sourceId ? (
        <SetEditor
          key={sourceId}
          sourceId={sourceId}
          working={working}
          onChange={setWorking}
          onSaved={() => refresh()}
          baseCandidates={list.status === "ready" ? list.items : []}
        />
      ) : null}
    </>
  );
}

function SetEditor({
  sourceId,
  working,
  onChange,
  onSaved,
  baseCandidates,
}: {
  sourceId: string;
  working: AssumptionSet;
  onChange: (next: AssumptionSet) => void;
  onSaved: () => void;
  baseCandidates: AssumptionSetListItem[];
}) {
  const [newId, setNewId] = useState(`${sourceId}-edit-1`);
  const [newLabel, setNewLabel] = useState(`${working.label} (edited)`);
  const [saveState, setSaveState] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  function updateBinding(index: number, path: string, value: number) {
    const bindings = working.bindings.map((b, i) =>
      i === index ? { ...b, overlay: setLeaf(b.overlay, path, value) } : b,
    );
    onChange({ ...working, bindings });
  }

  async function save() {
    setSaveState(null);
    setSaveError(null);
    // contentHash is engine-populated at bind time and never authored by hand.
    const { contentHash: _drop, ...rest } = working;
    void _drop;
    const candidate: AssumptionSet = { ...rest, id: newId.trim(), label: newLabel.trim() };
    try {
      const bound = await createAssumptionSet(candidate);
      setSaveState(`Saved ${bound.id} — contentHash ${bound.contentHash ?? "(missing)"} (engine-populated).`);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err));
    }
  }

  function applyJson() {
    if (jsonText === null) return;
    setJsonError(null);
    try {
      const parsed = JSON.parse(jsonText) as AssumptionSet;
      onChange(parsed);
      setShowJson(false);
      setJsonText(null);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="panel">
      <h2>
        Edit <code style={{ fontFamily: "var(--mono)" }}>{sourceId}</code>
      </h2>
      <p className="desc">
        Numeric fields are enumerated from the stored overlays; the raw-JSON drawer carries full fidelity
        (adding or removing bindings). Save-as posts the candidate; the server-side bind validates and fills the
        content hash.
      </p>

      {working.bindings.map((b, i) => (
        <div key={`${b.familyId}-${b.overlay.kind}-${i}`} style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 13, marginBottom: 6 }}>
            <code style={{ fontFamily: "var(--mono)" }}>{b.familyId}</code>{" "}
            <span className="zero">/ {b.overlay.kind}</span>{" "}
            <span className="zero">model {b.modelVersion}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 12 }}>
            {numericLeaves(b.overlay as unknown as Record<string, unknown>).map((leaf) => (
              <ParamField
                key={leaf.path}
                label={leaf.path}
                value={leaf.value}
                onChange={(v) => updateBinding(i, leaf.path, v)}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="controls">
        <button
          onClick={() => {
            setShowJson((s) => !s);
            setJsonText(JSON.stringify(working, null, 2));
            setJsonError(null);
          }}
        >
          {showJson ? "close raw JSON" : "raw JSON drawer"}
        </button>
      </div>
      {showJson && jsonText !== null ? (
        <div style={{ marginBottom: 12 }}>
          <textarea
            value={jsonText}
            onChange={(e) => setJsonText(e.target.value)}
            rows={16}
            style={{
              width: "100%",
              fontFamily: "var(--mono)",
              fontSize: 12,
              background: "var(--bg)",
              color: "var(--ink)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: 10,
            }}
          />
          <div className="controls" style={{ marginTop: 6 }}>
            <button onClick={applyJson}>apply JSON to editor</button>
          </div>
          {jsonError ? <p className="error" style={{ padding: 0 }}>JSON parse error: {jsonError}</p> : null}
        </div>
      ) : null}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginTop: 8 }}>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>save as id</span>
          <input type="text" value={newId} onChange={(e) => setNewId(e.target.value)} style={fieldStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>label</span>
          <input type="text" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} style={fieldStyle} />
        </label>
        <button style={miniButton} disabled={newId.trim() === ""} onClick={() => void save()}>
          save as new set
        </button>
      </div>
      {saveState ? <p className="emptynote">{saveState}</p> : null}
      {saveError ? <p className="error" style={{ padding: 0 }}>{saveError}</p> : null}

      <DiffPanel working={working} baseCandidates={baseCandidates} />
    </section>
  );
}

/**
 * Diff the working candidate against any stored base, through the server's
 * diff endpoint (the engine-family diff routine — never a client-side compare).
 */
function DiffPanel({
  working,
  baseCandidates,
}: {
  working: AssumptionSet;
  baseCandidates: AssumptionSetListItem[];
}) {
  const [baseId, setBaseId] = useState<string>("");
  const [result, setResult] = useState<{ diff: AssumptionDiff; baseSet: AssumptionSet } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runDiff() {
    setError(null);
    setResult(null);
    try {
      const { contentHash: _drop, ...candidate } = working;
      void _drop;
      const [diff, baseSet] = await Promise.all([
        diffAssumptionSets({ baseId, candidate: candidate as AssumptionSet }),
        getAssumptionSet(baseId),
      ]);
      setResult({ diff, baseSet });
    } catch (err) {
      setError(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err));
    }
  }

  return (
    <div style={{ marginTop: 18, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>Diff against base:</span>
        <select value={baseId} onChange={(e) => setBaseId(e.target.value)} style={fieldStyle}>
          <option value="">— pick a base set —</option>
          {baseCandidates.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id} — {s.label}
            </option>
          ))}
        </select>
        <button style={miniButton} disabled={baseId === ""} onClick={() => void runDiff()}>
          render diff
        </button>
      </div>
      {error ? <p className="error" style={{ padding: 0 }}>{error}</p> : null}
      {result ? (
        <ShowBeforeRunDiff
          sbr={{
            baseSet: result.baseSet,
            candidateSet: working,
            diff: result.diff,
            rationale: "hand-authored edit",
          }}
          familyLabel={(id) => id}
        />
      ) : null}
    </div>
  );
}

const fieldStyle = {
  font: "inherit",
  fontSize: 13,
  padding: "3px 8px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
} as const;

const miniButton = {
  font: "inherit",
  fontSize: 12,
  padding: "3px 12px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;
