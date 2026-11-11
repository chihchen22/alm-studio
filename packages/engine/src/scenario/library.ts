/**
 * The shipped scenario library. Data only. Ids are stable; a change is a new
 * id. Ramp entries exist so the schema is exercised; the run tags them
 * not-implemented until rateEnvironment carries a time-varying shock.
 */
import { REGULATORY_SHOCKS_BP, type ScenarioDefinition, type ScenarioLibrary } from "../contracts/scenario";

export const REGULATORY_GRID_LIBRARY: ScenarioLibrary = {
  schemaVersion: "1.0.0",
  id: "regulatory-grid-v1",
  label: "Regulatory parallel grid: base, +/-100, +/-200 bp, immediate",
  scenarios: REGULATORY_SHOCKS_BP.map((bp) => ({
    id: `S${bp}`,
    label: `S${bp}`,
    rateSpec: bp === 0 ? { kind: "base" as const } : { kind: "parallel" as const, shockBp: bp },
  })),
};

export const STEEPENER_LIBRARY: ScenarioLibrary = {
  schemaVersion: "1.0.0",
  id: "steepener-v1",
  label: "Steepener: 0 at the front, +100 bp at the long end, pivot 5y",
  scenarios: [{ id: "STEEP100", label: "Steepener +100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: 100, pivotYears: 5 } }],
};

export const FLATTENER_LIBRARY: ScenarioLibrary = {
  schemaVersion: "1.0.0",
  id: "flattener-v1",
  label: "Flattener: 0 at the front, -100 bp at the long end, pivot 5y",
  scenarios: [{ id: "FLAT100", label: "Flattener -100 long", rateSpec: { kind: "twist", shortBp: 0, longBp: -100, pivotYears: 5 } }],
};

export const RAMP_200_LIBRARY: ScenarioLibrary = {
  schemaVersion: "1.0.0",
  id: "ramp-200-12m-v1",
  label: "Parallel +200 bp reached linearly over 12 months",
  scenarios: [{ id: "R200", label: "Ramp +200 over 12m", rateSpec: { kind: "parallel", shockBp: 200 }, timing: { kind: "ramp", months: 12 } }],
};

// --- SRP31: the six prescribed shocks ------------------------------------------
//
// The prescribed formulas: S(t) = exp(-t/4),
// short rate shock 300bp, long rate shock 225bp, parallel 200bp. Each shock is
// a `custom` tenor-knot scenario at the eleven curve node tenors, so no new
// RateSpec kind exists (spec F5). Not in SHIPPED_LIBRARIES: the default
// scenario listing is unchanged; a seed writes the slate.

/** The eleven curve node tenors in years, ascending; the 1-month node is 0.083333. */
export const SRP31_TENORS: readonly number[] = [0.083333, 0.25, 0.5, 1, 2, 3, 5, 7, 10, 20, 30];

export type Srp31Name = "parallel_up" | "parallel_down" | "short_up" | "short_down" | "steepener" | "flattener";

const SRP31_SHORT_BP = 300;
const SRP31_LONG_BP = 225;
const SRP31_PARALLEL_BP = 200;
const SRP31_X = 4;

const SRP31_IDS: Record<Srp31Name, { id: string; label: string }> = {
  parallel_up: { id: "SRP-PUP", label: "SRP31 parallel up +200 bp" },
  parallel_down: { id: "SRP-PDN", label: "SRP31 parallel down -200 bp" },
  short_up: { id: "SRP-SUP", label: "SRP31 short rate up" },
  short_down: { id: "SRP-SDN", label: "SRP31 short rate down" },
  steepener: { id: "SRP-STEEP", label: "SRP31 steepener" },
  flattener: { id: "SRP-FLAT", label: "SRP31 flattener" },
};

/** Shock in basis points at a tenor in years for one SRP31 scenario. Pure; throws a sentence on a bad name or tenor. */
export function srp31ShockBp(name: Srp31Name, tYears: number): number {
  if (!Number.isFinite(tYears) || tYears < 0) {
    throw new Error(`SRP31 shock tenor must be a finite number of years >= 0, got ${String(tYears)}`);
  }
  const s = Math.exp(-tYears / SRP31_X);
  switch (name) {
    case "parallel_up":
      return SRP31_PARALLEL_BP;
    case "parallel_down":
      return -SRP31_PARALLEL_BP;
    case "short_up":
      return SRP31_SHORT_BP * s;
    case "short_down":
      return -SRP31_SHORT_BP * s;
    case "steepener":
      return -0.65 * SRP31_SHORT_BP * s + 0.9 * SRP31_LONG_BP * (1 - s);
    case "flattener":
      return 0.8 * SRP31_SHORT_BP * s - 0.6 * SRP31_LONG_BP * (1 - s);
    default:
      throw new Error(`unknown SRP31 shock name ${String(name)}; expected one of ${Object.keys(SRP31_IDS).join(", ")}`);
  }
}

/** One SRP31 scenario as a `custom` knot vector at SRP31_TENORS. Fresh objects on every call. */
export function srp31Scenario(name: Srp31Name, assumptionSetId: string): ScenarioDefinition {
  const meta = SRP31_IDS[name];
  if (meta === undefined) {
    throw new Error(`unknown SRP31 shock name ${String(name)}; expected one of ${Object.keys(SRP31_IDS).join(", ")}`);
  }
  return {
    id: meta.id,
    label: meta.label,
    rateSpec: { kind: "custom", shocks: SRP31_TENORS.map((t) => ({ tenorYears: t, shockBp: srp31ShockBp(name, t) })) },
    assumptionSetId,
  };
}

/** The six SRP31 scenarios, no base. The assumption set is taken from the plan's inputs. */
export const SRP31_USD: ScenarioLibrary = {
  schemaVersion: "1.0.0",
  id: "srp31-usd-v1",
  label: "SRP31 prescribed shocks: parallel up and down, short up and down, steepener, flattener",
  scenarios: (Object.keys(SRP31_IDS) as Srp31Name[]).map((name) => {
    const { id, label, rateSpec } = srp31Scenario(name, "");
    return { id, label, rateSpec };
  }),
};

export const SHIPPED_LIBRARIES: ScenarioLibrary[] = [REGULATORY_GRID_LIBRARY, STEEPENER_LIBRARY, FLATTENER_LIBRARY, RAMP_200_LIBRARY];
