/**
 * The committed-facility dials: expected and tail utilization on an
 * extended commitment face, the buffer requirement they imply, the contingent liquidity FTP leg, and the LCR
 * reference outflow beside the internal 30-day draw.
 *
 *   expected drawn      Ubar x face                     the base case carries it
 *   tail drawn          U99 x face
 *   buffer requirement  (U99 - Ubar) x face             the unexpected part only; the buffer absorbs it
 *   contingent charge   (U99 - Ubar) / (1 - Ubar) x sB  bp on the undrawn line; the face cancels
 *   LCR reference       lcrFactor x undrawn             the prescribed 30-day outflow
 *   internal 30 days    thirtyDayShare x requirement    the phasing rule's first-month share of the tail draw
 *
 * A delayed-draw book is scheduled, not stressed: its takedowns are listed and summed, and enter nothing else here.
 * Units: dollars, decimals and basis points. Pure.
 *
 * Studio slice S3d fix round (ruling 2026-11-05): the dials may take the undrawn amount now, U, in
 * place of the face. The face is then U / (1 - Ubar); Ubar and U99 stay shares of that face, and the LCR reference
 * reads U, the amount undrawn now. Given the face, every figure is computed as before.
 */

export interface CommitmentDials {
  /** The commitment face extended to borrowers, dollars. Give this or `undrawn`, exactly one. */
  face?: number;
  /** The amount undrawn now, U, dollars; the face is U / (1 - Ubar). Give this or `face`, exactly one. */
  undrawn?: number;
  /** Ubar, the expected utilization, a decimal. */
  expectedUtilization: number;
  /** U99, the stressed 12-month utilization, a decimal at or above Ubar. */
  tailUtilization: number;
  /** sB, the bank's funding spread over the yield on its liquid assets, bp. */
  fundingSpreadBp: number;
  /** The LCR outflow factor on the undrawn line, a decimal (0.10 for a corporate credit facility). */
  lcrFactor: number;
  /** The share of the tail draw the phasing rule puts inside the first month, a decimal. */
  thirtyDayShare: number;
  /** Delayed-draw takedowns on a contracted calendar. */
  delayedDraws?: Array<{ month: number; amount: number }>;
}

export interface CommitmentDialsResult {
  /** The commitment face the figures read: as given, or U / (1 - Ubar). */
  face: number;
  expectedDrawn: number;
  undrawn: number;
  tailDrawn: number;
  bufferRequirement: number;
  /** U99 - Ubar: the requirement as a share of face. */
  bufferRequirementShareOfFace: number;
  contingentChargeBp: number;
  /** The charge on the undrawn line for a year, dollars. */
  contingentChargeAnnual: number;
  lcrReferenceOutflow: number;
  internalThirtyDayDraw: number;
  /** internalThirtyDayDraw / lcrReferenceOutflow; null when the reference is 0. */
  internalOverLcr: number | null;
  /** internalThirtyDayDraw / undrawn; null when nothing is undrawn. */
  internalShareOfUndrawn: number | null;
  delayedDrawTotal: number;
}

function shown(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
}

/** The first problem with a dials object, as a plain sentence; undefined when it is well formed. */
export function commitmentDialsError(value: unknown, path = "commitment dials"): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return `${path} must be an object, got ${shown(value)}`;
  const v = value as Record<string, unknown>;
  const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if ((v.face === undefined) === (v.undrawn === undefined)) return `${path} must give face or undrawn, exactly one`;
  if (v.face !== undefined && (!finite(v.face) || v.face <= 0)) return `${path}.face must be a number of dollars above 0, got ${shown(v.face)}`;
  if (v.undrawn !== undefined && (!finite(v.undrawn) || v.undrawn <= 0)) return `${path}.undrawn must be a number of dollars above 0, got ${shown(v.undrawn)}`;
  for (const key of ["expectedUtilization", "tailUtilization", "lcrFactor", "thirtyDayShare"] as const) {
    const x = v[key];
    if (!finite(x) || x < 0 || x > 1) return `${path}.${key} must be a decimal in [0, 1], got ${shown(x)}`;
  }
  if ((v.expectedUtilization as number) >= 1) return `${path}.expectedUtilization must be below 1, so something is left undrawn, got ${shown(v.expectedUtilization)}`;
  if ((v.tailUtilization as number) < (v.expectedUtilization as number)) {
    return `${path}.tailUtilization ${shown(v.tailUtilization)} is below the expected ${shown(v.expectedUtilization)}; the tail sits at or above the expectation`;
  }
  if (!finite(v.fundingSpreadBp) || v.fundingSpreadBp < 0) return `${path}.fundingSpreadBp must be a number of basis points >= 0, got ${shown(v.fundingSpreadBp)}`;
  if (v.delayedDraws !== undefined) {
    if (!Array.isArray(v.delayedDraws)) return `${path}.delayedDraws must be a list of { month, amount }, got ${shown(v.delayedDraws)}`;
    for (let i = 0; i < v.delayedDraws.length; i++) {
      const d = v.delayedDraws[i] as Record<string, unknown> | null;
      if (d === null || typeof d !== "object" || !Number.isInteger(d.month) || (d.month as number) < 1 || !finite(d.amount) || d.amount < 0) {
        return `${path}.delayedDraws[${i}] must be { month: a whole month from 1, amount: dollars >= 0 }, got ${shown(d)}`;
      }
    }
  }
  return undefined;
}

export function computeCommitmentDials(d: CommitmentDials): CommitmentDialsResult {
  const problem = commitmentDialsError(d);
  if (problem !== undefined) throw new Error(problem.replace(/^commitment dials\./, "commitment dials: "));
  // Given the face, the arithmetic is the one this module always ran; given U, the face is derived and U is the undrawn.
  const face = d.face !== undefined ? d.face : d.undrawn! / (1 - d.expectedUtilization);
  const expectedDrawn = d.expectedUtilization * face;
  const undrawn = d.face !== undefined ? face - expectedDrawn : d.undrawn!;
  const unexpected = d.tailUtilization - d.expectedUtilization;
  const bufferRequirement = unexpected * face;
  const contingentChargeBp = (unexpected / (1 - d.expectedUtilization)) * d.fundingSpreadBp;
  const lcrReferenceOutflow = d.lcrFactor * undrawn;
  const internalThirtyDayDraw = d.thirtyDayShare * bufferRequirement;
  return {
    face,
    expectedDrawn,
    undrawn,
    tailDrawn: d.tailUtilization * face,
    bufferRequirement,
    bufferRequirementShareOfFace: unexpected,
    contingentChargeBp,
    contingentChargeAnnual: (contingentChargeBp / 1e4) * undrawn,
    lcrReferenceOutflow,
    internalThirtyDayDraw,
    internalOverLcr: lcrReferenceOutflow === 0 ? null : internalThirtyDayDraw / lcrReferenceOutflow,
    internalShareOfUndrawn: undrawn === 0 ? null : internalThirtyDayDraw / undrawn,
    delayedDrawTotal: (d.delayedDraws ?? []).reduce((s, x) => s + x.amount, 0),
  };
}
