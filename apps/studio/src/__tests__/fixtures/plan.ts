import type { PluginCatalogReply, ValidateResponse } from "@alm/reader";

const pass = (checked: string[]) => ({ passed: true, failures: [], checked });

/**
 * The wire shape of a gate that never ran (apps/server/src/http/routes/plans.ts
 * notRun): passed false, no failures, one "gate not run: <reason>" line.
 */
const notRun = (reason: string) => ({ passed: false, failures: [], checked: [`gate not run: ${reason}`] });

/** Clean compile with one tolerated catalog-only stage (st-ftp swapped to alm-ftp). */
export const REPLY_TAG: ValidateResponse = {
  type: pass(["T1 st-cashflow"]),
  routing: pass(["R1 st-prepay"]),
  compile: { passed: true },
  notImplemented: [{ layer: "plan.stage.st-ftp", reason: 'component "alm-ftp" (metric) is declared in the plan but no mounted plugin executes it' }],
  runLog: [],
};

/** The st-term wire into st-cashflow removed. */
export const REPLY_T1: ValidateResponse = {
  type: {
    passed: false,
    failures: [{ gate: "type", rule: "T1", stageId: "st-cashflow", detail: 'consumes "RatePath" but no stage in its dependsOn [st-beta] produces it and no context file supplies it' }],
    checked: ["T1 st-cashflow"],
  },
  routing: pass(["R1 st-prepay"]),
  compile: { passed: false, detail: "plan rejected: 1 gate failure(s): T1@st-cashflow", error: "PlanRejected" },
  runLog: [{ t: "refuse", error: "plan rejected: 1 gate failure(s): T1@st-cashflow", ids: { planId: "plan-synthetic-2500-v1" } }] as ValidateResponse["runLog"],
};

const UNLICENSED = 'assumption set "demo-behavioral-v1" bindings[2] binds family "dda" to behavioral kind "nmd-decay", which no behavioral stage in the plan licenses';

/**
 * st-decay swapped to alm-competing-risks-prepay: a plan-wide refusal with no
 * stage id. The license check runs between the two waterfalls and the compiler
 * attaches gate reports only after both, so the live server fills both gates
 * as not run (the type gate did run), which this fixture copies.
 */
export const REPLY_UNLICENSED: ValidateResponse = {
  type: notRun(UNLICENSED),
  routing: notRun(UNLICENSED),
  compile: { passed: false, detail: UNLICENSED, error: "UnlicensedBindingError" },
  runLog: [{ t: "refuse", error: "unlicensed", ids: { layer: "plan/license", planId: "plan-synthetic-2500-v1", familyId: "dda", kind: "nmd-decay" } }] as ValidateResponse["runLog"],
};

/** A stage-attributed executability refusal (PlanNotExecutableError carries ids.stageId). */
export const REPLY_NOT_EXECUTABLE: ValidateResponse = {
  type: pass(["T1 st-x"]),
  routing: pass(["R1 st-x"]),
  compile: { passed: false, detail: 'stage "st-x" names component "alm-x", which no mounted plugin declares', error: "PlanNotExecutableError" },
  runLog: [{ t: "refuse", error: 'stage "st-x" names component "alm-x", which no mounted plugin declares', ids: { planId: "p", stageId: "st-x" } }] as ValidateResponse["runLog"],
};

/** A loaded plan that carries a routing failure. */
export const REPLY_R1: ValidateResponse = {
  type: pass(["T1 st-decay"]),
  routing: {
    passed: false,
    failures: [
      { gate: "routing", rule: "R1", stageId: "st-decay", detail: 'class "decay" may not feed metric "nii" (policy says none)' },
      { gate: "routing", rule: "R4", stageId: null, detail: "positions carry behavioral classes with no matching behavioral stage" },
    ],
    checked: ["R1 st-decay"],
  },
  compile: { passed: false, detail: "plan rejected: 2 gate failure(s): R1@st-decay, R4", error: "PlanRejected" },
  runLog: [],
};

const UNKNOWN_DIMENSION = 'stage st-decay-nmd: selector names tag "segment", which the book\'s taxonomy does not declare';

/** Gates never ran (the refusal came before the waterfalls). */
export const REPLY_NOT_RUN: ValidateResponse = {
  type: notRun(UNKNOWN_DIMENSION),
  routing: notRun(UNKNOWN_DIMENSION),
  compile: { passed: false, detail: UNKNOWN_DIMENSION, error: "UnknownDimensionError" },
  runLog: [],
};

const MOUNT_REFUSED = 'profile row "r-ghost" names plugin "acme.not.installed", which is not installed';

/** A profile that will not mount: PlanRejected with no gate failures, both gates not run. */
export const REPLY_MOUNT_REFUSED: ValidateResponse = {
  type: notRun(MOUNT_REFUSED),
  routing: notRun(MOUNT_REFUSED),
  compile: { passed: false, detail: MOUNT_REFUSED, error: "PlanRejected" },
  runLog: [{ t: "refuse", error: MOUNT_REFUSED, ids: { planId: "p" } }] as ValidateResponse["runLog"],
};

/** A clean compile that also tags a plan-level layer naming no stage. */
export const REPLY_PLAN_NOTE: ValidateResponse = {
  type: pass(["T1 st-cashflow"]),
  routing: pass(["R1 st-prepay"]),
  compile: { passed: true },
  notImplemented: [
    { layer: "plan.stage.st-ftp", reason: 'component "alm-ftp" (metric) is declared in the plan but no mounted plugin executes it' },
    { layer: "plan.balance-plan.unused", reason: "the plan carries a balance plan but no stage consumes it" },
  ],
  runLog: [],
};

/** Mounted kinds follow each plugin's real `declares` (packages/engine/src/plugins/behavioral.ts, metrics.ts). */
export const CATALOG: PluginCatalogReply = {
  components: [
    { id: "alm-mortgage-prepayment", kind: "behavioral", label: "Mortgage prepayment", consumes: ["Position", "RatePath"], produces: ["Position"] },
    { id: "alm-competing-risks-prepay", kind: "behavioral", label: "Competing-risks prepayment", consumes: ["Position", "RatePath"], produces: ["Position"] },
    { id: "alm-deposit-decay", kind: "behavioral", label: "Deposit decay", consumes: ["Position", "RatePath"], produces: ["Position"] },
    { id: "alm-ftp", kind: "metric", label: "FTP", consumes: ["Cashflow", "ZeroCurve"], produces: ["FtpResult"] },
    { id: "alm-nii", kind: "metric", label: "NII", consumes: ["Cashflow"], produces: ["NiiResult"] },
  ],
  stageKinds: [{ id: "behavioral", label: "Behavioral overlay" }, { id: "metric", label: "Metric" }],
  mounted: [
    { id: "engine.behavioral.prepay", aliases: ["alm-mortgage-prepayment", "engine.prepay"], kind: "behavioral" },
    { id: "engine.behavioral.nmd-decay", aliases: ["alm-deposit-decay", "engine.nmd-decay"], kind: "behavioral" },
    { id: "engine.behavioral.cd-rollover", aliases: ["engine.cd-rollover"], kind: "behavioral" },
    { id: "engine.metric.nii", aliases: ["alm-nii", "engine.nii"], kind: "metric" },
    { id: "engine.metric.ftp", aliases: [], kind: "metric" },
  ],
};
