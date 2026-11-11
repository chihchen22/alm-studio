// apps/studio/src/rows/survivalPathRows.ts
/**
 * The survival path's calculator form: the form a learner edits, read from a stated
 * path, a registered preset case or the run's own numbers, and turned back into an engine input. Pure. The form holds text as typed; the screen shows USD millions
 * and percents, the engine reads dollars and decimals. A list of monthly values is typed as numbers separated by
 * spaces or commas, with no thousands separator.
 */
import {
  bookPathConfigError,
  commitmentDialsError,
  type BookPathInput,
  type BookPathPoint,
  type CommitmentDials,
} from "@alm/engine/src/liquidity";

const M = 1e6;

export interface PointForm {
  label: string;
  month?: number;
  days?: number;
  /** Cumulative net funding, USD M; a shortfall is negative. */
  cumulativeMusd: string;
}

export interface BuiltForm {
  horizonMonths: number;
  /** Cumulative counterbalancing inflow, USD M, one per month. */
  inflowMusd: string;
  savingsMusd: string;
  stableSharePct: string;
  stableRatePct: string;
  nonStableRatePct: string;
  wholesaleMusd: string;
  /** Cumulative share of the wholesale book gone, percent, one per month. */
  wholesaleSharePct: string;
}

export interface BookPathForm {
  hqlaMusd: string;
  receivedMusd: string;
  haircutPct: string;
  points: PointForm[];
  built: BuiltForm | null;
  drawOn: boolean;
  drawMusd: string;
  /** Cumulative share of the draw by each point (each month of a built path), percent. */
  drawSharePct: string;
}

const text = (v: number, digits = 6): string => String(Number(v.toFixed(digits)));
const list = (vs: number[], scale: number, digits = 6): string => vs.map((v) => text(v / scale, digits)).join(" ");

/** The form of a stored case: every value the case holds, in the screen's units. */
export function formOf(input: BookPathInput): BookPathForm {
  const src = input.source;
  const steps = src.kind === "stated" ? src.points.length : src.horizonMonths;
  return {
    hqlaMusd: text(input.buffer.hqla / M),
    receivedMusd: text(input.buffer.receivedFacilities / M),
    haircutPct: text(input.buffer.receivedHaircut * 100),
    points: src.kind === "stated" ? src.points.map((p) => ({ label: p.label, ...(p.month !== undefined ? { month: p.month } : { days: p.days }), cumulativeMusd: text(p.cumulative / M) })) : [],
    built:
      src.kind === "built"
        ? {
            horizonMonths: src.horizonMonths,
            inflowMusd: list(src.inflowCumulative, M, 3),
            savingsMusd: text(src.deposits.balance / M),
            stableSharePct: text(src.deposits.stableShare * 100),
            stableRatePct: text(src.deposits.stableRateMonthly * 100),
            nonStableRatePct: text(src.deposits.nonStableRateMonthly * 100),
            wholesaleMusd: text(src.wholesale.balance / M),
            wholesaleSharePct: list(src.wholesale.cumulativeShare, 0.01, 4),
          }
        : null,
    drawOn: input.draw !== undefined,
    drawMusd: text((input.draw?.amount ?? 0) / M),
    drawSharePct: input.draw === undefined ? new Array<string>(steps).fill("0").join(" ") : list(input.draw.cumulativeShare, 0.01, 4),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

function num(raw: string, what: string): Parsed<number> {
  const t = raw.trim();
  const v = Number(t);
  return t === "" || !Number.isFinite(v) ? { ok: false, reason: `${what}: "${raw}" is not a number.` } : { ok: true, value: v };
}

function nums(raw: string, what: string, length: number): Parsed<number[]> {
  const parts = raw.trim() === "" ? [] : raw.trim().split(/[\s,;]+/);
  if (parts.length !== length) return { ok: false, reason: `${what}: give ${length} values separated by spaces, got ${parts.length}.` };
  const out: number[] = [];
  for (const [i, p] of parts.entries()) {
    const v = Number(p);
    if (!Number.isFinite(v)) return { ok: false, reason: `${what}: value ${i + 1}, "${p}", is not a number.` };
    out.push(v);
  }
  return { ok: true, value: out };
}

/** The engine input a form states, or the first thing wrong with it in plain words. */
export function inputOf(form: BookPathForm): Parsed<BookPathInput> {
  const hqla = num(form.hqlaMusd, "HQLA");
  if (!hqla.ok) return hqla;
  const received = num(form.receivedMusd, "Received facilities");
  if (!received.ok) return received;
  const haircut = num(form.haircutPct, "Haircut on received facilities");
  if (!haircut.ok) return haircut;
  const buffer = { hqla: hqla.value * M, receivedFacilities: received.value * M, receivedHaircut: haircut.value / 100 };

  let source: BookPathInput["source"];
  let steps: number;
  if (form.built === null) {
    const points: BookPathPoint[] = [];
    for (const p of form.points) {
      const v = num(p.cumulativeMusd, p.label);
      if (!v.ok) return v;
      points.push({ label: p.label, ...(p.month !== undefined ? { month: p.month } : { days: p.days! }), cumulative: v.value * M });
    }
    source = { kind: "stated", points };
    steps = points.length;
  } else {
    const b = form.built;
    steps = b.horizonMonths;
    const inflow = nums(b.inflowMusd, "Counterbalancing inflow", steps);
    if (!inflow.ok) return inflow;
    const scalars: Array<[string, string]> = [
      [b.savingsMusd, "Deposit balance"], [b.stableSharePct, "Stable share"], [b.stableRatePct, "Stable runoff"],
      [b.nonStableRatePct, "Non-stable runoff"], [b.wholesaleMusd, "Wholesale balance"],
    ];
    const v: number[] = [];
    for (const [raw, what] of scalars) {
      const x = num(raw, what);
      if (!x.ok) return x;
      v.push(x.value);
    }
    const timing = nums(b.wholesaleSharePct, "Wholesale timing", steps);
    if (!timing.ok) return timing;
    source = {
      kind: "built",
      horizonMonths: steps,
      inflowCumulative: inflow.value.map((x) => x * M),
      deposits: { balance: v[0]! * M, stableShare: v[1]! / 100, stableRateMonthly: v[2]! / 100, nonStableRateMonthly: v[3]! / 100 },
      wholesale: { balance: v[4]! * M, cumulativeShare: timing.value.map((x) => x / 100) },
    };
  }

  const input: BookPathInput = { source, buffer };
  if (form.drawOn) {
    const amount = num(form.drawMusd, "Stressed draw");
    if (!amount.ok) return amount;
    const shares = nums(form.drawSharePct, "Draw phasing", steps);
    if (!shares.ok) return shares;
    input.draw = { amount: amount.value * M, cumulativeShare: shares.value.map((x) => x / 100) };
  }
  const problem = bookPathConfigError(input);
  return problem === undefined ? { ok: true, value: input } : { ok: false, reason: `${problem.replace(/^book path\./, "")}.` };
}

export interface DialsForm {
  /** S3d fix round: what the amount is, the commitment face or the amount undrawn now (the face is then U / (1 - Ubar)). */
  amountKind: "face" | "undrawn";
  amountMusd: string;
  expectedPct: string;
  tailPct: string;
  spreadBp: string;
  lcrPct: string;
  thirtyDayPct: string;
}

export function dialsFormOf(d: CommitmentDials): DialsForm {
  return {
    amountKind: d.undrawn !== undefined ? "undrawn" : "face",
    amountMusd: text((d.undrawn ?? d.face ?? 0) / M),
    expectedPct: text(d.expectedUtilization * 100),
    tailPct: text(d.tailUtilization * 100),
    spreadBp: text(d.fundingSpreadBp),
    lcrPct: text(d.lcrFactor * 100),
    thirtyDayPct: text(d.thirtyDayShare * 100),
  };
}

/** The dials a form states; the delayed-draw schedule is the stored one, which the form does not edit. */
export function dialsOf(form: DialsForm, stored: CommitmentDials): Parsed<CommitmentDials> {
  const fields: Array<[string, string]> = [
    [form.amountMusd, form.amountKind === "undrawn" ? "Undrawn now" : "Commitment face"], [form.expectedPct, "Expected utilization"], [form.tailPct, "Tail utilization"],
    [form.spreadBp, "Funding spread"], [form.lcrPct, "LCR factor"], [form.thirtyDayPct, "Share of the tail draw in 30 days"],
  ];
  const v: number[] = [];
  for (const [raw, what] of fields) {
    const x = num(raw, what);
    if (!x.ok) return x;
    v.push(x.value);
  }
  const dials: CommitmentDials = {
    ...(form.amountKind === "undrawn" ? { undrawn: v[0]! * M } : { face: v[0]! * M }),
    expectedUtilization: v[1]! / 100,
    tailUtilization: v[2]! / 100,
    fundingSpreadBp: v[3]!,
    lcrFactor: v[4]! / 100,
    thirtyDayShare: v[5]! / 100,
    ...(stored.delayedDraws !== undefined ? { delayedDraws: stored.delayedDraws.map((d) => ({ ...d })) } : {}),
  };
  const problem = commitmentDialsError(dials);
  return problem === undefined ? { ok: true, value: dials } : { ok: false, reason: `${problem.replace(/^commitment dials\./, "")}.` };
}

/** A figure with `digits` decimals and a true minus sign; "none" for a crossing that never happens, "n/a" for no value. */
export function figureText(v: number | null, digits: number): string {
  if (v === null) return "none";
  if (Number.isNaN(v)) return "n/a";
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return v < 0 && Number(s.replace(/,/g, "")) !== 0 ? `−${s}` : s;
}

/** A stated path of `months` monthly points, Month 1 to Month N, from cumulative dollars (a run's row, or zeros). */
export function statedForm(cumulative: readonly number[], buffer: { hqla: number; receivedFacilities: number; receivedHaircut: number }): BookPathForm {
  return formOf({
    source: { kind: "stated", points: cumulative.map((c, i) => ({ label: `Month ${i + 1}`, month: i + 1, cumulative: c })) },
    buffer: { ...buffer },
  });
}
