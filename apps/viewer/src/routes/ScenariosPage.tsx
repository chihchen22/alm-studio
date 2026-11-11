/**
 * Scenarios route: the stored scenario slates and a
 * builder constrained to the closed contract unions — RateSpec is exactly
 * base | parallel | twist | custom, NewBusinessStrategy is static | dynamic
 * rules. The UI paints no control outside those unions (design 4.4): no
 * time-phased ramps. Slate validation (exactly one base, unique ids,
 * defineScenario per scenario — including the custom-vector knot rules:
 * finite ascending tenors, finite bp shocks) is server-side; a 422 renders
 * verbatim.
 *
 * The custom per-tenor shock vector arm (W3-A6 landed the engine +
 * server side; this page adds the authoring UI). A custom vector is a static
 * instantaneous shock like parallel/twist: bp knots at ascending tenors,
 * linearly interpolated between knots, flat beyond them.
 *
 * REGULATORY_SHOCKS_BP is value-imported from the engine's contracts layer
 * directly (a dependency-free module; the package barrel would drag the node
 * runtime into the browser bundle).
 */
import { useCallback, useEffect, useState } from "react";
import type { CustomTenorShock, NewBusinessRule, RateSpec, Scenario } from "@alm/engine";
import { REGULATORY_SHOCKS_BP } from "@alm/engine/src/contracts/scenario";
import {
  ApiError,
  createScenarioSlate,
  listAssumptionSets,
  listScenarioSlates,
  type AssumptionSetListItem,
  type ScenarioSlate,
} from "@alm/reader";
import { ParamField } from "../components/ParamField";
import { formatScenarioLabel } from "@alm/reader";

type ListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; slates: ScenarioSlate[] };

export function ScenariosPage() {
  const [list, setList] = useState<ListState>({ status: "loading" });
  const [sets, setSets] = useState<AssumptionSetListItem[]>([]);

  const refresh = useCallback(() => {
    setList({ status: "loading" });
    listScenarioSlates()
      .then((slates) => setList({ status: "ready", slates }))
      .catch((err: unknown) =>
        setList({ status: "error", message: err instanceof Error ? err.message : String(err) }),
      );
    listAssumptionSets()
      .then(setSets)
      .catch(() => setSets([]));
  }, []);

  useEffect(() => refresh(), [refresh]);

  return (
    <>
      <section className="panel">
        <h2>Scenario slates</h2>
        <p className="desc">
          A slate is the stored scenario list a run executes: exactly one base rateSpec plus shocks. Labels below
          derive from each scenario's typed rateSpec.
        </p>
        {list.status === "loading" ? <p className="zero">Loading…</p> : null}
        {list.status === "error" ? <p className="error" style={{ padding: 0 }}>{list.message}</p> : null}
        {list.status === "ready" ? (
          list.slates.length === 0 ? (
            <p className="zero">No slates stored yet. Build one below.</p>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left" }}>Id</th>
                    <th style={{ textAlign: "left" }}>Label</th>
                    <th style={{ textAlign: "left" }}>Scenarios</th>
                  </tr>
                </thead>
                <tbody>
                  {list.slates.map((sl) => (
                    <tr key={sl.id}>
                      <td style={{ fontFamily: "var(--mono)" }}>{sl.id}</td>
                      <td style={{ textAlign: "left" }}>{sl.label}</td>
                      <td style={{ textAlign: "left" }}>
                        {sl.scenarios
                          .map((s) => formatScenarioLabel({ id: s.id, label: s.label, rateSpec: s.rateSpec }, s.id))
                          .join(", ")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : null}
      </section>

      <SlateBuilder sets={sets} onSaved={refresh} />
    </>
  );
}

// --- Builder -----------------------------------------------------------------

function emptyScenario(assumptionSetId: string): Scenario {
  return {
    id: "S0",
    label: "Base",
    rateSpec: { kind: "base" },
    assumptionSetId,
    newBusiness: { mode: "static", rules: [] },
  };
}

/** The regulatory parallel grid template, from the engine's pinned convention. */
function regulatoryGrid(assumptionSetId: string): Scenario[] {
  return REGULATORY_SHOCKS_BP.map((bp) => ({
    id: `S${bp}`,
    label: bp === 0 ? "Base" : `Parallel ${bp > 0 ? "+" : ""}${bp}bp`,
    rateSpec: bp === 0 ? ({ kind: "base" } as RateSpec) : ({ kind: "parallel", shockBp: bp } as RateSpec),
    assumptionSetId,
    newBusiness: { mode: "static", rules: [] },
  }));
}

function SlateBuilder({ sets, onSaved }: { sets: AssumptionSetListItem[]; onSaved: () => void }) {
  const [slateId, setSlateId] = useState("");
  const [label, setLabel] = useState("");
  const [defaultSetId, setDefaultSetId] = useState("");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  function update(i: number, next: Scenario) {
    setScenarios(scenarios.map((s, j) => (j === i ? next : s)));
  }

  async function save() {
    setSaved(null);
    setError(null);
    try {
      const created = await createScenarioSlate({ id: slateId.trim(), label: label.trim(), scenarios });
      setSaved(`Stored slate ${created.id} with ${created.scenarios.length} scenarios.`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "network", String(err)));
    }
  }

  const canSave = slateId.trim() !== "" && label.trim() !== "" && scenarios.length > 0;

  return (
    <section className="panel">
      <h2>Build a slate</h2>
      <p className="desc">
        Controls cover exactly the closed contract unions (base, parallel, twist, custom per-tenor vector;
        static or dynamic new business). The server validates the slate invariants: exactly one base, unique
        scenario ids, and the custom-vector knot rules.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>slate id</span>
          <input type="text" value={slateId} onChange={(e) => setSlateId(e.target.value)} style={fieldStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>label</span>
          <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} style={fieldStyle} />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>assumption set</span>
          <select value={defaultSetId} onChange={(e) => setDefaultSetId(e.target.value)} style={fieldStyle}>
            <option value="">— pick —</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="controls">
        <button
          disabled={defaultSetId === ""}
          onClick={() => setScenarios(regulatoryGrid(defaultSetId))}
          title="Base plus the +/-100, +/-200 parallel grid (REGULATORY_SHOCKS_BP)"
        >
          Regulatory grid template
        </button>
        <button disabled={defaultSetId === ""} onClick={() => setScenarios([...scenarios, emptyScenario(defaultSetId)])}>
          add scenario
        </button>
      </div>

      {scenarios.map((s, i) => (
        <ScenarioEditor key={i} scenario={s} sets={sets} onChange={(next) => update(i, next)} />
      ))}

      <div className="controls" style={{ marginTop: 8 }}>
        <button className="active" disabled={!canSave} onClick={() => void save()}>
          store slate
        </button>
      </div>
      {saved ? <p className="emptynote">{saved}</p> : null}
      {error ? (
        <div>
          <p className="error" style={{ padding: 0 }}>
            {error.status > 0 ? `${error.status} ` : ""}
            {error.code}: {error.message}
          </p>
          {error.detail !== undefined ? <pre className="rationale">{JSON.stringify(error.detail, null, 2)}</pre> : null}
        </div>
      ) : null}
    </section>
  );
}

function ScenarioEditor({
  scenario,
  sets,
  onChange,
}: {
  scenario: Scenario;
  sets: AssumptionSetListItem[];
  onChange: (next: Scenario) => void;
}) {
  const spec = scenario.rateSpec;

  function setKind(kind: RateSpec["kind"]) {
    const rateSpec: RateSpec =
      kind === "base"
        ? { kind: "base" }
        : kind === "parallel"
          ? { kind: "parallel", shockBp: 100 }
          : kind === "twist"
            ? { kind: "twist", shortBp: 0, longBp: 0, pivotYears: 5 }
            : {
                // Starter knots for the custom vector: a flat 0bp two-knot
                // vector the author edits; the server's defineScenario gate
                // validates the final vector (ascending finite tenors) and a
                // 422 renders verbatim.
                kind: "custom",
                shocks: [
                  { tenorYears: 0, shockBp: 0 },
                  { tenorYears: 30, shockBp: 0 },
                ],
              };
    onChange({ ...scenario, rateSpec });
  }

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px", marginBottom: 10 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>id</span>
          <input
            type="text"
            value={scenario.id}
            onChange={(e) => onChange({ ...scenario, id: e.target.value })}
            style={{ ...fieldStyle, width: 90 }}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>label</span>
          <input
            type="text"
            value={scenario.label}
            onChange={(e) => onChange({ ...scenario, label: e.target.value })}
            style={fieldStyle}
          />
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>rate spec</span>
          <select value={spec.kind} onChange={(e) => setKind(e.target.value as RateSpec["kind"])} style={fieldStyle}>
            <option value="base">base</option>
            <option value="parallel">parallel</option>
            <option value="twist">twist</option>
            <option value="custom">custom (per-tenor vector)</option>
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>assumption set</span>
          <select
            value={scenario.assumptionSetId}
            onChange={(e) => onChange({ ...scenario, assumptionSetId: e.target.value })}
            style={fieldStyle}
          >
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 13 }}>
          <span className="zero" style={{ marginRight: 6 }}>new business</span>
          <select
            value={scenario.newBusiness.mode}
            onChange={(e) =>
              onChange({
                ...scenario,
                newBusiness: { mode: e.target.value as "static" | "dynamic", rules: scenario.newBusiness.rules },
              })
            }
            style={fieldStyle}
          >
            <option value="static">static (runoff)</option>
            <option value="dynamic">dynamic (rules)</option>
          </select>
        </label>
      </div>

      {spec.kind === "parallel" ? (
        <ParamField
          label="shockBp"
          value={spec.shockBp}
          onChange={(v) => onChange({ ...scenario, rateSpec: { kind: "parallel", shockBp: v } })}
        />
      ) : null}
      {spec.kind === "twist" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <ParamField
            label="shortBp"
            value={spec.shortBp}
            onChange={(v) => onChange({ ...scenario, rateSpec: { ...spec, shortBp: v } })}
          />
          <ParamField
            label="longBp"
            value={spec.longBp}
            onChange={(v) => onChange({ ...scenario, rateSpec: { ...spec, longBp: v } })}
          />
          <ParamField
            label="pivotYears"
            value={spec.pivotYears}
            onChange={(v) => onChange({ ...scenario, rateSpec: { ...spec, pivotYears: v } })}
          />
        </div>
      ) : null}
      {spec.kind === "custom" ? (
        <CustomShocksEditor
          shocks={spec.shocks}
          onChange={(shocks) => onChange({ ...scenario, rateSpec: { kind: "custom", shocks } })}
        />
      ) : null}

      {scenario.newBusiness.mode === "dynamic" ? (
        <RulesEditor
          rules={scenario.newBusiness.rules}
          onChange={(rules) => onChange({ ...scenario, newBusiness: { mode: "dynamic", rules } })}
        />
      ) : null}
    </div>
  );
}

/**
 * Author a custom per-tenor shock vector (W3-A6 server arm; this is the UI).
 * Knots are edited freely; the engine's validateCustomShocks gate (finite
 * tenors >= 0, strictly ascending, finite bp) runs server-side at slate
 * creation and its 422 renders verbatim — the builder mirrors the twist
 * editor's philosophy of free numeric fields plus a server gate, and states
 * the interpolation convention so the author knows what the vector means.
 */
function CustomShocksEditor({
  shocks,
  onChange,
}: {
  shocks: CustomTenorShock[];
  onChange: (shocks: CustomTenorShock[]) => void;
}) {
  function update(i: number, next: CustomTenorShock) {
    onChange(shocks.map((s, j) => (j === i ? next : s)));
  }
  return (
    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--line)" }}>
      <p className="zero" style={{ fontSize: 12, margin: "0 0 6px" }}>
        Static instantaneous shock: bp at each tenor knot, linearly interpolated between knots, flat beyond
        the outermost knots. Tenors must be finite, &ge; 0, and strictly ascending (server-validated; a 422
        names the offending knot).
      </p>
      {shocks.map((s, i) => (
        <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 6 }}>
          <ParamField
            label={`knot ${i + 1} tenorYears`}
            value={s.tenorYears}
            onChange={(v) => update(i, { ...s, tenorYears: v })}
          />
          <ParamField
            label="shockBp"
            value={s.shockBp}
            onChange={(v) => update(i, { ...s, shockBp: v })}
          />
          <button
            style={miniEditorButton}
            title="Remove this knot from the vector being authored (nothing stored is touched)"
            onClick={() => onChange(shocks.filter((_, j) => j !== i))}
          >
            remove knot
          </button>
        </div>
      ))}
      <button
        style={miniEditorButton}
        onClick={() => {
          const lastTenor = shocks.length > 0 ? shocks[shocks.length - 1].tenorYears : 0;
          onChange([...shocks, { tenorYears: lastTenor + 1, shockBp: 0 }]);
        }}
      >
        add knot
      </button>
    </div>
  );
}

const miniEditorButton = {
  font: "inherit",
  fontSize: 12,
  padding: "2px 10px",
  border: "1px solid var(--line-strong)",
  borderRadius: 6,
  background: "var(--panel)",
  color: "var(--ink)",
  cursor: "pointer",
} as const;

function RulesEditor({ rules, onChange }: { rules: NewBusinessRule[]; onChange: (rules: NewBusinessRule[]) => void }) {
  function update(i: number, next: NewBusinessRule) {
    onChange(rules.map((r, j) => (j === i ? next : r)));
  }
  return (
    <div style={{ marginTop: 8, paddingLeft: 12, borderLeft: "2px solid var(--line)" }}>
      {rules.map((r, i) => (
        <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginBottom: 6 }}>
          <label style={{ fontSize: 13 }}>
            <span className="zero" style={{ marginRight: 6 }}>familyId</span>
            <input
              type="text"
              value={r.familyId}
              onChange={(e) => update(i, { ...r, familyId: e.target.value })}
              style={{ ...fieldStyle, width: 130 }}
            />
          </label>
          <label style={{ fontSize: 13 }}>
            <span className="zero" style={{ marginRight: 6 }}>reinvest</span>
            <select
              value={r.reinvest}
              onChange={(e) => update(i, { ...r, reinvest: e.target.value as NewBusinessRule["reinvest"] })}
              style={fieldStyle}
            >
              <option value="runoff">runoff</option>
              <option value="flat">flat</option>
              <option value="growth">growth</option>
            </select>
          </label>
          <ParamField
            label="spreadOverIndexBp"
            value={r.spreadOverIndexBp ?? 0}
            onChange={(v) => update(i, { ...r, spreadOverIndexBp: v })}
          />
          <ParamField
            label="termMonths"
            value={r.termMonths ?? 60}
            onChange={(v) => update(i, { ...r, termMonths: v })}
          />
          {r.reinvest === "growth" ? (
            <ParamField
              label="monthlyGrowthRate"
              value={r.monthlyGrowthRate ?? 0}
              onChange={(v) => update(i, { ...r, monthlyGrowthRate: v })}
            />
          ) : null}
        </div>
      ))}
      <button
        style={{
          font: "inherit",
          fontSize: 12,
          padding: "2px 10px",
          border: "1px solid var(--line-strong)",
          borderRadius: 6,
          background: "var(--panel)",
          color: "var(--ink)",
          cursor: "pointer",
        }}
        onClick={() => onChange([...rules, { familyId: "", reinvest: "flat" }])}
      >
        add rule
      </button>
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
