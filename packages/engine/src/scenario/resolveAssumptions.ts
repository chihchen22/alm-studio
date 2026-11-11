/**
 * resolveAssumptions: turn a validated AssumptionSet (DATA) into constructed,
 * executable kernel behavioral objects (MODELS).
 *
 * Where the kernel model is position-independent, resolution builds the live
 * object: a prepay binding becomes a `PrepayModel` (FourFactorCPR / ConstantCPR)
 * ready to emit a CPR schedule, and a deposit-beta binding becomes the kernel
 * `betaAtRate` closure. Where the executable model is position-DEPENDENT,
 * because the NMD decay kernel and the NMD-B instrument both need per-position
 * terms (notional, seasoning, deposit rate) that live on the Position and not
 * the assumption set, resolution carries a domain-validated param bundle, which the
 * cash-flow loop combines with the position's terms to build the instrument.
 *
 * Three failures are surfaced as inspectable errors, never as a silent drop:
 *   - a binding targeting a family absent from the catalogue (UnknownFamilyError);
 *   - a binding whose overlay kind the family's instrument type cannot consume
 *     (IncompatibleOverlayError; the D5 honesty fix, formerly a silent skip);
 *   - two bindings of the SAME overlay kind on ONE family (DuplicateOverlayError);
 * plus out-of-domain params (OverlayParamError). A single family legitimately
 * carries several DIFFERENT overlay kinds (an interest-bearing NMD needs both a
 * beta and a decay overlay), so byFamily maps to a LIST, preserving every
 * binding.
 */
import type { JsonValue } from "@alm/harness";
import {
  betaAtRate,
  ConstantCPR,
  FourFactorCPR,
  type BetaSCurveParams,
  type MBSParams,
  type NMDParams,
  type PrepayModel,
} from "@alm/kernel";
import {
  overlayKindOf,
  wholeFamilyKey,
  type AssumptionSet,
  type BehavioralOverlay,
  type BuiltinOverlayKind,
  type OverlayBinding,
} from "../contracts/assumptions";
import type { ProductFamilyDef } from "../contracts/chartOfAccounts";
import type { ProductFamilyId } from "../contracts/ids";
import type { EngineInstrumentType } from "../contracts/position";
import { OVERLAY_INSTRUMENT_COMPATIBILITY, overlayInstrumentTypes } from "../contracts/overlayCompatibility";
import { isDerivativeFamily } from "../swap/derivatives";
import { componentDecayIssues, fullFormIssues, replicatingPortfolioIssues } from "../contracts/paramSchema";

/** A binding whose target family is not in the run's family catalogue. */
export class UnknownFamilyError extends Error {
  readonly familyId: ProductFamilyId;
  readonly knownFamilies: ProductFamilyId[];
  constructor(familyId: ProductFamilyId, knownFamilies: ProductFamilyId[]) {
    super(
      `overlay binding targets unknown family "${familyId}"; ` +
        `known families: [${knownFamilies.join(", ")}]`,
    );
    this.name = "UnknownFamilyError";
    this.familyId = familyId;
    this.knownFamilies = knownFamilies;
  }
}

/**
 * The single source of truth for which kernel instrument types each overlay
 * kind can drive (D5), now in ../contracts/overlayCompatibility.ts so Studio
 * can read it without the kernel; re-exported here for
 * the callers that import it from this module. Enforced at run time by
 * resolveAssumptions and mirrored at compile time by the AI compiler THROUGH
 * checkOverlayCompatibility below: both gates call the same function against
 * the same table, so they cannot drift.
 */
export { OVERLAY_INSTRUMENT_COMPATIBILITY };

/**
 * An overlay bound to a family whose instrument type cannot consume it: a
 * genuine misconfiguration (a deposit-beta on a non-interest-bearing book, a
 * prepay curve on a fixed loan). Formerly skipped silently in static runoff
 * (defect D5); now a typed refusal naming the family,
 * the overlay kind, and the instrument type.
 */
export class IncompatibleOverlayError extends Error {
  readonly familyId: ProductFamilyId;
  readonly overlayKind: BehavioralOverlay["kind"];
  readonly instrumentType: EngineInstrumentType;
  readonly permittedTypes: EngineInstrumentType[];
  /** Set only on the registered arm: the kind the binding named. */
  readonly registeredKind?: string;
  /** Set only on the registered arm: the kinds plugins have registered. */
  readonly registeredKinds?: readonly string[];
  constructor(
    familyId: ProductFamilyId,
    overlayKind: BehavioralOverlay["kind"],
    instrumentType: EngineInstrumentType,
    permittedTypes: EngineInstrumentType[],
    registeredKind?: string,
    registeredKinds?: readonly string[],
  ) {
    super(
      registeredKind === undefined
        ? `family "${familyId}" has instrument type "${instrumentType}", which cannot carry a ` +
            `"${overlayKind}" overlay; "${overlayKind}" applies only to instrument types: ` +
            `[${permittedTypes.join(", ")}]`
        : `family "${familyId}" binds behavioral kind "${registeredKind}", which no mounted plugin ` +
            `registered; registered kinds: [${(registeredKinds ?? []).join(", ")}]`,
    );
    this.name = "IncompatibleOverlayError";
    this.familyId = familyId;
    this.overlayKind = overlayKind;
    this.instrumentType = instrumentType;
    this.permittedTypes = permittedTypes;
    if (registeredKind !== undefined) this.registeredKind = registeredKind;
    if (registeredKinds !== undefined) this.registeredKinds = registeredKinds;
  }
}

/**
 * A behavioral overlay bound to a derivative (swap) family. A swap's
 * two legs are contractual: the fixed leg is fixed and the floating leg reads
 * the scenario path. No overlay kind, built-in or registered, drives one.
 * Checked BEFORE the compatibility gate, because that gate lets a registered
 * kind through on any instrument type.
 */
export class DerivativeOverlayError extends Error {
  readonly familyId: ProductFamilyId;
  readonly overlayKind: string;
  constructor(familyId: ProductFamilyId, overlayKind: string) {
    super(
      `family "${familyId}" is a derivative family (side "derivative") and "${overlayKind}" is bound ` +
        `to it; no behavioral overlay binds to a swap, whose legs are contractual (the fixed leg is ` +
        `fixed and the floating leg reads the scenario path)`,
    );
    this.name = "DerivativeOverlayError";
    this.familyId = familyId;
    this.overlayKind = overlayKind;
  }
}

/**
 * The one shared compatibility gate. Throws IncompatibleOverlayError when the
 * overlay kind is not permitted on the instrument type. Called by
 * resolveAssumptions (run time) and by the AI compiler (compile time); any new
 * caller must use this function, never re-read the table inline.
 */
export function checkOverlayCompatibility(
  familyId: ProductFamilyId,
  overlayKind: BuiltinOverlayKind,
  instrumentType: EngineInstrumentType,
  model?: string,
): void {
  // `model` widens the prepay row for constant-cpr only (overlayInstrumentTypes).
  const permitted = overlayInstrumentTypes(overlayKind, model);
  if (!permitted.includes(instrumentType)) {
    throw new IncompatibleOverlayError(familyId, overlayKind, instrumentType, [...permitted]);
  }
}

/** The model a built-in overlay names, for the compatibility gate: the prepay arm only; undefined otherwise. */
export function overlayModelOf(overlay: BehavioralOverlay): string | undefined {
  return overlay.kind === "prepay" ? overlay.model : undefined;
}

/**
 * A registered overlay's compatibility is the plugin's business, not the
 * engine's: the table above covers the four kinds the engine executes. What the
 * engine checks is that the kind is mounted at all, and it names what is.
 */
export function checkRegisteredKind(
  familyId: ProductFamilyId,
  registeredKind: string,
  instrumentType: EngineInstrumentType,
  registeredKinds: readonly string[],
): void {
  if (!registeredKinds.includes(registeredKind)) {
    throw new IncompatibleOverlayError(
      familyId,
      "registered",
      instrumentType,
      [],
      registeredKind,
      registeredKinds,
    );
  }
}

/** Two overlays of the same kind bound to one family: an unresolvable conflict. */
export class DuplicateOverlayError extends Error {
  readonly familyId: ProductFamilyId;
  readonly overlayKind: BehavioralOverlay["kind"];
  constructor(familyId: ProductFamilyId, overlayKind: BehavioralOverlay["kind"]) {
    super(`family "${familyId}" has two "${overlayKind}" overlays; one family, one overlay per kind`);
    this.name = "DuplicateOverlayError";
    this.familyId = familyId;
    this.overlayKind = overlayKind;
  }
}

/** An overlay whose parameters fall outside the model's admissible domain. */
export class OverlayParamError extends Error {
  readonly familyId: ProductFamilyId;
  readonly overlayKind: BehavioralOverlay["kind"];
  constructor(familyId: ProductFamilyId, overlayKind: BehavioralOverlay["kind"], detail: string) {
    super(`family "${familyId}" ${overlayKind} overlay: ${detail}`);
    this.name = "OverlayParamError";
    this.familyId = familyId;
    this.overlayKind = overlayKind;
  }
}

/**
 * A loan client-rate total spread that differs from the prepay overlay's
 * securitization plus primary spread (both in bp) where the two apply to the same
 * position. Both overlays describe one quantity, the offered mortgage rate over
 * the 10-year benchmark, so equality enforces a single truth; summing them would
 * double count. Lives here, beside the other overlay refusals, so bindAssumptions
 * and applyOverlays can import it without a cycle (this module imports neither).
 */
export class ClientRateSpreadMismatchError extends Error {
  readonly setId: string;
  readonly familyId: ProductFamilyId;
  readonly selectorText: string | undefined;
  readonly totalSpreadBp: number;
  readonly secSpread: number;
  readonly primSpread: number;
  constructor(
    setId: string,
    familyId: ProductFamilyId,
    selectorText: string | undefined,
    totalSpreadBp: number,
    secSpread: number,
    primSpread: number,
  ) {
    const selectorClause = selectorText === undefined ? "" : ` selector ${selectorText}`;
    super(
      `assumption set ${setId} family ${familyId}${selectorClause}: ` +
        `loan client-rate total spread ${String(totalSpreadBp)} bp vs prepay ` +
        `${String(secSpread + primSpread)} (${String(secSpread)} + ${String(primSpread)}) bp; ` +
        `the two must be equal`,
    );
    this.name = "ClientRateSpreadMismatchError";
    this.setId = setId;
    this.familyId = familyId;
    this.selectorText = selectorText;
    this.totalSpreadBp = totalSpreadBp;
    this.secSpread = secSpread;
    this.primSpread = primSpread;
  }
}

/** The tolerance on |total - (sec + prim)|, in bp. */
const CLIENT_RATE_SPREAD_TOLERANCE_BP = 1e-9;

/**
 * The consistency rule for one (client-rate, prepay) pair. A constant-cpr prepay
 * has no offered rate and is exempt. Throws ClientRateSpreadMismatchError when
 * |totalSpreadBp - (secSpread + primSpread)| exceeds 1e-9 bp.
 */
export function checkClientRateSpread(
  setId: string,
  familyId: ProductFamilyId,
  clientOverlay: Extract<BehavioralOverlay, { kind: "loan-client-rate" }>,
  prepayOverlay: Extract<BehavioralOverlay, { kind: "prepay" }>,
  selectorText?: string,
): void {
  if (prepayOverlay.model !== "four-factor-cpr") return;
  const sec = prepayOverlay.params.secSpread;
  const prim = prepayOverlay.params.primSpread;
  const total = clientOverlay.totalSpreadBp;
  if (Math.abs(total - (sec + prim)) > CLIENT_RATE_SPREAD_TOLERANCE_BP) {
    throw new ClientRateSpreadMismatchError(setId, familyId, selectorText, total, sec, prim);
  }
}

/**
 * The whole-family pairs of a set: every (loan-client-rate, prepay) pair on one
 * family where neither binding has a selector. Pairs with a selector depend on
 * the book and are settled per position by checkBindingOverlap.
 */
export function checkClientRateSpreadPairs(set: AssumptionSet): void {
  const clients: OverlayBinding[] = [];
  const prepays: OverlayBinding[] = [];
  for (const b of set.bindings) {
    if (b.selector !== undefined) continue;
    if (b.overlay.kind === "loan-client-rate") clients.push(b);
    else if (b.overlay.kind === "prepay") prepays.push(b);
  }
  for (const c of clients) {
    for (const p of prepays) {
      if (p.familyId !== c.familyId) continue;
      checkClientRateSpread(
        set.id,
        c.familyId,
        c.overlay as Extract<BehavioralOverlay, { kind: "loan-client-rate" }>,
        p.overlay as Extract<BehavioralOverlay, { kind: "prepay" }>,
      );
    }
  }
}

interface ResolvedBase {
  familyId: ProductFamilyId;
  modelVersion: string;
}

/** A resolved overlay: the constructed model plus the source binding metadata. */
export type ResolvedOverlay =
  | (ResolvedBase & { kind: "prepay"; model: PrepayModel })
  | (ResolvedBase & { kind: "nmd-decay"; params: NMDParams })
  | (ResolvedBase & {
      kind: "deposit-beta";
      params: BetaSCurveParams;
      /** Kernel S-curve β at a market rate level (% pa). */
      betaAt: (rPct: number) => number;
    })
  | (ResolvedBase & {
      kind: "cd-rollover";
      renewalProbability: number;
      offeredSpreadBp: number;
      termMonths: number;
    })
  | (ResolvedBase & { kind: "commitment-draw"; rampRates: number[]; steadyRate: number })
  | (ResolvedBase & { kind: "loan-client-rate"; model: "flat-carry"; totalSpreadBp: number })
  | (ResolvedBase & { kind: "registered"; registeredKind: string; params: JsonValue });

export interface ResolvedAssumptions {
  /** Resolved overlays in binding order (determinism: never Map-iteration order). */
  overlays: ResolvedOverlay[];
  /** Lookup by family; a family maps to all its overlays, in binding order. */
  byFamily: Map<ProductFamilyId, ResolvedOverlay[]>;
}

function resolvePrepay(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "prepay" }>,
): ResolvedOverlay {
  const base: ResolvedBase = { familyId: binding.familyId, modelVersion: binding.modelVersion };
  if (overlay.model === "four-factor-cpr") {
    const p: MBSParams = overlay.params;
    if (!(p.maxCpr > p.minCpr)) {
      throw new OverlayParamError(binding.familyId, "prepay", "require maxCpr > minCpr");
    }
    if (!(p.seasoningRamp > 0)) {
      throw new OverlayParamError(binding.familyId, "prepay", "seasoningRamp must be positive");
    }
    return { ...base, kind: "prepay", model: new FourFactorCPR(p) };
  }
  const cpr = overlay.annualCpr;
  if (!(cpr >= 0 && cpr <= 1)) {
    throw new OverlayParamError(binding.familyId, "prepay", `constant annualCpr ${cpr} must be in [0,1]`);
  }
  const stress = overlay.stressAnnualCpr;
  if (stress !== undefined && !(stress >= 0 && stress <= 1)) {
    throw new OverlayParamError(binding.familyId, "prepay", `constant stressAnnualCpr ${stress} must be in [0,1]`);
  }
  return { ...base, kind: "prepay", model: new ConstantCPR(cpr) };
}

function resolveDepositBeta(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "deposit-beta" }>,
): ResolvedOverlay {
  const p = overlay.params;
  // Mirror the kernel NMDBeta constructor's admissibility checks up front, so a
  // bad set fails at resolution with a clear message rather than deep in the loop.
  if (!(p.betaMin >= 0 && p.betaMax > p.betaMin)) {
    throw new OverlayParamError(binding.familyId, "deposit-beta", "require 0 <= betaMin < betaMax");
  }
  if (!(p.lambda > 0 && p.lambda <= 1)) {
    throw new OverlayParamError(binding.familyId, "deposit-beta", "lambda must be in (0, 1]");
  }
  // A full form, when the overlay carries one, meets the bind-time schema rule again here.
  if (overlay.fullForm !== undefined) {
    const issue = fullFormIssues(overlay.fullForm)[0];
    if (issue !== undefined) throw new OverlayParamError(binding.familyId, "deposit-beta", issue.path + " " + issue.message);
  }
  // So does a replicating-portfolio credit, which needs the full form beside it.
  if (overlay.replicatingPortfolio !== undefined) {
    const issue = replicatingPortfolioIssues(overlay.replicatingPortfolio)[0];
    if (issue !== undefined) throw new OverlayParamError(binding.familyId, "deposit-beta", issue.path + " " + issue.message);
    if (overlay.fullForm === undefined) throw new OverlayParamError(binding.familyId, "deposit-beta", "replicatingPortfolio needs the full beta form beside it");
  }
  return {
    familyId: binding.familyId,
    modelVersion: binding.modelVersion,
    kind: "deposit-beta",
    params: p,
    betaAt: (rPct: number) => betaAtRate(rPct, p),
  };
}

function resolveDecay(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "nmd-decay" }>,
): ResolvedOverlay {
  const p = overlay.params;
  if (!(p.maPeriod > 0)) {
    throw new OverlayParamError(binding.familyId, "nmd-decay", "maPeriod must be positive");
  }
  if (!Array.isArray(p.buckets) || p.buckets.length === 0) {
    throw new OverlayParamError(binding.familyId, "nmd-decay", "buckets must be a non-empty array");
  }
  // A component decay form, when the overlay carries one, meets the bind-time rule again here.
  if (overlay.componentDecay !== undefined) {
    const issue = componentDecayIssues(overlay.componentDecay)[0];
    if (issue !== undefined) throw new OverlayParamError(binding.familyId, "nmd-decay", issue.path + " " + issue.message);
  }
  // So does a replicating-portfolio construction.
  if (overlay.replicatingPortfolio !== undefined) {
    const issue = replicatingPortfolioIssues(overlay.replicatingPortfolio)[0];
    if (issue !== undefined) throw new OverlayParamError(binding.familyId, "nmd-decay", issue.path + " " + issue.message);
  }
  return {
    familyId: binding.familyId,
    modelVersion: binding.modelVersion,
    kind: "nmd-decay",
    params: p,
  };
}

function resolveCdRollover(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "cd-rollover" }>,
): ResolvedOverlay {
  if (!(overlay.renewalProbability >= 0 && overlay.renewalProbability <= 1)) {
    throw new OverlayParamError(
      binding.familyId,
      "cd-rollover",
      `renewalProbability ${overlay.renewalProbability} must be in [0,1]`,
    );
  }
  if (!(overlay.termMonths > 0)) {
    throw new OverlayParamError(binding.familyId, "cd-rollover", "termMonths must be positive");
  }
  return {
    familyId: binding.familyId,
    modelVersion: binding.modelVersion,
    kind: "cd-rollover",
    renewalProbability: overlay.renewalProbability,
    offeredSpreadBp: overlay.offeredSpreadBp,
    termMonths: overlay.termMonths,
  };
}

function resolveCommitmentDraw(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "commitment-draw" }>,
): ResolvedOverlay {
  const base: ResolvedBase = { familyId: binding.familyId, modelVersion: binding.modelVersion };
  const bad = (what: string, v: number) =>
    new OverlayParamError(
      binding.familyId,
      "commitment-draw",
      `${what} must be a finite fraction in [0, 1], got ${String(v)}`,
    );
  if (!Array.isArray(overlay.rampRates)) {
    throw new OverlayParamError(binding.familyId, "commitment-draw", "rampRates must be an array");
  }
  overlay.rampRates.forEach((r, i) => {
    if (!Number.isFinite(r) || r < 0 || r > 1) throw bad(`rampRates[${i}]`, r);
  });
  if (!Number.isFinite(overlay.steadyRate) || overlay.steadyRate < 0 || overlay.steadyRate > 1) {
    throw bad("steadyRate", overlay.steadyRate);
  }
  return { ...base, kind: "commitment-draw", rampRates: [...overlay.rampRates], steadyRate: overlay.steadyRate };
}

function resolveLoanClientRate(
  binding: OverlayBinding,
  overlay: Extract<BehavioralOverlay, { kind: "loan-client-rate" }>,
): ResolvedOverlay {
  // The only public client-rate model is flat carry (ruling 2026-08-22).
  if ((overlay.model as unknown) !== "flat-carry") {
    throw new OverlayParamError(
      binding.familyId,
      "loan-client-rate",
      `model must be "flat-carry", got ${String(overlay.model)}`,
    );
  }
  const s = overlay.totalSpreadBp;
  if (typeof s !== "number" || !Number.isFinite(s) || s < 0 || s > 1000) {
    throw new OverlayParamError(
      binding.familyId,
      "loan-client-rate",
      `totalSpreadBp must be a finite number in [0, 1000], got ${String(s)}`,
    );
  }
  return {
    familyId: binding.familyId,
    modelVersion: binding.modelVersion,
    kind: "loan-client-rate",
    model: "flat-carry",
    totalSpreadBp: s,
  };
}

function resolveOverlay(binding: OverlayBinding): ResolvedOverlay {
  const overlay = binding.overlay;
  switch (overlay.kind) {
    case "prepay":
      return resolvePrepay(binding, overlay);
    case "deposit-beta":
      return resolveDepositBeta(binding, overlay);
    case "nmd-decay":
      return resolveDecay(binding, overlay);
    case "cd-rollover":
      return resolveCdRollover(binding, overlay);
    case "commitment-draw":
      return resolveCommitmentDraw(binding, overlay);
    case "loan-client-rate":
      return resolveLoanClientRate(binding, overlay);
    case "registered":
      return {
        familyId: binding.familyId,
        modelVersion: binding.modelVersion,
        kind: "registered",
        registeredKind: overlay.registeredKind,
        params: overlay.params,
      };
  }
}

/**
 * Resolve every binding into a constructed model. Throws UnknownFamilyError on a
 * binding whose family is not in `families`, IncompatibleOverlayError on an
 * overlay kind the family's instrument type cannot consume, DuplicateOverlayError
 * on a repeated (family, kind) where neither binding carries a selector, and
 * OverlayParamError on out-of-domain params.
 * `registeredKinds` are the behavioral kinds mounted plugins have registered;
 * a binding naming a kind outside that list is refused the same way.
 */
export function resolveAssumptions(
  set: AssumptionSet,
  families: ProductFamilyDef[],
  registeredKinds: readonly string[] = [],
): ResolvedAssumptions {
  const knownFamilies = families.map((f) => f.id);
  const known = new Set(knownFamilies);
  const familyById = new Map(families.map((f) => [f.id, f]));
  const overlays: ResolvedOverlay[] = [];
  const byFamily = new Map<ProductFamilyId, ResolvedOverlay[]>();
  const unselected = new Set<string>();

  for (const binding of set.bindings) {
    if (!known.has(binding.familyId)) {
      throw new UnknownFamilyError(binding.familyId, knownFamilies);
    }
    const familyDef = familyById.get(binding.familyId)!;
    if (isDerivativeFamily(familyDef)) {
      throw new DerivativeOverlayError(binding.familyId, overlayKindOf(binding.overlay));
    }
    if (binding.overlay.kind === "registered") {
      checkRegisteredKind(
        binding.familyId,
        binding.overlay.registeredKind,
        familyDef.instrumentType,
        registeredKinds,
      );
    } else {
      checkOverlayCompatibility(binding.familyId, binding.overlay.kind, familyDef.instrumentType, overlayModelOf(binding.overlay));
    }
    const existing = byFamily.get(binding.familyId) ?? [];
    // Two bindings of one kind on one family collide only when NEITHER carries
    // a selector: with a selector the overlap is a per-position
    // question, settled by L3 at compile and by checkBindingOverlap on the
    // applier's path. Unselected bindings are tracked per family per kind by
    // wholeFamilyKey, the key bindAssumptions refuses on at save: the
    // registry's name, so two plugins' kinds on one family stay distinct while
    // two bindings of one kind still collide.
    const wholeFamily = wholeFamilyKey(binding);
    if (wholeFamily !== null) {
      if (unselected.has(wholeFamily)) throw new DuplicateOverlayError(binding.familyId, binding.overlay.kind);
      unselected.add(wholeFamily);
    }
    const resolved = resolveOverlay(binding);
    overlays.push(resolved);
    existing.push(resolved);
    byFamily.set(binding.familyId, existing);
  }

  // One truth for the offered mortgage rate where both overlays apply.
  checkClientRateSpreadPairs(set);

  return { overlays, byFamily };
}
